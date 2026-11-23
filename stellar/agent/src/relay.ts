/**
 * Relay and relayer.
 *
 * Holds sealed signals (ciphertext only, never plaintext), waits until each one's commitment is
 * on-chain, hands it to the enclave, then for every vault that follows the leader: reads the vault,
 * its pools and the oracle, asks the enclave for a signed authorization, checks the enclave signed
 * the same payload this relayer will submit, and submits the swap, paying the fees.
 *
 * The relayer is untrusted by design: every vault re-checks the authorization on-chain.
 */

import {
  authPayload,
  isTransient,
  withRetry,
  randomNonce,
  swapAuthEntry,
  swapInvocation,
  swapOperation,
  type Chain,
  type SignalRecord,
  type Signer,
  type SwapPlan,
} from "@sigmax/stellar-client";

import type { EnclaveClient } from "./enclave.js";

/** Ledgers the vault's Soroban signature stays valid (the enclave allows up to 120). */
const SIGNATURE_LEDGERS = 60;
export type JobStatus = "waiting-for-commit" | "executing" | "done" | "failed";

export interface VaultResult {
  vault: string;
  status: "submitted" | "skipped" | "failed";
  reason?: string;
  tx?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  minOut?: string;
}

export interface SignalJob {
  commitment: string;
  receivedAt: number;
  status: JobStatus;
  leader?: string;
  results: VaultResult[];
  error?: string;
}

export interface RelayOptions {
  /** How long to wait for the leader's commit transaction, in ms. */
  commitTimeoutMs?: number;
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;

export class Relay {
  private readonly jobs = new Map<string, SignalJob>();
  private readonly ciphertexts = new Map<string, string>();
  private readonly queue: string[] = [];
  private running = false;
  private readonly log: (line: string) => void;

  constructor(
    private readonly chain: Chain,
    private readonly enclave: EnclaveClient,
    private readonly relayer: { publicKey: string; signer: Signer },
    private readonly opts: RelayOptions = {},
  ) {
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** Queue a sealed signal. Returns the job (existing one if the commitment was already sent). */
  accept(commitment: string, ciphertext: string): SignalJob {
    const c = commitment.toLowerCase().replace(/^0x/, "");
    const ct = ciphertext.toLowerCase().replace(/^0x/, "");
    if (!HEX32.test(c)) throw new Error("commitment must be 32 bytes of hex");
    if (!HEX.test(ct) || ct.length % 2 !== 0 || ct.length < 2 * (65 + 16 + 32)) throw new Error("ciphertext must be ECIES hex");
    if (ct.length > 2 * 8_192) throw new Error("ciphertext too large");
    const existing = this.jobs.get(c);
    if (existing && existing.status !== "failed") return existing;
    if (existing) {
      // Re-run a failed signal. Vaults that already traded it refuse a second trade on-chain.
      existing.status = "waiting-for-commit";
      existing.error = undefined;
      existing.results = [];
      this.ciphertexts.set(c, ct);
      this.queue.push(c);
      void this.drain();
      return existing;
    }
    const job: SignalJob = { commitment: c, receivedAt: Date.now(), status: "waiting-for-commit", results: [] };
    this.jobs.set(c, job);
    this.ciphertexts.set(c, ct);
    this.queue.push(c);
    void this.drain();
    return job;
  }

  get(commitment: string): SignalJob | undefined {
    return this.jobs.get(commitment.toLowerCase().replace(/^0x/, ""));
  }

  list(limit = 50): SignalJob[] {
    return [...this.jobs.values()].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, limit);
  }

  /** Process queued signals one at a time (one relayer account, one sequence number). */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let c = this.queue.shift(); c !== undefined; c = this.queue.shift()) {
        const job = this.jobs.get(c)!;
        try {
          await this.process(job);
          job.status = "done";
          // The ciphertext is only needed until the signal is done; a failed job keeps it so it
          // can be re-run by posting the same commitment again.
          this.ciphertexts.delete(c);
        } catch (e) {
          job.status = "failed";
          job.error = e instanceof Error ? e.message : String(e);
          this.log(`signal ${c.slice(0, 12)}… failed: ${job.error}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async waitForCommit(commitment: Uint8Array): Promise<SignalRecord> {
    const deadline = Date.now() + (this.opts.commitTimeoutMs ?? 120_000);
    for (;;) {
      const record = await this.chain.signalRecord(commitment).catch((e: unknown) => {
        if (isTransient(e)) return null;
        throw e;
      });
      if (record) return record;
      if (Date.now() > deadline) throw new Error("commitment never appeared in the Signal Registry");
      await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs ?? 3_000));
    }
  }

  private async process(job: SignalJob): Promise<void> {
    const commitment = Buffer.from(job.commitment, "hex");
    const record = await this.waitForCommit(commitment);
    job.leader = record.leader;
    job.status = "executing";
    await withRetry(() => this.enclave.submitSignal(job.commitment, this.ciphertexts.get(job.commitment)!, record));
    this.log(`signal ${job.commitment.slice(0, 12)}… from ${record.leader.slice(0, 8)}… accepted by the enclave`);

    for (const vault of await withRetry(() => this.chain.vaults())) {
      // A retry re-reads the vault: if the first attempt landed, the vault reports the signal as
      // used and the enclave skips it, so a retry can never trade twice.
      const result = await withRetry(() => this.executeVault(job.commitment, commitment, record, vault)).catch(
        (e: unknown): VaultResult => ({ vault, status: "failed", reason: e instanceof Error ? e.message : String(e) }),
      );
      if (result) {
        job.results.push(result);
        this.log(
          result.status === "submitted"
            ? `vault ${vault.slice(0, 8)}… swapped ${result.amountIn} ${result.tokenIn?.slice(0, 6)}… tx ${result.tx}`
            : `vault ${vault.slice(0, 8)}… ${result.status}: ${result.reason}`,
        );
      }
    }
  }

  /** Returns null for vaults that follow another leader (they are not part of this signal). */
  private async executeVault(
    commitmentHex: string,
    commitment: Uint8Array,
    record: SignalRecord,
    vault: string,
  ): Promise<VaultResult | null> {
    const state = await this.chain.vaultState(vault);
    if (state.policy.leader !== record.leader) return null;

    const [signalUsed, pools, oracle, ledger] = await Promise.all([
      this.chain.isSignalUsed(vault, commitment),
      Promise.all(state.policy.venues.map((v) => this.chain.poolState(v.pool))),
      this.chain.oracleState(
        state.policy.assets.map((a) => a.symbol),
        state.config.oracle,
      ),
      this.chain.latestLedger(),
    ]);
    const nonce = randomNonce();
    const signatureExpirationLedger = ledger.sequence + SIGNATURE_LEDGERS;
    const res = await this.enclave.authorize({
      commitment: commitmentHex,
      ledger: { sequence: ledger.sequence, timestamp: ledger.closeTime },
      vault: state,
      signalUsed,
      pools,
      oracle,
      nonce,
      signatureExpirationLedger,
    });
    if (res.status === "skipped") return { vault, status: "skipped", reason: res.reason };

    const plan: SwapPlan = {
      pool: res.plan.pool,
      tokenIn: res.plan.token_in,
      tokenOut: res.plan.token_out,
      inIdx: res.plan.in_idx,
      outIdx: res.plan.out_idx,
      amountIn: BigInt(res.plan.amount_in),
      minOut: BigInt(res.plan.min_out),
    };
    const invocation = swapInvocation(vault, plan);
    const payload = authPayload(this.chain.passphrase, nonce, signatureExpirationLedger, invocation);
    if (payload.toString("hex") !== res.auth_payload) {
      throw new Error("enclave signed a different payload than the relayer would submit");
    }
    const entry = swapAuthEntry(vault, nonce, signatureExpirationLedger, invocation, {
      signal: Buffer.from(res.proof.signal, "hex"),
      expiresAtLedger: res.proof.expires_at_ledger,
      signature: Buffer.from(res.proof.signature, "hex"),
    });
    const sent = await this.chain.submit(this.relayer.publicKey, this.relayer.signer, swapOperation(vault, plan, entry));
    return {
      vault,
      status: "submitted",
      tx: sent.hash,
      tokenIn: plan.tokenIn,
      tokenOut: plan.tokenOut,
      amountIn: plan.amountIn.toString(),
      minOut: plan.minOut.toString(),
    };
  }
}

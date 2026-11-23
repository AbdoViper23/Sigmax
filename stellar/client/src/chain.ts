/**
 * Stellar RPC access: contract reads by simulation, and a submit path that works with a local
 * keypair (relayer, scripts) or a browser wallet (web app) through the same `Signer` callback.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

import type { Deployment } from "./config.js";
import { isTransient, sleep, withRetry } from "./retry.js";
import {
  oracleOtherAsset,
  policyFromScVal,
  priceFromScVal,
  signalRecordFromScVal,
  tradeMarksFromScVal,
  vaultConfigFromScVal,
  type Policy,
  type SignalRecord,
  type TradeMark,
  type VaultConfig,
} from "./contracts.js";

/** Signs a transaction envelope (base64 XDR) and returns the signed envelope. */
export type Signer = (txXdr: string, networkPassphrase: string) => Promise<string>;

export function keypairSigner(keypair: Keypair): Signer {
  return async (txXdr, networkPassphrase) => {
    const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
    tx.sign(keypair);
    return tx.toXDR();
  };
}

export interface SubmitResult {
  hash: string;
  returnValue?: xdr.ScVal;
  ledger?: number;
}

export interface VaultState {
  vault: string;
  owner: string;
  config: VaultConfig;
  policy: Policy;
  paused: boolean;
  /** Token contract → balance in base units. */
  balances: Record<string, bigint>;
  recent: TradeMark[];
}

export interface PoolState {
  pool: string;
  tokens: string[];
  reserves: bigint[];
  feeBps: number;
}

export interface OracleState {
  decimals: number;
  prices: Record<string, { price: bigint; timestamp: bigint }>;
}

/**
 * Simulation can come in slightly under what the transaction uses when it is applied (state moves
 * between the two), and the network then fails it with `resource_limit_exceeded`. Pad the declared
 * instructions and I/O, and the resource fee to match. Seen on Testnet with an Aquarius swap.
 */
export function withResourceMargin(sim: rpc.Api.SimulateTransactionSuccessResponse, margin = 0.25): void {
  const data = sim.transactionData.build() as unknown as {
    resources: { instructions: number; diskReadBytes: number; writeBytes: number };
  };
  const pad = (n: number, extra: number) => Math.ceil(n * (1 + margin)) + extra;
  sim.transactionData.setResources(
    pad(data.resources.instructions, 100_000),
    pad(data.resources.diskReadBytes, 1_000),
    pad(data.resources.writeBytes, 1_000),
  );
  const fee = BigInt(sim.minResourceFee);
  const padded = fee + (fee * BigInt(Math.round(margin * 100))) / 100n + 10_000n;
  sim.transactionData.setResourceFee(padded);
  sim.minResourceFee = padded.toString();
}

/** Thrown when a simulation or transaction fails; carries the RPC's own error text. */
export class ChainError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(detail ? `${message}: ${detail}` : message);
  }
}

export class Chain {
  readonly server: rpc.Server;
  readonly passphrase: string;
  private readonly readSource: string;

  constructor(
    readonly deployment: Deployment,
    opts: { readSource?: string; rpcUrl?: string } = {},
  ) {
    const url = opts.rpcUrl ?? deployment.rpcUrl;
    this.server = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
    this.passphrase = deployment.networkPassphrase;
    // Simulation needs an existing source account; the deployer always exists.
    this.readSource = opts.readSource ?? deployment.admin;
  }

  /** Call a read-only contract function by simulation. */
  async read(contract: string, method: string, args: xdr.ScVal[] = []): Promise<xdr.ScVal> {
    const tx = new TransactionBuilder(new Account(this.readSource, "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await withRetry(() => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) throw new ChainError(`${method} on ${contract} failed`, sim.error);
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) throw new ChainError(`${method} on ${contract} returned nothing`);
    return retval;
  }

  /**
   * Simulate, assemble, sign and submit one operation from `source`, then wait for the result.
   * Simulation runs with the operation's authorization entries in enforcing mode, so a custom
   * account's `__check_auth` (the vault's) runs and its storage reads land in the footprint.
   */
  async submit(source: string, signer: Signer, op: xdr.Operation, timeoutSecs = 60): Promise<SubmitResult> {
    const account = await withRetry(() => this.server.getAccount(source));
    const tx = new TransactionBuilder(account, { fee: (Number(BASE_FEE) * 10).toString(), networkPassphrase: this.passphrase })
      .addOperation(op)
      .setTimeout(timeoutSecs)
      .build();
    const sim = await withRetry(() => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) throw new ChainError("simulation failed", sim.error);
    withResourceMargin(sim as rpc.Api.SimulateTransactionSuccessResponse);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    const signed = TransactionBuilder.fromXDR(await signer(prepared.toXDR(), this.passphrase), this.passphrase);
    // Resending the identical signed envelope is idempotent (same hash, same sequence number), so a
    // dropped connection during send is retried by sending it again, never by rebuilding it.
    const hash = Buffer.from(signed.hash()).toString("hex");
    for (let attempt = 1; ; attempt++) {
      try {
        const sent = await this.server.sendTransaction(signed);
        if (sent.status === "ERROR") throw new ChainError("send ERROR", sent.errorResult?.toXDR("base64"));
        if (sent.status === "TRY_AGAIN_LATER") {
          if (attempt >= 5) throw new ChainError("send TRY_AGAIN_LATER");
          await sleep(2_000 * attempt);
          continue;
        }
        break; // PENDING or DUPLICATE
      } catch (e) {
        if (!isTransient(e) || attempt >= 5) throw e;
        await sleep(2_000 * attempt);
      }
    }
    const sent = { hash };
    const done = await withRetry(() => this.server.pollTransaction(hash, { attempts: 30 }), 5);
    if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      const result = (done as { resultXdr?: { toXDR(f: "base64"): string } }).resultXdr;
      throw new ChainError(`transaction ${sent.hash} ${done.status}`, result?.toXDR("base64"));
    }
    return { hash: sent.hash, returnValue: done.returnValue, ledger: done.ledger };
  }

  /** Invoke `contract.method(args)` from `source`. */
  invoke(source: string, signer: Signer, contract: string, method: string, args: xdr.ScVal[] = []): Promise<SubmitResult> {
    return this.submit(source, signer, new Contract(contract).call(method, ...args));
  }

  async latestLedger(): Promise<{ sequence: number; closeTime: number }> {
    const l = (await this.server.getLatestLedger()) as rpc.Api.GetLatestLedgerResponse & { closeTime?: string };
    return {
      sequence: l.sequence,
      closeTime: l.closeTime ? Number(l.closeTime) : Math.floor(Date.now() / 1000),
    };
  }

  // -- registries -----------------------------------------------------------------------

  async signalRecord(commitment: Uint8Array): Promise<SignalRecord | null> {
    const v = await this.read(this.deployment.contracts.signalRegistry, "get", [
      xdr.ScVal.scvBytes(Buffer.from(commitment)),
    ]);
    return signalRecordFromScVal(v);
  }

  /** The enclave's 65-byte secp256k1 encryption key from the Enclave Registry, or null. */
  async enclaveEncryptionKey(): Promise<Uint8Array | null> {
    const v = await this.read(this.deployment.contracts.enclaveRegistry, "encryption_key");
    if (v.type === "scvVoid") return null;
    return new Uint8Array(scValToNative(v) as Uint8Array);
  }

  async enclaveSigningKey(): Promise<Uint8Array | null> {
    const v = await this.read(this.deployment.contracts.enclaveRegistry, "signing_key");
    if (v.type === "scvVoid") return null;
    return new Uint8Array(scValToNative(v) as Uint8Array);
  }

  // -- vaults -----------------------------------------------------------------------------

  /** Every vault the factory deployed, from its on-chain index. */
  async vaults(): Promise<string[]> {
    const factory = this.deployment.contracts.vaultFactory;
    const count = Number(scValToNative(await this.read(factory, "vault_count")));
    const out: string[] = [];
    for (let start = 0; start < count; start += 50) {
      const page = scValToNative(
        await this.read(factory, "vaults", [xdr.ScVal.scvU32(start), xdr.ScVal.scvU32(50)]),
      ) as string[];
      out.push(...page);
    }
    return out;
  }

  async tokenBalance(token: string, owner: string): Promise<bigint> {
    return BigInt(scValToNative(await this.read(token, "balance", [new Address(owner).toScVal()])) as bigint);
  }

  async vaultState(vault: string): Promise<VaultState> {
    const [owner, config, policy, paused, recent] = await Promise.all([
      this.read(vault, "owner"),
      this.read(vault, "config"),
      this.read(vault, "policy"),
      this.read(vault, "paused"),
      this.read(vault, "recent_trades"),
    ]);
    const p = policyFromScVal(policy);
    const balances = await Promise.all(p.assets.map((a) => this.tokenBalance(a.token, vault)));
    return {
      vault,
      owner: scValToNative(owner) as string,
      config: vaultConfigFromScVal(config),
      policy: p,
      paused: scValToNative(paused) as boolean,
      balances: Object.fromEntries(p.assets.map((a, i) => [a.token, balances[i]!])),
      recent: tradeMarksFromScVal(recent),
    };
  }

  async isSignalUsed(vault: string, commitment: Uint8Array): Promise<boolean> {
    return scValToNative(
      await this.read(vault, "is_signal_used", [xdr.ScVal.scvBytes(Buffer.from(commitment))]),
    ) as boolean;
  }

  // -- venues and oracle --------------------------------------------------------------------

  /** Live state of an Aquarius pool (`fee_fraction` is in basis points). */
  async poolState(pool: string): Promise<PoolState> {
    const [tokens, reserves, fee] = await Promise.all([
      this.read(pool, "get_tokens"),
      this.read(pool, "get_reserves"),
      this.read(pool, "get_fee_fraction"),
    ]);
    return {
      pool,
      tokens: scValToNative(tokens) as string[],
      reserves: (scValToNative(reserves) as bigint[]).map(BigInt),
      feeBps: Number(scValToNative(fee)),
    };
  }

  /** Aquarius' own quote for a pool swap. */
  async estimateSwap(pool: string, inIdx: number, outIdx: number, amountIn: bigint): Promise<bigint> {
    return BigInt(
      scValToNative(
        await this.read(pool, "estimate_swap", [
          xdr.ScVal.scvU32(inIdx),
          xdr.ScVal.scvU32(outIdx),
          nativeToScVal(amountIn, { type: "u128" }),
        ]),
      ) as bigint,
    );
  }

  async oracleState(symbols: string[], oracle = this.deployment.oracle): Promise<OracleState> {
    const [decimals, ...prices] = await Promise.all([
      this.read(oracle, "decimals"),
      ...symbols.map((s) => this.read(oracle, "lastprice", [oracleOtherAsset(s)])),
    ]);
    const out: OracleState["prices"] = {};
    symbols.forEach((s, i) => {
      const p = priceFromScVal(prices[i]!);
      if (p) out[s] = p;
    });
    return { decimals: Number(scValToNative(decimals!)), prices: out };
  }
}

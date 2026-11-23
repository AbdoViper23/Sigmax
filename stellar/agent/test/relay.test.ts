import { authPayload, swapInvocation, TESTNET_PASSPHRASE, type Chain, type SwapPlan } from "@sigmax/stellar-client";
import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import type { AuthorizeInput, EnclaveClient } from "../src/enclave.js";
import { Relay } from "../src/relay.js";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POOL = "CDVB6O3WX24AAZ77SQRN52ABU4ECB66N36FG5BFVPTV54DPG3V6MOTOD";
const FOLLOWER_VAULT = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const OTHER_VAULT = "CAVLP5DH2GJPZMVO7IJY4CVOD5MWEFTJFVPD2YY2FQXOQHRGHK4D6HLP";
const LEADER = "GCJRIDGV4EFTNEDBF4VRJLLA66LSJ5KYLGAK5E5HIODF6MZRYEAJI44X";
const OTHER_LEADER = "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON";
const COMMITMENT = "ab".repeat(32);
const CIPHERTEXT = "04" + "11".repeat(64 + 16 + 40 + 32);

const plan: SwapPlan = { pool: POOL, tokenIn: USDC, tokenOut: XLM, inIdx: 0, outIdx: 1, amountIn: 500n, minOut: 3500n };

function fakeChain(opts: { commitAfterPolls?: number } = {}) {
  let polls = 0;
  const submit = vi.fn(async (_source: string, _signer: unknown, op: xdr.Operation) => ({ hash: `tx-${op.toXDR("hex").length}` }));
  const chain = {
    passphrase: TESTNET_PASSPHRASE,
    signalRecord: vi.fn(async () =>
      polls++ < (opts.commitAfterPolls ?? 0) ? null : { leader: LEADER, seq: 1, ledger: 10, timestamp: 1000n },
    ),
    vaults: vi.fn(async () => [FOLLOWER_VAULT, OTHER_VAULT]),
    vaultState: vi.fn(async (vault: string) => ({
      vault,
      owner: LEADER,
      config: { enclaveRegistry: POOL, signalRegistry: POOL, oracle: POOL },
      policy: {
        leader: vault === FOLLOWER_VAULT ? LEADER : OTHER_LEADER,
        assets: [
          { token: USDC, symbol: "USDC", decimals: 7 },
          { token: XLM, symbol: "XLM", decimals: 7 },
        ],
        venues: [{ pool: POOL, tokens: [USDC, XLM] }],
        maxTradeBps: 5000,
        maxTradeUsd: 1n,
        maxDailyUsd: 1n,
        maxDailyTrades: 5,
        maxSlippageBps: 250,
        maxSignalAgeSecs: 3600n,
        maxOracleAgeSecs: 900n,
        expiresAt: 2_000_000_000n,
      },
      paused: false,
      balances: { [USDC]: 1000n, [XLM]: 0n },
      recent: [],
    })),
    isSignalUsed: vi.fn(async () => false),
    poolState: vi.fn(async () => ({ pool: POOL, tokens: [USDC, XLM], reserves: [10n, 70n], feeBps: 100 })),
    oracleState: vi.fn(async () => ({ decimals: 14, prices: {} })),
    latestLedger: vi.fn(async () => ({ sequence: 500, closeTime: 1100 })),
    submit,
  };
  return chain;
}

function fakeEnclave(sign: (input: AuthorizeInput) => string) {
  return {
    submitSignal: vi.fn(async () => undefined),
    authorize: vi.fn(async (input: AuthorizeInput) => ({
      status: "signed" as const,
      plan: { pool: POOL, token_in: USDC, token_out: XLM, in_idx: 0, out_idx: 1, amount_in: "500", min_out: "3500", usd_value: "1" },
      proof: { signal: COMMITMENT, expires_at_ledger: 560, signature: "22".repeat(64) },
      auth_payload: sign(input),
    })),
  };
}

const honest = (input: AuthorizeInput) =>
  authPayload(TESTNET_PASSPHRASE, input.nonce, input.signatureExpirationLedger, swapInvocation(input.vault.vault, plan)).toString("hex");

async function settle(relay: Relay) {
  await vi.waitFor(
    () => {
      const status = relay.get(COMMITMENT)!.status;
      if (status === "waiting-for-commit" || status === "executing") throw new Error("pending");
    },
    { timeout: 5_000, interval: 10 },
  );
  return relay.get(COMMITMENT)!;
}

describe("relay", () => {
  it("waits for the commitment, then executes only vaults that follow the leader", async () => {
    const chain = fakeChain({ commitAfterPolls: 2 });
    const enclave = fakeEnclave(honest);
    const relay = new Relay(chain as unknown as Chain, enclave as unknown as EnclaveClient, { publicKey: LEADER, signer: async (x) => x }, { pollIntervalMs: 1, log: () => {} });

    relay.accept(COMMITMENT, CIPHERTEXT);
    const job = await settle(relay);

    expect(job.status).toBe("done");
    expect(chain.signalRecord).toHaveBeenCalledTimes(3);
    expect(enclave.submitSignal).toHaveBeenCalledWith(COMMITMENT, CIPHERTEXT, expect.objectContaining({ leader: LEADER }));
    expect(enclave.authorize).toHaveBeenCalledTimes(1);
    expect(job.results).toEqual([expect.objectContaining({ vault: FOLLOWER_VAULT, status: "submitted", amountIn: "500" })]);
    expect(chain.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses to submit when the enclave signed a different payload", async () => {
    const chain = fakeChain();
    const relay = new Relay(chain as unknown as Chain, fakeEnclave(() => "00".repeat(32)) as unknown as EnclaveClient, { publicKey: LEADER, signer: async (x) => x }, { log: () => {} });

    relay.accept(COMMITMENT, CIPHERTEXT);
    const job = await settle(relay);

    expect(job.results[0]).toEqual(expect.objectContaining({ status: "failed", reason: expect.stringMatching(/different payload/) }));
    expect(chain.submit).not.toHaveBeenCalled();
  });

  it("fails the job if the commitment never lands", async () => {
    const chain = fakeChain({ commitAfterPolls: 1_000 });
    const relay = new Relay(chain as unknown as Chain, fakeEnclave(honest) as unknown as EnclaveClient, { publicKey: LEADER, signer: async (x) => x }, { commitTimeoutMs: 20, pollIntervalMs: 1, log: () => {} });
    relay.accept(COMMITMENT, CIPHERTEXT);
    const job = await settle(relay);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/never appeared/);
  });

  it("validates input and de-duplicates by commitment", () => {
    const relay = new Relay(fakeChain({ commitAfterPolls: 1_000 }) as unknown as Chain, fakeEnclave(honest) as unknown as EnclaveClient, { publicKey: LEADER, signer: async (x) => x }, { commitTimeoutMs: 1, log: () => {} });
    expect(() => relay.accept("abc", CIPHERTEXT)).toThrow(/commitment/);
    expect(() => relay.accept(COMMITMENT, "zz")).toThrow(/ciphertext/);
    expect(relay.accept(COMMITMENT, CIPHERTEXT)).toBe(relay.accept(`0x${COMMITMENT.toUpperCase()}`, CIPHERTEXT));
  });
});

describe("transient network errors", () => {
  it("retries a dropped RPC call instead of failing the signal", async () => {
    const chain = fakeChain();
    let drops = 2;
    const real = chain.vaults;
    chain.vaults = vi.fn(async () => {
      if (drops-- > 0) throw new TypeError("fetch failed");
      return real();
    });
    const relay = new Relay(chain as unknown as Chain, fakeEnclave(honest) as unknown as EnclaveClient, { publicKey: LEADER, signer: async (x) => x }, { log: () => {} });
    relay.accept(COMMITMENT, CIPHERTEXT);
    const job = await settle(relay);
    expect(job.status).toBe("done");
    expect(chain.vaults).toHaveBeenCalledTimes(3);
  });

  it("does not retry contract or simulation errors", async () => {
    const chain = fakeChain();
    chain.vaults = vi.fn(async () => {
      throw new Error("simulation failed: HostError");
    });
    const relay = new Relay(chain as unknown as Chain, fakeEnclave(honest) as unknown as EnclaveClient, { publicKey: LEADER, signer: async (x) => x }, { log: () => {} });
    relay.accept(COMMITMENT, CIPHERTEXT);
    const job = await settle(relay);
    expect(job.status).toBe("failed");
    expect(chain.vaults).toHaveBeenCalledTimes(1);
  });

  it("re-runs a failed signal when its commitment is posted again", async () => {
    const chain = fakeChain();
    let down = true;
    const real = chain.vaults;
    chain.vaults = vi.fn(async () => {
      if (down) throw new Error("rpc down hard");
      return real();
    });
    const relay = new Relay(chain as unknown as Chain, fakeEnclave(honest) as unknown as EnclaveClient, { publicKey: LEADER, signer: async (x) => x }, { log: () => {} });
    relay.accept(COMMITMENT, CIPHERTEXT);
    expect((await settle(relay)).status).toBe("failed");
    down = false;
    relay.accept(COMMITMENT, CIPHERTEXT);
    const job = await settle(relay);
    expect(job.status).toBe("done");
    expect(job.results).toHaveLength(1);
  });
});

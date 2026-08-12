import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import {
  handleSignalExecute,
  setSigmaxDeps,
  resetSigmaxState,
  reportSigmaxState,
  signalIdToBytes32,
  type SigmaxDeps,
} from "../app/sigmax/handler.js";
import { SIGNAL_ABI, decodeSignal } from "../app/sigmax/signal.js";
import { decodeSwapAuths } from "../app/sigmax/process-signal.js";
import type { SigmaxChainConfig } from "../app/sigmax/chain.js";
import { hexToBytes, bytesToHex } from "../base/encoding.js";

const TOKEN = "0x0b6A3645c240605887a5532109323A3E12273dc7"; // FXRP
const QUOTE = "0x1111111111111111111111111111111111111111"; // USDT0 stand-in
const ROUTER = "0x8D29b61C41CF318d15d031BE2928F79630e068e6"; // BlazeSwap
const STRATEGY = "0x2222222222222222222222222222222222222222";
const VAULT_A = "0x3333333333333333333333333333333333333333";
const VAULT_B = "0x4444444444444444444444444444444444444444";

const NOW = 1_800_000_000;
const TAKE_PROFIT = "999888777666";
const STOP_LOSS = "111222333444";

function encodeTestSignal(over: Partial<Record<string, unknown>> = {}): Hex {
  const s = {
    version: 1,
    signalId: "0x0123456789abcdef0123456789abcdef",
    strategyId: STRATEGY,
    chainId: 114,
    venue: 2, // flare
    action: 1, // EXIT: sell token into quote — uses the FTSO price directly
    token: TOKEN,
    quoteToken: QUOTE,
    sizeBps: 500,
    maxEntryPrice: 0n,
    takeProfitPrice: BigInt(TAKE_PROFIT),
    stopLossPrice: BigInt(STOP_LOSS),
    issuedAt: BigInt(NOW - 60),
    expiresAt: BigInt(NOW + 600),
    ...over,
  };
  return encodeAbiParameters(SIGNAL_ABI, [
    s.version as number,
    s.signalId as Hex,
    s.strategyId as Hex,
    s.chainId as number,
    s.venue as number,
    s.action as number,
    s.token as string,
    s.quoteToken as string,
    s.sizeBps as number,
    s.maxEntryPrice as bigint,
    s.takeProfitPrice as bigint,
    s.stopLossPrice as bigint,
    s.issuedAt as bigint,
    s.expiresAt as bigint,
  ]);
}

const config: SigmaxChainConfig = {
  rpcUrl: "http://unused",
  chainId: 114n,
  subscriptionRegistry: "0x5555555555555555555555555555555555555555",
  vaultFactory: "0x6666666666666666666666666666666666666666",
  router: ROUTER,
  ftsoV2: "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d",
  feedId: "0x015852502f55534400000000000000000000000000",
  slippageBps: 100,
  deadlineSecs: 600,
  subsFromBlock: 0n,
  // The mocked head is 1000, so one window covers the whole range in a single getLogs call.
  logWindow: 1_000n,
  hlTestnet: true,
  hlPerTradeCapUnits: 0n, // Hyperliquid venue disabled for the Flare-path tests
  hlMaxDeviationBps: 500,
};

/**
 * Fake Coston2: two subscribed followers (one inactive), FXRP price 1.104445 USD (6 decimals),
 * both tokens 6-decimal, vault caps well above the sized amounts.
 */
function makeClient(over: { balances?: Record<string, bigint>; active?: Record<string, boolean> } = {}) {
  const balances = over.balances ?? { [VAULT_A]: 1_000_000_000n, [VAULT_B]: 500_000_000n };
  const active = over.active ?? { [`${VAULT_A}`]: true, [`${VAULT_B}`]: true };
  const subscriberOf: Record<string, string> = { subA: VAULT_A, subB: VAULT_B };

  return {
    // The subscriber scan is windowed against the chain head (the public RPC caps eth_getLogs at 30
    // blocks), so it reads the head first. One window keeps these tests focused on the handler.
    getBlockNumber: vi.fn(async () => 1_000n),
    getLogs: vi.fn(async () => [
      { args: { subscriber: "subA" } },
      { args: { subscriber: "subB" } },
      { args: { subscriber: "subA" } }, // duplicate — must be deduped
    ]),
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case "getFeedById":
          return [1_104_445n, 6, BigInt(NOW)];
        case "decimals":
          return 6;
        case "isActive":
          return active[subscriberOf[args![0] as string]!] ?? false;
        case "vaultOf":
          return subscriberOf[args![0] as string] ?? "0x0000000000000000000000000000000000000000";
        case "balanceOf":
          return balances[args![0] as string] ?? 0n;
        case "perTradeCap":
          return 10_000_000_000n;
        default:
          throw new Error(`unexpected read: ${functionName}`);
      }
    }),
  };
}

function makeDeps(over: Partial<SigmaxDeps> = {}, clientOver = {}): SigmaxDeps {
  return {
    decrypt: async (ct: Uint8Array) => ct, // identity: ciphertext == plaintext in tests
    config,
    client: makeClient(clientOver) as unknown as SigmaxDeps["client"],
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  resetSigmaxState();
  setSigmaxDeps(makeDeps());
});

afterEach(() => {
  setSigmaxDeps(null);
  vi.restoreAllMocks();
});

describe("SIGNAL/EXECUTE handler", () => {
  it("issues one SwapAuth per active follower with FTSO-bounded minOut", async () => {
    const [data, status, err] = await handleSignalExecute(encodeTestSignal());

    expect(err).toBeNull();
    expect(status).toBe(1);
    const auths = decodeSwapAuths(data as Hex);
    expect(auths).toHaveLength(2);

    const a = auths[0]!;
    expect(a.vault).toBe(VAULT_A);
    expect(a.tokenIn).toBe(TOKEN); // EXIT sells the target token
    expect(a.tokenOut).toBe(QUOTE);
    expect(a.router).toBe(ROUTER);
    expect(a.chainId).toBe(114n);
    expect(a.deadline).toBe(BigInt(NOW + 600));
    expect(a.signalId).toBe(signalIdToBytes32("01234567-89ab-cdef-0123-456789abcdef"));

    // 1_000_000_000 * 500bps = 50_000_000 FXRP units (6dp)
    expect(a.amountIn).toBe(50_000_000n);
    // 50 FXRP * 1.104445 USD = 55.22225 USDT0, minus 1% slippage
    expect(a.minOut).toBe((50_000_000n * 1_104_445n * 10n ** 6n) / (10n ** 6n * 10n ** 6n) * 9900n / 10000n);
    expect(a.swapData.startsWith("0x38ed1739")).toBe(true); // swapExactTokensForTokens selector
  });

  it("skips inactive subscribers", async () => {
    setSigmaxDeps(makeDeps({}, { active: { [VAULT_A]: true, [VAULT_B]: false } }));

    const [data, status] = await handleSignalExecute(encodeTestSignal());

    expect(status).toBe(1);
    const auths = decodeSwapAuths(data as Hex);
    expect(auths).toHaveLength(1);
    expect(auths[0]!.vault).toBe(VAULT_A);
  });

  it("skips followers whose sized amount rounds to zero", async () => {
    setSigmaxDeps(makeDeps({}, { balances: { [VAULT_A]: 1_000_000_000n, [VAULT_B]: 0n } }));

    const [data] = await handleSignalExecute(encodeTestSignal());

    expect(decodeSwapAuths(data as Hex)).toHaveLength(1);
  });

  it("inverts the FTSO price for ENTRY (quote → token)", async () => {
    const [data, status] = await handleSignalExecute(encodeTestSignal({ action: 0 }));

    expect(status).toBe(1);
    const a = decodeSwapAuths(data as Hex)[0]!;
    expect(a.tokenIn).toBe(QUOTE);
    expect(a.tokenOut).toBe(TOKEN);
    // inverted price: 10^12 / 1_104_445 ≈ 905_432 (0.905432 XRP per USD)
    const inverted = 10n ** 12n / 1_104_445n;
    expect(a.minOut).toBe((a.amountIn * inverted * 10n ** 6n) / (10n ** 6n * 10n ** 6n) * 9900n / 10000n);
  });

  it("rejects an expired signal", async () => {
    const [data, status, err] = await handleSignalExecute(encodeTestSignal({ expiresAt: BigInt(NOW - 1) }));

    expect(data).toBeNull();
    expect(status).toBe(0);
    expect(err).toMatch(/expired/);
  });

  it("rejects a signal for another chain", async () => {
    const [, status, err] = await handleSignalExecute(encodeTestSignal({ chainId: 42161 }));

    expect(status).toBe(0);
    expect(err).toMatch(/chainId/);
  });

  /** Hyperliquid (venue 1) is now supported and covered in hl-handler.test.ts; arbitrum never was. */
  it("rejects a venue this extension does not execute", async () => {
    const [, status, err] = await handleSignalExecute(encodeTestSignal({ venue: 0 })); // arbitrum

    expect(status).toBe(0);
    expect(err).toMatch(/venue/);
  });

  it("rejects an empty message and undecryptable ciphertext", async () => {
    expect((await handleSignalExecute(""))[1]).toBe(0);

    setSigmaxDeps(makeDeps({ decrypt: async () => { throw new Error("no key"); } }));
    const [, status, err] = await handleSignalExecute(encodeTestSignal());
    expect(status).toBe(0);
    expect(err).toMatch(/decryption failed/);
  });

  it("rejects a malformed plaintext without leaking its bytes", async () => {
    setSigmaxDeps(makeDeps({ decrypt: async () => hexToBytes("0xdeadbeef") }));

    const [, status, err] = await handleSignalExecute("0xdeadbeef");

    expect(status).toBe(0);
    expect(err).toMatch(/invalid signal/);
  });

  it("never logs the strategy, take-profit, or stop-loss", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const [data] = await handleSignalExecute(encodeTestSignal());

    const written = [...log.mock.calls, ...errLog.mock.calls].flat().join(" ");
    expect(written).not.toContain(TAKE_PROFIT);
    expect(written).not.toContain(STOP_LOSS);
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain(TOKEN.toLowerCase());

    // The signed result carries the swap instructions, never the TP/SL levels.
    expect((data as string).toLowerCase()).not.toContain(BigInt(TAKE_PROFIT).toString(16));
    expect((data as string).toLowerCase()).not.toContain(BigInt(STOP_LOSS).toString(16));
  });

  it("keeps TP/SL out of the reported state", async () => {
    await handleSignalExecute(encodeTestSignal());
    await handleSignalExecute(encodeTestSignal({ chainId: 1 }));

    expect(reportSigmaxState()).toEqual({
      signalsProcessed: 1,
      signalsRejected: 1,
      authsIssued: 2,
      hlOrdersFilled: 0,
      duplicatesRejected: 0,
    });
    expect(JSON.stringify(reportSigmaxState())).not.toContain(TAKE_PROFIT);
  });

  it("round-trips the vendored signal codec against the shared ABI layout", () => {
    const s = decodeSignal(encodeTestSignal());

    expect(s.venue).toBe("flare");
    expect(s.action).toBe("EXIT");
    expect(s.strategyId).toBe(STRATEGY);
    expect(s.sizeBps).toBe(500);
    expect(s.takeProfitPrice).toBe(TAKE_PROFIT);
  });

  it("returns an empty signed batch when the control plane is not yet deployed", async () => {
    setSigmaxDeps(makeDeps({ config: { ...config, subscriptionRegistry: undefined, vaultFactory: undefined } }));

    const [data, status] = await handleSignalExecute(encodeTestSignal());

    expect(status).toBe(1);
    expect(decodeSwapAuths(data as Hex)).toHaveLength(0);
  });
});

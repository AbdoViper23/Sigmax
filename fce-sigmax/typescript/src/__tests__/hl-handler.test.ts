/**
 * The Hyperliquid venue, end to end inside the enclave — with the exchange and the chain faked, so
 * the whole path (decrypt → subscribers → size → sign → send → receipt) runs offline.
 *
 * The assertions that matter most are the negative ones. On this venue the enclave's own code is what
 * enforces the bounds — there is no vault contract to reject a bad order — so "refuses to trade when
 * unconfigured" and "never emits the strategy" are not nice-to-haves, they are the guarantee.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  handleSignalExecute,
  setSigmaxDeps,
  resetSigmaxState,
  reportSigmaxState,
  type SigmaxDeps,
} from "../app/sigmax/handler.js";
import { SIGNAL_ABI } from "../app/sigmax/signal.js";
import { HL_RECEIPT_ABI } from "../app/sigmax/hl/execute.js";
import { deriveAgentAddress, masterPublicKey } from "../app/sigmax/hl/agent-key.js";
import { createL1ActionHash } from "../app/sigmax/hl/sign.js";
import type { HlTransport } from "../app/sigmax/hl/api.js";
import type { SigmaxChainConfig } from "../app/sigmax/chain.js";
import { hexToBytes, bytesToHex } from "../base/encoding.js";

const STRATEGY = "0x2222222222222222222222222222222222222222";
const FOLLOWER_A = "0x3333333333333333333333333333333333333333";
const FOLLOWER_B = "0x4444444444444444444444444444444444444444";
const MASTER_KEY = hexToBytes("0x2222222222222222222222222222222222222222222222222222222222222222");

const NOW = 1_800_000_000;
const NONCE = 1_800_000_000_000;
const TAKE_PROFIT = "999888777666";
const STOP_LOSS = "111222333444";

/** A Hyperliquid signal: coins are SYMBOLS, not addresses (venue 1 = hyperliquid). */
function encodeHlSignal(over: Partial<Record<string, unknown>> = {}): Hex {
  const s = {
    version: 1,
    signalId: "0x0123456789abcdef0123456789abcdef",
    strategyId: STRATEGY,
    chainId: 114,
    venue: 1,
    action: 0, // ENTRY: buy HYPE with USDC
    token: "HYPE",
    quoteToken: "USDC",
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
  router: "0x8D29b61C41CF318d15d031BE2928F79630e068e6",
  ftsoV2: "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d",
  feedId: "0x015852502f55534400000000000000000000000000",
  slippageBps: 100,
  deadlineSecs: 600,
  subsFromBlock: 0n,
  logWindow: 1_000n,
  hlTestnet: true,
  hlPerTradeCapUnits: 10_000n * 100_000_000n, // $10,000 — above the sized amounts here
  hlMaxDeviationBps: 500,
};

/** Fake Coston2: two subscribers, both active unless told otherwise. */
function makeClient(over: { active?: Record<string, boolean> } = {}) {
  const active = over.active ?? { [FOLLOWER_A]: true, [FOLLOWER_B]: true };
  return {
    getBlockNumber: vi.fn(async () => 1_000n),
    getLogs: vi.fn(async () => [
      { args: { subscriber: FOLLOWER_A } },
      { args: { subscriber: FOLLOWER_B } },
    ]),
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "isActive") return active[args![0] as string] ?? false;
      throw new Error(`unexpected call ${functionName}`);
    }),
  } as unknown as SigmaxDeps["client"];
}

interface FakeExchange {
  transport: HlTransport;
  /** Every `/exchange` body sent, in order — the signed orders. */
  sent: Array<{ action: Record<string, unknown>; nonce: number; signature: { r: Hex; s: Hex; v: number } }>;
}

/** Fake Hyperliquid: HYPE/USDC at 20.0, both followers holding USDC, every IOC filling. */
function makeExchange(
  over: { balances?: Record<string, number>; fill?: boolean; askPx?: string } = {},
): FakeExchange {
  const balances = over.balances ?? { [FOLLOWER_A]: 1_000, [FOLLOWER_B]: 400 };
  const sent: FakeExchange["sent"] = [];

  const transport: HlTransport = {
    info: vi.fn(async (payload: unknown) => {
      const p = payload as { type: string; user?: string; coin?: string };
      switch (p.type) {
        case "spotMeta":
          return {
            tokens: [
              { name: "USDC", szDecimals: 2, weiDecimals: 8, index: 0 },
              { name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 1 },
            ],
            universe: [{ name: "HYPE/USDC", tokens: [1, 0], index: 107 }],
          };
        case "l2Book":
          return { levels: [[{ px: "19.9" }], [{ px: over.askPx ?? "20.0" }]] };
        case "allMids":
          return { "@107": "19.95" };
        case "spotClearinghouseState":
          return { balances: [{ coin: "USDC", total: String(balances[p.user!] ?? 0), hold: "0" }] };
        default:
          throw new Error(`unexpected info call ${p.type}`);
      }
    }),
    exchange: vi.fn(async (body: unknown) => {
      sent.push(body as FakeExchange["sent"][number]);
      return over.fill === false
        ? { response: { data: { statuses: [{ resting: { oid: 1 } }] } } }
        : { response: { data: { statuses: [{ filled: { totalSz: "2.5", avgPx: "20.0", oid: 555 } }] } } };
    }),
  };

  return { transport, sent };
}

function makeDeps(over: Partial<SigmaxDeps> = {}): SigmaxDeps {
  return {
    // The ciphertext IS the plaintext here — encryption is the node's job, not the handler's.
    decrypt: async (c) => c,
    config,
    client: makeClient(),
    now: () => NOW,
    hlNonce: () => NONCE,
    getMasterKey: () => MASTER_KEY,
    ...over,
  };
}

function decodeReceipts(data: string) {
  return decodeAbiParameters(HL_RECEIPT_ABI, data as Hex)[0];
}

beforeEach(() => resetSigmaxState());
afterEach(() => {
  setSigmaxDeps(null);
  vi.restoreAllMocks();
});

describe("hyperliquid venue", () => {
  it("places one signed order per active subscriber and returns receipts", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    const [data, status, err] = await handleSignalExecute(encodeHlSignal());

    expect(err).toBeNull();
    expect(status).toBe(1);
    expect(exchange.sent).toHaveLength(2);

    const receipts = decodeReceipts(data!);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ follower: FOLLOWER_A, oid: 555n, status: 1 });
    expect(receipts[1]).toMatchObject({ follower: FOLLOWER_B, oid: 555n, status: 1 });
  });

  it("sizes each follower against their own balance, capped by sizeBps", async () => {
    const exchange = makeExchange({ balances: { [FOLLOWER_A]: 1_000, [FOLLOWER_B]: 400 } });
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    await handleSignalExecute(encodeHlSignal());

    // 5% of $1000 = $50 at a 20.2 marketable price ≈ 2.47 HYPE; 5% of $400 = $20 ≈ 0.99 HYPE.
    const sizes = exchange.sent.map((s) => Number((s.action.orders as Array<{ s: string }>)[0]!.s));
    expect(sizes[0]).toBeCloseTo(2.47, 2);
    expect(sizes[1]).toBeCloseTo(0.99, 2);
  });

  /** Each follower must be signed for by THEIR OWN derived agent — a shared signer shares a nonce tracker. */
  it("signs each follower's order with that follower's own derived agent key", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    await handleSignalExecute(encodeHlSignal());

    const masterPub = masterPublicKey(MASTER_KEY);
    for (const [i, follower] of [FOLLOWER_A, FOLLOWER_B].entries()) {
      const { action, nonce, signature } = exchange.sent[i]!;
      const digest = {
        domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO } as const,
        types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
        primaryType: "Agent" as const,
        message: { source: "b", connectionId: createL1ActionHash({ action: action as never, nonce }) },
      };
      const recovered = await recoverTypedDataAddress(digest, signature);
      expect(recovered).toBe(deriveAgentAddress(masterPub, follower));
    }
  });

  it("only trades for subscribers whose subscription is active", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(
      makeDeps({
        hlTransport: exchange.transport,
        client: makeClient({ active: { [FOLLOWER_A]: true, [FOLLOWER_B]: false } }),
      }),
    );

    const [data] = await handleSignalExecute(encodeHlSignal());

    expect(exchange.sent).toHaveLength(1);
    expect(decodeReceipts(data!)).toHaveLength(1);
  });

  it("skips a follower with no balance instead of failing the whole signal", async () => {
    const exchange = makeExchange({ balances: { [FOLLOWER_A]: 1_000, [FOLLOWER_B]: 0 } });
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    const [data, status] = await handleSignalExecute(encodeHlSignal());

    expect(status).toBe(1);
    expect(exchange.sent).toHaveLength(1);
    const receipts = decodeReceipts(data!);
    expect(receipts[1]).toMatchObject({ follower: FOLLOWER_B, oid: 0n, status: 0 });
  });

  it("reports an unfilled IOC as a skip, not a failure", async () => {
    const exchange = makeExchange({ fill: false });
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    const [data, status] = await handleSignalExecute(encodeHlSignal());

    expect(status).toBe(1);
    expect(decodeReceipts(data!).every((r) => r.status === 0)).toBe(true);
  });

  it("isolates one follower's exchange error from the others", async () => {
    const exchange = makeExchange();
    let call = 0;
    exchange.transport.exchange = vi.fn(async () => {
      if (call++ === 0) throw new Error("hyperliquid: price 20.2 size 2.47 rejected");
      return { response: { data: { statuses: [{ filled: { totalSz: "1", avgPx: "20", oid: 777 } }] } } };
    });
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    const [data, status] = await handleSignalExecute(encodeHlSignal());

    expect(status).toBe(1);
    const receipts = decodeReceipts(data!);
    expect(receipts[0]).toMatchObject({ status: 0 });
    expect(receipts[1]).toMatchObject({ oid: 777n, status: 1 });
  });

  it("refuses to trade when no agent key has been injected", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport, getMasterKey: () => null }));

    const [data, status, err] = await handleSignalExecute(encodeHlSignal());

    expect(status).toBe(0);
    expect(data).toBeNull();
    expect(err).toMatch(/agent key/);
    expect(exchange.sent).toHaveLength(0);
  });

  /** A missing cap must fail closed. On this venue there is no contract to catch an unbounded trade. */
  it("refuses to trade when the per-trade cap is unconfigured", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(
      makeDeps({ hlTransport: exchange.transport, config: { ...config, hlPerTradeCapUnits: 0n } }),
    );

    const [, status, err] = await handleSignalExecute(encodeHlSignal());

    expect(status).toBe(0);
    expect(err).toMatch(/cap/);
    expect(exchange.sent).toHaveLength(0);
  });

  /**
   * FCC routes each instruction to a random registered machine and the publish path retries when it
   * hits a stale one, so the same signal genuinely can arrive twice. On Flare a replayed authorization
   * is refused by the vault; here a replay would be a second real market order.
   */
  it("refuses to execute the same signal twice", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    const signal = encodeHlSignal();
    const [, firstStatus] = await handleSignalExecute(signal);
    const [data, secondStatus, err] = await handleSignalExecute(signal);

    expect(firstStatus).toBe(1);
    expect(secondStatus).toBe(0);
    expect(data).toBeNull();
    expect(err).toMatch(/already executed/);
    // Two followers on the first pass, and nothing added by the replay.
    expect(exchange.sent).toHaveLength(2);
    expect(reportSigmaxState()).toMatchObject({ duplicatesRejected: 1 });
  });

  /** The guard is per signal, not a global latch — a genuinely new signal must still trade. */
  it("still executes a different signal after one has been executed", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    await handleSignalExecute(encodeHlSignal());
    const [, status] = await handleSignalExecute(
      encodeHlSignal({ signalId: "0xfedcba98765432100123456789abcdef" }),
    );

    expect(status).toBe(1);
    expect(exchange.sent).toHaveLength(4);
  });

  it("rejects an expired signal before contacting the exchange", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    const [, status, err] = await handleSignalExecute(encodeHlSignal({ expiresAt: BigInt(NOW - 1) }));

    expect(status).toBe(0);
    expect(err).toMatch(/expired/);
    expect(exchange.sent).toHaveLength(0);
  });

  it("fails cleanly on a coin the exchange does not list", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    const [, status, err] = await handleSignalExecute(encodeHlSignal({ token: "NOTACOIN" }));

    expect(status).toBe(0);
    expect(err).toMatch(/hyperliquid execution failed/);
    expect(exchange.sent).toHaveLength(0);
  });

  it("counts filled orders in the reported state without exposing the strategy", async () => {
    const exchange = makeExchange();
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    await handleSignalExecute(encodeHlSignal());

    expect(reportSigmaxState()).toMatchObject({ signalsProcessed: 1, hlOrdersFilled: 2 });
    const reported = JSON.stringify(reportSigmaxState());
    expect(reported).not.toContain(TAKE_PROFIT);
    expect(reported).not.toContain(STOP_LOSS);
    expect(reported).not.toContain("HYPE");
  });

  /**
   * The confidentiality gate. The take-profit and stop-loss must not reach a log line, an error
   * string, or the returned bytes — the same standard the Flare path is held to. The market and size
   * are excluded from logs too: they are only public once the order itself is public.
   */
  it("never emits the take-profit, stop-loss, or market", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));

    const exchange = makeExchange();
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    const [data, , err] = await handleSignalExecute(encodeHlSignal());

    const surface = `${logged.join("\n")}\n${data}\n${err}`;
    expect(surface).not.toContain(TAKE_PROFIT);
    expect(surface).not.toContain(STOP_LOSS);
    expect(surface).not.toContain("HYPE");
    // The signal id is already public (it is committed on-chain), so it may appear.
    expect(logged.join("\n")).toContain("hyperliquid");
  });

  /** An exchange rejection can quote the order back at us; that string must never escape. */
  it("does not leak an exchange error message into the result", async () => {
    const exchange = makeExchange();
    exchange.transport.info = vi.fn(async () => {
      throw new Error(`rejected order for HYPE at tp=${TAKE_PROFIT}`);
    });
    setSigmaxDeps(makeDeps({ hlTransport: exchange.transport }));

    const [, status, err] = await handleSignalExecute(encodeHlSignal());

    expect(status).toBe(0);
    expect(err).not.toContain(TAKE_PROFIT);
    expect(err).not.toContain("HYPE");
  });
});

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Recover the signer of an EIP-712 payload, to prove which agent key signed each order. */
async function recoverTypedDataAddress(
  typedData: Parameters<typeof import("viem").hashTypedData>[0],
  signature: { r: Hex; s: Hex; v: number },
): Promise<string> {
  const { hashTypedData, recoverAddress } = await import("viem");
  return recoverAddress({
    hash: hashTypedData(typedData),
    signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) },
  });
}

/** Guard: the fixture key must actually be a valid signer, or the recovery assertions prove nothing. */
it("the fixture master key is a usable signing key", () => {
  expect(privateKeyToAccount(bytesToHex(MASTER_KEY)).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
});

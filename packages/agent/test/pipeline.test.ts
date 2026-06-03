import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { MockCdr } from "@sigmax/cdr";
import { SignalPipeline } from "../src/pipeline.js";
import { PositionStore } from "../src/state.js";
import { AgentLogger } from "../src/logger.js";
import { FakeExecutor, FakeSubscribers, makeSignal } from "./helpers.js";

const A = "0x00000000000000000000000000000000000000aa" as Hex;
const B = "0x00000000000000000000000000000000000000bb" as Hex;

function deps(opts: { executor: FakeExecutor; subscribers: FakeSubscribers; store?: PositionStore }) {
  return {
    cdr: new MockCdr({ hasLicense: true }),
    executorFor: () => opts.executor,
    subscribers: opts.subscribers,
    store: opts.store ?? new PositionStore(),
    logger: new AgentLogger(() => {}),
    defaultSlippageBps: 100,
  };
}

async function publish(cdr: MockCdr, signal = makeSignal()) {
  const { uuid } = await cdr.publishSignal(signal);
  return uuid;
}

describe("SignalPipeline — ENTRY eligibility", () => {
  it("executes only for active followers; skips inactive", async () => {
    const executor = new FakeExecutor();
    const subscribers = new FakeSubscribers([A, B], new Set([A.toLowerCase()])); // only A active
    const d = deps({ executor, subscribers });
    const uuid = await publish(d.cdr);

    await new SignalPipeline(d).processSignal(uuid);

    expect(executor.swaps).toHaveLength(1);
    expect(executor.swaps[0]?.vault.toLowerCase()).toEqual(A.toLowerCase());
    expect(d.store.all()).toHaveLength(1);
  });

  it("opens no position for any follower when none are active", async () => {
    const executor = new FakeExecutor();
    const subscribers = new FakeSubscribers([A, B], new Set()); // none active
    const d = deps({ executor, subscribers });
    const uuid = await publish(d.cdr);

    await new SignalPipeline(d).processSignal(uuid);

    expect(executor.swaps).toHaveLength(0);
    expect(d.store.all()).toHaveLength(0);
  });

  it("skips a stale ENTRY", async () => {
    const executor = new FakeExecutor();
    const subscribers = new FakeSubscribers([A]);
    const d = { ...deps({ executor, subscribers }), now: () => 2_000_000_000 }; // past expiresAt
    const uuid = await publish(d.cdr, makeSignal({ expiresAt: 1_900_000_000 }));

    await new SignalPipeline(d).processSignal(uuid);
    expect(executor.swaps).toHaveLength(0);
  });
});

describe("SignalPipeline — idempotency", () => {
  it("executes a signalId at most once even if processed twice", async () => {
    const executor = new FakeExecutor();
    const subscribers = new FakeSubscribers([A]);
    const d = deps({ executor, subscribers });
    const uuid = await publish(d.cdr);
    const pipeline = new SignalPipeline(d);

    await pipeline.processSignal(uuid);
    await pipeline.processSignal(uuid); // duplicate — must dedupe

    expect(executor.swaps).toHaveLength(1);
  });
});

describe("SignalPipeline — per-follower idempotency", () => {
  it("does not re-enter a follower that already has a position for this signal (crash-restart guard)", async () => {
    const executor = new FakeExecutor();
    const subscribers = new FakeSubscribers([A]);
    const store = new PositionStore();
    const d = deps({ executor, subscribers, store });
    const uuid = await publish(d.cdr);

    // Simulate a restart where A's position was restored but the signal was not yet marked processed.
    const vault = await executor.vaultOf(A);
    store.open({
      signalId: "11111111-2222-3333-4444-555555555555",
      uuid,
      venue: "arbitrum",
      follower: A,
      vault,
      token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Hex,
      quoteToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Hex,
      amountIn: 1n,
      received: 1n,
      entryTxHash: ("0x" + "00".repeat(32)) as Hex,
      takeProfitPrice: 0n,
      stopLossPrice: 0n,
    });

    await new SignalPipeline(d).processSignal(uuid);
    expect(executor.swaps).toHaveLength(0); // already-open → no second entry
  });
});

describe("SignalPipeline — venue routing", () => {
  it("routes a signal to the executor for its venue", async () => {
    const arb = new FakeExecutor();
    const hl = new FakeExecutor();
    const d = {
      cdr: new MockCdr({ hasLicense: true }),
      executorFor: (v: "arbitrum" | "hyperliquid") => (v === "hyperliquid" ? hl : arb),
      subscribers: new FakeSubscribers([A]),
      store: new PositionStore(),
      logger: new AgentLogger(() => {}),
      defaultSlippageBps: 100,
    };
    // An HL signal carries a coin symbol; route must hit the HL executor only.
    const uuid = await publish(d.cdr, makeSignal({ venue: "hyperliquid", token: "HYPE", quoteToken: "USDC" }));

    await new SignalPipeline(d).processSignal(uuid);

    expect(hl.swaps).toHaveLength(1);
    expect(arb.swaps).toHaveLength(0);
    expect(d.store.all()[0]?.venue).toBe("hyperliquid");
  });

  it("skips (does not crash) when the signal's venue isn't configured", async () => {
    const arb = new FakeExecutor();
    const d = {
      cdr: new MockCdr({ hasLicense: true }),
      executorFor: (v: "arbitrum" | "hyperliquid") => {
        if (v !== "arbitrum") throw new Error(`venue_not_configured: ${v}`);
        return arb;
      },
      subscribers: new FakeSubscribers([A]),
      store: new PositionStore(),
      logger: new AgentLogger(() => {}),
      defaultSlippageBps: 100,
    };
    const uuid = await publish(d.cdr, makeSignal({ venue: "hyperliquid", token: "HYPE", quoteToken: "USDC" }));

    await expect(new SignalPipeline(d).processSignal(uuid)).resolves.toBeUndefined();
    expect(arb.swaps).toHaveLength(0);
    expect(d.store.all()).toHaveLength(0);
  });
});

describe("SignalPipeline — per-follower error isolation", () => {
  it("one follower's revert does not block the others", async () => {
    // vault == follower (default vaultFor); throw only for A's vault.
    const executor = new FakeExecutor({ throwForVault: (v) => v.toLowerCase() === A.toLowerCase() });
    const subscribers = new FakeSubscribers([A, B]);
    const d = deps({ executor, subscribers });
    const uuid = await publish(d.cdr);

    await expect(new SignalPipeline(d).processSignal(uuid)).resolves.toBeUndefined();

    expect(executor.swaps).toHaveLength(1);
    expect(executor.swaps[0]?.vault.toLowerCase()).toEqual(B.toLowerCase());
  });
});

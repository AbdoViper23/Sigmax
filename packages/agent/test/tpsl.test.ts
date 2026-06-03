import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { TpSlMonitor, crossReason } from "../src/tpsl.js";
import { PositionStore } from "../src/state.js";
import { AgentLogger } from "../src/logger.js";
import type { OpenPosition } from "../src/ports.js";
import { FakeExecutor, FakePrice, WETH, USDC } from "./helpers.js";

const FOLLOWER = "0x00000000000000000000000000000000000000aa" as Hex;
const VAULT = "0x00000000000000000000000000000000000000a1" as Hex;

function position(over: Partial<OpenPosition> = {}): OpenPosition {
  return {
    signalId: "s1",
    uuid: 1,
    venue: "arbitrum",
    follower: FOLLOWER,
    vault: VAULT,
    token: WETH,
    quoteToken: USDC,
    amountIn: 500_000_000n,
    received: 250_000_000_000_000_000n, // 0.25 WETH
    entryTxHash: ("0x" + "00".repeat(32)) as Hex,
    takeProfitPrice: 300_000_000_000n, // $3000
    stopLossPrice: 250_000_000_000n, // $2500
    ...over,
  };
}

describe("crossReason", () => {
  it("fires TP at/above the take-profit", () => {
    expect(crossReason(position(), 300_000_000_000n)).toEqual("TP");
    expect(crossReason(position(), 310_000_000_000n)).toEqual("TP");
  });
  it("fires SL at/below the stop-loss", () => {
    expect(crossReason(position(), 250_000_000_000n)).toEqual("SL");
    expect(crossReason(position(), 240_000_000_000n)).toEqual("SL");
  });
  it("does nothing in between", () => {
    expect(crossReason(position(), 275_000_000_000n)).toBeUndefined();
  });
  it("ignores a zero (unset) threshold", () => {
    expect(crossReason(position({ takeProfitPrice: 0n }), 999_000_000_000n)).toBeUndefined();
  });
});

describe("TpSlMonitor.tick", () => {
  function setup(price: bigint) {
    const executor = new FakeExecutor();
    const store = new PositionStore();
    const monitor = new TpSlMonitor({
      executorFor: () => executor,
      priceFor: () => new FakePrice(price),
      store,
      logger: new AgentLogger(() => {}),
      pollMs: 1000,
      defaultSlippageBps: 100,
    });
    return { executor, store, monitor };
  }

  it("exits and closes the position when TP is crossed", async () => {
    const { executor, store, monitor } = setup(305_000_000_000n);
    store.open(position());
    await monitor.tick();

    expect(executor.swaps).toHaveLength(1);
    expect(executor.swaps[0]?.tokenIn.toLowerCase()).toEqual(WETH.toLowerCase()); // sells the token back
    expect(executor.swaps[0]?.tokenOut.toLowerCase()).toEqual(USDC.toLowerCase());
    expect(store.all()).toHaveLength(0); // closed
  });

  it("exits when SL is crossed", async () => {
    const { executor, store, monitor } = setup(240_000_000_000n);
    store.open(position());
    await monitor.tick();
    expect(executor.swaps).toHaveLength(1);
    expect(store.all()).toHaveLength(0);
  });

  it("does not exit when price is between thresholds", async () => {
    const { executor, store, monitor } = setup(275_000_000_000n);
    store.open(position());
    await monitor.tick();
    expect(executor.swaps).toHaveLength(0);
    expect(store.all()).toHaveLength(1); // still open
  });
});

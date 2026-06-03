import { describe, it, expect } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { PositionStore } from "../src/state.js";
import type { OpenPosition } from "../src/ports.js";
import { FakeCdr, makeSignal, WETH, USDC, TP, SL } from "./helpers.js";

const FOLLOWER = "0x00000000000000000000000000000000000000aa" as Hex;
const VAULT = "0x00000000000000000000000000000000000000a1" as Hex;

describe("PositionStore — persistence excludes secrets, reconcile re-derives them from CDR", () => {
  it("persists only non-secret metadata, then restores TP/SL by re-reading the CDR vault", async () => {
    const statePath = join(tmpdir(), `sigmax-state-${process.pid}.json`);
    const cdr = new FakeCdr();
    const { uuid } = await cdr.publishSignal(makeSignal()); // CDR holds the secret thresholds

    const store1 = new PositionStore(statePath);
    store1.markProcessed("sig-1");
    const pos: OpenPosition = {
      signalId: "sig-1",
      uuid,
      venue: "arbitrum",
      follower: FOLLOWER,
      vault: VAULT,
      token: WETH,
      quoteToken: USDC,
      amountIn: 500_000_000n,
      received: 250_000_000n,
      entryTxHash: ("0x" + "00".repeat(32)) as Hex,
      takeProfitPrice: BigInt(TP),
      stopLossPrice: BigInt(SL),
    };
    store1.open(pos);
    await store1.persist();

    try {
      // On-disk: no secret thresholds.
      const file = await readFile(statePath, "utf8");
      expect(file).not.toContain(TP);
      expect(file).not.toContain(SL);
      expect(file).toContain("sig-1"); // non-secret metadata is there

      // A fresh store reconciles: idempotency set restored, TP/SL re-derived from CDR (in memory only).
      const store2 = new PositionStore(statePath);
      const { restored, dropped } = await store2.reconcile(cdr);
      expect(restored).toEqual(1);
      expect(dropped).toEqual(0);
      expect(store2.isProcessed("sig-1")).toBe(true);

      const restoredPos = store2.all()[0];
      expect(restoredPos?.takeProfitPrice).toEqual(BigInt(TP));
      expect(restoredPos?.stopLossPrice).toEqual(BigInt(SL));
    } finally {
      await rm(statePath, { force: true });
    }
  });

  it("dedupe is reported by isProcessed", () => {
    const store = new PositionStore();
    expect(store.isProcessed("x")).toBe(false);
    store.markProcessed("x");
    expect(store.isProcessed("x")).toBe(true);
  });
});

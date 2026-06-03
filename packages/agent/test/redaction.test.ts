import { describe, it, expect } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockCdr } from "@sigmax/cdr";
import { SignalPipeline } from "../src/pipeline.js";
import { TpSlMonitor } from "../src/tpsl.js";
import { PositionStore } from "../src/state.js";
import { AgentLogger } from "../src/logger.js";
import { FakeExecutor, FakePrice, FakeSubscribers, recordingSink, makeSignal, TP, SL } from "./helpers.js";

const FOLLOWER = "0x00000000000000000000000000000000000000aa" as `0x${string}`;

/**
 * The confidentiality acceptance test (doc 82 §7 / 81 Phase 5-6): drive the FULL loop (entry → TP exit)
 * and prove the secret take-profit / stop-loss values never appear in any log line or persisted state.
 */
describe("redaction — TP/SL never leak through logs or state", () => {
  it("runs entry+exit yet no log line or state file contains the secret thresholds", async () => {
    const statePath = join(tmpdir(), `sigmax-redaction-${process.pid}.json`);
    const { lines, sink } = recordingSink();
    const logger = new AgentLogger(sink);
    const cdr = new MockCdr({ hasLicense: true });
    const executor = new FakeExecutor();
    const store = new PositionStore(statePath);

    const { uuid } = await cdr.publishSignal(makeSignal());

    const pipeline = new SignalPipeline({
      cdr,
      executorFor: () => executor,
      subscribers: new FakeSubscribers([FOLLOWER]),
      store,
      logger,
      defaultSlippageBps: 100,
    });
    await pipeline.processSignal(uuid);

    const monitor = new TpSlMonitor({
      executorFor: () => executor,
      priceFor: () => new FakePrice(310_000_000_000n), // above TP → exit fires
      store,
      logger,
      pollMs: 1000,
      defaultSlippageBps: 100,
    });
    await monitor.tick();
    await store.persist();

    try {
      // The loop genuinely ran: an entry and an exit swap (so the redaction check isn't vacuous).
      expect(executor.swaps).toHaveLength(2);
      expect(store.all()).toHaveLength(0); // position closed by the exit

      const log = lines.join("\n");
      const file = await readFile(statePath, "utf8");

      // Sanity: useful non-secret info IS logged.
      expect(log).toContain("11111111-2222-3333-4444-555555555555"); // signalId
      expect(log).toContain("swap_executed");

      // The invariant: secret thresholds appear NOWHERE.
      for (const blob of [log, file]) {
        expect(blob).not.toContain(TP);
        expect(blob).not.toContain(SL);
      }
      // And the raw decrypted-signal shape (its field names) is never dumped.
      expect(log).not.toContain("takeProfitPrice");
      expect(log).not.toContain("stopLossPrice");
      expect(file).not.toContain("takeProfitPrice");
    } finally {
      await rm(statePath, { force: true });
    }
  });
});

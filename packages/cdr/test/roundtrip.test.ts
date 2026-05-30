import { describe, it, expect } from "vitest";
import { SignalSchema, type Signal, ARBITRUM_ADDRESSES } from "@sigmax/shared";
import { MockCdr, ReadConditionDenied } from "../src/index.js";

const signal: Signal = SignalSchema.parse({
  signalId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  strategyId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  chainId: 42161,
  action: "ENTRY",
  token: ARBITRUM_ADDRESSES.weth,
  quoteToken: ARBITRUM_ADDRESSES.usdc,
  sizeBps: 2500,
  takeProfitPrice: "350000000000",
  stopLossPrice: "270000000000",
  issuedAt: 1748600000,
  expiresAt: 1748686400,
});

describe("CDR publish → access round-trip (mock)", () => {
  it("a licensed reader recovers the exact signal", async () => {
    const cdr = new MockCdr({ hasLicense: true });
    const { uuid } = await cdr.publishSignal(signal);
    expect(await cdr.accessSignal(uuid)).toEqual(signal);
  });

  it("an unlicensed reader is denied (read condition reverts)", async () => {
    const cdr = new MockCdr({ hasLicense: false });
    const { uuid } = await cdr.publishSignal(signal);
    await expect(cdr.accessSignal(uuid)).rejects.toBeInstanceOf(ReadConditionDenied);
  });
});

import { describe, it, expect } from "vitest";
import { encodeSignal, decodeSignal, SignalSchema, type Signal } from "../src/signal.js";
import { ARBITRUM_ADDRESSES } from "../src/addresses.js";

const base: Signal = SignalSchema.parse({
  version: 1,
  signalId: "11111111-2222-3333-4444-555555555555",
  strategyId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  chainId: 42161,
  venue: "arbitrum",
  action: "ENTRY",
  token: ARBITRUM_ADDRESSES.weth,
  quoteToken: ARBITRUM_ADDRESSES.usdc,
  sizeBps: 500,
  maxEntryPrice: "300000000000", // $3000 @ 1e8
  takeProfitPrice: "350000000000",
  stopLossPrice: "270000000000",
  issuedAt: 1748600000,
  expiresAt: 1748686400,
});

const hlBase: Signal = SignalSchema.parse({
  version: 1,
  signalId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  strategyId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  chainId: 42161,
  venue: "hyperliquid",
  action: "ENTRY",
  token: "HYPE", // spot coin symbol, not an address
  quoteToken: "USDC",
  sizeBps: 500,
  maxEntryPrice: "0",
  takeProfitPrice: "350000000000",
  stopLossPrice: "270000000000",
  issuedAt: 1748600000,
  expiresAt: 1748686400,
});

describe("signal encode/decode", () => {
  it("round-trips to an identical signal", () => {
    const decoded = decodeSignal(encodeSignal(base));
    expect(decoded).toEqual(base);
  });

  it("preserves EXIT and absent (0) price fields", () => {
    const exit: Signal = SignalSchema.parse({
      ...base,
      action: "EXIT",
      maxEntryPrice: "0",
      takeProfitPrice: "0",
      stopLossPrice: "0",
    });
    expect(decodeSignal(encodeSignal(exit))).toEqual(exit);
  });

  it("stays within the 1024-byte CDR payload limit", () => {
    const bytes = (encodeSignal(base).length - 2) / 2;
    expect(bytes).toBeLessThan(1024);
  });

  it("rejects a malformed payload (bad address) on arbitrum", () => {
    expect(() => SignalSchema.parse({ ...base, token: "0xnot_an_address" })).toThrow();
  });

  it("rejects an unknown action (no leverage/short by construction)", () => {
    expect(() => SignalSchema.parse({ ...base, action: "SHORT" })).toThrow();
  });

  it("round-trips a hyperliquid signal with a coin symbol", () => {
    const decoded = decodeSignal(encodeSignal(hlBase));
    expect(decoded).toEqual(hlBase);
    expect(decoded.venue).toBe("hyperliquid");
    expect(decoded.token).toBe("HYPE");
  });

  it("accepts a coin symbol on hyperliquid but rejects it on arbitrum", () => {
    expect(() => SignalSchema.parse({ ...hlBase, token: "HYPE" })).not.toThrow();
    expect(() => SignalSchema.parse({ ...base, token: "HYPE" })).toThrow();
  });
});

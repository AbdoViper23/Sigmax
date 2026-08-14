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

describe("sizeBps ceiling by action", () => {
  const withSize = (action: "ENTRY" | "EXIT", sizeBps: number) =>
    SignalSchema.safeParse({ ...base, action, sizeBps });

  it("caps an ENTRY at 20%", () => {
    expect(withSize("ENTRY", 2000).success).toBe(true);
    expect(withSize("ENTRY", 2001).success).toBe(false);
  });

  // An exit closes a position, so it has to be able to reach all of it — capped at 20% a leader
  // could not express "close it", and the remainder was often too small for a venue's minimum
  // order value to ever sell.
  it("lets an EXIT close the whole position", () => {
    expect(withSize("EXIT", 10_000).success).toBe(true);
    expect(withSize("EXIT", 10_001).success).toBe(false);
  });

  it("survives the ABI round trip at 100%", () => {
    const full = SignalSchema.parse({ ...base, action: "EXIT", sizeBps: 10_000 });
    expect(decodeSignal(encodeSignal(full)).sizeBps).toBe(10_000);
  });
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

  it("round-trips a flare (FXRP) signal with EVM addresses", () => {
    const flare: Signal = SignalSchema.parse({
      version: 1,
      signalId: "ffffffff-1111-2222-3333-444444444444",
      strategyId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
      chainId: 114,
      venue: "flare",
      action: "ENTRY",
      token: "0x0b6A3645c240605887a5532109323A3E12273dc7", // FXRP on Coston2
      quoteToken: "0x1111111111111111111111111111111111111111", // USDT0 placeholder (EVM address)
      sizeBps: 500,
      maxEntryPrice: "0",
      takeProfitPrice: "0",
      stopLossPrice: "0",
      issuedAt: 1748600000,
      expiresAt: 1748686400,
    });
    const decoded = decodeSignal(encodeSignal(flare));
    expect(decoded).toEqual(flare);
    expect(decoded.venue).toBe("flare");
  });

  it("requires EVM addresses on flare (rejects a coin symbol)", () => {
    const raw = {
      version: 1,
      signalId: "ffffffff-1111-2222-3333-444444444444",
      strategyId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
      chainId: 114,
      venue: "flare",
      action: "ENTRY",
      token: "FXRP",
      quoteToken: "USDT0",
      sizeBps: 500,
      maxEntryPrice: "0",
      takeProfitPrice: "0",
      stopLossPrice: "0",
      issuedAt: 1748600000,
      expiresAt: 1748686400,
    };
    expect(() => SignalSchema.parse(raw)).toThrow();
  });
});

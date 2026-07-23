import { describe, it, expect } from "vitest";
import { computeAmountIn, computeMinOut, buildSwapAuths } from "../src/flare/swap-auth.js";
import { SignalSchema, type Signal } from "@sigmax/shared";

const signal: Signal = SignalSchema.parse({
  version: 1,
  signalId: "ffffffff-1111-2222-3333-444444444444",
  strategyId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  chainId: 114,
  venue: "flare",
  action: "ENTRY",
  token: "0x0b6A3645c240605887a5532109323A3E12273dc7",
  quoteToken: "0x1111111111111111111111111111111111111111",
  sizeBps: 500, // 5%
  maxEntryPrice: "0",
  takeProfitPrice: "0",
  stopLossPrice: "0",
  issuedAt: 1748600000,
  expiresAt: 1748686400,
});

describe("computeAmountIn", () => {
  it("sizes to sizeBps of balance", () => {
    expect(computeAmountIn(100_000000n, 500, 1_000_000000n)).toBe(5_000000n); // 5% of 100
  });
  it("clamps to perTradeCap", () => {
    expect(computeAmountIn(100_000000n, 500, 3_000000n)).toBe(3_000000n); // 5% = 5 > cap 3
  });
  it("returns 0 for empty balance", () => {
    expect(computeAmountIn(0n, 500, 1_000000n)).toBe(0n);
  });
});

describe("computeMinOut", () => {
  it("applies price and slippage (6-decimal tokens)", () => {
    // 10 FXRP @ price 2.0 (USDT0 per FXRP) = 20 USDT0 expected; 5% slippage -> 19 USDT0.
    const minOut = computeMinOut({
      amountIn: 10_000000n,
      tokenInDecimals: 6,
      tokenOutDecimals: 6,
      price: 2_000000n, // 2.0 @ 1e6
      priceDecimals: 6,
      slippageBps: 500,
    });
    expect(minOut).toBe(19_000000n);
  });
});

describe("buildSwapAuths", () => {
  const common = {
    signal,
    tokenIn: "0x0b6A3645c240605887a5532109323A3E12273dc7" as const,
    tokenOut: "0x1111111111111111111111111111111111111111" as const,
    tokenInDecimals: 6,
    tokenOutDecimals: 6,
    router: "0x8D29b61C41CF318d15d031BE2928F79630e068e6" as const,
    perTradeCap: 1_000_000000n,
    price: 2_000000n,
    priceDecimals: 6,
    slippageBps: 500,
    deadline: 1_784_900_000n,
    chainId: 114n,
    signalIdBytes32: "0xffffffff111122223333444444444444000000000000000000000000000000ff" as const,
    encodeSwapData: () => "0xdeadbeef" as const,
  };

  it("builds one auth per funded follower and skips zero-balance ones", () => {
    const auths = buildSwapAuths({
      ...common,
      followers: [
        { vault: "0xAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaA", balance: 100_000000n },
        { vault: "0xBbBBBBbbBBBbbBBBbbbBbBBbBBbBbbBbBBbBBBBB", balance: 0n }, // skipped
      ],
    });
    expect(auths).toHaveLength(1);
    const a = auths[0];
    expect(a.vault).toBe("0xAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaA");
    expect(a.amountIn).toBe(5_000000n); // 5% of 100
    expect(a.minOut).toBe(9_500000n); // 5 FXRP @ 2.0 = 10, -5% = 9.5
    expect(a.chainId).toBe(114n);
    expect(a.swapData).toBe("0xdeadbeef");
  });
});

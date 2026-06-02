import { describe, it, expect } from "vitest";
import {
  resolvePair,
  roundPrice,
  roundSize,
  marketableIocPrice,
  numberToUnits,
  unitsToNumber,
  assertSpotAsset,
  planSpotOrder,
  type SpotMeta,
} from "../src/hyperliquid/meta.js";

// A minimal spotMeta: USDC (index 0), HYPE (index 1); pair HYPE/USDC at universe index 107.
const META: SpotMeta = {
  tokens: [
    { name: "USDC", szDecimals: 2, weiDecimals: 8, index: 0 },
    { name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 1 },
  ],
  universe: [{ name: "HYPE/USDC", tokens: [1, 0], index: 107 }],
};

describe("resolvePair", () => {
  it("maps USDC->HYPE to a BUY of the base on HYPE/USDC", () => {
    const r = resolvePair(META, "USDC", "HYPE");
    expect(r).toMatchObject({
      assetId: 10_107,
      midsKey: "@107",
      pairName: "HYPE/USDC",
      baseCoin: "HYPE",
      quoteCoin: "USDC",
      szDecimals: 2,
      isBuy: true,
    });
  });

  it("maps HYPE->USDC to a SELL of the base", () => {
    expect(resolvePair(META, "HYPE", "USDC").isBuy).toBe(false);
  });

  it("is case-insensitive on coin names", () => {
    expect(resolvePair(META, "usdc", "hype").assetId).toBe(10_107);
  });

  it("throws for an unknown token or missing pair", () => {
    expect(() => resolvePair(META, "USDC", "WIF")).toThrow(/token not found/);
  });
});

describe("roundPrice", () => {
  it("caps at 5 significant figures", () => {
    expect(roundPrice(18.123456, 2)).toBe("18.123");
    expect(roundPrice(1234.56, 2)).toBe("1234.6");
  });

  it("caps decimals at 8 - szDecimals", () => {
    // szDecimals 2 -> max 6 decimals, but 5 sig figs dominates for small numbers
    expect(roundPrice(0.0123456, 2)).toBe("0.012346");
  });

  it("allows integer prices and strips trailing zeros", () => {
    expect(roundPrice(20.0, 2)).toBe("20");
    expect(roundPrice(18.5, 2)).toBe("18.5");
  });

  it("rejects non-positive prices", () => {
    expect(() => roundPrice(0, 2)).toThrow();
  });
});

describe("roundSize", () => {
  it("floors to szDecimals (never over-spend)", () => {
    expect(roundSize(1.259, 2)).toBe("1.25");
    expect(roundSize(1.2, 2)).toBe("1.2");
    expect(roundSize(3, 2)).toBe("3");
  });

  it("floors to a whole number when szDecimals is 0", () => {
    expect(roundSize(5.99, 0)).toBe("5");
  });
});

describe("marketableIocPrice", () => {
  it("crosses up for buys and down for sells", () => {
    expect(marketableIocPrice(100, true, 100)).toBeCloseTo(101); // +1%
    expect(marketableIocPrice(100, false, 100)).toBeCloseTo(99); // -1%
  });
});

describe("uniform units (1e8)", () => {
  it("round-trips a quantity through bigint units", () => {
    expect(numberToUnits(123.45)).toBe(12_345_000_000n);
    expect(unitsToNumber(12_345_000_000n)).toBeCloseTo(123.45);
  });
});

describe("planSpotOrder (market vs limit)", () => {
  const buy = resolvePair(META, "USDC", "HYPE"); // isBuy=true, szDecimals=2
  const sell = resolvePair(META, "HYPE", "USDC"); // isBuy=false

  it("MARKET buy: sizes off mid and crosses up by slippage", () => {
    // $100 notional at mid 20, +1% slippage -> price 20.2, size 100/20.2 ≈ 4.95
    const plan = planSpotOrder(buy, 20, 100, numberToUnits(100), 0n);
    expect(plan.isLimit).toBe(false);
    expect(plan.price).toBe("20.2");
    expect(Number(plan.size)).toBeCloseTo(4.95, 2);
  });

  it("LIMIT buy: prices at the cap and sizes against it (cost ≤ notional)", () => {
    // $100 notional, limit 18 -> price 18, size 100/18 ≈ 5.55
    const plan = planSpotOrder(buy, 20, 100, numberToUnits(100), numberToUnits(18));
    expect(plan.isLimit).toBe(true);
    expect(plan.price).toBe("18");
    expect(Number(plan.size)).toBeCloseTo(5.55, 2);
  });

  it("MARKET sell: sizes the held base and crosses down", () => {
    const plan = planSpotOrder(sell, 20, 100, numberToUnits(3), 0n); // sell 3 HYPE
    expect(plan.isLimit).toBe(false);
    expect(plan.price).toBe("19.8"); // 20 * (1 - 1%)
    expect(Number(plan.size)).toBeCloseTo(3, 6);
  });

  it("ignores maxEntryPrice on a SELL (limit only applies to buys)", () => {
    expect(planSpotOrder(sell, 20, 100, numberToUnits(3), numberToUnits(18)).isLimit).toBe(false);
  });

  it("rejects orders below the $10 minimum", () => {
    expect(() => planSpotOrder(buy, 20, 100, numberToUnits(5), 0n)).toThrow(/below \$10/);
  });

  it("rejects a size that rounds to zero", () => {
    // $10 notional at mid 1e6 -> size 1e-5, rounds to 0 at szDecimals 2
    expect(() => planSpotOrder(buy, 1_000_000, 100, numberToUnits(10), 0n)).toThrow(/rounds to zero/);
  });
});

describe("assertSpotAsset (spot-only guard)", () => {
  it("accepts spot asset ids (>= 10000)", () => {
    expect(() => assertSpotAsset(10_107)).not.toThrow();
  });

  it("rejects perp/other asset ids (< 10000)", () => {
    expect(() => assertSpotAsset(0)).toThrow(/spot-only guard/);
    expect(() => assertSpotAsset(5)).toThrow(/spot-only guard/);
  });
});

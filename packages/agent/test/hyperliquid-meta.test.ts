import { describe, it, expect } from "vitest";
import {
  resolvePair,
  roundPrice,
  roundSize,
  marketableIocPrice,
  numberToUnits,
  unitsToNumber,
  assertSpotAsset,
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

describe("assertSpotAsset (spot-only guard)", () => {
  it("accepts spot asset ids (>= 10000)", () => {
    expect(() => assertSpotAsset(10_107)).not.toThrow();
  });

  it("rejects perp/other asset ids (< 10000)", () => {
    expect(() => assertSpotAsset(0)).toThrow(/spot-only guard/);
    expect(() => assertSpotAsset(5)).toThrow(/spot-only guard/);
  });
});

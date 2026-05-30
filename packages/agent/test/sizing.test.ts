import { describe, it, expect } from "vitest";
import { entryAmount } from "../src/executor.js";

describe("entryAmount (ENTRY sizing)", () => {
  it("takes sizeBps of the balance", () => {
    expect(entryAmount(1_000_000_000n, 5000, 10_000_000_000n)).toEqual(500_000_000n); // 50%
    expect(entryAmount(1_000_000_000n, 10000, 10_000_000_000n)).toEqual(1_000_000_000n); // 100%
  });

  it("clamps to perTradeCap (partial copy, not skip)", () => {
    expect(entryAmount(1_000_000_000n, 10000, 200_000_000n)).toEqual(200_000_000n);
  });

  it("is zero when the balance is zero", () => {
    expect(entryAmount(0n, 10000, 1_000_000_000n)).toEqual(0n);
  });
});

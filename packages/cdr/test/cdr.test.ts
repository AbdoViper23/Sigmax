import { describe, it, expect } from "vitest";
import { RealCdr, ReadConditionDenied, type CdrPort } from "../src/index.js";

// CDR is live-only (real threshold encryption on Story Aeneid). The end-to-end publish→access
// round-trip is exercised against live Aeneid by `scripts/poc-cdr.ts`; here we only assert the
// pieces that can be checked offline (no network, no funded wallet).

describe("ReadConditionDenied", () => {
  it("is an Error with a stable name (the read-gate signal the agent catches)", () => {
    const e = new ReadConditionDenied();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ReadConditionDenied");
  });
});

describe("RealCdr", () => {
  it("constructs offline and implements the CdrPort surface", () => {
    const cdr: CdrPort = new RealCdr({
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      apiUrl: "http://localhost:1317",
      getLicenseTokenIds: () => [],
    });
    expect(typeof cdr.publishSignal).toBe("function");
    expect(typeof cdr.accessSignal).toBe("function");
  });
});

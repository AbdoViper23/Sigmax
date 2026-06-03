import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { HyperliquidExecutor } from "../src/hyperliquid/executor.js";

const AGENT_PK = ("0x" + "11".repeat(32)) as Hex;
const FOLLOWER = "0x00000000000000000000000000000000000000aa" as Hex;

function makeExecutor(tokens: Record<string, string> = {}) {
  return new HyperliquidExecutor({
    agentPk: AGENT_PK,
    testnet: true,
    tokens, // optional legacy map; signals now carry the coin symbol directly
    perTradeCap: 1_500_000_000n, // $15 in 1e8 units
  });
}

describe("HyperliquidExecutor (non-custodial + spot-only shape)", () => {
  it("treats the follower's own master account as the 'vault' (no custody indirection)", async () => {
    await expect(makeExecutor().vaultOf(FOLLOWER)).resolves.toBe(FOLLOWER);
  });

  it("returns the config per-trade cap (no on-chain cap on HL)", async () => {
    await expect(makeExecutor().perTradeCap(FOLLOWER)).resolves.toBe(1_500_000_000n);
  });

  it("needs no static token whitelist — coins resolve dynamically from spotMeta", () => {
    // Constructing with an empty token map is valid now: HL signals carry the spot coin symbol and the
    // executor resolves it live via spotMeta. Unknown-coin rejection is enforced by resolvePair and is
    // unit-tested (network-free) in hyperliquid-meta.test.ts ("throws for an unknown token").
    const ex = makeExecutor() as unknown as Record<string, unknown>;
    expect(typeof ex.quoteAndSwap).toBe("function");
  });

  it("exposes no withdraw/transfer/perp surface (only the trade Executor port)", () => {
    const ex = makeExecutor() as unknown as Record<string, unknown>;
    // The class deliberately implements only the Executor port — no fund-movement methods exist.
    for (const forbidden of ["withdraw", "usdSend", "spotSend", "agentSendAsset", "updateLeverage", "usdClassTransfer"]) {
      expect(typeof ex[forbidden]).not.toBe("function");
    }
  });
});

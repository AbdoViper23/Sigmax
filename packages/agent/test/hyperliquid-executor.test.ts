import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { HyperliquidExecutor } from "../src/hyperliquid/executor.js";

const HYPE = "0x0000000000000000000000000000000000000001" as Hex;
const USDC = "0x0000000000000000000000000000000000000002" as Hex;
const UNKNOWN = "0x0000000000000000000000000000000000000099" as Hex;
const AGENT_PK = ("0x" + "11".repeat(32)) as Hex;
const FOLLOWER = "0x00000000000000000000000000000000000000aa" as Hex;

function makeExecutor() {
  return new HyperliquidExecutor({
    agentPk: AGENT_PK,
    testnet: true,
    tokens: { [HYPE.toLowerCase()]: "HYPE", [USDC.toLowerCase()]: "USDC" },
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

  it("refuses to trade a token that isn't in the spot whitelist (before any network call)", async () => {
    const ex = makeExecutor();
    await expect(
      ex.quoteAndSwap({ vault: FOLLOWER, tokenIn: USDC, tokenOut: UNKNOWN, amountIn: 50_000_000_000n, slippageBps: 100 }),
    ).rejects.toThrow(/no HL coin mapped/);
  });

  it("exposes no withdraw/transfer/perp surface (only the trade Executor port)", () => {
    const ex = makeExecutor() as unknown as Record<string, unknown>;
    // The class deliberately implements only the Executor port — no fund-movement methods exist.
    for (const forbidden of ["withdraw", "usdSend", "spotSend", "agentSendAsset", "updateLeverage", "usdClassTransfer"]) {
      expect(typeof ex[forbidden]).not.toBe("function");
    }
  });
});

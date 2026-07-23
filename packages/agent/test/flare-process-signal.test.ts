import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem";
import { SignalSchema, type Signal } from "@sigmax/shared";
import {
  encodeSwapAuths,
  decodeSwapAuths,
  blazeSwapEncoder,
  processFlareSignal,
} from "../src/flare/process-signal.js";

const signal: Signal = SignalSchema.parse({
  version: 1,
  signalId: "ffffffff-1111-2222-3333-444444444444",
  strategyId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  chainId: 114,
  venue: "flare",
  action: "ENTRY",
  token: "0x0b6A3645c240605887a5532109323A3E12273dc7",
  quoteToken: "0x1111111111111111111111111111111111111111",
  sizeBps: 500,
  maxEntryPrice: "0",
  takeProfitPrice: "0",
  stopLossPrice: "0",
  issuedAt: 1748600000,
  expiresAt: 1748686400,
});

const cfg = {
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
};

describe("processFlareSignal", () => {
  it("skips inactive/zero-balance followers and sizes the rest", () => {
    const { auths } = processFlareSignal({
      ...cfg,
      activeFollowers: [
        { vault: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", balance: 100_000000n },
        { vault: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", balance: 0n },
      ],
    });
    expect(auths).toHaveLength(1);
    expect(auths[0].amountIn).toBe(5_000000n);
    expect(auths[0].minOut).toBe(9_500000n);
  });

  it("resultData ABI-round-trips (self-consistent with the on-chain decode)", () => {
    const { auths, resultData } = processFlareSignal({
      ...cfg,
      activeFollowers: [{ vault: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", balance: 100_000000n }],
    });
    const decoded = decodeSwapAuths(resultData);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].amountIn).toBe(auths[0].amountIn);
    expect(decoded[0].minOut).toBe(auths[0].minOut);
    expect(decoded[0].chainId).toBe(114n);
    expect(decoded[0].vault.toLowerCase()).toBe(auths[0].vault.toLowerCase());
  });

  it("swapData carries the Uniswap-V2 swapExactTokensForTokens selector", () => {
    const encode = blazeSwapEncoder(cfg.deadline);
    const data = encode({
      tokenIn: cfg.tokenIn,
      amountIn: 5_000000n,
      tokenOut: cfg.tokenOut,
      minOut: 9_500000n,
      vault: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const selector = toFunctionSelector(
      "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    );
    expect(data.startsWith(selector)).toBe(true);
  });
});

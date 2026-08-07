/**
 * Vendored from packages/agent/src/flare/swap-auth.ts — keep byte-identical logic.
 * (fce-sigmax is a standalone package; it cannot import @sigmax/* workspace packages.)
 */

import type { Hex } from "viem";
import type { Signal } from "./signal.js";

/**
 * TypeScript mirror of `CopyVaultFlare.SwapAuth` (Solidity). Amounts are in token smallest units.
 * The TEE builds one of these per active follower for a signal, signs the whole array (ActionResult),
 * and each vault verifies the signature + acts on its own entry.
 */
export interface SwapAuth {
  vault: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  minOut: bigint;
  router: `0x${string}`;
  swapData: Hex;
  signalId: Hex; // bytes32
  deadline: bigint;
  chainId: bigint;
}

export interface FollowerBalance {
  vault: `0x${string}`;
  balance: bigint; // tokenIn balance held in the follower's vault (smallest units)
}

/** `balance * sizeBps / 10000`, clamped to `perTradeCap`. Zero/again-zero stays zero (skip). */
export function computeAmountIn(balance: bigint, sizeBps: number, perTradeCap: bigint): bigint {
  if (balance <= 0n || sizeBps <= 0) return 0n;
  const sized = (balance * BigInt(sizeBps)) / 10000n;
  return sized > perTradeCap ? perTradeCap : sized;
}

/**
 * FTSO-bounded floor for tokenOut received. `price` is tokenOut-per-tokenIn scaled by 10^priceDecimals
 * (for FXRP→USDT0 use XRP/USD, since FXRP≈XRP and USDT0≈USD). Applies `slippageBps` haircut.
 */
export function computeMinOut(args: {
  amountIn: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  price: bigint;
  priceDecimals: number;
  slippageBps: number;
}): bigint {
  const { amountIn, tokenInDecimals, tokenOutDecimals, price, priceDecimals, slippageBps } = args;
  const expectedOut =
    (amountIn * price * 10n ** BigInt(tokenOutDecimals)) /
    (10n ** BigInt(tokenInDecimals) * 10n ** BigInt(priceDecimals));
  return (expectedOut * BigInt(10000 - slippageBps)) / 10000n;
}

export interface BuildSwapAuthsParams {
  signal: Signal;
  followers: FollowerBalance[];
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  router: `0x${string}`;
  perTradeCap: bigint;
  price: bigint; // FTSO price, tokenOut per tokenIn
  priceDecimals: number;
  slippageBps: number;
  deadline: bigint;
  chainId: bigint;
  signalIdBytes32: Hex;
  /** Router-specific calldata builder (injected so this stays router-agnostic and testable). */
  encodeSwapData: (a: {
    tokenIn: `0x${string}`;
    amountIn: bigint;
    tokenOut: `0x${string}`;
    minOut: bigint;
    vault: `0x${string}`;
  }) => Hex;
}

/**
 * Build one `SwapAuth` per follower whose sized amount is nonzero (0-sized followers are skipped).
 * Pure: no I/O — balances, price, cap and deadline are passed in (read by the caller inside the TEE).
 */
export function buildSwapAuths(p: BuildSwapAuthsParams): SwapAuth[] {
  const auths: SwapAuth[] = [];
  for (const f of p.followers) {
    const amountIn = computeAmountIn(f.balance, p.signal.sizeBps, p.perTradeCap);
    if (amountIn === 0n) continue;
    const minOut = computeMinOut({
      amountIn,
      tokenInDecimals: p.tokenInDecimals,
      tokenOutDecimals: p.tokenOutDecimals,
      price: p.price,
      priceDecimals: p.priceDecimals,
      slippageBps: p.slippageBps,
    });
    auths.push({
      vault: f.vault,
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amountIn,
      minOut,
      router: p.router,
      swapData: p.encodeSwapData({ tokenIn: p.tokenIn, amountIn, tokenOut: p.tokenOut, minOut, vault: f.vault }),
      signalId: p.signalIdBytes32,
      deadline: p.deadline,
      chainId: p.chainId,
    });
  }
  return auths;
}

/**
 * Vendored from packages/agent/src/flare/process-signal.ts — keep byte-identical logic.
 * The SwapAuth ABI tuple below is proven byte-for-byte equal to Solidity `abi.encode(SwapAuth[])`
 * by the cross tests in the main repo (flare-encoding-vector.test.ts / SwapAuthEncoding.t.sol).
 */

import { encodeAbiParameters, decodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import type { Signal } from "./signal.js";
import { buildSwapAuths, type SwapAuth, type FollowerBalance } from "./swap-auth.js";

/**
 * ABI tuple mirroring `CopyVaultFlare.SwapAuth` — field order + types MUST match the Solidity struct,
 * because the TEE node signs `abi.encode(SwapAuth[])` as the ActionResult and each vault recomputes
 * that hash to verify the signature.
 */
export const SWAP_AUTH_ABI = [
  {
    type: "tuple[]",
    components: [
      { name: "vault", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
      { name: "router", type: "address" },
      { name: "swapData", type: "bytes" },
      { name: "signalId", type: "bytes32" },
      { name: "deadline", type: "uint256" },
      { name: "chainId", type: "uint256" },
    ],
  },
] as const;

/** ABI-encode the batch exactly as the contract/node do — this is the `resultData` the TEE signs. */
export function encodeSwapAuths(auths: SwapAuth[]): Hex {
  return encodeAbiParameters(SWAP_AUTH_ABI, [auths]);
}

/** Decode back (mirror of the contract's calldata view) — used by tests + tooling. */
export function decodeSwapAuths(data: Hex): readonly SwapAuth[] {
  return decodeAbiParameters(SWAP_AUTH_ABI, data)[0] as readonly SwapAuth[];
}

const UNIV2_ROUTER_ABI = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

/**
 * BlazeSwap (Uniswap-V2-compatible) calldata builder. The vault `forceApprove`s the router then
 * `router.call(swapData)`; the router pulls tokenIn and sends tokenOut back to the vault (`to`).
 */
export function blazeSwapEncoder(deadline: bigint) {
  return (a: {
    tokenIn: `0x${string}`;
    amountIn: bigint;
    tokenOut: `0x${string}`;
    minOut: bigint;
    vault: `0x${string}`;
  }): Hex =>
    encodeFunctionData({
      abi: UNIV2_ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [a.amountIn, a.minOut, [a.tokenIn, a.tokenOut], a.vault, deadline],
    });
}

export interface ProcessFlareSignalParams {
  signal: Signal;
  /** Followers already filtered to active subscribers (SubscriptionRegistry.isActive) by the caller. */
  activeFollowers: FollowerBalance[];
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  router: `0x${string}`;
  perTradeCap: bigint;
  price: bigint;
  priceDecimals: number;
  slippageBps: number;
  deadline: bigint;
  chainId: bigint;
  signalIdBytes32: Hex;
}

/**
 * The confidential-execution core (runs inside the enclave after decrypt+validate): size each active
 * follower, build the per-vault `SwapAuth[]`, and ABI-encode it as the `resultData` the TEE node signs.
 * Pure — all chain/price reads are done by the caller and passed in.
 */
export function processFlareSignal(p: ProcessFlareSignalParams): { auths: SwapAuth[]; resultData: Hex } {
  const auths = buildSwapAuths({
    signal: p.signal,
    followers: p.activeFollowers,
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    tokenInDecimals: p.tokenInDecimals,
    tokenOutDecimals: p.tokenOutDecimals,
    router: p.router,
    perTradeCap: p.perTradeCap,
    price: p.price,
    priceDecimals: p.priceDecimals,
    slippageBps: p.slippageBps,
    deadline: p.deadline,
    chainId: p.chainId,
    signalIdBytes32: p.signalIdBytes32,
    encodeSwapData: blazeSwapEncoder(p.deadline),
  });
  return { auths, resultData: encodeSwapAuths(auths) };
}

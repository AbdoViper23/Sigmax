import type { Hex } from "viem";

/**
 * The agent is built around small injectable ports so the real daemon runs live (viem / 0x / Story RPC)
 * while unit tests inject light fakes. The CDR decrypt port (`CdrPort`) is reused from `@sigmax/cdr`.
 */

/** Resolves a follower's vault, gets a quote, and executes the bounded spot swap on the liquidity chain. */
export interface Executor {
  /** The follower's CopyVault address (via CopyVaultFactory.vaultOf). */
  vaultOf(follower: Hex): Promise<Hex>;
  /** The vault's balance of `token` (smallest units). Used to size ENTRY swaps and detect open positions. */
  balanceOf(vault: Hex, token: Hex): Promise<bigint>;
  /** The vault's per-trade cap (smallest units of tokenIn). */
  perTradeCap(vault: Hex): Promise<bigint>;
  /**
   * Quote `tokenIn→tokenOut` for `amountIn` and execute the spot trade. Returns tx hash + amount received.
   * `maxEntryPrice` (PRICE_SCALE/1e8, in quote terms; `0n`/undefined = none) caps an ENTRY's fill price:
   * a venue that supports it places a limit at that price (fill-or-skip) instead of a market order.
   * EXIT / TP-SL never pass it (exits are always market).
   */
  quoteAndSwap(args: {
    vault: Hex;
    tokenIn: Hex;
    tokenOut: Hex;
    amountIn: bigint;
    slippageBps: number;
    maxEntryPrice?: bigint;
  }): Promise<{ txHash: Hex; received: bigint }>;
}

/** Reads a token's spot price in quote-token terms, scaled to PRICE_SCALE (8). NOT secret. */
export interface PriceSource {
  getPrice(token: Hex): Promise<bigint>;
}

/** The eligibility gate: reads SubscriptionRegistry on Story L1 and the (demo) follower set. */
export interface SubscriberSource {
  isActive(follower: Hex, strategyId: Hex): Promise<boolean>;
  listFollowers(strategyId: Hex): Promise<Hex[]>;
}

/** A live open position. TP/SL are SECRET — held in memory only, never logged/persisted in plaintext. */
export interface OpenPosition {
  signalId: string;
  uuid: number;
  follower: Hex;
  vault: Hex;
  token: Hex;
  quoteToken: Hex;
  amountIn: bigint;
  received: bigint;
  entryTxHash: Hex;
  takeProfitPrice: bigint; // 0n = none
  stopLossPrice: bigint; // 0n = none
}

/** The non-secret subset of a position that is safe to persist to disk / log (excludes TP/SL). */
export type SafePosition = Omit<OpenPosition, "takeProfitPrice" | "stopLossPrice">;

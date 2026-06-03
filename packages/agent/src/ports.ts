import type { Hex } from "viem";
import type { SignalVenueT } from "@sigmax/shared";

/**
 * The agent is built around small injectable ports so the real daemon runs live (viem / 0x / Story RPC)
 * while unit tests inject light fakes. The CDR decrypt port (`CdrPort`) is reused from `@sigmax/cdr`.
 *
 * `token`/`quoteToken` are venue-dependent strings: an EVM address on arbitrum, a spot coin symbol
 * (e.g. "HYPE") on hyperliquid. Each Executor interprets them for its own venue.
 */

/** Resolves a follower's vault/account, gets a quote, and executes the bounded spot swap on a venue. */
export interface Executor {
  /** The follower's CopyVault address (arbitrum) or the follower's own account (hyperliquid). */
  vaultOf(follower: Hex): Promise<Hex>;
  /** The vault/account balance of `token` (smallest units). Used to size ENTRY swaps and detect positions. */
  balanceOf(vault: Hex, token: string): Promise<bigint>;
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
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    slippageBps: number;
    maxEntryPrice?: bigint;
  }): Promise<{ txHash: Hex; received: bigint }>;
}

/** Reads a token's spot price in quote-token terms, scaled to PRICE_SCALE (8). NOT secret. */
export interface PriceSource {
  /** Price of `token` denominated in `quoteToken` (the position's quote — e.g. "USDC"). */
  getPrice(token: string, quoteToken: string): Promise<bigint>;
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
  venue: SignalVenueT; // which executor opened it → which one closes it / monitors TP-SL
  follower: Hex;
  vault: Hex;
  token: string; // address on arbitrum, coin symbol on hyperliquid
  quoteToken: string;
  amountIn: bigint;
  received: bigint;
  entryTxHash: Hex;
  takeProfitPrice: bigint; // 0n = none
  stopLossPrice: bigint; // 0n = none
}

/** The non-secret subset of a position that is safe to persist to disk / log (excludes TP/SL). */
export type SafePosition = Omit<OpenPosition, "takeProfitPrice" | "stopLossPrice">;

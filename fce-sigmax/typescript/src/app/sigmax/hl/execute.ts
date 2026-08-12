/**
 * The Hyperliquid execute path — the confidential core for the off-chain venue.
 *
 * Runs INSIDE the TEE, immediately after the signal is decrypted. For each active subscriber it
 * reads their spot balance, sizes the trade with the same rule the Flare venue uses, plans a spot
 * IOC order, signs it with **that follower's own** enclave-derived agent key, and sends it straight
 * to Hyperliquid.
 *
 * CONFIDENTIALITY: the coin, the price, the size, and above all `takeProfitPrice` / `stopLossPrice`
 * never appear in a log line or in the returned receipt. The receipt carries only what is public
 * anyway — which follower traded, the order id, and whether it filled. Sizing decisions derived from
 * secret fields are consumed here and discarded.
 *
 * SPOT-ONLY (hard rule): `assertSpotAsset` runs before any order is built, and this module constructs
 * no action type other than a spot `order`. There is deliberately no path to leverage, margin,
 * transfers, or account settings.
 */

import { encodeAbiParameters, type Hex } from "viem";
import type { Signal } from "../signal.js";
import { computeAmountIn } from "../swap-auth.js";
import { deriveAgentPrivateKey } from "./agent-key.js";
import { signL1Action } from "./sign.js";
import {
  extractFill,
  readMids,
  readSpotBalance,
  readTouchPrice,
  type HlTransport,
} from "./api.js";
import {
  assertSpotAsset,
  normalizeSpotMeta,
  numberToUnits,
  planSpotOrder,
  resolvePair,
  type RawSpotMeta,
  type ResolvedPair,
} from "./meta.js";

/** One follower's outcome. Public by construction — nothing here reveals the strategy. */
export interface HlReceipt {
  follower: `0x${string}`;
  /** Hyperliquid order id, or 0 when nothing was placed or nothing filled. */
  oid: bigint;
  /** 1 = filled, 0 = skipped or failed. */
  status: number;
}

export interface HlExecuteParams {
  signal: Signal;
  /** Subscribers already filtered to active by the caller (Coston2 SubscriptionRegistry). */
  subscribers: `0x${string}`[];
  transport: HlTransport;
  /** The injected master secret. Per-follower agent keys are derived from it and never leave. */
  masterKey: Uint8Array;
  isTestnet: boolean;
  slippageBps: number;
  /** Per-trade ceiling in uniform 1e8 units. Hyperliquid has no on-chain vault cap to read. */
  perTradeCapUnits: bigint;
  /** Monotonic nonce source (milliseconds). Injected so tests are deterministic. */
  nonce: () => number;
  /**
   * Optional independent reference price (e.g. FTSO) in USD for the base coin, with the maximum
   * deviation tolerated from the order book. When the book disagrees by more than this, we refuse to
   * trade rather than execute against a possibly manipulated or dislocated book. Omitted when no feed
   * covers the coin — an honest gap, not a silent one.
   */
  referenceUsd?: { price: number; maxDeviationBps: number };
}

export interface HlExecuteResult {
  receipts: HlReceipt[];
  filled: number;
  skipped: number;
}

/** ENTRY buys `token` with `quoteToken`; EXIT sells `token` back into `quoteToken`. */
function resolveCoins(signal: Signal): { coinIn: string; coinOut: string } {
  return signal.action === "ENTRY"
    ? { coinIn: signal.quoteToken, coinOut: signal.token }
    : { coinIn: signal.token, coinOut: signal.quoteToken };
}

/**
 * The price a marketable order is planned against: the book touch when readable, else the mid.
 *
 * A market order has to cross the OPPOSITE side of the book, not the mid. On a wide book — routine on
 * testnet — `mid ± slippage` may never reach the touch, so the IOC cancels unfilled and the follower
 * silently misses the trade.
 */
async function referencePrice(transport: HlTransport, pair: ResolvedPair): Promise<number> {
  const touch = await readTouchPrice(transport, pair.pairName, pair.isBuy);
  if (touch !== null) return touch;

  const mids = await readMids(transport);
  const mid = Number(mids[pair.midsKey] ?? mids[pair.pairName]);
  if (!(mid > 0)) throw new Error("hyperliquid: no price available for the requested market");
  return mid;
}

/** Refuse to trade when the venue's price is implausible against an independent feed. */
function assertWithinReference(price: number, reference: HlExecuteParams["referenceUsd"]): void {
  if (!reference || !(reference.price > 0)) return;
  const deviationBps = Math.abs(price - reference.price) / reference.price * 10_000;
  if (deviationBps > reference.maxDeviationBps) {
    // No coin, no prices — only the fact that the guard fired.
    throw new Error("hyperliquid: venue price deviates from the reference feed beyond tolerance");
  }
}

/**
 * Execute one signal across every active subscriber.
 *
 * Per-follower failures are isolated: a follower with no balance, an unapproved agent, or an IOC that
 * did not cross becomes a `status: 0` receipt, never an aborted fan-out for everyone else.
 */
export async function executeHyperliquidSignal(p: HlExecuteParams): Promise<HlExecuteResult> {
  const { coinIn, coinOut } = resolveCoins(p.signal);

  const meta = normalizeSpotMeta((await p.transport.info({ type: "spotMeta" })) as RawSpotMeta);
  const pair = resolvePair(meta, coinIn, coinOut);
  assertSpotAsset(pair.assetId); // spot-only guard, before anything is built

  const reference = await referencePrice(p.transport, pair);
  assertWithinReference(reference, p.referenceUsd);

  const maxEntryPriceUnits = BigInt(p.signal.maxEntryPrice);
  const receipts: HlReceipt[] = [];

  for (const follower of p.subscribers) {
    try {
      const available = await readSpotBalance(p.transport, follower, coinIn);
      const amountIn = computeAmountIn(numberToUnits(available), p.signal.sizeBps, p.perTradeCapUnits);
      if (amountIn === 0n) {
        receipts.push({ follower, oid: 0n, status: 0 });
        continue;
      }

      const plan = planSpotOrder(pair, reference, p.slippageBps, amountIn, maxEntryPriceUnits);

      // Field order in this literal is load-bearing: Hyperliquid hashes the msgpack encoding, and
      // msgpack preserves insertion order. Reordering these keys invalidates every signature.
      const action = {
        type: "order",
        orders: [
          {
            a: pair.assetId,
            b: pair.isBuy,
            p: plan.price,
            s: plan.size,
            r: false,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      };

      const nonce = p.nonce();
      const agentKey = deriveAgentPrivateKey(p.masterKey, follower);
      const signature = signL1Action({
        privateKey: agentKey,
        action,
        nonce,
        isTestnet: p.isTestnet,
      });

      const response = await p.transport.exchange({ action, nonce, signature });
      const fill = extractFill(response);

      receipts.push(
        fill && Number(fill.totalSz) > 0
          ? { follower, oid: BigInt(fill.oid), status: 1 }
          : { follower, oid: 0n, status: 0 }, // IOC did not cross / limit not reached
      );
    } catch {
      // Swallow the reason deliberately: a Hyperliquid rejection can echo the price and size back,
      // and those belong to the strategy. The receipt records that this follower did not trade.
      receipts.push({ follower, oid: 0n, status: 0 });
    }
  }

  const filled = receipts.filter((r) => r.status === 1).length;
  return { receipts, filled, skipped: receipts.length - filled };
}

/** ABI tuple for the on-chain receipt — public fields only. */
export const HL_RECEIPT_ABI = [
  {
    type: "tuple[]",
    components: [
      { name: "follower", type: "address" },
      { name: "oid", type: "uint64" },
      { name: "status", type: "uint8" },
    ],
  },
] as const;

/** Encode receipts as the instruction's `resultData` — the TEE-signed, publicly verifiable outcome. */
export function encodeHlReceipts(receipts: HlReceipt[]): Hex {
  return encodeAbiParameters(HL_RECEIPT_ABI, [receipts]);
}

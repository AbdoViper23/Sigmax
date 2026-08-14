/**
 * Vendored from packages/agent/src/hyperliquid/meta.ts — keep the logic byte-identical.
 * (fce-sigmax is a standalone npm package; it cannot import @sigmax/* workspace packages. The same
 * constraint already applies to `sigmax/swap-auth.ts`, which is vendored the same way.)
 *
 * Pure helpers for Hyperliquid spot: pair resolution, unit conversion, Hyperliquid's tick/lot
 * rounding rules, and the order planner. No network, no key material, fully unit-testable — which is
 * exactly why this is the part that gets copied rather than reimplemented: it already carries a
 * proven test suite, and rewriting rounding rules is how you get orders rejected at the exchange.
 *
 * UNITS: one uniform fixed-point scale, `HL_UNIT_SCALE = 10^8`. Every bigint quantity here is a token
 * QUANTITY × 1e8, NOT an on-chain smallest-unit. Hyperliquid itself speaks decimal strings; we convert
 * at the boundary.
 */

/**
 * MUST equal `PRICE_SCALE` in `@sigmax/shared` (8). The signal arrives with `maxEntryPrice`,
 * `takeProfitPrice` and `stopLossPrice` already scaled by this, so it is a wire contract, not a
 * local choice — changing it here without changing the encoder silently mis-prices every order.
 */
export const HL_PRICE_SCALE = 8;
export const HL_UNIT_SCALE = 10n ** BigInt(HL_PRICE_SCALE); // 1e8
const HL_UNIT_SCALE_NUM = Number(HL_UNIT_SCALE);

/** Hyperliquid's $10 minimum notional per order (rejected below this with "minimum value of $10"). */
export const MIN_NOTIONAL_USD = 10;

/** Spot prices/sizes carry at most this many significant figures. */
const MAX_SIG_FIGS = 5;
/** Spot price decimals are capped at MAX_DECIMALS - szDecimals; spot MAX_DECIMALS = 8 (perps = 6). */
const SPOT_MAX_DECIMALS = 8;

/** A single spot token entry from `info.spotMeta().tokens`. */
export interface SpotToken {
  name: string;
  szDecimals: number;
  weiDecimals: number;
  index: number;
}

/** A single spot pair from `info.spotMeta().universe`; `tokens` are [baseIndex, quoteIndex]. */
export interface SpotPair {
  name: string;
  tokens: [number, number];
  index: number;
}

export interface SpotMeta {
  tokens: SpotToken[];
  universe: SpotPair[];
}

/** Everything the executor needs to act on a `tokenIn -> tokenOut` spot trade. */
export interface ResolvedPair {
  /** Exchange order asset id = 10000 + universe index. */
  assetId: number;
  /** Info/websocket key for mids, e.g. "@107". */
  midsKey: string;
  /** Canonical pair name, e.g. "HYPE/USDC". */
  pairName: string;
  baseCoin: string;
  quoteCoin: string;
  /** Order size is always denominated in the base asset and rounded to this many decimals. */
  szDecimals: number;
  /** true = buy base (tokenOut is base), false = sell base (tokenIn is base). */
  isBuy: boolean;
}

/** Raw `info.spotMeta()` shape (read-only / extra fields tolerated). */
export interface RawSpotMeta {
  tokens: ReadonlyArray<{ name: string; szDecimals: number; weiDecimals: number; index: number }>;
  universe: ReadonlyArray<{ name: string; tokens: ReadonlyArray<number>; index: number }>;
}

/** Normalize a raw spotMeta into our shape (pure: no network). */
export function normalizeSpotMeta(raw: RawSpotMeta): SpotMeta {
  return {
    tokens: raw.tokens.map((t) => ({
      name: t.name,
      szDecimals: t.szDecimals,
      weiDecimals: t.weiDecimals,
      index: t.index,
    })),
    universe: raw.universe.map((u) => {
      const base = u.tokens[0];
      const quote = u.tokens[1];
      if (base === undefined || quote === undefined) throw new Error(`hyperliquid: malformed pair ${u.name}`);
      return { name: u.name, tokens: [base, quote], index: u.index };
    }),
  };
}

function findToken(meta: SpotMeta, coin: string): SpotToken {
  const t = meta.tokens.find((tok) => tok.name.toLowerCase() === coin.toLowerCase());
  if (!t) throw new Error(`hyperliquid spot token not found: ${coin}`);
  return t;
}

/** Resolve the spot pair + direction for trading `coinIn -> coinOut` (e.g. USDC -> HYPE = buy HYPE). */
export function resolvePair(meta: SpotMeta, coinIn: string, coinOut: string): ResolvedPair {
  const inTok = findToken(meta, coinIn);
  const outTok = findToken(meta, coinOut);
  const pair = meta.universe.find(
    (p) =>
      (p.tokens[0] === inTok.index && p.tokens[1] === outTok.index) ||
      (p.tokens[0] === outTok.index && p.tokens[1] === inTok.index),
  );
  if (!pair) throw new Error(`hyperliquid spot pair not found for ${coinIn}/${coinOut}`);
  const baseTok = meta.tokens.find((t) => t.index === pair.tokens[0]);
  const quoteTok = meta.tokens.find((t) => t.index === pair.tokens[1]);
  if (!baseTok || !quoteTok) throw new Error(`hyperliquid pair ${pair.name} references unknown tokens`);
  return {
    assetId: 10_000 + pair.index,
    midsKey: `@${pair.index}`,
    pairName: pair.name,
    baseCoin: baseTok.name,
    quoteCoin: quoteTok.name,
    szDecimals: baseTok.szDecimals,
    // Buying the base means the base is what we receive (tokenOut).
    isBuy: outTok.index === baseTok.index,
  };
}

/** Uniform-units bigint (qty × 1e8) -> a JS number quantity. */
export function unitsToNumber(units: bigint): number {
  return Number(units) / HL_UNIT_SCALE_NUM;
}

/** A JS number quantity -> uniform-units bigint (qty × 1e8), rounded to the nearest unit. */
export function numberToUnits(qty: number): bigint {
  return BigInt(Math.round(qty * HL_UNIT_SCALE_NUM));
}

/**
 * Marketable IOC price: cross the book by `slippageBps` so the order fills like a market order.
 * Buy: ref × (1 + slip); sell: ref × (1 - slip). The result is later rounded with `roundPrice`.
 */
export function marketableIocPrice(reference: number, isBuy: boolean, slippageBps: number): number {
  const slip = slippageBps / 10_000;
  return isBuy ? reference * (1 + slip) : reference * (1 - slip);
}

/** Round to at most `digits` significant figures (returns a JS number). */
function toSignificantFigures(value: number, digits: number): number {
  if (value === 0) return 0;
  const mag = Math.ceil(Math.log10(Math.abs(value)));
  const power = digits - mag;
  const factor = Math.pow(10, power);
  return Math.round(value * factor) / factor;
}

/** Drop trailing zeros from a fixed-decimal string ("18.500" -> "18.5", "20.0" -> "20"). */
function stripTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

/**
 * Round a spot PRICE to Hyperliquid's rules: ≤ 5 significant figures AND ≤ (8 - szDecimals) decimals.
 * Integer prices are always allowed. Trailing zeros are stripped (required before signing).
 */
export function roundPrice(price: number, szDecimals: number): string {
  if (price <= 0) throw new Error(`invalid spot price: ${price}`);
  const maxDecimals = Math.max(0, SPOT_MAX_DECIMALS - szDecimals);
  const sigRounded = toSignificantFigures(price, MAX_SIG_FIGS);
  // Integers are always allowed regardless of the decimal cap.
  const decimals = Number.isInteger(sigRounded) ? 0 : maxDecimals;
  return stripTrailingZeros(sigRounded.toFixed(decimals));
}

/** Round an order SIZE down to the base asset's `szDecimals` (never over-spend), strip trailing zeros. */
export function roundSize(size: number, szDecimals: number): string {
  if (size < 0) throw new Error(`invalid spot size: ${size}`);
  const factor = Math.pow(10, szDecimals);
  const floored = Math.floor(size * factor) / factor;
  return stripTrailingZeros(floored.toFixed(szDecimals));
}

/** A ready-to-send spot order: the rounded price/size strings plus whether it's a limit (vs market). */
export interface SpotOrderPlan {
  price: string;
  size: string;
  isLimit: boolean;
}

/**
 * Pure order planner (no network) — decides MARKET vs LIMIT and computes the rounded price + base size.
 *  - `maxEntryPriceUnits > 0` on a BUY → LIMIT at that price (size against the cap so cost ≤ notional).
 *  - otherwise → MARKET (marketable IOC at `reference ± slippage`).
 * `amountInUnits` is 1e8 units: the quote notional for a buy, the held base amount for a sell.
 * Throws on the $10-min-notional guard or a zero-rounded size.
 */
export function planSpotOrder(
  pair: ResolvedPair,
  reference: number,
  slippageBps: number,
  amountInUnits: bigint,
  maxEntryPriceUnits: bigint,
): SpotOrderPlan {
  if (!(reference > 0)) throw new Error(`hyperliquid: invalid reference price for ${pair.pairName}`);
  // LIMIT only applies to a BUY entry (exits never carry maxEntryPrice).
  const limitUsd = pair.isBuy && maxEntryPriceUnits > 0n ? unitsToNumber(maxEntryPriceUnits) : 0;
  const isLimit = limitUsd > 0;
  const execPx = isLimit ? limitUsd : marketableIocPrice(reference, pair.isBuy, slippageBps);
  if (!(execPx > 0)) throw new Error(`hyperliquid: invalid execution price for ${pair.pairName}`);

  let sizeBase: number;
  if (pair.isBuy) {
    sizeBase = unitsToNumber(amountInUnits) / execPx; // quote notional → base size
  } else {
    sizeBase = unitsToNumber(amountInUnits); // held base amount being sold
  }

  const price = roundPrice(execPx, pair.szDecimals);
  const size = roundSize(sizeBase, pair.szDecimals);
  if (Number(size) <= 0) throw new Error("hyperliquid: order size rounds to zero");

  /*
   * Check the minimum against the ROUNDED order, not the requested notional.
   *
   * `roundSize` floors to the asset's lot, and on a coarse lot that is a large step down: PURR has
   * szDecimals 0, so a $12.90 buy at 4.67 becomes 2 whole PURR = $9.34. Validating before rounding
   * passed that order and Hyperliquid then rejected it for being under its $10 minimum — which the
   * executor reports as an ordinary skip, so it reads as "no trade" with no reason anywhere.
   */
  const orderedUsd = Number(size) * Number(price);
  if (orderedUsd < MIN_NOTIONAL_USD) {
    throw new Error(`hyperliquid: rounded order $${orderedUsd.toFixed(2)} below $${MIN_NOTIONAL_USD} minimum`);
  }
  return { price, size, isLimit };
}

/** Spot-only guard: every order this venue places must target a spot asset (index ≥ 10000). */
export function assertSpotAsset(assetId: number): void {
  if (!Number.isInteger(assetId) || assetId < 10_000) {
    throw new Error(`spot-only guard: refusing non-spot asset id ${assetId} (perps/other are forbidden)`);
  }
}

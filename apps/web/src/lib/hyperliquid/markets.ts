// Hyperliquid spot market metadata — a faithful port of the Menese reference
// (.../frontend-refactor/src/lib/hyperliquid/metadata.ts). Builds the FULL spot market list as
// "BASE/QUOTE" pairs from spotMetaAndAssetCtxs, applies the Unit-Protocol display remap, and carries
// the raw token names (what our signal + agent resolve by) plus the wsCoin/assetId trading identifiers.

export const SPOT_ASSET_OFFSET = 10000;

/** Raw spotMeta token entry. */
export interface SpotToken {
  name: string;
  szDecimals: number;
  weiDecimals: number;
  index: number;
}
/** Raw spotMeta pair entry; `tokens` = [baseIndex, quoteIndex]; `name` = "@{index}" or "PURR/USDC". */
export interface SpotPair {
  name: string;
  tokens: [number, number];
  index: number;
}
export interface SpotMetaRaw {
  tokens: SpotToken[];
  universe: SpotPair[];
}
/** Per-pair context (24h volume etc.), keyed by `coin` === pair.name. */
export interface SpotAssetCtx {
  coin: string;
  dayNtlVlm: string;
  markPx: string;
}

export interface MarketInfo {
  displaySymbol: string; // "BTC/USDC" — what the user sees
  displayBase: string; // "BTC"
  displayQuote: string; // "USDC"
  baseToken: string; // raw "UBTC" — signal/agent resolve by this
  quoteToken: string; // raw "USDC"
  wsCoin: string; // "@142" or "PURR/USDC" — price key
  assetId: number; // 10000 + pairIndex — order asset
  szDecimals: number;
  dayNtlVlm: number; // 24h notional volume, 0 if unknown
  markPx: string;
}

// Matches what app.hyperliquid.xyz shows in the Spot tab. Unit Protocol wrappers drop the "U" prefix;
// Tether-style wrappers drop the trailing "0" (USDT0 → USDT, LINK0 → LINK, XAUT0 → XAUT).
const DISPLAY_REMAP: Record<string, string> = {
  UBTC: "BTC",
  UETH: "ETH",
  USOL: "SOL",
  UFART: "FART",
  UPUMP: "PUMP",
  UBONK: "BONK",
  UDOGE: "DOGE",
  UXRP: "XRP",
  USDT0: "USDT",
  LINK0: "LINK",
  XAUT0: "XAUT",
};
export function displayName(raw: string): string {
  return DISPLAY_REMAP[raw] ?? raw;
}

/** Build the full market list from a spotMetaAndAssetCtxs response. No filtering — every pair. */
export function buildMarkets(meta: SpotMetaRaw, ctxs: SpotAssetCtx[]): MarketInfo[] {
  const tokenByIdx = new Map<number, SpotToken>();
  for (const t of meta.tokens) tokenByIdx.set(t.index, t);
  const ctxByCoin = new Map<string, SpotAssetCtx>();
  for (const c of ctxs) ctxByCoin.set(c.coin, c);

  const out: MarketInfo[] = [];
  meta.universe.forEach((pair, i) => {
    const base = tokenByIdx.get(pair.tokens[0]);
    const quote = tokenByIdx.get(pair.tokens[1]);
    if (!base || !quote) return;
    const ctx = ctxByCoin.get(pair.name) ?? ctxs[i];
    const displayBase = displayName(base.name);
    const displayQuote = displayName(quote.name);
    out.push({
      displaySymbol: `${displayBase}/${displayQuote}`,
      displayBase,
      displayQuote,
      baseToken: base.name,
      quoteToken: quote.name,
      wsCoin: pair.name,
      assetId: SPOT_ASSET_OFFSET + pair.index,
      szDecimals: base.szDecimals,
      dayNtlVlm: ctx ? parseFloat(ctx.dayNtlVlm) || 0 : 0,
      markPx: ctx?.markPx ?? "",
    });
  });
  return out;
}

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { PriceSource } from "../ports.js";
import { normalizeSpotMeta, numberToUnits, resolvePair, type SpotMeta } from "./meta.js";

export interface HyperliquidPriceSourceConfig {
  testnet: boolean;
  /** Optional legacy override the executor also uses: EVM-style token address -> HL spot coin symbol. */
  tokens: Record<string, string>;
  /** Reference/quote coin the TP/SL thresholds are denominated in (default "USDC"). */
  quoteCoin?: string;
}

/**
 * Reads HyperCore spot mid prices for TP/SL monitoring, normalized to PRICE_SCALE (1e8) so they
 * compare directly to a signal's takeProfitPrice/stopLossPrice — exactly like ChainlinkPriceSource,
 * so the existing `TpSlMonitor` works unchanged. The price is NOT secret; only the thresholds are,
 * and those live in TEE memory and are never sent to Hyperliquid until an exit order fires.
 */
export class HyperliquidPriceSource implements PriceSource {
  private readonly info: InfoClient;
  private readonly tokens: Record<string, string>;
  private readonly quoteCoin: string;
  private cachedMeta?: SpotMeta;

  constructor(cfg: HyperliquidPriceSourceConfig) {
    this.info = new InfoClient({ transport: new HttpTransport({ isTestnet: cfg.testnet }) });
    this.tokens = Object.fromEntries(Object.entries(cfg.tokens).map(([k, v]) => [k.toLowerCase(), v]));
    this.quoteCoin = cfg.quoteCoin ?? "USDC";
  }

  /** Spot mid of `token` in `quoteToken` terms, scaled to PRICE_SCALE (1e8). Throws if unpriced. */
  async getPrice(token: string, quoteToken?: string): Promise<bigint> {
    // Signals carry the coin symbol directly; the `tokens` map is an optional legacy address override.
    const coin = this.tokens[token.toLowerCase()] ?? token;
    // Price in the position's own quote (e.g. a HYPE/USDC TP is in USDC); fall back to the default quote.
    const quote = quoteToken ? (this.tokens[quoteToken.toLowerCase()] ?? quoteToken) : this.quoteCoin;
    const meta = await this.meta();
    const pair = resolvePair(meta, coin, quote);
    const mids = await this.info.allMids();
    const midStr = mids[pair.midsKey] ?? mids[pair.pairName];
    if (!midStr) throw new Error(`hyperliquid: no mid price for ${pair.pairName}`);
    const mid = Number(midStr);
    if (!(mid > 0)) throw new Error(`hyperliquid: invalid mid price for ${pair.pairName}`);
    return numberToUnits(mid); // mid is quote-per-base; numberToUnits scales by 1e8 = PRICE_SCALE
  }

  private async meta(): Promise<SpotMeta> {
    if (this.cachedMeta) return this.cachedMeta;
    this.cachedMeta = normalizeSpotMeta(await this.info.spotMeta());
    return this.cachedMeta;
  }
}

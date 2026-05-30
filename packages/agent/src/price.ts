import { createPublicClient, defineChain, http, type Hex, type PublicClient } from "viem";
import { PRICE_SCALE } from "@sigmax/shared";
import { CHAINLINK_AGGREGATOR_ABI } from "./abis.js";
import type { PriceSource } from "./ports.js";

const PRICE_SCALE_FACTOR = 10n ** BigInt(PRICE_SCALE); // 1e8

/**
 * Reads token spot prices (in quote-token/USD terms) from Chainlink feeds and normalizes them to
 * PRICE_SCALE (1e8) so they compare directly to a signal's takeProfitPrice/stopLossPrice. The price
 * itself is NOT secret (doc 32) — only the thresholds are. Tokens without a configured feed throw,
 * which surfaces as a non-secret error rather than a silently-missed exit.
 *
 * On Arbitrum (the demo chain): WETH → ETH/USD feed 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612.
 * A Uniswap-v3-quoter reader is the documented fallback (not needed for the WETH demo path).
 */
export const ARBITRUM_CHAINLINK_FEEDS: Record<string, Hex> = {
  // WETH → ETH/USD (8 decimals)
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
};

export interface ChainlinkPriceSourceConfig {
  rpcUrl: string;
  chainId: number;
  feeds?: Record<string, Hex>; // token (lowercased) → aggregator; defaults to Arbitrum feeds
}

export class ChainlinkPriceSource implements PriceSource {
  private readonly publicClient: PublicClient;
  private readonly feeds: Record<string, Hex>;

  constructor(cfg: ChainlinkPriceSourceConfig) {
    this.feeds = cfg.feeds ?? ARBITRUM_CHAINLINK_FEEDS;
    const chain = defineChain({
      id: cfg.chainId,
      name: `chain-${cfg.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    this.publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  }

  async getPrice(token: Hex): Promise<bigint> {
    const feed = this.feeds[token.toLowerCase()];
    if (!feed) throw new Error(`no price feed configured for token ${token}`);

    const [, answer] = await this.publicClient.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    });
    const decimals = await this.publicClient.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    });
    if (answer <= 0n) throw new Error(`invalid price from feed ${feed}`);

    // Normalize the feed's `decimals` to PRICE_SCALE.
    const feedScale = 10n ** BigInt(decimals);
    return (answer * PRICE_SCALE_FACTOR) / feedScale;
  }
}

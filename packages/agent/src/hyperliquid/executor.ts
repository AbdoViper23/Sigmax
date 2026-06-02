import { numberToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { Executor } from "../ports.js";
import {
  assertSpotAsset,
  marketableIocPrice,
  MIN_NOTIONAL_USD,
  normalizeSpotMeta,
  numberToUnits,
  resolvePair,
  roundPrice,
  roundSize,
  unitsToNumber,
  type SpotMeta,
} from "./meta.js";

export interface HyperliquidExecutorConfig {
  /** HL agent key (approved by each follower's master via approveAgent). Signs orders, never withdraws. */
  agentPk: Hex;
  /** Use the Hyperliquid testnet API (the demo default). */
  testnet: boolean;
  /** Maps a signal's EVM-style token address (any case) -> HL spot coin symbol, e.g. {"0x..":"HYPE"}. */
  tokens: Record<string, string>;
  /** Per-trade cap in uniform 1e8 USD units (replaces the on-chain CopyVault cap). */
  perTradeCap: bigint;
}

/**
 * Hyperliquid HyperCore spot executor — the non-Arbitrum venue. It implements the same `Executor`
 * port the pipeline + TP/SL monitor already use, so nothing upstream changes.
 *
 * SPOT-ONLY (Hard Rule #1): Hyperliquid has NO protocol-level spot-only scope, so this class IS the
 * guard. It only ever constructs spot `order` actions (asset index ≥ 10000, asserted on every order)
 * and deliberately exposes no path to `agentSendAsset`, `usdClassTransfer`, `updateLeverage`,
 * `updateIsolatedMargin`, perps, or any account-setting change. NON-CUSTODIAL is preserved by the
 * architecture (follower = own master, agent only approved to trade) — an agent key cannot withdraw.
 */
export class HyperliquidExecutor implements Executor {
  private readonly info: InfoClient;
  private readonly exchange: ExchangeClient;
  private readonly tokens: Record<string, string>;
  private readonly cap: bigint;
  private cachedMeta?: SpotMeta;

  constructor(cfg: HyperliquidExecutorConfig) {
    const transport = new HttpTransport({ isTestnet: cfg.testnet });
    this.info = new InfoClient({ transport });
    this.exchange = new ExchangeClient({ transport, wallet: privateKeyToAccount(cfg.agentPk) });
    this.tokens = Object.fromEntries(Object.entries(cfg.tokens).map(([k, v]) => [k.toLowerCase(), v]));
    this.cap = cfg.perTradeCap;
  }

  /** On Hyperliquid the follower's own master account IS where funds live — there is no vault. */
  async vaultOf(follower: Hex): Promise<Hex> {
    return follower;
  }

  /** Available spot balance (`total - hold`) of `token` for `account`, in uniform 1e8 units. */
  async balanceOf(account: Hex, token: Hex): Promise<bigint> {
    const coin = this.coinFor(token);
    // ALWAYS query the master address (the funded account), never the agent address.
    const state = await this.info.spotClearinghouseState({ user: account });
    const bal = state.balances.find((b) => b.coin.toLowerCase() === coin.toLowerCase());
    if (!bal) return 0n;
    const available = Number(bal.total) - Number(bal.hold);
    return available > 0 ? numberToUnits(available) : 0n;
  }

  /** The per-trade cap lives in config here (the on-chain CopyVault cap has no HL equivalent). */
  async perTradeCap(_account: Hex): Promise<bigint> {
    return this.cap;
  }

  /**
   * Place a marketable IOC spot order for `tokenIn -> tokenOut`. Buys size the base from the quote
   * notional; sells convert a held base amount. Returns the HL order id (as a hex string, since HL
   * has no per-order EVM tx hash) and the amount received in `tokenOut`'s uniform 1e8 units.
   */
  async quoteAndSwap(args: {
    vault: Hex;
    tokenIn: Hex;
    tokenOut: Hex;
    amountIn: bigint;
    slippageBps: number;
  }): Promise<{ txHash: Hex; received: bigint }> {
    // Resolve coins from the whitelist FIRST so an unmapped token fails fast without any network call.
    const coinIn = this.coinFor(args.tokenIn);
    const coinOut = this.coinFor(args.tokenOut);
    const meta = await this.meta();
    const pair = resolvePair(meta, coinIn, coinOut);
    assertSpotAsset(pair.assetId); // spot-only guard — refuse anything that isn't a spot asset

    const mids = await this.info.allMids();
    const midStr = mids[pair.midsKey] ?? mids[pair.pairName];
    if (!midStr) throw new Error(`hyperliquid: no mid price for ${pair.pairName}`);
    const mid = Number(midStr);
    if (!(mid > 0)) throw new Error(`hyperliquid: invalid mid price for ${pair.pairName}`);

    // Size in the base asset, and the $10-min-notional guard (HL rejects orders below $10).
    let sizeBase: number;
    if (pair.isBuy) {
      const notionalUsd = unitsToNumber(args.amountIn); // amountIn is the quote (USDC) notional
      if (notionalUsd < MIN_NOTIONAL_USD) throw new Error(`hyperliquid: order $${notionalUsd} below $10 minimum`);
      sizeBase = notionalUsd / mid;
    } else {
      sizeBase = unitsToNumber(args.amountIn); // amountIn is the base amount we hold and are selling
      if (sizeBase * mid < MIN_NOTIONAL_USD) throw new Error(`hyperliquid: order ~$${sizeBase * mid} below $10 minimum`);
    }

    const p = roundPrice(marketableIocPrice(mid, pair.isBuy, args.slippageBps), pair.szDecimals);
    const s = roundSize(sizeBase, pair.szDecimals);
    if (Number(s) <= 0) throw new Error("hyperliquid: order size rounds to zero");

    const res = await this.exchange.order({
      orders: [{ a: pair.assetId, b: pair.isBuy, p, s, r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    });

    const fill = extractFill(res);
    const filledBase = Number(fill.totalSz);
    const avgPx = Number(fill.avgPx);
    if (!(filledBase > 0)) throw new Error("hyperliquid: IOC order did not fill");
    const received = pair.isBuy ? numberToUnits(filledBase) : numberToUnits(filledBase * avgPx);
    return { txHash: numberToHex(BigInt(fill.oid)), received };
  }

  /** Resolve a signal's EVM-style token address to its HL spot coin symbol (config-mapped). */
  private coinFor(token: Hex): string {
    const coin = this.tokens[token.toLowerCase()];
    if (!coin) throw new Error(`hyperliquid: no HL coin mapped for token ${token} (set HYPERLIQUID_TOKENS)`);
    return coin;
  }

  /** Fetch + cache spotMeta, normalized to the pure-helper shape (decoupled from SDK tuple typing). */
  private async meta(): Promise<SpotMeta> {
    if (this.cachedMeta) return this.cachedMeta;
    this.cachedMeta = normalizeSpotMeta(await this.info.spotMeta());
    return this.cachedMeta;
  }
}

interface OrderFill {
  totalSz: string;
  avgPx: string;
  oid: number;
}

/** Pull the fill out of an exchange `order` response, surfacing HL errors instead of silent no-ops. */
function extractFill(res: unknown): OrderFill {
  const status = (res as { response?: { data?: { statuses?: unknown[] } } }).response?.data?.statuses?.[0];
  if (status && typeof status === "object") {
    if ("filled" in status) return (status as { filled: OrderFill }).filled;
    if ("error" in status) throw new Error(`hyperliquid order error: ${String((status as { error: unknown }).error)}`);
  }
  throw new Error("hyperliquid: IOC order did not fill (no resting fills accepted)");
}

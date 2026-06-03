import { numberToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { Executor } from "../ports.js";
import {
  assertSpotAsset,
  normalizeSpotMeta,
  numberToUnits,
  planSpotOrder,
  resolvePair,
  unitsToNumber,
  type ResolvedPair,
  type SpotMeta,
} from "./meta.js";

export interface HyperliquidExecutorConfig {
  /** HL agent key (approved by each follower's master via approveAgent). Signs orders, never withdraws. */
  agentPk: Hex;
  /** Use the Hyperliquid testnet API (the demo default). */
  testnet: boolean;
  /** Optional legacy override: EVM-style token address (any case) -> HL spot coin symbol, e.g. {"0x..":"HYPE"}.
   *  Signals now carry the coin symbol directly, so this is usually empty. */
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
  async balanceOf(account: Hex, token: string): Promise<bigint> {
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
   * Best ask (buy) / best bid (sell) from the L2 book — the price a market order must reach to fill.
   * Used instead of mid for marketable IOC pricing so it crosses even on wide books. Degrades to `mid`
   * if the book can't be read or the relevant side is empty, so a transient hiccup falls back to the
   * old behaviour rather than throwing.
   */
  private async touchPrice(pair: ResolvedPair, isBuy: boolean, mid: number): Promise<number> {
    try {
      const book = await this.info.l2Book({ coin: pair.pairName });
      const [bids, asks] = book?.levels ?? [[], []];
      const px = Number(isBuy ? asks?.[0]?.px : bids?.[0]?.px);
      return px > 0 ? px : mid;
    } catch {
      return mid;
    }
  }

  /**
   * Place an IOC spot order for `tokenIn -> tokenOut`. Two modes:
   *  - MARKET (`maxEntryPrice` 0/undefined): marketable IOC priced off the book touch ± slippage.
   *  - LIMIT (`maxEntryPrice > 0` on a BUY): IOC capped at that price — fills now if the book is
   *    marketable at/under it, otherwise nothing fills and we throw "limit price not reached" (the
   *    pipeline logs that as a per-follower skip). This matches "execute as soon as posted".
   * Buys size the base from the quote notional; sells convert a held base amount. Returns the HL
   * order id (hex — HL has no per-order EVM tx hash) and the amount received in `tokenOut`'s 1e8 units.
   */
  async quoteAndSwap(args: {
    vault: Hex;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    slippageBps: number;
    maxEntryPrice?: bigint;
  }): Promise<{ txHash: Hex; received: bigint }> {
    // Resolve coin symbols FIRST (cheap), then validate against live spotMeta below.
    const coinIn = this.coinFor(args.tokenIn);
    const coinOut = this.coinFor(args.tokenOut);
    const meta = await this.meta();
    const pair = resolvePair(meta, coinIn, coinOut);
    assertSpotAsset(pair.assetId); // spot-only guard — refuse anything that isn't a spot asset

    const mids = await this.info.allMids();
    const midStr = mids[pair.midsKey] ?? mids[pair.pairName];
    if (!midStr) throw new Error(`hyperliquid: no mid price for ${pair.pairName}`);
    const mid = Number(midStr);

    // A MARKET order must cross the OPPOSITE side of the book, not the mid. On a wide/dislocated book
    // (common on testnet — e.g. a HYPE/USDC spread of 62.88/88.0 around a 75.44 mid) `mid ± slippage`
    // may never reach the touch, so the IOC cancels with "could not immediately match". Price off the
    // best ask (buy) / best bid (sell); `marketableIocPrice` then adds the slippage buffer on top so it
    // still crosses. LIMIT orders keep `mid` — their execution price is the explicit cap, not mid-derived.
    const isLimit = pair.isBuy && (args.maxEntryPrice ?? 0n) > 0n;
    const refPx = isLimit ? mid : await this.touchPrice(pair, pair.isBuy, mid);

    // Decide MARKET vs LIMIT and compute the rounded price/size (pure, unit-tested in meta.ts).
    const plan = planSpotOrder(pair, refPx, args.slippageBps, args.amountIn, args.maxEntryPrice ?? 0n);

    const res = await this.exchange.order({
      orders: [{ a: pair.assetId, b: pair.isBuy, p: plan.price, s: plan.size, r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    });

    const fill = extractFill(res); // null = no fill (IOC didn't cross / limit not reached)
    const filledBase = fill ? Number(fill.totalSz) : 0;
    if (!(filledBase > 0)) {
      if (plan.isLimit) {
        throw new Error(`hyperliquid: limit price ${unitsToNumber(args.maxEntryPrice as bigint)} not reached for ${pair.pairName} — no fill`);
      }
      throw new Error("hyperliquid: IOC order did not fill");
    }
    const avgPx = Number(fill!.avgPx);
    const received = pair.isBuy ? numberToUnits(filledBase) : numberToUnits(filledBase * avgPx);
    return { txHash: numberToHex(BigInt(fill!.oid)), received };
  }

  /**
   * Resolve a signal's `token` to its HL spot coin symbol. HL signals now carry the symbol directly
   * (e.g. "HYPE"), so we use it as-is; the optional `tokens` map is a legacy EVM-address→symbol
   * override (kept for back-compat). The returned symbol is validated against live spotMeta in
   * `resolvePair`/`findToken`, so an unknown coin still fails fast there.
   */
  private coinFor(token: string): string {
    return this.tokens[token.toLowerCase()] ?? token;
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

/**
 * Pull the fill out of an exchange `order` response. Returns `null` when nothing filled (IOC didn't
 * cross / resting), so the caller can distinguish "limit not reached" from a real error. Still throws
 * on an explicit HL `error` status.
 */
function extractFill(res: unknown): OrderFill | null {
  const status = (res as { response?: { data?: { statuses?: unknown[] } } }).response?.data?.statuses?.[0];
  if (status && typeof status === "object") {
    if ("filled" in status) return (status as { filled: OrderFill }).filled;
    if ("error" in status) throw new Error(`hyperliquid order error: ${String((status as { error: unknown }).error)}`);
  }
  return null; // resting / no fill
}

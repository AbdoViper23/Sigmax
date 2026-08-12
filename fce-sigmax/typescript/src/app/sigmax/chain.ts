/**
 * Coston2 chain context for the SIGNAL/EXECUTE handler: discover active subscribers, their vaults
 * and balances, and read the FTSO price — everything `processFlareSignal` needs that lives on-chain.
 *
 * All addresses come from env (set at container launch); with the registry/factory unset the handler
 * still round-trips (returns an empty, signed SwapAuth[] batch) so Phase 0a can gate before the
 * control plane is deployed.
 */

import { createPublicClient, http, parseAbi, parseAbiItem, type PublicClient } from "viem";
import type { FollowerBalance } from "./swap-auth.js";

export interface SigmaxChainConfig {
  rpcUrl: string;
  chainId: bigint;
  subscriptionRegistry?: `0x${string}`;
  vaultFactory?: `0x${string}`;
  router: `0x${string}`;
  ftsoV2: `0x${string}`;
  feedId: `0x${string}`; // bytes21 FTSO feed id (XRP/USD)
  slippageBps: number;
  deadlineSecs: number;
  subsFromBlock: bigint;
  /** Max blocks per eth_getLogs call. The public Coston2 RPC caps this at 30. */
  logWindow: bigint;

  // --- Hyperliquid venue (see docs/flare/02-hyperliquid-venue.md) ---
  /** Trade against the Hyperliquid testnet API. Defaults true — mainnet must be opted into explicitly. */
  hlTestnet: boolean;
  /**
   * Per-trade ceiling in uniform 1e8 units ($15 = 1_500_000_000). Hyperliquid has no on-chain vault
   * to read a cap from, so this config value IS the cap — it defaults to 0, which disables the venue
   * rather than trading unbounded. A missing cap must never mean "no limit".
   */
  hlPerTradeCapUnits: bigint;
  /**
   * How far the order book may deviate from the independent reference feed before we refuse to trade.
   * Only applied when a feed covers the coin.
   */
  hlMaxDeviationBps: number;
}

/** Read handler config from env with Coston2 defaults (addresses from docs/flare/reference/phase-0-findings.md). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SigmaxChainConfig {
  const addr = (v: string | undefined): `0x${string}` | undefined =>
    v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : undefined;

  /**
   * Treat an empty value as absent.
   *
   * `??` alone is not enough here: docker-compose renders `${VAR:-}` for an unset variable as the
   * *empty string*, which is not nullish, so `Number("") === 0` silently won. That turned an unset
   * `SIGMAX_SLIPPAGE_BPS` into **zero slippage tolerance** — every authorization demanded the exact
   * FTSO price, so the router rejected every swap with INSUFFICIENT_OUTPUT_AMOUNT and the vault
   * reported `SwapFailed()`. The signal, the signature and the sizing were all correct; only the
   * bound was impossible.
   */
  const str = (v: string | undefined, fallback: string): string =>
    v !== undefined && v.trim() !== "" ? v.trim() : fallback;

  return {
    rpcUrl: str(env.SIGMAX_RPC_URL, "https://coston2-api.flare.network/ext/C/rpc"),
    chainId: BigInt(str(env.SIGMAX_CHAIN_ID, "114")),
    subscriptionRegistry: addr(env.SIGMAX_SUBSCRIPTION_REGISTRY),
    vaultFactory: addr(env.SIGMAX_VAULT_FACTORY),
    router: addr(env.SIGMAX_ROUTER) ?? "0x8D29b61C41CF318d15d031BE2928F79630e068e6", // BlazeSwap
    ftsoV2: addr(env.SIGMAX_FTSO_V2) ?? "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d",
    feedId: str(env.SIGMAX_FEED_ID, "0x015852502f55534400000000000000000000000000") as `0x${string}`,
    slippageBps: Number(str(env.SIGMAX_SLIPPAGE_BPS, "100")),
    deadlineSecs: Number(str(env.SIGMAX_DEADLINE_SECS, "600")),
    subsFromBlock: BigInt(str(env.SIGMAX_SUBS_FROM_BLOCK, "0")),
    logWindow: BigInt(str(env.SIGMAX_LOG_WINDOW, "30")),

    // Only "false"/"0" disable testnet — an unset or malformed value must not silently point live
    // orders at mainnet. (`Boolean("false")` is `true`, which is exactly how that mistake happens.)
    hlTestnet: !["false", "0"].includes(str(env.SIGMAX_HL_TESTNET, "true").toLowerCase()),
    hlPerTradeCapUnits: BigInt(str(env.SIGMAX_HL_PER_TRADE_CAP, "0")),
    hlMaxDeviationBps: Number(str(env.SIGMAX_HL_MAX_DEVIATION_BPS, "500")),
  };
}

const SUBSCRIBED_EVENT = parseAbiItem(
  "event Subscribed(address indexed strategyId, address indexed subscriber, uint64 newExpiry, uint256 paid)",
);

const REGISTRY_ABI = parseAbi([
  "function isActive(address subscriber, address strategyId) view returns (bool)",
]);

const FACTORY_ABI = parseAbi(["function vaultOf(address follower) view returns (address)"]);

const VAULT_ABI = parseAbi(["function perTradeCap() view returns (uint256)"]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const FTSO_V2_ABI = parseAbi([
  "function getFeedById(bytes21 feedId) view returns (uint256 value, int8 decimals, uint64 timestamp)",
]);

export function makeClient(cfg: SigmaxChainConfig): PublicClient {
  return createPublicClient({ transport: http(cfg.rpcUrl) });
}

/** One follower ready for sizing: vault, tokenIn balance, and the vault's own per-trade cap. */
export interface FollowerContext extends FollowerBalance {
  perTradeCap: bigint;
}

/**
 * Collect distinct subscribers from `Subscribed` logs.
 *
 * Scans in windows because the public Coston2 RPC caps `eth_getLogs` at 30 blocks and answers a
 * wider range with "requested too many blocks" — which surfaced as the whole signal being rejected.
 * Windows are requested in parallel batches so a few thousand blocks stay well inside the
 * instruction's time budget. Point `SIGMAX_SUBS_FROM_BLOCK` at the registry's deploy block; a
 * dedicated RPC with a higher cap can raise `SIGMAX_LOG_WINDOW`.
 */
/**
 * Subscriber sets per strategy, with the block they were scanned up to.
 *
 * Rescanning the whole history on every signal blew the node's HTTP timeout for the action, which
 * the proxy reported as a pending (status 3) result — the authorization was correct but arrived too
 * late to be the answer. Each signal now scans only the blocks since the previous one. Subscriptions
 * are append-only (`Subscribed` is emitted on every renewal too, and expiry is re-checked via
 * `isActive` below), so a cached address can go inactive but can never be wrongly dropped.
 *
 * In-enclave memory only: it holds public addresses, never any part of a signal.
 */
const subscriberCache = new Map<string, { scannedTo: bigint; subscribers: Set<`0x${string}`> }>();

/**
 * Drop the cache. Wired into `resetSigmaxState()` so each test starts from a clean scan — otherwise
 * one test's subscriber set leaks into the next and the tests stop testing what they claim to.
 */
export function resetSubscriberCache(): void {
  subscriberCache.clear();
}

async function readSubscribers(
  client: PublicClient,
  cfg: SigmaxChainConfig,
  strategyId: `0x${string}`,
): Promise<`0x${string}`[]> {
  const head = await client.getBlockNumber();
  const cacheKey = `${cfg.subscriptionRegistry}:${strategyId}`.toLowerCase();
  const cached = subscriberCache.get(cacheKey);

  // Resume from just after the last scan; otherwise start at the configured floor.
  const from = cached ? cached.scannedTo + 1n : (cfg.subsFromBlock ?? 0n);
  if (head < from) return cached ? [...cached.subscribers] : [];

  const window = cfg.logWindow;
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = from; start <= head; start += window) {
    const end = start + window - 1n;
    ranges.push({ fromBlock: start, toBlock: end > head ? head : end });
  }

  const subscribers = cached ? cached.subscribers : new Set<`0x${string}`>();
  const BATCH = 30; // concurrent getLogs calls; the node's action timeout is the binding constraint
  for (let i = 0; i < ranges.length; i += BATCH) {
    const batches = await Promise.all(
      ranges.slice(i, i + BATCH).map((r) =>
        client.getLogs({
          address: cfg.subscriptionRegistry,
          event: SUBSCRIBED_EVENT,
          args: { strategyId },
          fromBlock: r.fromBlock,
          toBlock: r.toBlock,
        }),
      ),
    );
    for (const logs of batches) {
      for (const l of logs) if (l.args.subscriber) subscribers.add(l.args.subscriber);
    }
  }

  subscriberCache.set(cacheKey, { scannedTo: head, subscribers });
  return [...subscribers];
}

/**
 * The subscribers of `strategyId` whose subscription is currently paid up: Subscribed logs → dedupe
 * → `isActive` filter. Returns [] when the registry env is unset.
 *
 * Split out of `readActiveFollowers` because it is the half that is **venue-independent**. The Flare
 * path continues from here to the follower's vault; the Hyperliquid path needs the subscriber address
 * itself — a Hyperliquid account IS an EVM address, so the same addresses work unchanged on both
 * venues, with no mapping table and no second registry.
 */
export async function readActiveSubscribers(
  client: PublicClient,
  cfg: SigmaxChainConfig,
  strategyId: `0x${string}`,
): Promise<`0x${string}`[]> {
  if (!cfg.subscriptionRegistry) return [];

  const subscribers = await readSubscribers(client, cfg, strategyId);

  const active: `0x${string}`[] = [];
  for (const subscriber of subscribers) {
    const isActive = await client.readContract({
      address: cfg.subscriptionRegistry,
      abi: REGISTRY_ABI,
      functionName: "isActive",
      args: [subscriber, strategyId],
    });
    if (isActive) active.push(subscriber);
  }
  return active;
}

/**
 * Discover active followers of `strategyId` for the FLARE venue: active subscribers → vaultOf →
 * tokenIn balance + vault cap. Returns [] when the registry/factory env is unset.
 */
export async function readActiveFollowers(
  client: PublicClient,
  cfg: SigmaxChainConfig,
  strategyId: `0x${string}`,
  tokenIn: `0x${string}`,
): Promise<FollowerContext[]> {
  if (!cfg.subscriptionRegistry || !cfg.vaultFactory) return [];

  const subscribers = await readActiveSubscribers(client, cfg, strategyId);

  const followers: FollowerContext[] = [];
  for (const subscriber of subscribers) {
    const vault = await client.readContract({
      address: cfg.vaultFactory,
      abi: FACTORY_ABI,
      functionName: "vaultOf",
      args: [subscriber],
    });
    if (vault === "0x0000000000000000000000000000000000000000") continue;

    const [balance, perTradeCap] = await Promise.all([
      client.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] }),
      client.readContract({ address: vault, abi: VAULT_ABI, functionName: "perTradeCap" }),
    ]);
    followers.push({ vault, balance, perTradeCap });
  }
  return followers;
}

/** ERC-20 decimals for both legs of the swap. */
export async function readDecimals(
  client: PublicClient,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
): Promise<{ tokenInDecimals: number; tokenOutDecimals: number }> {
  const [tokenInDecimals, tokenOutDecimals] = await Promise.all([
    client.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: tokenOut, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  return { tokenInDecimals, tokenOutDecimals };
}

/** Fee-free FTSO block-latency read (XRP/USD by default). */
export async function readFtsoPrice(
  client: PublicClient,
  cfg: SigmaxChainConfig,
): Promise<{ value: bigint; decimals: number }> {
  const [value, decimals] = await client.readContract({
    address: cfg.ftsoV2,
    abi: FTSO_V2_ABI,
    functionName: "getFeedById",
    args: [cfg.feedId],
  });
  if (decimals < 0) throw new Error(`unsupported negative FTSO feed decimals: ${decimals}`);
  if (value <= 0n) throw new Error("FTSO feed returned a non-positive price");
  return { value, decimals: Number(decimals) };
}

/**
 * Invert a scaled price, keeping the same scale: given tokenB-per-tokenA scaled by 10^d,
 * return tokenA-per-tokenB scaled by 10^d. Used for ENTRY (quote → token) where the FTSO
 * feed quotes token-per-quote (XRP/USD).
 */
export function invertScaledPrice(value: bigint, decimals: number): bigint {
  return 10n ** BigInt(2 * decimals) / value;
}

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
}

/** Read handler config from env with Coston2 defaults (addresses from docs/flare/reference/phase-0-findings.md). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SigmaxChainConfig {
  const addr = (v: string | undefined): `0x${string}` | undefined =>
    v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : undefined;
  return {
    rpcUrl: env.SIGMAX_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc",
    chainId: BigInt(env.SIGMAX_CHAIN_ID ?? "114"),
    subscriptionRegistry: addr(env.SIGMAX_SUBSCRIPTION_REGISTRY),
    vaultFactory: addr(env.SIGMAX_VAULT_FACTORY),
    router: addr(env.SIGMAX_ROUTER) ?? "0x8D29b61C41CF318d15d031BE2928F79630e068e6", // BlazeSwap
    ftsoV2: addr(env.SIGMAX_FTSO_V2) ?? "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d",
    feedId: (env.SIGMAX_FEED_ID ?? "0x015852502f55534400000000000000000000000000") as `0x${string}`,
    slippageBps: Number(env.SIGMAX_SLIPPAGE_BPS ?? "100"),
    deadlineSecs: Number(env.SIGMAX_DEADLINE_SECS ?? "600"),
    subsFromBlock: BigInt(env.SIGMAX_SUBS_FROM_BLOCK ?? "0"),
    logWindow: BigInt(env.SIGMAX_LOG_WINDOW ?? "30"),
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
async function readSubscribers(
  client: PublicClient,
  cfg: SigmaxChainConfig,
  strategyId: `0x${string}`,
): Promise<`0x${string}`[]> {
  const head = await client.getBlockNumber();
  const from = cfg.subsFromBlock ?? 0n;
  if (head < from) return [];

  const window = cfg.logWindow;
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = from; start <= head; start += window) {
    const end = start + window - 1n;
    ranges.push({ fromBlock: start, toBlock: end > head ? head : end });
  }

  const subscribers = new Set<`0x${string}`>();
  const BATCH = 12; // concurrent getLogs calls; keeps us under provider rate limits
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
  return [...subscribers];
}

/**
 * Discover active followers of `strategyId`: Subscribed logs → dedupe → isActive filter →
 * vaultOf → tokenIn balance + vault cap. Returns [] when the registry/factory env is unset.
 */
export async function readActiveFollowers(
  client: PublicClient,
  cfg: SigmaxChainConfig,
  strategyId: `0x${string}`,
  tokenIn: `0x${string}`,
): Promise<FollowerContext[]> {
  if (!cfg.subscriptionRegistry || !cfg.vaultFactory) return [];

  const subscribers = await readSubscribers(client, cfg, strategyId);

  const followers: FollowerContext[] = [];
  for (const subscriber of subscribers) {
    const active = await client.readContract({
      address: cfg.subscriptionRegistry,
      abi: REGISTRY_ABI,
      functionName: "isActive",
      args: [subscriber, strategyId],
    });
    if (!active) continue;

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

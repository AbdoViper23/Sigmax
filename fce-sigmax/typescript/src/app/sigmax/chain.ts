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

  const logs = await client.getLogs({
    address: cfg.subscriptionRegistry,
    event: SUBSCRIBED_EVENT,
    args: { strategyId },
    fromBlock: cfg.subsFromBlock,
    toBlock: "latest",
  });
  const subscribers = [...new Set(logs.map((l) => l.args.subscriber!))];

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

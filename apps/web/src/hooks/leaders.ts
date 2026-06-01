import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Address } from "viem";
import { chainConfigReady, env } from "@/lib/env";
import { COPY_VAULT_ABI, COPY_VAULT_FACTORY_ABI, SUBSCRIPTION_REGISTRY_ABI } from "@/lib/abis";
import { mockLeaders } from "@/lib/mock";
import type { Leader, LeaderPerformance } from "@/lib/leaders";

const STORY = env.storyChainId;
const ARB = env.liquidityChainId;
const WIP_DECIMALS = 18;
const USDC_DECIMALS = 6;
const usdcNum = (x: bigint) => Number(formatUnits(x, USDC_DECIMALS));

type Swap = { tokenIn: Address; amountIn: bigint; tokenOut: Address; received: bigint };

/**
 * Per-vault FIFO realized PnL, accumulated across all of a leader's subscribers' vaults — mirrors
 * useStrategyPerformance (strategies.ts) but scoped to one leader. NOTE: a vault's `Swapped` events
 * carry no strategy tag, so when a follower copies more than one leader this attribution is an
 * approximation (correct in the common one-leader-per-follower case). Documented seam.
 */
function fifoStats(swapsByVault: Swap[][], usdc: string): LeaderPerformance {
  let realizedPnl = 0;
  let costBasis = 0;
  let closedTrades = 0;
  let wins = 0;
  for (const swaps of swapsByVault) {
    const openByToken = new Map<string, number[]>(); // token → FIFO queue of entry USDC
    for (const s of swaps) {
      if (s.tokenIn.toLowerCase() === usdc) {
        const q = openByToken.get(s.tokenOut.toLowerCase()) ?? [];
        q.push(usdcNum(s.amountIn));
        openByToken.set(s.tokenOut.toLowerCase(), q);
      } else if (s.tokenOut.toLowerCase() === usdc) {
        const entry = openByToken.get(s.tokenIn.toLowerCase())?.shift();
        if (entry !== undefined) {
          const exit = usdcNum(s.received);
          realizedPnl += exit - entry;
          costBasis += entry;
          closedTrades += 1;
          if (exit > entry) wins += 1;
        }
      }
    }
  }
  return {
    verifiedReturnPct: costBasis > 0 ? Number(((realizedPnl / costBasis) * 100).toFixed(2)) : null,
    winRatePct: closedTrades > 0 ? Math.round((wins / closedTrades) * 100) : null,
    maxDrawdownPct: null, // not derivable on-chain without an equity time series
    closedTrades,
  };
}

/**
 * The marketplace's source of leaders — discovered ENTIRELY from chain. `PlanCreated` (Story) yields
 * each leader + on-chain username/displayName/price; `Subscribed` (Story) gives the subscriber set;
 * per-leader track record is the FIFO realized PnL of those subscribers' vaults' `Swapped` events
 * (Arbitrum). When contracts aren't configured, falls back to the mock roster so the UI still renders.
 *
 * Return type matches Phase 1 (`Leader[]`), so routes/components are unchanged.
 */
export function useLeaders(): { leaders: Leader[]; loading: boolean } {
  const story = usePublicClient({ chainId: STORY });
  const arb = usePublicClient({ chainId: ARB });

  const q = useQuery({
    queryKey: ["leaders-onchain", env.registryAddress, env.factoryAddress],
    enabled: Boolean(story && arb && chainConfigReady && env.registryAddress && env.factoryAddress),
    staleTime: 30_000,
    queryFn: async (): Promise<Leader[]> => {
      if (!story || !arb || !env.registryAddress || !env.factoryAddress) return [];
      const usdc = env.usdc.toLowerCase();

      // 1. Leaders from PlanCreated (Story).
      const planLogs = await story.getContractEvents({
        address: env.registryAddress,
        abi: SUBSCRIPTION_REGISTRY_ABI,
        eventName: "PlanCreated",
        fromBlock: "earliest",
        toBlock: "latest",
      });

      // 2. Subscribers per strategy from Subscribed (Story).
      const subLogs = await story.getContractEvents({
        address: env.registryAddress,
        abi: SUBSCRIPTION_REGISTRY_ABI,
        eventName: "Subscribed",
        fromBlock: "earliest",
        toBlock: "latest",
      });
      const subsByStrategy = new Map<string, Set<string>>();
      for (const l of subLogs) {
        const { strategyId, subscriber } = l.args as { strategyId?: string; subscriber?: string };
        if (!strategyId || !subscriber) continue;
        const key = strategyId.toLowerCase();
        const set = subsByStrategy.get(key) ?? new Set<string>();
        set.add(subscriber.toLowerCase());
        subsByStrategy.set(key, set);
      }

      // 3. owner → vault from VaultCreated (Arbitrum).
      const vaultLogs = await arb.getContractEvents({
        address: env.factoryAddress,
        abi: COPY_VAULT_FACTORY_ABI,
        eventName: "VaultCreated",
        fromBlock: "earliest",
        toBlock: "latest",
      });
      const vaultByOwner = new Map<string, Address>();
      for (const l of vaultLogs) {
        const { owner, vault } = l.args as { owner?: Address; vault?: Address };
        if (owner && vault) vaultByOwner.set(owner.toLowerCase(), vault);
      }

      // Cache per-vault Swapped scans (a vault is shared if a follower copies several leaders).
      const swapsCache = new Map<string, Swap[]>();
      const vaultSwaps = async (vault: Address): Promise<Swap[]> => {
        const key = vault.toLowerCase();
        const cached = swapsCache.get(key);
        if (cached) return cached;
        const logs = await arb.getContractEvents({
          address: vault,
          abi: COPY_VAULT_ABI,
          eventName: "Swapped",
          fromBlock: "earliest",
          toBlock: "latest",
        });
        const swaps = logs.map((l) => l.args as Swap);
        swapsCache.set(key, swaps);
        return swaps;
      };

      const leaders: Leader[] = [];
      for (const p of planLogs) {
        const { strategyId, leader, monthlyPrice, username, displayName } = p.args as {
          strategyId?: Address;
          leader?: Address;
          monthlyPrice?: bigint;
          username?: string;
          displayName?: string;
        };
        if (!strategyId || !leader) continue;
        const subs = subsByStrategy.get(strategyId.toLowerCase()) ?? new Set<string>();
        const swapsByVault: Swap[][] = [];
        for (const sub of subs) {
          const vault = vaultByOwner.get(sub);
          if (vault) swapsByVault.push(await vaultSwaps(vault));
        }
        leaders.push({
          id: strategyId,
          leaderAddress: leader,
          username: username || strategyId.slice(0, 8),
          displayName: displayName || `Strategy ${strategyId.slice(0, 6)}…`,
          monthlyPriceWip: formatUnits(monthlyPrice ?? 0n, WIP_DECIMALS),
          performance: fifoStats(swapsByVault, usdc),
          subscribers: subs.size,
        });
      }
      return leaders;
    },
  });

  // Mock fallback only when contracts aren't configured (keeps dev/SSR rendering).
  if (!chainConfigReady) return { leaders: mockLeaders, loading: false };

  return { leaders: q.data ?? [], loading: q.isLoading };
}

/** Resolve a single leader by strategy id (route param). Undefined when no such leader exists. */
export function useLeader(id: string): { leader: Leader | undefined; loading: boolean } {
  const { leaders, loading } = useLeaders();
  const leader = leaders.find((l) => l.id.toLowerCase() === id.toLowerCase());
  return { leader, loading };
}

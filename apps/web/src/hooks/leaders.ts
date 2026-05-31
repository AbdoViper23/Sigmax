import { useMemo } from "react";
import { chainConfigReady, env } from "@/lib/env";
import { useStrategyStats } from "@/hooks/leader";
import { useStrategyPerformance } from "@/hooks/strategies";
import { getLeaderProfile, shortAddress } from "@/lib/leaderProfiles";
import { mockLeaders } from "@/lib/mock";
import type { Leader } from "@/lib/leaders";

/**
 * The marketplace's source of leaders. Phase 1 returns the mock roster PLUS the single configured
 * live strategy (so the demo's real leader shows live numbers among mock peers). The return shape is
 * the wiring contract — routes/components depend on `Leader[]` only.
 *
 * WIRING SEAM: replace the body with a `PlanCreated` event scan on `env.registryAddress` (one event
 * → one Leader), overlaying off-chain profiles via getLeaderProfile(). Return type stays identical.
 *
 * Note: `useStrategyStats()` / `useStrategyPerformance()` are called unconditionally and self-disable
 * when unconfigured (Rules of Hooks). For the configured strategy, performance today = that one
 * strategy's trades; the per-leader version (filtering vaults to a leader's subscribers) is a wiring
 * concern.
 */
export function useLeaders(): { leaders: Leader[]; loading: boolean } {
  const stats = useStrategyStats();
  const perf = useStrategyPerformance();

  const leaders = useMemo<Leader[]>(() => {
    const list: Leader[] = [];

    if (chainConfigReady && env.strategyIpId) {
      const profile = getLeaderProfile(env.strategyIpId);
      list.push({
        id: env.strategyIpId,
        leaderAddress: env.strategyIpId,
        username: profile?.username ?? shortAddress(env.strategyIpId),
        displayName: profile?.displayName ?? env.strategyName,
        monthlyPriceWip: profile?.monthlyPriceWip ?? "5",
        bio: profile?.bio,
        performance: {
          verifiedReturnPct: perf.verifiedReturnPct,
          winRatePct: perf.winRatePct,
          maxDrawdownPct: perf.maxDrawdownPct,
          closedTrades: perf.closedTrades,
        },
        subscribers: stats.subscribers,
      });
    }

    list.push(...mockLeaders);
    return list;
  }, [
    stats.subscribers,
    perf.verifiedReturnPct,
    perf.winRatePct,
    perf.maxDrawdownPct,
    perf.closedTrades,
  ]);

  return { leaders, loading: stats.loading || perf.loading };
}

/** Resolve a single leader by strategy id (route param). Undefined when no such leader exists. */
export function useLeader(id: string): { leader: Leader | undefined; loading: boolean } {
  const { leaders, loading } = useLeaders();
  const leader = leaders.find((l) => l.id.toLowerCase() === id.toLowerCase());
  return { leader, loading };
}

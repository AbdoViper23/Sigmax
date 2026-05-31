import { chainConfigReady, env } from "@/lib/env";
import { useStrategyStats } from "@/hooks/leader";
import type { LeaderboardRow } from "@/components/sigmax/LeaderboardTable";
import { mockLeaderboard, mockStrategy } from "@/lib/mock";

/**
 * Leaderboard rows. There is no on-chain registry of all strategies (and no PnL/win-rate on-chain,
 * no indexer), so when wired we surface the single configured strategy with its live subscriber
 * count; performance columns stay null (the table renders "—"). Off-chain → fall back to mock.
 */
export function useLeaderboard(): { rows: LeaderboardRow[]; loading: boolean } {
  const stats = useStrategyStats(); // hook must run unconditionally; it self-disables when unconfigured

  if (!chainConfigReady || !env.strategyIpId) {
    return { rows: mockLeaderboard, loading: false };
  }

  const row: LeaderboardRow = {
    id: env.strategyIpId,
    name: mockStrategy.name, // cosmetic — no strategy name is stored on-chain
    verifiedReturnPct: null,
    winRatePct: null,
    maxDrawdownPct: null,
    subscribers: stats.subscribers,
  };
  return { rows: [row], loading: stats.loading };
}

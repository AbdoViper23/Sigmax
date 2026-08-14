/**
 * Canonical leader/strategy shape consumed by the marketplace UI. One leader = one strategy = one
 * monthly price + a verified track record (CLAUDE.md product model). Routes and components depend on
 * THIS type only — today it's filled from mock data (see lib/mock.ts) + the single configured live
 * strategy, and the wiring phase swaps the source (PlanCreated events) without touching consumers.
 *
 * `username` / `displayName` have no on-chain home (PlanCreated only carries addresses + price), so
 * they live off-chain for now (lib/leaderProfiles.ts). See the wiring seams in the plan.
 */
import type { LeaderboardRow } from "@/components/sigmax/LeaderboardTable";

export interface LeaderPerformance {
  verifiedReturnPct: number | null;
  winRatePct: number | null;
  maxDrawdownPct: number | null;
  closedTrades: number;
}

export interface Leader {
  /** Strategy IP id (Hex). Route param for /strategy/$id and the subscribe key. */
  id: string;
  /** On-chain plan.leader address (mock today). */
  leaderAddress: string;
  /** Off-chain handle, e.g. "momentum_alpha". */
  username: string;
  /** Off-chain human title, e.g. "Momentum Alpha". */
  displayName: string;
  /** Human string; on-chain later as plan.monthlyPrice. */
  monthlyPrice: string;
  bio?: string;
  performance: LeaderPerformance;
  subscribers: number;
  /** Seeded demo leader — not a real on-chain track record. Surfaces a "Test" badge in the UI. */
  flaggedForTesting?: boolean;
}

/** Map a Leader to the existing LeaderboardRow so LeaderboardTable stays reusable as a table view. */
export function leaderToRow(l: Leader): LeaderboardRow {
  return {
    id: l.id,
    name: l.displayName,
    verifiedReturnPct: l.performance.verifiedReturnPct,
    winRatePct: l.performance.winRatePct,
    maxDrawdownPct: l.performance.maxDrawdownPct,
    subscribers: l.subscribers,
    flaggedForTesting: l.flaggedForTesting,
  };
}

/** Sort keys exposed by the browse grid header. */
export type LeaderSort = "return" | "subscribers" | "price";

export function sortLeaders(leaders: Leader[], by: LeaderSort): Leader[] {
  const arr = [...leaders];
  switch (by) {
    case "subscribers":
      return arr.sort((a, b) => b.subscribers - a.subscribers);
    case "price":
      return arr.sort((a, b) => Number(a.monthlyPrice) - Number(b.monthlyPrice));
    case "return":
    default:
      // nulls last, then descending verified return
      return arr.sort((a, b) => {
        const av = a.performance.verifiedReturnPct;
        const bv = b.performance.verifiedReturnPct;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return bv - av;
      });
  }
}

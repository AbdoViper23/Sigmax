import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface StrategyStatsCardProps {
  subscribers: number;
  signalsPublished: number;
  verifiedReturnPct: number | null;
  /** Cumulative leader take in $WIP — already transferred to the leader on each subscribe (no claim). */
  totalEarnedWip: string;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 font-mono text-2xl tabular-nums", accent && "text-success")}>
        {value}
      </div>
    </div>
  );
}

export function StrategyStatsCard({
  subscribers,
  signalsPublished,
  verifiedReturnPct,
  totalEarnedWip,
}: StrategyStatsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Performance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat label="Subscribers" value={subscribers.toString()} />
          <Stat label="Signals" value={signalsPublished.toString()} />
          <Stat
            label="Verified return"
            value={
              verifiedReturnPct === null
                ? "—"
                : `${verifiedReturnPct >= 0 ? "+" : ""}${verifiedReturnPct.toFixed(1)}%`
            }
            accent={verifiedReturnPct !== null && verifiedReturnPct >= 0}
          />
          <Stat label="Total earned" value={`${totalEarnedWip} WIP`} accent />
        </div>
        {/* Revenue is split to the leader's wallet automatically on every subscribe/renew
            (SubscriptionRegistry.subscribe) — there is nothing to claim. */}
        <p className="text-xs text-muted-foreground">
          Subscription revenue is paid to your wallet automatically on every subscribe & renewal — no
          claim needed.
        </p>
      </CardContent>
    </Card>
  );
}

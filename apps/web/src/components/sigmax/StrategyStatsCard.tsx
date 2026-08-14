import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { QUOTE_SYMBOL } from "@/lib/env";

export interface StrategyStatsCardProps {
  subscribers: number;
  signalsPublished: number;
  verifiedReturnPct: number | null;
  /**
   * Cumulative leader take, denominated in the plan's pay token (`QUOTE_SYMBOL`) — already
   * transferred to the leader on each subscribe, so there is no claim step.
   */
  totalEarned: string;
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 font-mono text-2xl tabular-nums", className)}>{value}</div>
    </div>
  );
}

export function StrategyStatsCard({
  subscribers,
  signalsPublished,
  verifiedReturnPct,
  totalEarned,
}: StrategyStatsCardProps) {
  const fresh = subscribers === 0 && signalsPublished === 0;
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
            className={
              verifiedReturnPct === null
                ? "text-muted-foreground"
                : verifiedReturnPct >= 0
                  ? "text-success"
                  : "text-danger"
            }
          />
          <Stat
            label="Total earned"
            value={`${totalEarned} ${QUOTE_SYMBOL}`}
            className="text-success"
          />
        </div>
        {fresh ? (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            Fresh desk — publish your first signal below to start your on-chain track record.
          </p>
        ) : (
          /* Revenue is split to the leader's wallet automatically on every subscribe/renew
             (SubscriptionRegistry.subscribe) — there is nothing to claim. */
          <p className="text-xs text-muted-foreground">
            Subscription revenue is paid to your wallet automatically on every subscribe & renewal —
            no claim needed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TxButton } from "./TxButton";
import { cn } from "@/lib/utils";

export interface StrategyStatsCardProps {
  subscribers: number;
  claimableWip: string;
  signalsPublished: number;
  verifiedReturnPct: number | null;
  onClaim: () => Promise<void>;
  claiming: boolean;
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
  claimableWip,
  signalsPublished,
  verifiedReturnPct,
  onClaim,
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
          <Stat label="Claimable" value={`${claimableWip} WIP`} />
        </div>
        <TxButton label="Claim revenue" pendingLabel="Claiming…" onClick={onClaim} />
      </CardContent>
    </Card>
  );
}

import { Card, CardContent } from "@/components/ui/card";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StrategyHeaderProps {
  name: string;
  verifiedReturnPct: number | null;
  winRatePct: number | null;
  maxDrawdownPct: number | null;
  subscribers: number;
  publishedSignals: { signalId: string; at: string; txUrl: string }[];
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "muted";
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-2xl tabular-nums",
          tone === "up" && "text-success",
          tone === "down" && "text-danger",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function StrategyHeader({
  name,
  verifiedReturnPct,
  winRatePct,
  maxDrawdownPct,
  subscribers,
  publishedSignals,
}: StrategyHeaderProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Verifiable track record. Every signal is committed on-chain before its outcome is known.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
          <ShieldCheck className="h-3.5 w-3.5" /> Commit-before-outcome
        </span>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-6 pt-6 sm:grid-cols-4">
          <Stat
            label="Verified return"
            value={
              verifiedReturnPct === null
                ? "—"
                : `${verifiedReturnPct >= 0 ? "+" : ""}${verifiedReturnPct.toFixed(1)}%`
            }
            tone={verifiedReturnPct === null ? "muted" : verifiedReturnPct >= 0 ? "up" : "down"}
          />
          <Stat label="Win rate" value={winRatePct === null ? "—" : `${winRatePct.toFixed(0)}%`} />
          <Stat
            label="Max drawdown"
            value={maxDrawdownPct === null ? "—" : `${maxDrawdownPct.toFixed(1)}%`}
          />
          <Stat label="Subscribers" value={subscribers.toString()} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-3 text-sm font-medium">Published signals (on-chain proof)</h2>
          <ul className="divide-y divide-border text-sm">
            {publishedSignals.map((s) => (
              <li key={s.signalId} className="flex items-center justify-between py-2">
                <code className="font-mono text-muted-foreground">{s.signalId}</code>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {new Date(s.at).toLocaleString()}
                  </span>
                  <a
                    href={s.txUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs hover:text-foreground"
                  >
                    proof <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

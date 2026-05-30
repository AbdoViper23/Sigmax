import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ExternalLink } from "lucide-react";

export interface PositionRow {
  id: string;
  pair: string;
  amountIn: string;
  currentValue: string;
  pnlPct: number;
  pnlUsd: string;
  openedAt: string;
  status: "open" | "closed";
  txUrl: string;
  closeReason?: "TP" | "SL" | "SIGNAL";
}

export interface PositionsTableProps {
  positions: PositionRow[];
  loading: boolean;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PositionsTable({ positions, loading }: PositionsTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Positions</CardTitle>
        <CardDescription>Outcomes only. Strategy thresholds are never shown.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : positions.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No positions yet. They'll appear here when the agent copies a trade.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 font-medium">Pair</th>
                  <th className="py-2 font-medium text-right">Amount in</th>
                  <th className="py-2 font-medium text-right">Value</th>
                  <th className="py-2 font-medium text-right">PnL</th>
                  <th className="py-2 font-medium">Opened</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium text-right">Tx</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id} className="border-b border-border/60 last:border-0">
                    <td className="py-3 font-medium">{p.pair}</td>
                    <td className="py-3 text-right font-mono tabular-nums">{p.amountIn}</td>
                    <td className="py-3 text-right font-mono tabular-nums">{p.currentValue}</td>
                    <td
                      className={cn(
                        "py-3 text-right font-mono tabular-nums",
                        p.pnlPct >= 0 ? "text-success" : "text-danger",
                      )}
                    >
                      {p.pnlUsd} ({p.pnlPct >= 0 ? "+" : ""}
                      {p.pnlPct.toFixed(2)}%)
                    </td>
                    <td className="py-3 text-muted-foreground">{fmtTime(p.openedAt)}</td>
                    <td className="py-3">
                      {p.status === "open" ? (
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className="h-1.5 w-1.5 rounded-full bg-success" /> Open
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" /> Closed
                          {p.closeReason && (
                            <span className="rounded bg-muted px-1.5 py-0.5">auto-exit</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <a
                        href={p.txUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

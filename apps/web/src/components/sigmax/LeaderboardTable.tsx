import { Link } from "@tanstack/react-router";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { TestBadge } from "./TestBadge";
import { cn } from "@/lib/utils";

export interface LeaderboardRow {
  id: string;
  name: string;
  verifiedReturnPct: number | null;
  winRatePct: number | null;
  maxDrawdownPct: number | null;
  subscribers: number;
  flaggedForTesting?: boolean;
}

export interface LeaderboardTableProps {
  rows: LeaderboardRow[];
  loading: boolean;
}

function pct(v: number | null, signed = false) {
  if (v === null) return "—";
  return `${signed && v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function LeaderboardTable({ rows, loading }: LeaderboardTableProps) {
  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          No strategies yet. Be the first.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="overflow-x-auto pt-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 font-medium">#</th>
              <th className="py-2 font-medium">Strategy</th>
              <th className="py-2 font-medium text-right">Return</th>
              <th className="py-2 font-medium text-right">Win rate</th>
              <th className="py-2 font-medium text-right">Max DD</th>
              <th className="py-2 font-medium text-right">Subs</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="border-b border-border/60 last:border-0">
                <td className="py-3 font-mono text-muted-foreground">{i + 1}</td>
                <td className="py-3 font-medium">
                  <span className="inline-flex items-center gap-2">
                    {r.name}
                    {r.flaggedForTesting && <TestBadge withIcon={false} />}
                  </span>
                </td>
                <td
                  className={cn(
                    "py-3 text-right font-mono tabular-nums",
                    r.verifiedReturnPct === null
                      ? "text-muted-foreground"
                      : r.verifiedReturnPct >= 0
                        ? "text-success"
                        : "text-danger",
                  )}
                >
                  {pct(r.verifiedReturnPct, true)}
                </td>
                <td className="py-3 text-right font-mono tabular-nums">{pct(r.winRatePct)}</td>
                <td className="py-3 text-right font-mono tabular-nums">{pct(r.maxDrawdownPct)}</td>
                <td className="py-3 text-right font-mono tabular-nums">{r.subscribers}</td>
                <td className="py-3 text-right">
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/strategy/$id" params={{ id: r.id }}>
                      View
                    </Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import type { Hex } from "viem";
import { ArrowUpRight, Check, Loader2, ShieldCheck, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TestBadge } from "./TestBadge";
import { cn } from "@/lib/utils";
import { useCopyTrade } from "@/hooks/follower";
import type { Leader } from "@/lib/leaders";

/** Monogram seeded from the leader handle — same square-badge idiom as the Nav logo. */
function Monogram({ seed }: { seed: string }) {
  const letter = seed.trim().charAt(0).toUpperCase() || "Σ";
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-foreground text-background">
      <span className="text-sm font-bold">{letter}</span>
    </span>
  );
}

function pct(v: number | null, signed = false) {
  if (v === null) return "—";
  return `${signed && v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-lg tabular-nums", className)}>{value}</div>
    </div>
  );
}

export function LeaderCard({ leader }: { leader: Leader }) {
  const ret = leader.performance.verifiedReturnPct;
  const test = leader.flaggedForTesting;
  return (
    <Card
      className={cn(
        "group flex flex-col transition-colors hover:border-primary/40",
        test && "border-dashed border-warning/40 hover:border-warning/60",
      )}
    >
      <CardContent className="flex flex-1 flex-col gap-4 pt-6">
        {/* Identity */}
        <div className="flex items-start gap-3">
          <Monogram seed={leader.username} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate font-semibold tracking-tight">{leader.displayName}</h3>
              {test ? (
                <TestBadge withIcon={false} className="shrink-0" />
              ) : (
                <ShieldCheck
                  className="h-3.5 w-3.5 shrink-0 text-success"
                  aria-label="Verified track record"
                />
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">@{leader.username}</p>
          </div>
          <span className="shrink-0 rounded-full border border-border bg-muted/40 px-2.5 py-1 font-mono text-xs tabular-nums">
            {leader.monthlyPriceWip} WIP<span className="text-muted-foreground">/mo</span>
          </span>
        </div>

        {leader.bio && <p className="line-clamp-2 text-sm text-muted-foreground">{leader.bio}</p>}

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 border-t border-border/60 pt-4">
          <Stat
            label="Return"
            value={pct(ret, true)}
            className={
              ret === null ? "text-muted-foreground" : ret >= 0 ? "text-success" : "text-danger"
            }
          />
          <Stat label="Win rate" value={pct(leader.performance.winRatePct)} />
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Subs</div>
            <div className="mt-0.5 flex items-center gap-1 font-mono text-lg tabular-nums">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              {leader.subscribers}
            </div>
          </div>
        </div>

        {/* CTA — one-click subscribe right here, plus a link to the full strategy page */}
        <CardCta leader={leader} />
      </CardContent>
    </Card>
  );
}

/**
 * Quick subscribe directly from the card: one click runs the chained subscribe + agent-authorize
 * (useCopyTrade). Shows a "Subscribed" state when already active so the leaderboard doubles as an
 * at-a-glance view of who you're copying. The full strategy page stays one tap away.
 */
function CardCta({ leader }: { leader: Leader }) {
  const copy = useCopyTrade(leader.id as Hex);
  const [busy, setBusy] = useState(false);

  if (copy.active) {
    return (
      <div className="mt-auto flex items-center gap-2">
        <span className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm font-medium text-success">
          <Check className="h-4 w-4" /> Subscribed
        </span>
        <Button asChild variant="outline">
          <Link
            to="/strategy/$id"
            params={{ id: leader.id }}
            aria-label={`View ${leader.displayName}`}
          >
            View
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-auto flex items-center gap-2">
      <Button
        type="button"
        className="flex-1"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await copy.start();
            toast.success(`You're now copying ${leader.displayName}`);
          } catch {
            /* useCopyTrade already surfaced the error via toast */
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Starting…
          </>
        ) : (
          "Subscribe"
        )}
      </Button>
      <Button asChild variant="outline">
        <Link
          to="/strategy/$id"
          params={{ id: leader.id }}
          aria-label={`View ${leader.displayName}`}
        >
          View
          <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </Link>
      </Button>
    </div>
  );
}

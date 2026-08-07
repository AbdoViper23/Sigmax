import { Activity } from "lucide-react";
import { useFtsoXrpUsd } from "@/hooks/flare";
import { cn } from "@/lib/utils";

/**
 * Live XRP/USD from Flare's FTSO — the same oracle reading that bounds `minOut` inside the enclave.
 * Showing it makes the execution guarantee legible: the follower can see the price their swap floor
 * is derived from, without the strategy being revealed.
 */
export function FtsoPriceBadge({ className }: { className?: string }) {
  const { price, loading } = useFtsoXrpUsd();

  if (loading && !price) {
    return (
      <div
        className={cn(
          "inline-flex h-7 items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3",
          className,
        )}
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/50" aria-hidden />
        <span className="text-xs text-muted-foreground">Reading FTSO…</span>
      </div>
    );
  }

  if (!price) return null;

  const age = Math.max(0, Math.floor(Date.now() / 1000) - price.timestamp);

  return (
    <div
      className={cn(
        "inline-flex h-7 items-center gap-2 rounded-full border border-border/60 bg-card/60 px-3",
        className,
      )}
      title={`FTSO block-latency feed, updated ${age}s ago`}
    >
      <Activity className="h-3.5 w-3.5 text-success" aria-hidden />
      <span className="text-xs text-muted-foreground">FTSO XRP/USD</span>
      <span className="font-mono text-xs tabular-nums">
        ${Number(price.formatted).toFixed(4)}
      </span>
    </div>
  );
}

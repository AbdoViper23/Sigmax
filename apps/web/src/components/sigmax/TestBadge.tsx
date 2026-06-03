import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Marks a leader/strategy as seeded test data (not a real on-chain track record). Rendered wherever a
 * flagged leader surfaces — leaderboard card, table row, and strategy header — so demo data is never
 * mistaken for verified, on-chain performance. Tied to `Leader.flaggedForTesting` (see lib/mock.ts).
 */
export function TestBadge({
  className,
  withIcon = true,
}: {
  className?: string;
  withIcon?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning",
        className,
      )}
      title="Seeded test data — not a verified on-chain track record"
    >
      {withIcon && <FlaskConical className="h-3 w-3" aria-hidden />}
      Test
    </span>
  );
}

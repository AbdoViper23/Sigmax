import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { LayoutGrid, List, Search, X } from "lucide-react";
import { LeaderboardTable } from "@/components/sigmax/LeaderboardTable";
import { LeaderCard } from "@/components/sigmax/LeaderCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useLeaders } from "@/hooks/leaders";
import { leaderToRow, sortLeaders, type LeaderSort } from "@/lib/leaders";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaders — Sigmax" },
      { name: "description", content: "Browse verified copy-trading leaders on Sigmax." },
      { property: "og:title", content: "Leaders — Sigmax" },
      { property: "og:description", content: "Browse verified copy-trading leaders on Sigmax." },
    ],
  }),
  component: LeaderboardPage,
});

const SORTS: { key: LeaderSort; label: string }[] = [
  { key: "return", label: "Top return" },
  { key: "subscribers", label: "Most followed" },
  { key: "price", label: "Lowest price" },
];

function LeaderboardPage() {
  const { leaders, loading } = useLeaders();
  const [sort, setSort] = useState<LeaderSort>("return");
  const [view, setView] = useState<"grid" | "table">("grid");
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => {
    const base = sortLeaders(leaders, sort);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    // Match by either display name or @username.
    return base.filter(
      (l) => l.displayName.toLowerCase().includes(q) || l.username.toLowerCase().includes(q),
    );
  }, [leaders, sort, query]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Leaders</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a leader and copy their spot trades in your own non-custodial vault. Every metric
            is computed from on-chain proofs — leaders with fewer than 10 closed trades show "—".
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/leader">Become a leader</Link>
        </Button>
      </div>

      {/* Search by name or @username */}
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search leaders by name or @username…"
          aria-label="Search leaders by name or username"
          className="h-11 pl-9 pr-9"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Controls: sort segmented control + grid/table toggle */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSort(s.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                sort === s.key
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
          <button
            onClick={() => setView("grid")}
            aria-label="Grid view"
            className={cn(
              "grid h-8 w-8 place-items-center rounded-md transition-colors",
              view === "grid"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setView("table")}
            aria-label="Table view"
            className={cn(
              "grid h-8 w-8 place-items-center rounded-md transition-colors",
              view === "table"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-56 w-full rounded-xl" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-muted/20 py-16 text-center text-sm text-muted-foreground">
          {query.trim()
            ? `No leaders match "${query.trim()}".`
            : "No leaders yet. Be the first to register."}
        </div>
      ) : view === "grid" ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((l) => (
            <LeaderCard key={l.id} leader={l} />
          ))}
        </div>
      ) : (
        <LeaderboardTable rows={sorted.map(leaderToRow)} loading={false} />
      )}
    </main>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { LeaderboardTable } from "@/components/sigmax/LeaderboardTable";
import { mockLeaderboard } from "@/lib/mock";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaderboard — Sigmax" },
      { name: "description", content: "Verified track records of every strategy on Sigmax." },
      { property: "og:title", content: "Leaderboard — Sigmax" },
      {
        property: "og:description",
        content: "Verified track records of every strategy on Sigmax.",
      },
    ],
  }),
  component: LeaderboardPage,
});

function LeaderboardPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Leaderboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every metric is computed from on-chain proofs. Strategies with fewer than 10 signals show
          "—".
        </p>
      </div>
      <LeaderboardTable rows={mockLeaderboard} loading={false} />
    </main>
  );
}

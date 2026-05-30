import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { StrategyHeader } from "@/components/sigmax/StrategyHeader";
import { mockLeaderboard, mockPublishedSignals } from "@/lib/mock";

export const Route = createFileRoute("/strategy/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Strategy ${params.id} — Sigmax` },
      {
        name: "description",
        content: "Verified track record and on-chain signal proofs for this strategy.",
      },
    ],
  }),
  component: StrategyPage,
});

function StrategyPage() {
  const { id } = Route.useParams();
  const strat = mockLeaderboard.find((s) => s.id === id) ?? mockLeaderboard[0];
  if (!strat) throw notFound();

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <StrategyHeader
        name={strat.name}
        verifiedReturnPct={strat.verifiedReturnPct}
        winRatePct={strat.winRatePct}
        maxDrawdownPct={strat.maxDrawdownPct}
        subscribers={strat.subscribers}
        publishedSignals={mockPublishedSignals}
      />
      <div className="mt-8 flex justify-end">
        <Button asChild size="lg">
          <Link to="/follower">Follow this strategy</Link>
        </Button>
      </div>
    </main>
  );
}

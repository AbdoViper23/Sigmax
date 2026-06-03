import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { Hex } from "viem";
import { Button } from "@/components/ui/button";
import { StrategyHeader } from "@/components/sigmax/StrategyHeader";
import { SubscribeCard } from "@/components/sigmax/SubscribeCard";
import { PositionsTable } from "@/components/sigmax/PositionsTable";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { chainConfigReady, env } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import { useCopyTrade } from "@/hooks/follower";
import { useLeader } from "@/hooks/leaders";
import { getPublishedSignals } from "@/lib/publishedSignals";
import { mockLeaderPositions } from "@/lib/mock";
import type { Leader } from "@/lib/leaders";

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
  const { leader, loading } = useLeader(id);

  if (!leader) {
    return loading ? <StrategyLoading /> : <StrategyNotFound />;
  }
  return <StrategyDetail leader={leader} id={id} />;
}

// ───────────────────────── detail (real subscribe on Story) ─────────────────────────

function StrategyDetail({ leader, id }: { leader: Leader; id: string }) {
  const net = useNetwork();
  const copy = useCopyTrade(id as Hex);

  // Real publish history recorded by this browser (non-secret metadata only — no TP/SL).
  const publishedSignals = getPublishedSignals(id).map((s) => ({
    signalId: s.uuid !== undefined ? `CDR vault #${s.uuid}` : s.signalId,
    at: s.at,
    txUrl: env.explorers.story,
  }));

  // Plan price comes from the registry read; fall back to the leader's PlanCreated price.
  const priceWip = Number(copy.monthlyPriceWip) > 0 ? copy.monthlyPriceWip : leader.monthlyPriceWip;

  const subscribeArea = (
    <NetworkSwitchPrompt
      requiredChain="story"
      current={net.current}
      onSwitch={() => net.switchTo("story")}
    >
      <SubscribeCard
        strategyName={leader.displayName}
        monthlyPriceWip={priceWip}
        status={copy.active ? "active" : "idle"}
        activeUntil={copy.activeUntil}
        pendingLabel={copy.phase === "authorizing" ? "Authorizing…" : "Subscribing…"}
        onSubscribe={async () => {
          await copy.start();
          toast.success(`You're now copying ${leader.displayName}`);
        }}
      />
    </NetworkSwitchPrompt>
  );

  // Track record of recent trades. Real per-leader trade history is computed for the aggregate stats
  // above; the example trade rows render in the mock fallback (no contracts configured) — and always
  // for seeded test leaders, whose whole point is to demo a populated track record even when live.
  const trades =
    leader.flaggedForTesting || !chainConfigReady
      ? mockLeaderPositions[leader.id.toLowerCase()]
      : undefined;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <StrategyHeader
        name={leader.displayName}
        username={leader.username}
        bio={leader.bio}
        verifiedReturnPct={leader.performance.verifiedReturnPct}
        winRatePct={leader.performance.winRatePct}
        maxDrawdownPct={leader.performance.maxDrawdownPct}
        subscribers={leader.subscribers}
        publishedSignals={publishedSignals}
        flaggedForTesting={leader.flaggedForTesting}
      />
      {/* Subscribe sits up top at a constrained width; the trades table gets the full row below. */}
      <div className="mt-10 lg:max-w-xl">{subscribeArea}</div>
      {trades && trades.length > 0 && (
        <div className="mt-10">
          <PositionsTable positions={trades} loading={false} />
        </div>
      )}
    </main>
  );
}

// ───────────────────────── loading / not-found ─────────────────────────

function StrategyLoading() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-20 text-center text-sm text-muted-foreground">
      Loading strategy…
    </main>
  );
}

function StrategyNotFound() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-20 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Strategy not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We couldn't find a leader with that id. Browse all leaders on the leaderboard.
      </p>
      <div className="mt-6 flex justify-center">
        <Button asChild>
          <Link to="/leaderboard">Back to leaders</Link>
        </Button>
      </div>
    </main>
  );
}

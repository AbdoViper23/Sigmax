import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { Hex } from "viem";
import { Button } from "@/components/ui/button";
import { StrategyHeader } from "@/components/sigmax/StrategyHeader";
import { SubscribeCard } from "@/components/sigmax/SubscribeCard";
import { PositionsTable } from "@/components/sigmax/PositionsTable";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { flareConfigReady, env } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import { useFlareLeader, useFlareLeaderStats, useFlareSubscription } from "@/hooks/flareControlPlane";
import { getPublishedSignals, signalProofs } from "@/lib/publishedSignals";
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
  const { leader, loading } = useFlareLeader(id);

  if (!leader) {
    return loading ? <StrategyLoading /> : <StrategyNotFound />;
  }
  return <StrategyDetail leader={leader} id={id} />;
}

// ───────────────────────── detail (real subscribe on Coston2) ─────────────────────────

function StrategyDetail({ leader, id }: { leader: Leader; id: string }) {
  const net = useNetwork();
  const sub = useFlareSubscription(id as Hex);
  /*
   * The roster (`listPlans`) carries no labels or metrics — those need log history, and folding them
   * into the roster read is what made the leaderboard hang. So they load here, per strategy, and the
   * page renders immediately with the truncated id until they arrive.
   */
  const { stats } = useFlareLeaderStats(leader.flaggedForTesting ? undefined : id);
  const displayName = stats?.displayName || leader.displayName;
  const username = stats?.username || leader.username;
  const performance = stats?.performance ?? leader.performance;
  const subscribers = stats?.subscribers ?? leader.subscribers;

  /**
   * The publish history this browser recorded. It is deliberately thin: there is no on-chain
   * enumeration of a strategy's signals, and the only thing worth showing is the proof that a
   * commitment landed BEFORE the outcome was known. Nothing about the strategy itself is here.
   */
  const publishedSignals = getPublishedSignals(id).map((s) => ({
    signalId: s.ciphertextBytes ? `${s.signalId.slice(0, 8)}… (${s.ciphertextBytes} bytes)` : s.signalId,
    at: s.at,
    proofs: signalProofs(s, env.explorers.flare),
  }));

  // Registry read wins; the PlanCreated price is the fallback while it loads.
  const price = Number(sub.monthlyPrice) > 0 ? sub.monthlyPrice : leader.monthlyPrice;

  const subscribeArea = (
    <NetworkSwitchPrompt
      requiredChain="flare"
      current={net.current}
      onSwitch={() => net.switchTo("flare")}
    >
      <SubscribeCard
        strategyName={displayName}
        monthlyPrice={price}
        status={sub.active ? "active" : "idle"}
        activeUntil={sub.expiresAt > 0 ? new Date(sub.expiresAt * 1000).toISOString() : undefined}
        pendingLabel="Subscribing…"
        onSubscribe={async () => {
          await sub.subscribe();
          toast.success(`You're now copying ${displayName}`);
        }}
      />
    </NetworkSwitchPrompt>
  );

  // Track record of recent trades. Real per-leader trade history is computed for the aggregate stats
  // above; the example trade rows render in the mock fallback (no contracts configured) — and always
  // for seeded test leaders, whose whole point is to demo a populated track record even when live.
  const trades =
    leader.flaggedForTesting || !flareConfigReady
      ? mockLeaderPositions[leader.id.toLowerCase()]
      : undefined;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <StrategyHeader
        name={displayName}
        username={username}
        bio={leader.bio}
        verifiedReturnPct={performance.verifiedReturnPct}
        winRatePct={performance.winRatePct}
        maxDrawdownPct={performance.maxDrawdownPct}
        subscribers={subscribers}
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

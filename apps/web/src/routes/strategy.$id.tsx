import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import type { Hex } from "viem";
import { Button } from "@/components/ui/button";
import { StrategyHeader } from "@/components/sigmax/StrategyHeader";
import { SubscribeCard } from "@/components/sigmax/SubscribeCard";
import { PositionsTable } from "@/components/sigmax/PositionsTable";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { chainConfigReady, env } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import { useSubscription } from "@/hooks/follower";
import { useLeader } from "@/hooks/leaders";
import { getPublishedSignals } from "@/lib/publishedSignals";
import { mockLeaderPositions, mockTx } from "@/lib/mock";
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

// ───────────────────────── detail (live for the configured leader, mock otherwise) ─────────────────────────

function StrategyDetail({ leader, id }: { leader: Leader; id: string }) {
  const net = useNetwork();

  // Only the single configured strategy is wired to real on-chain subscribe; mock leaders use a
  // simulated subscribe so the browse → subscribe flow is walkable without contracts (Phase 1).
  const isLive =
    chainConfigReady &&
    Boolean(env.strategyIpId) &&
    id.toLowerCase() === env.strategyIpId!.toLowerCase();

  const sub = useSubscription(isLive ? (id as Hex) : undefined);
  const [mockStatus, setMockStatus] = useState<"idle" | "subscribing" | "active">("idle");

  // Real publish history recorded by this browser (non-secret metadata only — no TP/SL).
  const publishedSignals = getPublishedSignals(id).map((s) => ({
    signalId: s.uuid !== undefined ? `CDR vault #${s.uuid}` : s.signalId,
    at: s.at,
    txUrl: env.explorers.story,
  }));

  const priceWip =
    isLive && Number(sub.monthlyPriceWip) > 0 ? sub.monthlyPriceWip : leader.monthlyPriceWip;
  const status = isLive ? sub.status : mockStatus;
  const activeUntil = isLive
    ? sub.activeUntil
    : mockStatus === "active"
      ? new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString()
      : undefined;

  const onSubscribe = async () => {
    if (isLive) {
      await sub.subscribe();
      toast.success("Subscribed");
      return;
    }
    setMockStatus("subscribing");
    await mockTx();
    setMockStatus("active");
    toast.success(`Following ${leader.displayName} — demo`);
  };

  const subscribeCard = (
    <SubscribeCard
      strategyName={leader.displayName}
      monthlyPriceWip={priceWip}
      status={status}
      activeUntil={activeUntil}
      onSubscribe={onSubscribe}
    />
  );

  const subscribeArea = isLive ? (
    <NetworkSwitchPrompt
      requiredChain="story"
      current={net.current}
      onSwitch={() => net.switchTo("story")}
    >
      {subscribeCard}
    </NetworkSwitchPrompt>
  ) : (
    subscribeCard
  );

  // Track record of recent trades. Per-leader on-chain trade history is a wiring-phase concern, so
  // only mock leaders show example trades here today (the live strategy shows its verified stats above).
  const trades = isLive ? undefined : mockLeaderPositions[leader.id.toLowerCase()];

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

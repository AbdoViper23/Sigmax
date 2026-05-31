import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { Hex } from "viem";
import { Button } from "@/components/ui/button";
import { StrategyHeader } from "@/components/sigmax/StrategyHeader";
import { SubscribeCard } from "@/components/sigmax/SubscribeCard";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { chainConfigReady, env } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import { useSubscription } from "@/hooks/follower";
import { useStrategyStats } from "@/hooks/leader";
import { useStrategyPerformance } from "@/hooks/strategies";
import { getPublishedSignals } from "@/lib/publishedSignals";

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
  const isConfigured =
    chainConfigReady &&
    Boolean(env.strategyIpId) &&
    id.toLowerCase() === env.strategyIpId!.toLowerCase();
  return isConfigured ? <StrategyLive id={env.strategyIpId as Hex} /> : <StrategyNotFound />;
}

// ───────────────────────── live (real web3) ─────────────────────────

function StrategyLive({ id }: { id: Hex }) {
  const net = useNetwork();
  const sub = useSubscription(id);
  const stats = useStrategyStats();
  const perf = useStrategyPerformance();

  // Real publish history recorded by this browser (non-secret metadata only — no TP/SL).
  const publishedSignals = getPublishedSignals(id).map((s) => ({
    signalId: s.uuid !== undefined ? `CDR vault #${s.uuid}` : s.signalId,
    at: s.at,
    txUrl: env.explorers.story,
  }));

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      {/* Subscribers + performance are all on-chain derived; drawdown shows "—" (no equity series). */}
      <StrategyHeader
        name={env.strategyName}
        verifiedReturnPct={perf.verifiedReturnPct}
        winRatePct={perf.winRatePct}
        maxDrawdownPct={perf.maxDrawdownPct}
        subscribers={stats.subscribers}
        publishedSignals={publishedSignals}
      />
      <div className="mt-8 max-w-md">
        <NetworkSwitchPrompt
          requiredChain="story"
          current={net.current}
          onSwitch={() => net.switchTo("story")}
        >
          <SubscribeCard
            strategyName={env.strategyName}
            monthlyPriceWip={sub.monthlyPriceWip}
            status={sub.status}
            activeUntil={sub.activeUntil}
            onSubscribe={async () => {
              await sub.subscribe();
              toast.success("Subscribed");
            }}
          />
        </NetworkSwitchPrompt>
      </div>
    </main>
  );
}

// ───────────── unknown strategy (single-strategy MVP: only the configured one exists) ─────────────

function StrategyNotFound() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-20 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Strategy not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This deployment runs a single configured strategy. Browse it on the leaderboard.
      </p>
      <div className="mt-6 flex justify-center">
        <Button asChild>
          <Link to="/leaderboard">Back to leaderboard</Link>
        </Button>
      </div>
    </main>
  );
}

import { createFileRoute, Link, notFound } from "@tanstack/react-router";
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
import { mockLeaderboard, mockPublishedSignals, mockStrategy } from "@/lib/mock";

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
  return isConfigured ? <StrategyLive id={env.strategyIpId as Hex} /> : <StrategyMock id={id} />;
}

// ───────────────────────── live (real web3) ─────────────────────────

function StrategyLive({ id }: { id: Hex }) {
  const net = useNetwork();
  const sub = useSubscription(id);
  const stats = useStrategyStats();

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      {/* Subscribers is live (event-derived); performance is off-chain (no indexer) → "—". */}
      <StrategyHeader
        name={mockStrategy.name}
        verifiedReturnPct={null}
        winRatePct={null}
        maxDrawdownPct={null}
        subscribers={stats.subscribers}
        publishedSignals={mockPublishedSignals}
      />
      <div className="mt-8 max-w-md">
        <NetworkSwitchPrompt
          requiredChain="story"
          current={net.current}
          onSwitch={() => net.switchTo("story")}
        >
          <SubscribeCard
            strategyName={mockStrategy.name}
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

// ───────────────────────── mock (no wallet / no env) ─────────────────────────

function StrategyMock({ id }: { id: string }) {
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

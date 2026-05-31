import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import { RegisterStrategyCard } from "@/components/sigmax/RegisterStrategyCard";
import { PublishSignalForm } from "@/components/sigmax/PublishSignalForm";
import { StrategyStatsCard } from "@/components/sigmax/StrategyStatsCard";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { chainConfigReady, env, publishableTokens } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import { useLeaderPlan, usePublishSignal, useStrategyStats } from "@/hooks/leader";
import { useStrategyPerformance } from "@/hooks/strategies";
import { addPublishedSignal, getPublishedSignals } from "@/lib/publishedSignals";

export const Route = createFileRoute("/leader")({
  head: () => ({
    meta: [
      { title: "Leader dashboard — Sigmax" },
      {
        name: "description",
        content: "Register a strategy and publish encrypted signals on Story Aeneid.",
      },
    ],
  }),
  component: LeaderPage,
});

function LeaderPage() {
  const { isConnected } = useAccount();
  // Live when contracts are configured (VITE_* env) AND a wallet is connected; else mock for dev/SSR.
  return chainConfigReady && isConnected ? <LeaderLive /> : <LeaderMock />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Leader dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Register once. Publish encrypted signals on Story Aeneid. Revenue is paid to your wallet
          automatically.
        </p>
      </div>
      {children}
    </main>
  );
}

// ───────────────────────── live (real web3) ─────────────────────────

function LeaderLive() {
  const net = useNetwork();
  const plan = useLeaderPlan();
  const stats = useStrategyStats();
  const perf = useStrategyPerformance();
  const { publish } = usePublishSignal();
  const [publishing, setPublishing] = useState(false);
  const [signals, setSignals] = useState(() => getPublishedSignals(env.strategyIpId));

  const lastPublished = signals[0]
    ? {
        signalId:
          signals[0].uuid !== undefined ? `CDR vault #${signals[0].uuid}` : signals[0].signalId,
        txUrl: env.explorers.story,
        at: signals[0].at,
      }
    : undefined;

  return (
    <Shell>
      <div className="grid gap-6 lg:grid-cols-2">
        <NetworkSwitchPrompt
          requiredChain="story"
          current={net.current}
          onSwitch={() => net.switchTo("story")}
        >
          <RegisterStrategyCard
            registered={plan.registered}
            ipId={plan.ipId}
            onRegister={async (v) => {
              await plan.createPlan(v);
              toast.success(`Plan created for "${v.name}"`);
            }}
          />
        </NetworkSwitchPrompt>

        {/* All real: subscribers + total earned from Subscribed events; return from on-chain trades. */}
        <StrategyStatsCard
          subscribers={stats.subscribers}
          signalsPublished={signals.length}
          verifiedReturnPct={perf.verifiedReturnPct}
          totalEarnedWip={stats.totalEarnedWip}
        />
      </div>

      <NetworkSwitchPrompt
        requiredChain="story"
        current={net.current}
        onSwitch={() => net.switchTo("story")}
      >
        <PublishSignalForm
          tokenOptions={publishableTokens}
          publishing={publishing}
          lastPublished={lastPublished}
          onPublish={async (v) => {
            setPublishing(true);
            try {
              const r = await publish(v);
              setSignals(
                addPublishedSignal(env.strategyIpId, {
                  signalId: r.signalId,
                  uuid: r.uuid,
                  action: v.action,
                  at: r.at,
                }),
              );
              toast.success(`${v.action} signal published`);
            } finally {
              setPublishing(false);
            }
          }}
        />
      </NetworkSwitchPrompt>
    </Shell>
  );
}

// ───────────── disconnected / unconfigured (connect-wallet prompt state) ─────────────

function LeaderMock() {
  const currentChain = "story" as const;
  const noop = async () => {};

  return (
    <Shell>
      <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
        Connect your wallet on Story Aeneid to register your strategy and publish signals. Live
        stats appear once connected.
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <NetworkSwitchPrompt requiredChain="story" current={currentChain} onSwitch={noop}>
          <RegisterStrategyCard registered={false} ipId={undefined} onRegister={noop} />
        </NetworkSwitchPrompt>

        <StrategyStatsCard
          subscribers={0}
          signalsPublished={0}
          verifiedReturnPct={null}
          totalEarnedWip="0"
        />
      </div>

      <NetworkSwitchPrompt requiredChain="story" current={currentChain} onSwitch={noop}>
        <PublishSignalForm tokenOptions={publishableTokens} publishing={false} onPublish={noop} />
      </NetworkSwitchPrompt>
    </Shell>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import { RegisterStrategyCard } from "@/components/sigmax/RegisterStrategyCard";
import { PublishSignalForm } from "@/components/sigmax/PublishSignalForm";
import { StrategyStatsCard } from "@/components/sigmax/StrategyStatsCard";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { chainConfigReady, env } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import { useLeaderPlan, usePublishSignal, useStrategyStats } from "@/hooks/leader";
import {
  mockStrategy,
  mockStrategyStats,
  mockTokenOptions,
  mockLastPublished,
  mockTx,
} from "@/lib/mock";

export const Route = createFileRoute("/leader")({
  head: () => ({
    meta: [
      { title: "Leader dashboard — Sigmax" },
      {
        name: "description",
        content: "Register a strategy, publish encrypted signals, claim revenue.",
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
          Register once. Publish encrypted signals on Story Aeneid. Claim revenue.
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
  const { publish } = usePublishSignal();
  const [claiming, setClaiming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [lastPublished, setLastPublished] = useState<
    { signalId: string; txUrl: string; at: string } | undefined
  >();

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

        {/* Subscribers is live (event-derived); revenue/return are off-chain (no indexer) → mock. */}
        <StrategyStatsCard
          subscribers={stats.subscribers}
          claimableWip={mockStrategyStats.claimableWip}
          signalsPublished={mockStrategyStats.signalsPublished}
          verifiedReturnPct={mockStrategyStats.verifiedReturnPct}
          claiming={claiming}
          onClaim={async () => {
            setClaiming(true);
            try {
              await mockTx();
              toast.info("Revenue claim runs through the Story royalty module (coming soon).");
            } finally {
              setClaiming(false);
            }
          }}
        />
      </div>

      <NetworkSwitchPrompt
        requiredChain="story"
        current={net.current}
        onSwitch={() => net.switchTo("story")}
      >
        <PublishSignalForm
          tokenOptions={mockTokenOptions}
          publishing={publishing}
          lastPublished={lastPublished}
          onPublish={async (v) => {
            setPublishing(true);
            try {
              const r = await publish(v);
              setLastPublished({
                signalId: r.uuid !== undefined ? `CDR vault #${r.uuid}` : r.signalId,
                txUrl: env.explorers.story,
                at: r.at,
              });
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

// ───────────────────────── mock (no wallet / no env) ─────────────────────────

function LeaderMock() {
  const [registered, setRegistered] = useState(mockStrategy.registered);
  const [ipId, setIpId] = useState<string | undefined>(mockStrategy.ipId);
  const [lastPublished, setLastPublished] = useState(mockLastPublished);
  const [claiming, setClaiming] = useState(false);

  const currentChain = "story" as const;

  return (
    <Shell>
      <div className="grid gap-6 lg:grid-cols-2">
        <NetworkSwitchPrompt requiredChain="story" current={currentChain} onSwitch={mockTx}>
          <RegisterStrategyCard
            registered={registered}
            ipId={ipId}
            onRegister={async (v) => {
              await mockTx();
              setRegistered(true);
              setIpId("0x" + Math.random().toString(16).slice(2, 42).padEnd(40, "a"));
              toast.success(`Strategy "${v.name}" registered`);
            }}
          />
        </NetworkSwitchPrompt>

        <StrategyStatsCard
          subscribers={mockStrategyStats.subscribers}
          claimableWip={mockStrategyStats.claimableWip}
          signalsPublished={mockStrategyStats.signalsPublished}
          verifiedReturnPct={mockStrategyStats.verifiedReturnPct}
          claiming={claiming}
          onClaim={async () => {
            setClaiming(true);
            try {
              await mockTx();
              toast.success(`Claimed ${mockStrategyStats.claimableWip} $WIP`);
            } finally {
              setClaiming(false);
            }
          }}
        />
      </div>

      <NetworkSwitchPrompt requiredChain="story" current={currentChain} onSwitch={mockTx}>
        <PublishSignalForm
          tokenOptions={mockTokenOptions}
          publishing={false}
          lastPublished={lastPublished}
          onPublish={async (v) => {
            await mockTx();
            setLastPublished({
              signalId: "0x" + Math.random().toString(16).slice(2, 10) + "...",
              txUrl: "https://aeneid.storyscan.io/tx/0xnew",
              at: new Date().toISOString(),
            });
            toast.success(`${v.action} signal published`);
          }}
        />
      </NetworkSwitchPrompt>
    </Shell>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { RegisterStrategyCard } from "@/components/sigmax/RegisterStrategyCard";
import { PublishSignalForm } from "@/components/sigmax/PublishSignalForm";
import { StrategyStatsCard } from "@/components/sigmax/StrategyStatsCard";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
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
  const [registered, setRegistered] = useState(mockStrategy.registered);
  const [ipId, setIpId] = useState<string | undefined>(mockStrategy.ipId);
  const [lastPublished, setLastPublished] = useState(mockLastPublished);
  const [claiming, setClaiming] = useState(false);

  // Mock: assume connected to story chain
  const currentChain = "story" as const;

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Leader dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Register once. Publish encrypted signals on Story Aeneid. Claim revenue.
        </p>
      </div>

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
    </main>
  );
}

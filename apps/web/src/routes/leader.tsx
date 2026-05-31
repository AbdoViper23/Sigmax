import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import { Check, Lock } from "lucide-react";
import { RegisterStrategyCard } from "@/components/sigmax/RegisterStrategyCard";
import { PublishSignalForm } from "@/components/sigmax/PublishSignalForm";
import { StrategyStatsCard } from "@/components/sigmax/StrategyStatsCard";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { chainConfigReady, env, publishableTokens } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import { useLeaderPlan, usePublishSignal, useStrategyStats } from "@/hooks/leader";
import { useStrategyPerformance } from "@/hooks/strategies";
import { addPublishedSignal, getPublishedSignals } from "@/lib/publishedSignals";
import { setLeaderProfile } from "@/lib/leaderProfiles";
import { mockTx } from "@/lib/mock";

export const Route = createFileRoute("/leader")({
  head: () => ({
    meta: [
      { title: "Become a leader — Sigmax" },
      {
        name: "description",
        content: "Register as a leader and publish encrypted signals on Story Aeneid.",
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
        <h1 className="text-3xl font-semibold tracking-tight">Become a leader</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Register once with a handle, name and price. Then publish encrypted signals on Story
          Aeneid — revenue is paid to your wallet automatically.
        </p>
      </div>
      {children}
    </main>
  );
}

/** Greyed-out publish area shown until the leader registers — makes "register first" obvious. */
function LockedPublish() {
  return (
    <div className="relative overflow-hidden rounded-xl">
      <div className="pointer-events-none select-none opacity-50">
        <PublishSignalForm
          tokenOptions={publishableTokens}
          publishing={false}
          onPublish={async () => {}}
        />
      </div>
      <div className="absolute inset-0 grid place-items-center bg-background/60 backdrop-blur-[1px]">
        <div className="flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm text-muted-foreground shadow-sm">
          <Lock className="h-3.5 w-3.5" />
          Register to unlock signal publishing
        </div>
      </div>
    </div>
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
              // Persist the off-chain profile so the leaderboard/detail show name + handle.
              setLeaderProfile(env.strategyIpId, {
                username: v.username,
                displayName: v.displayName,
                monthlyPriceWip: v.monthlyPriceWip,
              });
              toast.success(`Registered as "${v.displayName}"`);
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

      {plan.registered ? (
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
      ) : (
        <LockedPublish />
      )}
    </Shell>
  );
}

// ───────────── disconnected / unconfigured (demo registration + publish, local state) ─────────────

function LeaderMock() {
  const [profile, setProfile] = useState<{ username: string; displayName: string } | null>(null);
  const registered = profile !== null;

  return (
    <Shell>
      {!registered && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
          Demo mode — connect your wallet on Story Aeneid to register for real. You can still walk
          the flow below.
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        {registered ? (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-success/15 text-success">
                  <Check className="h-3 w-3" />
                </span>
                <CardTitle>Registered (demo)</CardTitle>
              </div>
              <CardDescription>
                <span className="font-medium text-foreground">{profile.displayName}</span> · @
                {profile.username}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Connect a wallet to register on-chain and start earning. Publishing below is a demo.
            </CardContent>
          </Card>
        ) : (
          <RegisterStrategyCard
            registered={false}
            ipId={undefined}
            onRegister={async (v) => {
              await mockTx();
              setProfile({ username: v.username, displayName: v.displayName });
              toast.success(`Registered as "${v.displayName}" — demo`);
            }}
          />
        )}

        <StrategyStatsCard
          subscribers={0}
          signalsPublished={0}
          verifiedReturnPct={null}
          totalEarnedWip="0"
        />
      </div>

      {registered ? (
        <PublishSignalForm
          tokenOptions={publishableTokens}
          publishing={false}
          onPublish={async (v) => {
            await mockTx();
            toast.success(`${v.action} signal published — demo`);
          }}
        />
      ) : (
        <LockedPublish />
      )}
    </Shell>
  );
}

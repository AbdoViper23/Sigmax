import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import type { Hex } from "viem";
import { Check, EyeOff, LineChart, Lock, Wallet } from "lucide-react";
import { RegisterStrategyCard } from "@/components/sigmax/RegisterStrategyCard";
import { PublishSignalForm } from "@/components/sigmax/PublishSignalForm";
import { StrategyStatsCard } from "@/components/sigmax/StrategyStatsCard";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { chainConfigReady, env, publishableTokens } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import { usePublishSignal, useStrategyStats } from "@/hooks/leader";
import { useLeaders } from "@/hooks/leaders";
import { useRegisterLeader, type RegisterStep } from "@/hooks/useStoryIp";
import { addPublishedSignal, getPublishedSignals, signalProofs } from "@/lib/publishedSignals";
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

/**
 * The leader's path in three real stages. Register is a one-time gate; once passed, the page
 * becomes a publishing desk — the rail keeps that arc visible in both states.
 */
function JourneyRail({ current }: { current: 0 | 1 }) {
  const steps = ["Register your strategy", "Publish encrypted signals", "Earn subscriptions"];
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center gap-3">
            <span
              className={cn(
                "flex items-center gap-1.5",
                active ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-full border font-mono text-[10px]",
                  done && "border-success bg-success/10 text-success",
                  active && "border-foreground bg-foreground text-background",
                  !done && !active && "border-border",
                )}
              >
                {done ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
              </span>
              {label}
            </span>
            {i < steps.length - 1 && <span className="h-px w-6 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function Shell({ children, journeyStep }: { children: React.ReactNode; journeyStep: 0 | 1 }) {
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div className="animate-enter space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          {journeyStep === 0 ? "Become a leader" : "Your strategy desk"}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {journeyStep === 0
            ? "Register once — your wallet creates a Story IP for your strategy and grants the agent a license to execute. Then publish encrypted signals; revenue is paid to your wallet automatically."
            : "Publish encrypted signals below. Followers copy each trade in their own vaults — your thresholds stay sealed, and revenue streams to your wallet on every subscribe & renewal."}
        </p>
        <JourneyRail current={journeyStep} />
      </div>
      {children}
    </main>
  );
}

/** What registering unlocks — replaces a dead all-zero stats card for not-yet leaders. */
function WhatYouGetCard() {
  const items = [
    {
      icon: <EyeOff className="h-4 w-4" aria-hidden />,
      title: "Your strategy stays sealed",
      body: "Take-profit, stop-loss, and entry rules are encrypted in your browser. Followers copy outcomes — never the recipe.",
    },
    {
      icon: <LineChart className="h-4 w-4" aria-hidden />,
      title: "A track record no one can fake",
      body: "Every signal is committed on-chain before its outcome is known. No cherry-picking, no edited history.",
    },
    {
      icon: <Wallet className="h-4 w-4" aria-hidden />,
      title: "Revenue on autopilot",
      body: "Your share of every subscription lands in your wallet the moment a follower subscribes or renews.",
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>What you get</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((it) => (
          <div key={it.title} className="flex gap-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
              {it.icon}
            </span>
            <div>
              <div className="text-sm font-medium">{it.title}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{it.body}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// The 4 on-chain registration transactions, surfaced as a live checklist while they run.
const REGISTER_STEPS = [
  "Create your Story IP asset",
  "Attach license terms",
  "Mint the agent's operator license",
  "Create your subscription plan",
];
const STEP_INDEX: Record<RegisterStep, number> = {
  idle: -1,
  "registering-ip": 0,
  "attaching-terms": 1,
  "minting-license": 2,
  "creating-plan": 3,
  done: 4,
};

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

// ───────────────────────── live (real web3, self-serve) ─────────────────────────

function LeaderLive() {
  const net = useNetwork();
  const { address } = useAccount();
  const qc = useQueryClient();
  const { leaders } = useLeaders();

  // A leader's own strategy is the plan whose on-chain leader == the connected wallet.
  const mine = leaders.find((l) => l.leaderAddress.toLowerCase() === address?.toLowerCase());
  const myId = mine?.id as Hex | undefined;
  const registered = Boolean(mine);

  const { register, step } = useRegisterLeader();
  const stats = useStrategyStats(myId);
  const { publish } = usePublishSignal(myId);
  const [publishing, setPublishing] = useState(false);
  const [signals, setSignals] = useState(() => getPublishedSignals(myId));

  const stepIdx = STEP_INDEX[step];
  const lastPublished = signals[0]
    ? {
        signalId:
          signals[0].uuid !== undefined ? `CDR vault #${signals[0].uuid}` : signals[0].signalId,
        proofs: signalProofs(signals[0], env.explorers.story),
        at: signals[0].at,
      }
    : undefined;

  return (
    <Shell journeyStep={registered ? 1 : 0}>
      <div className="grid animate-enter gap-6 lg:grid-cols-2" style={{ animationDelay: "80ms" }}>
        <NetworkSwitchPrompt
          requiredChain="story"
          current={net.current}
          onSwitch={() => net.switchTo("story")}
        >
          <RegisterStrategyCard
            registered={registered}
            ipId={mine?.id}
            progress={
              stepIdx >= 0 && stepIdx < REGISTER_STEPS.length
                ? { steps: REGISTER_STEPS, current: stepIdx }
                : undefined
            }
            onRegister={async (v) => {
              await register(v);
              // Refresh the on-chain leader list so this page flips to "registered" immediately
              // (otherwise the UI stays stale until a re-render).
              await qc.invalidateQueries({ queryKey: ["leaders-onchain"] });
              toast.success(`Registered as "${v.displayName}"`);
            }}
          />
        </NetworkSwitchPrompt>

        {registered ? (
          /* Per-leader: subscribers + earned from this strategy's Subscribed events; return from trades. */
          <StrategyStatsCard
            subscribers={stats.subscribers}
            signalsPublished={signals.length}
            verifiedReturnPct={mine?.performance.verifiedReturnPct ?? null}
            totalEarnedWip={stats.totalEarnedWip}
          />
        ) : (
          <WhatYouGetCard />
        )}
      </div>

      <div className="animate-enter" style={{ animationDelay: "160ms" }}>
        {registered && myId ? (
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
                    addPublishedSignal(myId, {
                      signalId: r.signalId,
                      uuid: r.uuid,
                      action: v.action,
                      at: r.at,
                      txHashes: r.txHashes,
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
      </div>
    </Shell>
  );
}

// ───────────── disconnected / unconfigured (demo registration + publish, local state) ─────────────

function LeaderMock() {
  const [profile, setProfile] = useState<{ username: string; displayName: string } | null>(null);
  const registered = profile !== null;

  return (
    <Shell journeyStep={registered ? 1 : 0}>
      {!registered && (
        <div
          className="animate-enter rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
          style={{ animationDelay: "40ms" }}
        >
          Demo mode — connect your wallet on Story Aeneid to register for real. You can still walk
          the flow below.
        </div>
      )}
      <div className="grid animate-enter gap-6 lg:grid-cols-2" style={{ animationDelay: "80ms" }}>
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

        {registered ? (
          <StrategyStatsCard
            subscribers={0}
            signalsPublished={0}
            verifiedReturnPct={null}
            totalEarnedWip="0"
          />
        ) : (
          <WhatYouGetCard />
        )}
      </div>

      <div className="animate-enter" style={{ animationDelay: "160ms" }}>
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
      </div>
    </Shell>
  );
}

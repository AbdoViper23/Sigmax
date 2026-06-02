import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import { Stepper } from "@/components/sigmax/Stepper";
import { SubscribeCard } from "@/components/sigmax/SubscribeCard";
import { FundStatusCard } from "@/components/sigmax/FundStatusCard";
import { AuthorizeAgentCard } from "@/components/sigmax/AuthorizeAgentCard";
import { RevokeControl } from "@/components/sigmax/RevokeControl";
import { PositionsTable } from "@/components/sigmax/PositionsTable";
import { SubscriptionStatusBadge } from "@/components/sigmax/SubscriptionStatusBadge";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { hlConfigReady, env } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import { useSubscription } from "@/hooks/follower";
import {
  useAgentApproval,
  useApproveAgent,
  useHlBalance,
  useHlPositions,
  useRevokeAgent,
} from "@/hooks/hyperliquid";
import { mockPositions, mockStrategy, mockSubscription, mockTx } from "@/lib/mock";

export const Route = createFileRoute("/follower")({
  head: () => ({
    meta: [
      { title: "Copy a strategy — Sigmax" },
      {
        name: "description",
        content: "Subscribe to a leader, authorize copy-trading, and let the strategy trade for you.",
      },
    ],
  }),
  component: FollowerPage,
});

const STRATEGY_NAME = env.strategyName; // cosmetic display name (config, not on-chain)
const STEPS = ["Subscribe", "Fund", "Authorize", "Active"];

function FollowerPage() {
  const { isConnected } = useAccount();
  // Live when copy-trading is configured (VITE_* env) AND a wallet is connected; else mock for dev/SSR.
  return hlConfigReady && isConnected ? <FollowerLive /> : <FollowerMock />;
}

function Shell({ badge, children }: { badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Copy {STRATEGY_NAME}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Subscribe, authorize copy-trading, done. Your funds stay in your own account — revoke anytime.
          </p>
        </div>
        {badge}
      </div>
      {children}
    </main>
  );
}

// ───────────────────────── live (real web3) ─────────────────────────

function FollowerLive() {
  const strategyId = env.strategyIpId!; // hlConfigReady guarantees this
  const { address } = useAccount();
  const net = useNetwork();
  const sub = useSubscription(strategyId);
  const bal = useHlBalance(address);
  const approval = useAgentApproval(address);
  const positions = useHlPositions(address);
  const { approve } = useApproveAgent();
  const { revoke } = useRevokeAgent();

  const subActive = sub.status === "active";
  const funded = bal.usdc > 0;
  const authorized = approval.approved;
  const current = !subActive ? 0 : !funded ? 1 : !authorized ? 2 : 3;
  const fullySetUp = current === 3;

  return (
    <Shell
      badge={subActive ? <SubscriptionStatusBadge active expiry={sub.activeUntil ?? null} /> : undefined}
    >
      <Stepper steps={STEPS} current={current} />

      {!fullySetUp ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className={current === 0 ? "" : "pointer-events-none opacity-50"}>
            <NetworkSwitchPrompt
              requiredChain="story"
              current={net.current}
              onSwitch={() => net.switchTo("story")}
            >
              <SubscribeCard
                strategyName={STRATEGY_NAME}
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

          <div className={current === 1 ? "" : "pointer-events-none opacity-50"}>
            <FundStatusCard
              usdc={bal.usdc}
              loading={bal.loading}
              onRecheck={async () => {
                await bal.refetch();
              }}
            />
          </div>

          <div className={current === 2 ? "" : "pointer-events-none opacity-50"}>
            <AuthorizeAgentCard
              approved={authorized}
              loading={approval.loading}
              onAuthorize={async () => {
                await approve();
                await approval.refetch();
                toast.success("Copy-trading authorized");
              }}
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <PositionsTable positions={positions.positions} loading={positions.loading} />
          </div>
          <div className="space-y-6">
            <FundStatusCard usdc={bal.usdc} loading={bal.loading} onRecheck={async () => void bal.refetch()} />
            <RevokeControl
              onRevoke={async () => {
                await revoke();
                await approval.refetch();
                toast.success("Copy-trading stopped");
              }}
            />
          </div>
        </div>
      )}
    </Shell>
  );
}

// ───────────────────────── mock (no wallet / no env) ─────────────────────────

type SubStatus = "idle" | "subscribing" | "active";

function FollowerMock() {
  const [subStatus, setSubStatus] = useState<SubStatus>("idle");
  const [balance, setBalance] = useState(0);
  const [authorized, setAuthorized] = useState(false);
  const [activeUntil, setActiveUntil] = useState<string | undefined>();

  const subActive = subStatus === "active";
  const funded = balance > 0;
  const current = !subActive ? 0 : !funded ? 1 : !authorized ? 2 : 3;
  const fullySetUp = current === 3;

  return (
    <Shell
      badge={
        subActive ? (
          <SubscriptionStatusBadge active expiry={activeUntil ?? mockSubscription.expiry} />
        ) : undefined
      }
    >
      <Stepper steps={STEPS} current={current} />

      {!fullySetUp ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className={current === 0 ? "" : "pointer-events-none opacity-50"}>
            <NetworkSwitchPrompt requiredChain="story" current="story" onSwitch={mockTx}>
              <SubscribeCard
                strategyName={STRATEGY_NAME}
                monthlyPriceWip={mockStrategy.monthlyPriceWip}
                status={subStatus}
                activeUntil={activeUntil}
                onSubscribe={async () => {
                  setSubStatus("subscribing");
                  try {
                    await mockTx();
                    setSubStatus("active");
                    setActiveUntil(new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString());
                    toast.success("Subscribed");
                  } catch (e) {
                    setSubStatus("idle");
                    throw e;
                  }
                }}
              />
            </NetworkSwitchPrompt>
          </div>

          <div className={current === 1 ? "" : "pointer-events-none opacity-50"}>
            <FundStatusCard
              usdc={balance}
              onRecheck={async () => {
                await mockTx();
                setBalance(250); // simulate funds arriving
                toast.success("Balance updated");
              }}
            />
          </div>

          <div className={current === 2 ? "" : "pointer-events-none opacity-50"}>
            <AuthorizeAgentCard
              approved={authorized}
              onAuthorize={async () => {
                await mockTx();
                setAuthorized(true);
                toast.success("Copy-trading authorized");
              }}
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <PositionsTable positions={mockPositions} loading={false} />
          </div>
          <div className="space-y-6">
            <FundStatusCard usdc={balance} onRecheck={async () => void mockTx()} />
            <RevokeControl
              onRevoke={async () => {
                await mockTx();
                setAuthorized(false);
                toast.success("Copy-trading stopped");
              }}
            />
          </div>
        </div>
      )}
    </Shell>
  );
}

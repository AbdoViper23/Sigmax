import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import { Stepper } from "@/components/sigmax/Stepper";
import { SubscribeCard } from "@/components/sigmax/SubscribeCard";
import { CreateVaultCard } from "@/components/sigmax/CreateVaultCard";
import { DepositCard } from "@/components/sigmax/DepositCard";
import { PositionsTable } from "@/components/sigmax/PositionsTable";
import { RevokePauseControls } from "@/components/sigmax/RevokePauseControls";
import { SubscriptionStatusBadge } from "@/components/sigmax/SubscriptionStatusBadge";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { chainConfigReady, env } from "@/lib/env";
import { useNetwork } from "@/hooks/useNetwork";
import {
  useBalances,
  usePositions,
  useSubscription,
  useVault,
  useVaultControls,
} from "@/hooks/follower";
import {
  mockBalances,
  mockPositions,
  mockStrategy,
  mockSubscription,
  mockVault,
  mockTx,
} from "@/lib/mock";

export const Route = createFileRoute("/follower")({
  head: () => ({
    meta: [
      { title: "Follower dashboard — Sigmax" },
      {
        name: "description",
        content: "Subscribe, create your vault, deposit, and copy verified strategies.",
      },
    ],
  }),
  component: FollowerPage,
});

const STRATEGY_NAME = mockStrategy.name; // cosmetic only; not stored on-chain

function FollowerPage() {
  const { isConnected } = useAccount();
  // Live when contracts are configured (VITE_* env) AND a wallet is connected; else mock for dev/SSR.
  return chainConfigReady && isConnected ? <FollowerLive /> : <FollowerMock />;
}

function Shell({ badge, children }: { badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Follow {STRATEGY_NAME}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Three steps to start copying. Funds stay in your vault. Revoke anytime.
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
  const strategyId = env.strategyIpId!; // chainConfigReady guarantees this
  const net = useNetwork();
  const sub = useSubscription(strategyId);
  const vault = useVault();
  const balances = useBalances(vault.vaultAddress);
  const controls = useVaultControls(vault.vaultAddress);
  const positions = usePositions(vault.vaultAddress);

  const subActive = sub.status === "active";
  const vaultCreated = Boolean(vault.vaultAddress);
  const hasDeposit = Number(balances.vaultUsdc.replace(/,/g, "")) > 0;
  const current = !subActive ? 0 : !vaultCreated ? 1 : !hasDeposit ? 2 : 3;
  const fullySetUp = current === 3;

  return (
    <Shell
      badge={
        subActive ? (
          <SubscriptionStatusBadge active={true} expiry={sub.activeUntil ?? null} />
        ) : undefined
      }
    >
      <Stepper steps={["Subscribe", "Create vault", "Deposit", "Copying"]} current={current} />

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
            <NetworkSwitchPrompt
              requiredChain="arbitrum"
              current={net.current}
              onSwitch={() => net.switchTo("arbitrum")}
            >
              <CreateVaultCard
                status={vault.status}
                vaultAddress={vault.vaultAddress}
                onCreate={async (v) => {
                  await vault.createVault(v);
                  toast.success("Vault deployed");
                }}
              />
            </NetworkSwitchPrompt>
          </div>

          <div className={current === 2 ? "" : "pointer-events-none opacity-50"}>
            <NetworkSwitchPrompt
              requiredChain="arbitrum"
              current={net.current}
              onSwitch={() => net.switchTo("arbitrum")}
            >
              <DepositCard
                walletUsdc={balances.walletUsdc}
                vaultUsdc={balances.vaultUsdc}
                status="idle"
                onDeposit={async (amt) => {
                  await balances.deposit(amt);
                  toast.success(`Deposited ${amt} USDC`);
                }}
              />
            </NetworkSwitchPrompt>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <PositionsTable positions={positions.positions} loading={positions.loading} />
          </div>
          <div className="space-y-6">
            <RevokePauseControls
              paused={controls.paused}
              agentAuthorized={controls.agentAuthorized}
              onTogglePause={async (next) => {
                await controls.togglePause(next);
                toast.success(next ? "Copying paused" : "Copying resumed");
              }}
              onRevoke={async () => {
                await controls.revoke();
                toast.success("Agent revoked");
              }}
            />
            <DepositCard
              walletUsdc={balances.walletUsdc}
              vaultUsdc={balances.vaultUsdc}
              status="idle"
              onDeposit={async (amt) => {
                await balances.deposit(amt);
                toast.success(`Deposited ${amt} USDC`);
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
type VaultStatus = "idle" | "creating" | "created";

function FollowerMock() {
  const [subStatus, setSubStatus] = useState<SubStatus>("idle");
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>("idle");
  const [vaultAddress, setVaultAddress] = useState<string | undefined>();
  const [vaultBalance, setVaultBalance] = useState(mockBalances.vaultUsdc);
  const [paused, setPaused] = useState(false);
  const [agentAuthorized, setAgentAuthorized] = useState(true);
  const [activeUntil, setActiveUntil] = useState<string | undefined>();

  const currentChain = "story" as const;

  const current =
    subStatus !== "active"
      ? 0
      : vaultStatus !== "created"
        ? 1
        : Number(vaultBalance.replace(/[^\d.-]/g, "")) <= 0
          ? 2
          : 3;
  const fullySetUp = current === 3;

  return (
    <Shell
      badge={
        subStatus === "active" ? (
          <SubscriptionStatusBadge active={true} expiry={activeUntil ?? mockSubscription.expiry} />
        ) : undefined
      }
    >
      <Stepper steps={["Subscribe", "Create vault", "Deposit", "Copying"]} current={current} />

      {!fullySetUp ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className={current === 0 ? "" : "pointer-events-none opacity-50"}>
            <NetworkSwitchPrompt requiredChain="story" current={currentChain} onSwitch={mockTx}>
              <SubscribeCard
                strategyName={mockStrategy.name}
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
            <NetworkSwitchPrompt requiredChain="arbitrum" current={currentChain} onSwitch={mockTx}>
              <CreateVaultCard
                status={vaultStatus}
                vaultAddress={vaultAddress}
                onCreate={async () => {
                  setVaultStatus("creating");
                  try {
                    await mockTx();
                    setVaultStatus("created");
                    setVaultAddress(mockVault.address);
                    toast.success("Vault deployed");
                  } catch (e) {
                    setVaultStatus("idle");
                    throw e;
                  }
                }}
              />
            </NetworkSwitchPrompt>
          </div>

          <div className={current === 2 ? "" : "pointer-events-none opacity-50"}>
            <NetworkSwitchPrompt requiredChain="arbitrum" current={currentChain} onSwitch={mockTx}>
              <DepositCard
                walletUsdc={mockBalances.walletUsdc}
                vaultUsdc={vaultBalance}
                status="idle"
                onDeposit={async (amt) => {
                  await mockTx();
                  setVaultBalance(
                    (Number(vaultBalance.replace(/,/g, "")) + Number(amt)).toFixed(2),
                  );
                  toast.success(`Deposited ${amt} USDC`);
                }}
              />
            </NetworkSwitchPrompt>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <PositionsTable positions={mockPositions} loading={false} />
          </div>
          <div className="space-y-6">
            <RevokePauseControls
              paused={paused}
              agentAuthorized={agentAuthorized}
              onTogglePause={async (next) => {
                await mockTx();
                setPaused(next);
                toast.success(next ? "Copying paused" : "Copying resumed");
              }}
              onRevoke={async () => {
                await mockTx();
                setAgentAuthorized(false);
                toast.success("Agent revoked");
              }}
            />
            <DepositCard
              walletUsdc={mockBalances.walletUsdc}
              vaultUsdc={vaultBalance}
              status="idle"
              onDeposit={async (amt) => {
                await mockTx();
                setVaultBalance((Number(vaultBalance.replace(/,/g, "")) + Number(amt)).toFixed(2));
                toast.success(`Deposited ${amt} USDC`);
              }}
            />
          </div>
        </div>
      )}
    </Shell>
  );
}

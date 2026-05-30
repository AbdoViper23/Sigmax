import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Stepper } from "@/components/sigmax/Stepper";
import { SubscribeCard } from "@/components/sigmax/SubscribeCard";
import { CreateVaultCard } from "@/components/sigmax/CreateVaultCard";
import { DepositCard } from "@/components/sigmax/DepositCard";
import { PositionsTable } from "@/components/sigmax/PositionsTable";
import { RevokePauseControls } from "@/components/sigmax/RevokePauseControls";
import { SubscriptionStatusBadge } from "@/components/sigmax/SubscriptionStatusBadge";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
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

type SubStatus = "idle" | "subscribing" | "active";
type VaultStatus = "idle" | "creating" | "created";

function FollowerPage() {
  // Step state
  const [subStatus, setSubStatus] = useState<SubStatus>("idle");
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>("idle");
  const [vaultAddress, setVaultAddress] = useState<string | undefined>();
  const [vaultBalance, setVaultBalance] = useState(mockBalances.vaultUsdc);

  // Controls
  const [paused, setPaused] = useState(false);
  const [agentAuthorized, setAgentAuthorized] = useState(true);
  const [activeUntil, setActiveUntil] = useState<string | undefined>();

  // Mock current chain — toggles by step (story for sub, arbitrum for vault/deposit)
  const currentChain = "story" as const; // pretend we're on story; the prompts will surface for arbitrum steps

  // Derived current step (0-based)
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
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Follow {mockStrategy.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Three steps to start copying. Funds stay in your vault. Revoke anytime.
          </p>
        </div>
        {subStatus === "active" && (
          <SubscriptionStatusBadge active={true} expiry={activeUntil ?? mockSubscription.expiry} />
        )}
      </div>

      <Stepper steps={["Subscribe", "Create vault", "Deposit", "Copying"]} current={current} />

      {!fullySetUp ? (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Step 1 — Story */}
          <div className={current === 0 ? "" : "opacity-50 pointer-events-none"}>
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

          {/* Step 2 — Arbitrum */}
          <div className={current === 1 ? "" : "opacity-50 pointer-events-none"}>
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

          {/* Step 3 — Arbitrum */}
          <div className={current === 2 ? "" : "opacity-50 pointer-events-none"}>
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
    </main>
  );
}

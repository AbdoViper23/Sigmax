import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import type { Hex } from "viem";
import { ArrowUpRight, CheckCircle2, Loader2, ShieldOff, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SubscriptionStatusBadge } from "@/components/sigmax/SubscriptionStatusBadge";
import { PositionsTable } from "@/components/sigmax/PositionsTable";
import { VaultCard, type VaultLeg } from "@/components/sigmax/VaultCard";
import { AuthorizeAgentCard } from "@/components/sigmax/AuthorizeAgentCard";
import { NetworkSwitchPrompt } from "@/components/sigmax/NetworkSwitchPrompt";
import { VenueSummary, VENUE_META, type BadgeVenue } from "@/components/sigmax/VenueBadge";
import { VenueTrustPanel } from "@/components/sigmax/VenueTrustPanel";
import { cn } from "@/lib/utils";
import { useNetwork } from "@/hooks/useNetwork";
import {
  formatToken,
  useCancelFlareSubscription,
  useFlareVault,
  useFlareVaultTrades,
  useFlareWallet,
  useMyFlareSubscriptions,
  type MyFlareSubscription,
} from "@/hooks/flareControlPlane";
import { useAgentApproval, useApproveAgent, useHlAgentAddress } from "@/hooks/hyperliquid";
import { env, QUOTE_SYMBOL } from "@/lib/env";

export const Route = createFileRoute("/follower")({
  head: () => ({
    meta: [
      { title: "My subscriptions — Sigmax" },
      {
        name: "description",
        content: "See which strategies you're copying, your balance, and cancel anytime.",
      },
    ],
  }),
  component: DashboardPage,
});

/** Human label for whichever leg a vault action targets. */
const legLabel = (leg: VaultLeg) => (leg === "fxrp" ? "FXRP" : QUOTE_SYMBOL);

function DashboardPage() {
  const { isConnected } = useAccount();

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-10">
      <div className="animate-enter">
        <h1 className="text-3xl font-semibold tracking-tight">My subscriptions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything you're copying, in one place. Your funds stay in your own account — cancel anytime.
        </p>
      </div>

      {isConnected ? <DashboardLive /> : <ConnectPrompt />}
    </main>
  );
}

function ConnectPrompt() {
  // Phrased for both venues: "your own vault or your own account" is the accurate union, and the
  // withdrawal guarantee is the one property that holds identically on each.
  const points = [
    "Every trade runs in your own vault or your own account",
    "Nothing can withdraw your funds — only you",
    "Cancel or revoke access anytime",
  ];
  return (
    <Card className="animate-enter" style={{ animationDelay: "80ms" }}>
      <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-accent text-accent-foreground">
          <Wallet className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <p className="font-medium">Connect your wallet to see who you're copying</p>
          <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
            {points.map((p) => (
              <li key={p} className="flex items-center justify-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden /> {p}
              </li>
            ))}
          </ul>
        </div>
        <Button asChild variant="outline" className="mt-1">
          <Link to="/leaderboard">Browse leaders</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The heading that opens a venue's section. Carries the venue badge plus the one line that matters
 * there — where funds sit and what enforces the limits — so the trade-off is restated at the point of
 * action rather than only in the comparison table further down.
 */
function VenueSectionHeading({ venue }: { venue: BadgeVenue }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-sm font-medium text-foreground">{VENUE_META[venue].label}</h2>
      <VenueSummary venue={venue} />
    </div>
  );
}

/** Same square-badge idiom as the Nav logo and leaderboard cards — keeps identities scannable. */
function Monogram({ seed }: { seed: string }) {
  const letter = seed.trim().charAt(0).toUpperCase() || "Σ";
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-foreground text-background">
      <span className="text-sm font-bold">{letter}</span>
    </span>
  );
}

/**
 * The dashboard's at-a-glance answer to the follower's three questions:
 * how much is in my account, how many strategies trade with it, and does the agent have access.
 */
function OverviewStrip({
  vaultFxrp,
  balLoading,
  copying,
  vaultExists,
  explorerUrl,
}: {
  vaultFxrp: string;
  balLoading: boolean;
  copying: number;
  vaultExists: boolean;
  explorerUrl?: string;
}) {
  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }}>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-6 py-5 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">In your vault</div>
          {balLoading ? (
            <Skeleton className="mt-1.5 h-8 w-28" />
          ) : (
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
              {Number(vaultFxrp).toLocaleString(undefined, { maximumFractionDigits: 4 })}{" "}
              <span className="text-base font-medium text-muted-foreground">FXRP</span>
            </div>
          )}
          {explorerUrl && (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              View on explorer <ArrowUpRight className="h-3 w-3" aria-hidden />
            </a>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Copying</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{copying}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {copying === 1 ? "active strategy" : "active strategies"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Custody</div>
          <div
            className={cn(
              "mt-1.5 inline-flex items-center gap-1.5 text-sm font-medium",
              vaultExists ? "text-success" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                vaultExists ? "bg-success" : "bg-muted-foreground/40",
              )}
              aria-hidden
            />
            {vaultExists ? "Your vault" : "No vault yet"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {vaultExists ? "Only you can withdraw" : "Create one to start copying"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardLive() {
  const net = useNetwork();
  const { address } = useAccount();
  const { subs, loading } = useMyFlareSubscriptions();
  const vault = useFlareVault();
  const wallet = useFlareWallet();
  // Off-chain venue (Hyperliquid). Present only when the enclave has a trading key injected.
  const hlAgent = useHlAgentAddress(address);
  const hlApproval = useAgentApproval(address);
  const { approve: approveHlAgent } = useApproveAgent();
  // Every trade is a `Swapped` event on the follower's OWN vault — the results are public and
  // verifiable while the strategy that produced them is not.
  const { trades, loading: tradesLoading } = useFlareVaultTrades(vault.vault);

  return (
    <>
      <OverviewStrip
        vaultFxrp={formatToken(vault.fxrp)}
        balLoading={vault.loading}
        copying={subs.length}
        vaultExists={vault.exists}
        explorerUrl={vault.vault ? `${env.explorers.flare}/address/${vault.vault}` : undefined}
      />

      {/* Venue sections. Each answers the same two questions for its own venue — where the money is,
          and what is allowed to trade it — so a follower on both venues never has to work out which
          card belongs to which. */}
      <section className="animate-enter space-y-3" style={{ animationDelay: "90ms" }}>
        <VenueSectionHeading venue="flare" />
        <NetworkSwitchPrompt
          requiredChain="flare"
          current={net.current}
          onSwitch={() => net.switchTo("flare")}
        >
          <VaultCard
            vault={vault.vault}
            fxrp={formatToken(vault.fxrp)}
            quote={formatToken(vault.quote)}
            quoteSymbol={QUOTE_SYMBOL}
            walletFxrp={formatToken(wallet.fxrp)}
            walletQuote={formatToken(wallet.quote)}
            explorerBase={env.explorers.flare}
            busy={vault.creating || vault.depositing || vault.withdrawing || vault.repointing}
            teeStale={vault.teeStale}
            onCreateAndFund={async (amount, leg) => {
              await vault.createAndFund({ amount, leg });
              await wallet.refresh();
              toast.success(`Vault created and funded with ${amount} ${legLabel(leg)}`);
            }}
            onDeposit={async (amount, leg) => {
              await vault.deposit({ amount, leg });
              await wallet.refresh();
              toast.success(`Deposited ${amount} ${legLabel(leg)}`);
            }}
            onWithdraw={async (amount, leg) => {
              await vault.withdraw({ amount, leg });
              await wallet.refresh();
              toast.success(`Withdrew ${amount} ${legLabel(leg)}`);
            }}
            onMintQuote={async () => {
              await wallet.mintQuote();
              toast.success(`${QUOTE_SYMBOL} minted from the faucet`);
            }}
            onRepointTee={async () => {
              await vault.repointTee();
              toast.success("Vault now trusts the current enclave");
            }}
          />
        </NetworkSwitchPrompt>
      </section>

      {/* Copied trades — results only, never the strategy. Every row is a `Swapped` event from this
          follower's own vault, so it is publicly auditable without revealing what drove it. */}
      {trades.length > 0 && (
        <section className="animate-enter space-y-3" style={{ animationDelay: "120ms" }}>
          <h3 className="text-sm font-medium text-muted-foreground">Trades in this vault</h3>
          <PositionsTable positions={trades.map(tradeToRow)} loading={tradesLoading} />
        </section>
      )}

      {/* The off-chain venue. Shown ONLY once the enclave actually holds a trading key — that key is
          memory-only and cleared by a restart, so gating on the derived address means the section never
          invites a follower to authorize something that cannot yet trade. */}
      {hlAgent.agentAddress && (
        <section className="animate-enter space-y-3" style={{ animationDelay: "150ms" }}>
          <VenueSectionHeading venue="hyperliquid" />
          <AuthorizeAgentCard
            approved={hlApproval.approved}
            loading={hlApproval.loading}
            agentAddress={hlAgent.agentAddress}
            onAuthorize={async () => {
              await approveHlAgent();
              await hlApproval.refetch();
              toast.success("Copy-trading authorized");
            }}
          />
        </section>
      )}

      {/* Active subscriptions are venue-independent: a subscription buys access to a leader's signals,
          and the leader chooses the venue per signal. Placed after the venues so the page reads
          "here is your money" before "here is who can trade it". */}
      <section className="animate-enter space-y-3" style={{ animationDelay: "180ms" }}>
        <h2 className="text-sm font-medium text-muted-foreground">
          Copying{subs.length > 0 && <span className="text-muted-foreground/60"> · {subs.length}</span>}
        </h2>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : subs.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <div>
                <p className="text-sm font-medium">You're not copying anyone yet.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Pick a leader with a verified track record — trades run in your own account and you
                  can cancel anytime.
                </p>
              </div>
              <Button asChild>
                <Link to="/leaderboard">Browse leaders</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          subs.map((s) => <SubscriptionRow key={s.leader.id} sub={s} />)
        )}
      </section>

      <section className="animate-enter" style={{ animationDelay: "210ms" }}>
        <VenueTrustPanel />
      </section>
    </>
  );
}

function pct(v: number | null) {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/**
 * A vault `Swapped` event as a dashboard row. `tokenIn == quote` means an entry (spent testUSD to buy
 * FXRP); the other direction is an exit. Deliberately shows amounts and the tx and nothing else — the
 * take-profit and stop-loss that decided this trade are not ours to display.
 */
function tradeToRow(t: {
  id: string;
  txHash: string | null;
  isEntry: boolean;
  amountIn: bigint;
  received: bigint;
}) {
  return {
    id: t.id,
    pair: t.isEntry ? `${QUOTE_SYMBOL} → FXRP` : `FXRP → ${QUOTE_SYMBOL}`,
    amountIn: `${formatToken(t.amountIn)} ${t.isEntry ? QUOTE_SYMBOL : "FXRP"}`,
    currentValue: `${formatToken(t.received)} ${t.isEntry ? "FXRP" : QUOTE_SYMBOL}`,
    pnlPct: 0,
    pnlUsd: "—",
    openedAt: new Date().toISOString(),
    status: (t.isEntry ? "open" : "closed") as "open" | "closed",
    txUrl: t.txHash ? `${env.explorers.flare}/tx/${t.txHash}` : "#",
  };
}

function SubscriptionRow({ sub }: { sub: MyFlareSubscription }) {
  const { cancel } = useCancelFlareSubscription();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const ret = sub.leader.performance.verifiedReturnPct;

  async function handleCancel() {
    setPending(true);
    try {
      await cancel(sub.leader.id as Hex);
      await qc.invalidateQueries({ queryKey: ["my-flare-subscriptions"] });
      toast.success(`Unsubscribed from ${sub.leader.displayName}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't unsubscribe");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <Monogram seed={sub.leader.username} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold tracking-tight">{sub.leader.displayName}</span>
            <SubscriptionStatusBadge active expiry={sub.expiry ?? null} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            @{sub.leader.username} ·{" "}
            <span className="font-mono tabular-nums">
              {sub.leader.monthlyPrice} {QUOTE_SYMBOL}
            </span>
            /mo
          </p>
        </div>
        <div className="hidden text-right sm:block">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Return</div>
          <div
            className={cn(
              "mt-0.5 font-mono text-sm tabular-nums",
              ret === null ? "text-muted-foreground" : ret >= 0 ? "text-success" : "text-danger",
            )}
          >
            {pct(ret)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/strategy/$id" params={{ id: sub.leader.id }}>
              View
            </Link>
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="text-danger" disabled={pending}>
                {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                {pending ? "Cancelling…" : "Unsubscribe"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsubscribe from {sub.leader.displayName}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The strategy stops copying new trades for you immediately. Your funds and any open
                  positions stay in your account — you can manage or close them yourself, and
                  re-subscribe anytime. No refund for the current period.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep copying</AlertDialogCancel>
                <AlertDialogAction onClick={handleCancel}>Unsubscribe</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

/** Global "stop everything" — revokes the shared agent so it can no longer trade for you at all. */
function RevokeAllControl({ onRevoke }: { onRevoke: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  async function handle() {
    setPending(true);
    try {
      await onRevoke();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revoke access");
    } finally {
      setPending(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Stop all copy-trading</CardTitle>
        <CardDescription>
          Revoke the agent's permission to trade for you across every strategy at once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="destructive" disabled={pending}>
              {pending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldOff className="mr-2 h-4 w-4" />
              )}
              {pending ? "Revoking…" : "Revoke all access"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke all copy-trading access?</AlertDialogTitle>
              <AlertDialogDescription>
                The agent will no longer place any trades for you. Your funds stay in your account.
                You can re-authorize by subscribing to a strategy again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep copying</AlertDialogCancel>
              <AlertDialogAction onClick={handle}>Revoke all</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

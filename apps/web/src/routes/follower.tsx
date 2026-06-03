import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import type { Hex } from "viem";
import { ArrowUpRight, Loader2, ShieldOff, Wallet } from "lucide-react";
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
import { useMySubscriptions, useSubscription, type MySubscription } from "@/hooks/follower";
import { useHlBalance, useHlPositions, useAgentApproval, useRevokeAgent } from "@/hooks/hyperliquid";
import { env } from "@/lib/env";

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

const HL_APP = env.hlTestnet ? "https://app.hyperliquid-testnet.xyz" : "https://app.hyperliquid.xyz";

function DashboardPage() {
  const { isConnected } = useAccount();

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-10">
      <div>
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
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <Wallet className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Connect your wallet to see the strategies you're copying.
        </p>
        <Button asChild variant="outline" className="mt-1">
          <Link to="/leaderboard">Browse leaders</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function DashboardLive() {
  const { address } = useAccount();
  const { subs, loading } = useMySubscriptions();
  const bal = useHlBalance(address);
  const positions = useHlPositions(address);
  const approval = useAgentApproval(address);
  const { revoke } = useRevokeAgent();

  return (
    <>
      {/* Balance — the only Hyperliquid surface left, read-only. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Your balance</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
              {bal.loading ? "…" : bal.usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
              <span className="text-base font-medium text-muted-foreground">USDC</span>
            </div>
          </div>
          <a
            href={HL_APP}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            Deposit <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        </CardContent>
      </Card>

      {/* Active subscriptions */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Copying</h2>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : subs.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm text-muted-foreground">You're not copying anyone yet.</p>
              <Button asChild>
                <Link to="/leaderboard">Browse leaders</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          subs.map((s) => <SubscriptionRow key={s.leader.id} sub={s} />)
        )}
      </section>

      {/* Recent copied trades (results only — never the strategy) */}
      {positions.positions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Recent copied trades</h2>
          <PositionsTable positions={positions.positions} loading={positions.loading} />
        </section>
      )}

      {/* Danger zone — global kill switch. Per-leader cancel is on each row above; this stops
          ALL copy-trading at once by revoking the shared agent's permission. */}
      {approval.approved && (
        <section className="space-y-3 border-t border-border pt-6">
          <RevokeAllControl
            onRevoke={async () => {
              await revoke();
              await approval.refetch();
              toast.success("Copy-trading access revoked");
            }}
          />
        </section>
      )}
    </>
  );
}

function SubscriptionRow({ sub }: { sub: MySubscription }) {
  const s = useSubscription(sub.leader.id as Hex);
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);

  async function handleCancel() {
    setPending(true);
    try {
      await s.cancel();
      await qc.invalidateQueries({ queryKey: ["my-subscriptions"] });
      toast.success(`Unsubscribed from ${sub.leader.displayName}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't unsubscribe");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold tracking-tight">{sub.leader.displayName}</span>
            <SubscriptionStatusBadge active expiry={sub.expiry ?? null} />
          </div>
          <p className="truncate text-xs text-muted-foreground">@{sub.leader.username}</p>
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

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
import { cn } from "@/lib/utils";
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
  const points = [
    "Every trade runs in your own account",
    "The agent can trade for you — never withdraw",
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
  usdc,
  balLoading,
  copying,
  agentApproved,
}: {
  usdc: number;
  balLoading: boolean;
  copying: number;
  agentApproved: boolean;
}) {
  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }}>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-6 py-5 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Your balance</div>
          {balLoading ? (
            <Skeleton className="mt-1.5 h-8 w-28" />
          ) : (
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
              {usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
              <span className="text-base font-medium text-muted-foreground">USDC</span>
            </div>
          )}
          <a
            href={HL_APP}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Deposit <ArrowUpRight className="h-3 w-3" aria-hidden />
          </a>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Copying</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{copying}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {copying === 1 ? "active strategy" : "active strategies"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Agent access</div>
          <div
            className={cn(
              "mt-1.5 inline-flex items-center gap-1.5 text-sm font-medium",
              agentApproved ? "text-success" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                agentApproved ? "bg-success" : "bg-muted-foreground/40",
              )}
              aria-hidden
            />
            {agentApproved ? "Authorized" : "Off"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {agentApproved ? "Can trade for you — never withdraw" : "No trading permission granted"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardLive() {
  const { address } = useAccount();
  const { subs, loading } = useMySubscriptions();
  const bal = useHlBalance(address);
  const approval = useAgentApproval(address);
  // Only the trades the agent placed — fills from when copy-trading was authorized onward, not the
  // follower's own prior history. See useHlPositions / useAgentApproval.
  const positions = useHlPositions(address, approval.copyTradingSince);
  const { revoke } = useRevokeAgent();

  return (
    <>
      <OverviewStrip
        usdc={bal.usdc}
        balLoading={bal.loading}
        copying={subs.length}
        agentApproved={Boolean(approval.approved)}
      />

      {/* Active subscriptions */}
      <section className="animate-enter space-y-3" style={{ animationDelay: "120ms" }}>
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

      {/* Recent copied trades (results only — never the strategy). Shown only once the agent is
          authorized: before that no copy trade can exist, and we never surface the follower's own
          manual history here. */}
      {approval.approved && positions.positions.length > 0 && (
        <section className="animate-enter space-y-3" style={{ animationDelay: "180ms" }}>
          <h2 className="text-sm font-medium text-muted-foreground">Recent copied trades</h2>
          <PositionsTable positions={positions.positions} loading={positions.loading} />
        </section>
      )}

      {/* Danger zone — global kill switch. Per-leader cancel is on each row above; this stops
          ALL copy-trading at once by revoking the shared agent's permission. */}
      {approval.approved && (
        <section
          className="animate-enter space-y-3 border-t border-border pt-6"
          style={{ animationDelay: "240ms" }}
        >
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

function pct(v: number | null) {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function SubscriptionRow({ sub }: { sub: MySubscription }) {
  const s = useSubscription(sub.leader.id as Hex);
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const ret = sub.leader.performance.verifiedReturnPct;

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
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <Monogram seed={sub.leader.username} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold tracking-tight">{sub.leader.displayName}</span>
            <SubscriptionStatusBadge active expiry={sub.expiry ?? null} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            @{sub.leader.username} ·{" "}
            <span className="font-mono tabular-nums">{sub.leader.monthlyPriceWip} WIP</span>/mo
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

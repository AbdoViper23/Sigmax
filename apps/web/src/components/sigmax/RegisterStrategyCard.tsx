import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { TxButton } from "./TxButton";
import { cn } from "@/lib/utils";
import { ArrowUpRight, Check, Copy, Loader2 } from "lucide-react";

/** Multi-tx on-chain registration progress: steps before `current` are done, `current` is in flight. */
export interface RegisterProgress {
  steps: string[];
  current: number;
}

export interface RegisterStrategyCardProps {
  registered: boolean;
  ipId?: string;
  // username/displayName are OFF-CHAIN profile fields (PlanCreated carries no name) — do NOT pass
  // them to createPlan. They're stored via lib/leaderProfiles.ts (see the wiring seam).
  onRegister: (v: {
    username: string;
    displayName: string;
    monthlyPriceWip: string;
  }) => Promise<void>;
  /** Live on-chain registration progress; rendered as a checklist under the button while in flight. */
  progress?: RegisterProgress;
}

const PLATFORM_FEE_PCT = 15;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/** "4.25" not "4.250000" — trims trailing zeros from the earnings math. */
function fmtWip(n: number) {
  return n.toFixed(2).replace(/\.?0+$/, "");
}

export function RegisterStrategyCard({
  registered,
  ipId,
  onRegister,
  progress,
}: RegisterStrategyCardProps) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [price, setPrice] = useState("5");
  const [copied, setCopied] = useState(false);

  const normalizedUsername = username.trim().toLowerCase();
  const usernameValid = USERNAME_RE.test(normalizedUsername);
  const valid = usernameValid && displayName.trim().length > 0 && Number(price) > 0;
  const keepPerSub = Number(price) > 0 ? Number(price) * (1 - PLATFORM_FEE_PCT / 100) : 0;

  if (registered && ipId) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-success/15 text-success">
              <Check className="h-3 w-3" />
            </span>
            <CardTitle>Strategy registered</CardTitle>
          </div>
          <CardDescription>Your IP asset is live on Story Aeneid.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">IP Asset ID</Label>
            <div className="mt-1 flex items-center gap-1 rounded-md border border-border bg-muted/40 py-1 pl-3 pr-1">
              <code className="flex-1 truncate font-mono text-sm">{ipId}</code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(ipId);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={copied ? "Copied" : "Copy IP asset ID"}
              >
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <Link
            to="/strategy/$id"
            params={{ id: ipId }}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            View your public page <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Register your strategy</CardTitle>
        <CardDescription>
          Pick a handle, name your strategy, and set your monthly price. Registering creates your IP
          asset on Story Aeneid and unlocks signal publishing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="leader-username">Username</Label>
            <div className="flex items-center rounded-md border border-input focus-within:ring-1 focus-within:ring-ring">
              <span className="pl-3 text-sm text-muted-foreground">@</span>
              <Input
                id="leader-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="momentum_alpha"
                className="border-0 pl-1 focus-visible:ring-0"
                autoComplete="off"
              />
            </div>
            {username.length > 0 && !usernameValid && (
              <p className="text-xs text-danger">3–20 chars: lowercase letters, numbers, _</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="leader-name">Display name</Label>
            <Input
              id="leader-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Momentum Alpha"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="strat-price">Monthly price ($WIP)</Label>
              <Input
                id="strat-price"
                type="number"
                min="0"
                step="0.1"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Platform fee</Label>
              <div className="flex h-9 items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground">
                {PLATFORM_FEE_PCT}% (fixed)
              </div>
            </div>
          </div>
          {/* Live earnings math — answers "what do I actually make?" right where the price is set. */}
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {keepPerSub > 0 ? (
              <>
                You keep{" "}
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {fmtWip(keepPerSub)} WIP
                </span>
                /mo per subscriber, paid to your wallet automatically.
              </>
            ) : (
              "Set a price to see what you keep per subscriber."
            )}
          </p>
        </div>
        <TxButton
          label="Register as leader"
          pendingLabel="Registering…"
          disabled={!valid}
          onClick={() =>
            onRegister({
              username: normalizedUsername,
              displayName: displayName.trim(),
              monthlyPriceWip: price,
            })
          }
        />
        {progress && (
          <ol className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3" aria-live="polite">
            {progress.steps.map((label, i) => {
              const done = i < progress.current;
              const active = i === progress.current;
              return (
                <li
                  key={label}
                  className={cn(
                    "flex items-center gap-2 text-xs",
                    done ? "text-success" : active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {done ? (
                    <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  ) : active ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                  ) : (
                    <span className="grid h-3.5 w-3.5 shrink-0 place-items-center" aria-hidden>
                      <span className="h-1 w-1 rounded-full bg-current" />
                    </span>
                  )}
                  {label}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

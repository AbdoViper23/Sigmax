import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { TxButton } from "./TxButton";
import { Check, Copy } from "lucide-react";

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
  /** Optional progress line shown under the button (e.g. multi-step on-chain registration). */
  statusNote?: string;
}

const PLATFORM_FEE_PCT = 15;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export function RegisterStrategyCard({
  registered,
  ipId,
  onRegister,
  statusNote,
}: RegisterStrategyCardProps) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [price, setPrice] = useState("5");
  const [copied, setCopied] = useState(false);

  const normalizedUsername = username.trim().toLowerCase();
  const usernameValid = USERNAME_RE.test(normalizedUsername);
  const valid = usernameValid && displayName.trim().length > 0 && Number(price) > 0;

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
        <CardContent>
          <Label className="text-xs text-muted-foreground">IP Asset ID</Label>
          <div className="mt-1 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <code className="flex-1 truncate font-mono text-sm">{ipId}</code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(ipId);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Copy"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Register as a leader</CardTitle>
        <CardDescription>
          Step one. Pick a handle, name your strategy, and set your monthly price. This creates your
          IP asset on Story Aeneid and unlocks signal publishing.
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
        {statusNote && <p className="text-center text-xs text-muted-foreground">{statusNote}</p>}
      </CardContent>
    </Card>
  );
}

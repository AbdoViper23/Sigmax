import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { TxButton } from "./TxButton";
import { Check, Copy } from "lucide-react";

export interface RegisterStrategyCardProps {
  registered: boolean;
  ipId?: string;
  onRegister: (v: { name: string; monthlyPriceWip: string }) => Promise<void>;
}

const PLATFORM_FEE_PCT = 15;

export function RegisterStrategyCard({ registered, ipId, onRegister }: RegisterStrategyCardProps) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("5");
  const [copied, setCopied] = useState(false);

  const valid = name.trim().length > 0 && Number(price) > 0;

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
        <CardTitle>Register strategy</CardTitle>
        <CardDescription>One-time. Creates your IP asset on Story Aeneid.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="strat-name">Strategy name</Label>
          <Input
            id="strat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Momentum Alpha"
          />
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
          label="Register strategy"
          pendingLabel="Registering…"
          disabled={!valid}
          onClick={() => onRegister({ name: name.trim(), monthlyPriceWip: price })}
        />
      </CardContent>
    </Card>
  );
}

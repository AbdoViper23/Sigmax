import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { TxButton } from "./TxButton";
import { ShieldCheck } from "lucide-react";

export interface CreateVaultCardProps {
  status: "idle" | "creating" | "created";
  vaultAddress?: string;
  onCreate: (v: { perTradeCapUsdc: string }) => Promise<void>;
}

export function CreateVaultCard({ status, vaultAddress, onCreate }: CreateVaultCardProps) {
  const [cap, setCap] = useState("250");
  const valid = Number(cap) > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your vault</CardTitle>
        <CardDescription>
          Deploys on Arbitrum. Whitelists USDC + target tokens and authorizes the agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <p className="text-muted-foreground">
            Funds stay in <span className="font-medium text-foreground">your</span> vault. The agent
            can only <span className="font-medium text-foreground">swap</span> within your token
            list + caps. It can <span className="font-medium text-foreground">never withdraw</span>.
            You can revoke anytime.
          </p>
        </div>

        {status === "created" && vaultAddress ? (
          <div>
            <Label className="text-xs text-muted-foreground">Vault address</Label>
            <div className="mt-1 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm">
              {vaultAddress}
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="cap">Per-trade cap (USDC)</Label>
              <Input
                id="cap"
                type="number"
                min="1"
                step="1"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Max size the agent can swap in a single trade.
              </p>
            </div>
            <TxButton
              label="Create my vault"
              pendingLabel="Deploying vault…"
              disabled={!valid}
              onClick={() => onCreate({ perTradeCapUsdc: cap })}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

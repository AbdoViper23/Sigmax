import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TxButton } from "./TxButton";
import { env } from "@/lib/env";
import { Wallet, ExternalLink, CheckCircle2 } from "lucide-react";

export interface FundStatusCardProps {
  /** Spendable balance in the follower's own trading account, in USDC. */
  usdc: number;
  loading?: boolean;
  onRecheck: () => Promise<void>;
}

const DEPOSIT_URL = env.hlTestnet
  ? "https://app.hyperliquid-testnet.xyz/drip"
  : "https://app.hyperliquid.xyz/trade";

/**
 * "Your trading balance" — the follower funds their OWN account externally (we never custody funds);
 * here we just confirm the balance is there. Funded once it shows > 0.
 */
export function FundStatusCard({ usdc, loading, onRecheck }: FundStatusCardProps) {
  const funded = usdc > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your trading balance</CardTitle>
        <CardDescription>Your funds stay in your own account — we never hold them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2.5">
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Wallet className="h-4 w-4" /> Available
          </span>
          <span className="font-mono text-base tabular-nums">
            {loading ? "…" : usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
          </span>
        </div>

        {funded ? (
          <div className="inline-flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" /> Funded and ready
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Add USDC to your account to start copying. Once it lands here, this step completes.
            </p>
            <a href={DEPOSIT_URL} target="_blank" rel="noreferrer" className="block">
              <Button type="button" variant="outline" className="w-full">
                Add funds <ExternalLink className="ml-2 h-4 w-4" />
              </Button>
            </a>
            <TxButton label="Re-check balance" pendingLabel="Checking…" onClick={onRecheck} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TxButton } from "./TxButton";
import { ShieldCheck, Ban, CheckCircle2 } from "lucide-react";

export interface AuthorizeAgentCardProps {
  approved: boolean;
  loading?: boolean;
  /**
   * The address being authorized, derived in the follower's own browser from the enclave's published
   * key. Shown because the whole point is that they can check it rather than take our word for it.
   */
  agentAddress?: string;
  onAuthorize: () => Promise<void>;
}

/**
 * "Authorize copy-trading" — the follower signs a wallet message that lets the strategy place trades
 * for them on the off-chain venue. Deliberately abstracted: no Hyperliquid jargon. The key reassurance
 * (and the truth) is that this permission can place trades but can NEVER withdraw funds — the exchange
 * itself rejects a withdrawal signed by an agent key — and it is revocable at any time.
 */
export function AuthorizeAgentCard({
  approved,
  loading,
  agentAddress,
  onAuthorize,
}: AuthorizeAgentCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Authorize copy-trading</CardTitle>
        <CardDescription>Let the strategy trade for you — trading only, never withdrawals.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>Places trades on your behalf when the leader posts a signal.</span>
          </li>
          <li className="flex items-start gap-2">
            <Ban className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>
              <span className="font-medium text-foreground">Cannot withdraw or move your funds</span> —
              only you can.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>Revocable at any time, and expires automatically.</span>
          </li>
        </ul>

        {agentAddress && (
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Address being authorized
            </div>
            <div className="mt-1 break-all font-mono text-xs">{agentAddress}</div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Computed in this browser from the enclave's published key and your own address — yours
              alone, and not shared with any other follower.
            </p>
          </div>
        )}

        {approved ? (
          <div className="inline-flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" /> Copy-trading authorized
          </div>
        ) : (
          <TxButton
            label="Authorize"
            pendingLabel="Waiting for signature…"
            disabled={loading || !agentAddress}
            onClick={onAuthorize}
          />
        )}
      </CardContent>
    </Card>
  );
}

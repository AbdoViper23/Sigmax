import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TxButton } from "./TxButton";
import { ShieldCheck, Ban, CheckCircle2 } from "lucide-react";

export interface AuthorizeAgentCardProps {
  approved: boolean;
  loading?: boolean;
  onAuthorize: () => Promise<void>;
}

/**
 * "Authorize copy-trading" — the follower signs a wallet message that lets the strategy place trades
 * for them. Deliberately abstracted: no Hyperliquid jargon. The key reassurance (and the truth) is
 * that this permission can place trades but can NEVER withdraw funds, and is revocable anytime.
 */
export function AuthorizeAgentCard({ approved, loading, onAuthorize }: AuthorizeAgentCardProps) {
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

        {approved ? (
          <div className="inline-flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" /> Copy-trading authorized
          </div>
        ) : (
          <TxButton
            label="Authorize"
            pendingLabel="Waiting for signature…"
            disabled={loading}
            onClick={onAuthorize}
          />
        )}
      </CardContent>
    </Card>
  );
}

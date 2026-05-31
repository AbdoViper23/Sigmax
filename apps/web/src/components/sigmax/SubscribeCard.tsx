import { Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TxButton } from "./TxButton";
import { SubscriptionStatusBadge } from "./SubscriptionStatusBadge";

export interface SubscribeCardProps {
  strategyName: string;
  monthlyPriceWip: string;
  status: "idle" | "subscribing" | "active";
  activeUntil?: string;
  onSubscribe: () => Promise<void>;
}

export function SubscribeCard({
  strategyName,
  monthlyPriceWip,
  status,
  activeUntil,
  onSubscribe,
}: SubscribeCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Subscribe</CardTitle>
            <CardDescription>
              Copy <span className="font-medium text-foreground">{strategyName}</span> in your own
              vault. The strategy stays encrypted — you only ever see results.
            </CardDescription>
          </div>
          {status === "active" && (
            <SubscriptionStatusBadge active={true} expiry={activeUntil ?? null} />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Price block — the monthly cost, front and center */}
        <div className="flex items-baseline gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <span className="font-mono text-3xl font-semibold tabular-nums">{monthlyPriceWip}</span>
          <span className="text-sm font-medium text-foreground">$WIP</span>
          <span className="text-sm text-muted-foreground">/ month</span>
        </div>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> Automatic copy-execution in
            your own non-custodial vault
          </li>
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> Strategy stays secret — you
            only see outcomes
          </li>
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> Cancel anytime — funds never
            leave your wallet's control
          </li>
        </ul>
        {status !== "active" ? (
          <TxButton label="Subscribe" pendingLabel="Subscribing…" onClick={onSubscribe} />
        ) : (
          <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
            Subscription active. Continue to step 2.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

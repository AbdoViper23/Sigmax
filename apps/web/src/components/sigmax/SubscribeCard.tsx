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
              Pay monthly for access to{" "}
              <span className="font-medium text-foreground">{strategyName}</span>'s encrypted
              signals.
            </CardDescription>
          </div>
          {status === "active" && (
            <SubscriptionStatusBadge active={true} expiry={activeUntil ?? null} />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li>• Monthly access on Story Aeneid</li>
          <li>• Automatic copy-execution in your own vault</li>
          <li>• Strategy stays secret — you only see results</li>
        </ul>
        {status !== "active" ? (
          <TxButton
            label={`Subscribe — pay ${monthlyPriceWip} $WIP`}
            pendingLabel="Subscribing…"
            onClick={onSubscribe}
          />
        ) : (
          <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
            Subscription active. Continue to step 2.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

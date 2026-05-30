import { cn } from "@/lib/utils";

export interface SubscriptionStatusBadgeProps {
  active: boolean;
  expiry: string | null;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SubscriptionStatusBadge({ active, expiry }: SubscriptionStatusBadgeProps) {
  if (!active) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" /> Expired
      </span>
    );
  }
  const soon = expiry && new Date(expiry).getTime() - Date.now() < 1000 * 60 * 60 * 24 * 7;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        soon
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-success/30 bg-success/10 text-success",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", soon ? "bg-warning" : "bg-success")} />
      {soon ? "Expiring soon" : "Active"} {expiry && `until ${fmt(expiry)}`}
    </span>
  );
}

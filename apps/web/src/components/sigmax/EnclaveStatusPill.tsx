import { useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldOff } from "lucide-react";
import { useEnclaveStatus } from "@/hooks/systemStatus";
import { cn } from "@/lib/utils";

/**
 * Live TEE indicator in the global chrome.
 *
 * Confidential compute is the product's central claim, and a claim about a machine nobody can see
 * needs a heartbeat someone can. This polls the enclave's own /state through the failover fetcher
 * and shows exactly three honest states: live (reachable, trading key loaded), degraded (reachable
 * but no key — Hyperliquid signals would be rejected), offline (no route answered). Hovering shows
 * the counters the enclave itself reports, which is the closest thing to watching it work.
 */
export function EnclaveStatusPill() {
  const { health } = useEnclaveStatus();
  const [open, setOpen] = useState(false);

  if (!health) {
    return (
      <span className="hidden h-7 w-24 animate-pulse rounded-full bg-muted sm:inline-block" aria-hidden />
    );
  }

  const spec =
    health.status === "live"
      ? {
          icon: ShieldCheck,
          label: "TEE live",
          dot: "bg-success",
          cls: "border-success/30 bg-success/10 text-success",
        }
      : health.status === "no-key"
        ? {
            icon: ShieldAlert,
            label: "TEE up · no HL key",
            dot: "bg-warning",
            cls: "border-warning/40 bg-warning/10 text-warning",
          }
        : {
            icon: ShieldOff,
            label: "TEE offline",
            dot: "bg-destructive",
            cls: "border-destructive/30 bg-destructive/10 text-destructive",
          };
  const Icon = spec.icon;
  const s = health.status !== "offline" ? health.state.sigmax : undefined;

  return (
    <div
      className="relative hidden sm:block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Enclave status: ${spec.label}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
          spec.cls,
        )}
      >
        <span className="relative flex h-2 w-2">
          {health.status === "live" && (
            <span
              className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none", spec.dot)}
            />
          )}
          <span className={cn("relative inline-flex h-2 w-2 rounded-full", spec.dot)} />
        </span>
        <Icon className="h-3.5 w-3.5" />
        {spec.label}
      </button>

      {open && health.status !== "offline" && (
        <div className="absolute right-0 top-9 z-50 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
          <p className="mb-2 text-xs font-medium">Reported by the enclave itself</p>
          <dl className="space-y-1 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <dt>Signals processed</dt>
              <dd className="font-mono tabular-nums text-foreground">{s?.signalsProcessed ?? 0}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Authorizations signed</dt>
              <dd className="font-mono tabular-nums text-foreground">{s?.authsIssued ?? 0}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Hyperliquid fills</dt>
              <dd className="font-mono tabular-nums text-foreground">{s?.hlOrdersFilled ?? 0}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Replays rejected</dt>
              <dd className="font-mono tabular-nums text-foreground">{s?.duplicatesRejected ?? 0}</dd>
            </div>
          </dl>
          <p className="mt-2 border-t border-border pt-2 text-[11px] leading-snug text-muted-foreground">
            The strategy is plaintext only inside this machine. A restart clears its keys — this
            heartbeat is how you know it is the same live enclave.
          </p>
        </div>
      )}
    </div>
  );
}

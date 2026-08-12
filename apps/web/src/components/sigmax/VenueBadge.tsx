import { Landmark, Waves, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SignalVenueT } from "@sigmax/shared";

/**
 * A venue, everywhere it appears.
 *
 * The product now executes on two venues whose guarantees genuinely differ — on Flare the *contract*
 * enforces the caps and the price floor; on Hyperliquid *attested code* does, because Hyperliquid has
 * nothing on-chain to verify a TEE signature against. That distinction is the kind a user should be
 * able to see at a glance rather than read in a footnote, so venue gets a consistent visual identity
 * and this component is the only place it is defined.
 *
 * Colour is never the sole carrier: every badge pairs its hue with an icon AND a label, so it survives
 * greyscale, colour-blindness, and a screenshot in a submission PDF.
 */

export interface VenueMeta {
  label: string;
  /** Where the trade actually settles. */
  settles: string;
  /** What enforces the limits — the honest one-liner. */
  enforcedBy: string;
  icon: LucideIcon;
}

export const VENUE_META: Record<Exclude<SignalVenueT, "arbitrum">, VenueMeta> = {
  flare: {
    label: "Flare",
    settles: "Your own vault on Coston2",
    enforcedBy: "Enforced on-chain by your vault",
    // A vault is a building you hold the key to — the on-chain, custodial-by-you half.
    icon: Landmark,
  },
  hyperliquid: {
    label: "Hyperliquid",
    settles: "Your own Hyperliquid account",
    enforcedBy: "Enforced by attested enclave code",
    // Order-book liquidity — the off-chain half.
    icon: Waves,
  },
};

const styles = {
  flare: {
    wrap: "border-chain-flare/30 bg-chain-flare/10 text-chain-flare",
    dot: "bg-chain-flare",
  },
  hyperliquid: {
    wrap: "border-chain-hyperliquid/30 bg-chain-hyperliquid/10 text-chain-hyperliquid",
    dot: "bg-chain-hyperliquid",
  },
} as const;

export type BadgeVenue = keyof typeof styles;

/** Narrow a signal venue to one this UI renders. Arbitrum is legacy and never shown. */
export function asBadgeVenue(venue: SignalVenueT): BadgeVenue | null {
  return venue === "flare" || venue === "hyperliquid" ? venue : null;
}

export function VenueBadge({
  venue,
  size = "sm",
  className,
}: {
  venue: BadgeVenue;
  size?: "sm" | "md";
  className?: string;
}) {
  const meta = VENUE_META[venue];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
        styles[venue].wrap,
        className,
      )}
    >
      <Icon className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      {meta.label}
    </span>
  );
}

/**
 * A small legend row: the venue, where it settles, and what enforces the limits there.
 * Used wherever a user is choosing or reviewing a venue, so the trade-off is never implicit.
 */
export function VenueSummary({ venue }: { venue: BadgeVenue }) {
  const meta = VENUE_META[venue];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <VenueBadge venue={venue} />
      <span>{meta.settles}</span>
      <span aria-hidden className="text-border">
        ·
      </span>
      <span>{meta.enforcedBy}</span>
    </div>
  );
}

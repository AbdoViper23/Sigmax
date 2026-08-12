import { cn } from "@/lib/utils";

export type ChainId = "flare" | "story" | "arbitrum" | "unknown";

const labels: Record<ChainId, string> = {
  flare: "Flare Coston2",
  story: "Story Aeneid",
  arbitrum: "Arbitrum",
  unknown: "Wrong network",
};

const styles: Record<ChainId, { wrap: string; dot: string }> = {
  flare: { wrap: "border-chain-flare/30 bg-chain-flare/10 text-chain-flare", dot: "bg-chain-flare" },
  story: { wrap: "border-chain-story/30 bg-chain-story/10 text-chain-story", dot: "bg-chain-story" },
  arbitrum: {
    wrap: "border-chain-arbitrum/30 bg-chain-arbitrum/10 text-chain-arbitrum",
    dot: "bg-chain-arbitrum",
  },
  unknown: { wrap: "border-danger/30 bg-danger/10 text-danger", dot: "bg-danger" },
};

/**
 * Which chain the wallet is currently on.
 *
 * Distinct from `VenueBadge`, and the difference is worth keeping: a CHAIN is where the wallet is
 * connected, a VENUE is where a trade settles. Hyperliquid is a venue and not a chain the wallet
 * switches to, which is exactly why it does not appear here.
 */
export function NetworkBadge({ chain }: { chain: ChainId }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        styles[chain].wrap,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", styles[chain].dot)} aria-hidden />
      {labels[chain]}
    </span>
  );
}

import { cn } from "@/lib/utils";

export type ChainId = "flare" | "story" | "arbitrum" | "unknown";

const labels: Record<ChainId, string> = {
  flare: "Flare Coston2",
  story: "Story Aeneid",
  arbitrum: "Arbitrum",
  unknown: "Wrong network",
};

export function NetworkBadge({ chain }: { chain: ChainId }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        chain === "flare" && "border-chain-flare/30 bg-chain-flare/10 text-chain-flare",
        chain === "story" && "border-chain-story/30 bg-chain-story/10 text-chain-story",
        chain === "arbitrum" && "border-chain-arbitrum/30 bg-chain-arbitrum/10 text-chain-arbitrum",
        chain === "unknown" && "border-danger/30 bg-danger/10 text-danger",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          chain === "flare" && "bg-chain-flare",
          chain === "story" && "bg-chain-story",
          chain === "arbitrum" && "bg-chain-arbitrum",
          chain === "unknown" && "bg-danger",
        )}
      />
      {labels[chain]}
    </span>
  );
}

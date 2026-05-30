import { TxButton } from "./TxButton";
import type { ChainId } from "./NetworkBadge";

export interface NetworkSwitchPromptProps {
  requiredChain: "story" | "arbitrum";
  current: ChainId;
  onSwitch: () => Promise<void>;
  children: React.ReactNode;
}

const chainLabel = { story: "Story Aeneid", arbitrum: "Arbitrum" } as const;

/**
 * Wrap an action area. If current chain ≠ required, replaces the action with a
 * "Switch network" prompt. Otherwise renders children.
 */
export function NetworkSwitchPrompt({
  requiredChain,
  current,
  onSwitch,
  children,
}: NetworkSwitchPromptProps) {
  if (current === requiredChain) return <>{children}</>;
  return (
    <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        This action runs on{" "}
        <span className="font-medium text-foreground">{chainLabel[requiredChain]}</span>.
      </p>
      <TxButton
        label={`Switch to ${chainLabel[requiredChain]}`}
        pendingLabel="Switching…"
        onClick={onSwitch}
      />
    </div>
  );
}

import { useChainId, useSwitchChain } from "wagmi";
import { env } from "@/lib/env";
import { toChainId } from "@/lib/wagmi";

export type UiChain = "flare" | "story" | "arbitrum";

const chainIdFor: Record<UiChain, number> = {
  flare: env.flareChainId,
  story: env.storyChainId,
  arbitrum: env.liquidityChainId,
};

/** Current UI chain + a switcher, for NetworkSwitchPrompt. Reads/writes target chains explicitly. */
export function useNetwork() {
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const current = toChainId(chainId);

  const switchTo = async (target: UiChain): Promise<void> => {
    await switchChainAsync({ chainId: chainIdFor[target] });
  };

  return { current, switchTo };
}

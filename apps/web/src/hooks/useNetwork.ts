import { useChainId, useSwitchChain } from "wagmi";
import { env } from "@/lib/env";
import { toChainId } from "@/lib/wagmi";

export type UiChain = "story" | "arbitrum";

/** Current UI chain + a switcher, for NetworkSwitchPrompt. Reads/writes target chains explicitly. */
export function useNetwork() {
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const current = toChainId(chainId);

  const switchTo = async (target: UiChain): Promise<void> => {
    const id = target === "story" ? env.storyChainId : env.liquidityChainId;
    await switchChainAsync({ chainId: id });
  };

  return { current, switchTo };
}

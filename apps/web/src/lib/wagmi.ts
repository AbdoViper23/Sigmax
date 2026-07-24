import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { arbitrum } from "wagmi/chains";
import { defineChain } from "viem";
import { env } from "./env";

/** Story Aeneid (1315) — license/subscribe/IP/CDR chain. */
export const storyAeneid = defineChain({
  id: env.storyChainId,
  name: "Story Aeneid",
  nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
  rpcUrls: { default: { http: [env.storyRpcUrl] } },
  blockExplorers: { default: { name: "Storyscan", url: env.explorers.story } },
  testnet: true,
});

/**
 * Two-chain wagmi config: Story Aeneid (subscribe/license) + Arbitrum (vault/deposit/swaps).
 * `ssr: true` so TanStack Start's server render doesn't touch browser-only wallet state.
 */
export const wagmiConfig = getDefaultConfig({
  appName: "Sigmax",
  projectId: env.walletConnectProjectId,
  chains: [storyAeneid, arbitrum],
  transports: {
    [storyAeneid.id]: http(env.storyRpcUrl),
    [arbitrum.id]: http(env.liquidityRpcUrl),
  },
  ssr: true,
});

/** Map a connected chainId to the UI's ChainId union used by NetworkBadge/NetworkSwitchPrompt. */
export function toChainId(chainId: number | undefined): "story" | "arbitrum" | "unknown" {
  if (chainId === env.storyChainId) return "story";
  if (chainId === env.liquidityChainId) return "arbitrum";
  return "unknown";
}

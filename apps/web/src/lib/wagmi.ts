import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { arbitrum } from "wagmi/chains";
import { defineChain } from "viem";
import { FLARE_COSTON2 } from "@sigmax/shared";
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
 * Flare Coston2 (114) — the Flare build's single chain: subscriptions, signal publishing, the FCC
 * extension, the vaults, AND the swap venue all live here (no cross-chain hop).
 */
export const flareCoston2 = defineChain({
  id: FLARE_COSTON2.id,
  name: FLARE_COSTON2.name,
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [env.flareRpcUrl] } },
  blockExplorers: { default: { name: "Coston2 Explorer", url: env.explorers.flare } },
  testnet: true,
});

/**
 * wagmi config. Coston2 is first — it is the default the wallet is prompted to switch to. Story
 * Aeneid and Arbitrum stay registered so the legacy Story pages keep working during the migration.
 * `ssr: true` so TanStack Start's server render doesn't touch browser-only wallet state.
 */
export const wagmiConfig = getDefaultConfig({
  appName: "Sigmax",
  projectId: env.walletConnectProjectId,
  chains: [flareCoston2, storyAeneid, arbitrum],
  transports: {
    [flareCoston2.id]: http(env.flareRpcUrl),
    [storyAeneid.id]: http(env.storyRpcUrl),
    [arbitrum.id]: http(env.liquidityRpcUrl),
  },
  ssr: true,
});

/** Map a connected chainId to the UI's ChainId union used by NetworkBadge/NetworkSwitchPrompt. */
export function toChainId(chainId: number | undefined): "flare" | "story" | "arbitrum" | "unknown" {
  if (chainId === env.flareChainId) return "flare";
  if (chainId === env.storyChainId) return "story";
  if (chainId === env.liquidityChainId) return "arbitrum";
  return "unknown";
}

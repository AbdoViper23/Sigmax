/** Layer 1 — Story (confidentiality + IP/royalty). Verified 2026-05-30. */
export const STORY_AENEID = {
  id: 1315,
  name: "Story Aeneid",
  rpcUrl: "https://aeneid.storyrpc.io",
  explorer: "https://aeneid.storyscan.io",
} as const;

/** Layer 3 — liquidity chain (spot swaps). Demoed via `anvil --fork-url`. */
export const ARBITRUM_ONE = {
  id: 42161,
  name: "Arbitrum One",
  rpcUrl: "https://arb1.arbitrum.io/rpc",
} as const;

/**
 * Flare Coston2 — the single chain of the Flare build: FCC control plane (SignalRegistry /
 * InstructionSender / SubscriptionRegistry / CopyVaultFlare) AND the swap venue, so there is no
 * cross-chain hop. Confirmed on-chain 2026-07-23 (docs/flare/reference/phase-0-findings.md).
 */
export const FLARE_COSTON2 = {
  id: 114,
  name: "Flare Coston2",
  rpcUrl: "https://coston2-api.flare.network/ext/C/rpc",
  explorer: "https://coston2-explorer.flare.network",
} as const;

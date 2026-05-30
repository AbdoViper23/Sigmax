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

import type { Hex } from "viem";
import {
  STORY_AENEID,
  ARBITRUM_ONE,
  FLARE_COSTON2,
  STORY_AENEID_ADDRESSES,
  ARBITRUM_ADDRESSES,
  COSTON2_ADDRESSES,
  FTSO_FEED_IDS,
} from "@sigmax/shared";

/**
 * Runtime config from Vite `VITE_*` env. On-chain addresses default to @sigmax/shared where they are
 * fixed (tokens, conditions); the per-deployment ones (registry, factory, strategy IP, agent) come from
 * env and gate `chainConfigReady`. When not ready, the UI falls back to mock data so it always renders.
 */
const E = import.meta.env as Record<string, string | undefined>;

const asAddr = (v: string | undefined): Hex | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Hex) : undefined;

export const env = {
  // chains
  storyChainId: STORY_AENEID.id,
  liquidityChainId: ARBITRUM_ONE.id,
  flareChainId: FLARE_COSTON2.id,
  storyRpcUrl: E.VITE_STORY_RPC_URL ?? STORY_AENEID.rpcUrl,
  liquidityRpcUrl: E.VITE_LIQUIDITY_RPC_URL ?? ARBITRUM_ONE.rpcUrl,
  flareRpcUrl: E.VITE_FLARE_RPC_URL ?? FLARE_COSTON2.rpcUrl,

  // per-deployment (env-driven; gate readiness)
  registryAddress: asAddr(E.VITE_REGISTRY_ADDRESS),
  factoryAddress: asAddr(E.VITE_FACTORY_ADDRESS),
  strategyIpId: asAddr(E.VITE_STRATEGY_IP_ID),
  agentAddress: asAddr(E.VITE_AGENT_ADDRESS),

  // --- Flare (Coston2) deployment ---
  // Our own contracts, from env so a redeploy is config-only.
  flareSubscriptionRegistry: asAddr(E.VITE_FLARE_SUBSCRIPTION_REGISTRY),
  flareVaultFactory: asAddr(E.VITE_FLARE_VAULT_FACTORY),
  /** The FCC InstructionSender — publishSignal() commits the ciphertext AND routes it to the TEE. */
  flareInstructionSender: asAddr(E.VITE_FLARE_INSTRUCTION_SENDER),
  flareTeeVerifier: asAddr(E.VITE_FLARE_TEE_VERIFIER),
  /** Public URL of the FCC ext-proxy; the browser reads the enclave's ECIES key from its /info. */
  flareProxyUrl: E.VITE_FLARE_PROXY_URL?.replace(/\/$/, ""),

  // Fixed Coston2 infrastructure (verified on-chain).
  fxrp: asAddr(E.VITE_FXRP_ADDRESS) ?? (COSTON2_ADDRESSES.fxrp as Hex),
  /** Quote leg for FXRP swaps; set once Phase 0b picks the stablecoin/pool. */
  flareQuoteToken: asAddr(E.VITE_FLARE_QUOTE_TOKEN),
  blazeSwapRouter: asAddr(E.VITE_BLAZESWAP_ROUTER) ?? (COSTON2_ADDRESSES.blazeSwapRouter as Hex),
  ftsoV2: asAddr(E.VITE_FTSO_V2) ?? (COSTON2_ADDRESSES.ftsoV2 as Hex),
  ftsoXrpUsdFeedId: FTSO_FEED_IDS.xrpUsd,

  // Hyperliquid (copy-trading execution venue). hlAgentAddress = the PUBLIC address of the backend's
  // HYPERLIQUID_AGENT_PK; the follower approves it to trade on their behalf (never to withdraw).
  hlAgentAddress: asAddr(E.VITE_HL_AGENT_ADDRESS),
  hlTestnet: (E.VITE_HL_TESTNET ?? "true").toLowerCase() !== "false",

  // tokens (fixed defaults from shared)
  wip: asAddr(E.VITE_WIP_ADDRESS) ?? (STORY_AENEID_ADDRESSES.wip as Hex),
  usdc: asAddr(E.VITE_USDC_ADDRESS) ?? (ARBITRUM_ADDRESSES.usdc as Hex),
  weth: asAddr(E.VITE_WETH_ADDRESS) ?? (ARBITRUM_ADDRESSES.weth as Hex),

  // routers to whitelist on the vault (comma-separated); the agent's swap router(s)
  routers: (E.VITE_ROUTERS ?? "")
    .split(",")
    .map((s) => asAddr(s.trim()))
    .filter((a): a is Hex => Boolean(a)),

  // agent HTTP endpoint for publishing signals (CDR encryption is server-only; see hooks/leader.ts).
  // When unset, the leader's Publish Signal stays mock so the page still works without the agent.
  agentApiUrl: E.VITE_AGENT_API_URL?.replace(/\/$/, ""),

  // platform fee (bps) used by SubscriptionRegistry.createPlan; 15% default, matches the FE display.
  platformFeeBps: Number(E.VITE_PLATFORM_FEE_BPS ?? "1500"),

  // Display name for the single configured strategy. No name is stored on-chain, so it is config —
  // not mock data. Override per deployment with VITE_STRATEGY_NAME.
  strategyName: E.VITE_STRATEGY_NAME || "Sigmax Strategy",

  // wallet connect (RainbowKit); placeholder is fine for injected wallets in the demo
  walletConnectProjectId: E.VITE_WALLETCONNECT_PROJECT_ID || "sigmax-demo",

  explorers: {
    story: "https://aeneid.storyscan.io",
    arbitrum: "https://arbiscan.io",
    flare: FLARE_COSTON2.explorer,
  },
} as const;

/** True only when the per-deployment addresses are present → use real hooks; else fall back to mock. */
export const chainConfigReady = Boolean(
  env.registryAddress && env.factoryAddress && env.strategyIpId && env.agentAddress,
);

/**
 * Flare readiness: the control plane plus the proxy URL the browser needs to fetch the enclave's
 * ECIES key. Without the proxy we cannot encrypt client-side, and publishing plaintext is never an
 * acceptable fallback — the publish flow blocks instead (see hooks/flare.ts).
 */
export const flareConfigReady = Boolean(
  env.flareSubscriptionRegistry &&
    env.flareVaultFactory &&
    env.flareInstructionSender &&
    env.flareQuoteToken &&
    env.flareProxyUrl,
);

/**
 * Hyperliquid copy-trading readiness: the subscription registry + strategy + the HL agent address to
 * authorize. Funding is external (the follower deposits to their own HL account), so it isn't gated
 * here. When false, the follower page falls back to mock so it always renders.
 */
export const hlConfigReady = Boolean(
  env.registryAddress && env.strategyIpId && env.hlAgentAddress,
);

/**
 * Tokens a leader can publish a signal for. MUST stay a subset of what the vault whitelists at
 * creation — publishing any other token would revert at execution. The quote leg is implicit
 * (USDC on Arbitrum, the Coston2 stablecoin on Flare), so only the traded leg is listed.
 */
export const publishableTokens: { symbol: string; address: string }[] = [
  { symbol: "FXRP", address: env.fxrp },
  { symbol: "WETH", address: env.weth },
];

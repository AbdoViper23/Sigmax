import type { Hex } from "viem";
import {
  STORY_AENEID,
  ARBITRUM_ONE,
  STORY_AENEID_ADDRESSES,
  ARBITRUM_ADDRESSES,
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
  storyRpcUrl: E.VITE_STORY_RPC_URL ?? STORY_AENEID.rpcUrl,
  liquidityRpcUrl: E.VITE_LIQUIDITY_RPC_URL ?? ARBITRUM_ONE.rpcUrl,

  // per-deployment (env-driven; gate readiness)
  registryAddress: asAddr(E.VITE_REGISTRY_ADDRESS),
  factoryAddress: asAddr(E.VITE_FACTORY_ADDRESS),
  strategyIpId: asAddr(E.VITE_STRATEGY_IP_ID),
  agentAddress: asAddr(E.VITE_AGENT_ADDRESS),

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
  },
} as const;

/** True only when the per-deployment addresses are present → use real hooks; else fall back to mock. */
export const chainConfigReady = Boolean(
  env.registryAddress && env.factoryAddress && env.strategyIpId && env.agentAddress,
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
 * creation (`createVault` whitelists [usdc, weth]) — publishing any other token would revert at
 * execution. USDC is the quote token, so WETH is the only spot leg in the MVP.
 */
export const publishableTokens: { symbol: string; address: string }[] = [
  { symbol: "WETH", address: env.weth },
];

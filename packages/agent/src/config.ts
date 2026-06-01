import { z } from "zod";
import type { Hex } from "viem";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/, "expected 0x-hex");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an address");

/**
 * Agent configuration, loaded from env. Validated with zod; values are NEVER logged.
 * On-chain addresses are read from env so the agent runs against whatever is already deployed
 * (the deploy/live wiring is done separately).
 */
export const AgentConfigSchema = z.object({
  // keys
  agentPk: hex, // AGENT_PK — executor key (bounded executeSwap only; never withdraws)
  cdrKey: hex, // CDR_KEY — decrypt key (holds the operator license)
  // endpoints
  storyApiUrl: z.string().url(), // Story-API REST base for CDR DKG partials
  storyRpcUrl: z.string().url(), // Story L1 RPC (SubscriptionRegistry reads)
  liquidityRpcUrl: z.string().url(), // forked Arbitrum RPC (anvil) — swaps execute here
  // contracts / ids
  registryAddress: address, // SubscriptionRegistry on Story L1
  factoryAddress: address, // CopyVaultFactory on the liquidity chain
  // MULTI-LEADER: the agent no longer watches a single strategy — it discovers leaders from
  // PlanCreated and the licenses it holds. Both fields are optional seeds (e.g. the demo leader).
  strategyIpId: address.optional(), // optional: a configured demo strategy IP
  operatorLicenseTokenId: z.coerce.bigint().optional(), // optional: a pre-known operator license id
  // optional
  zeroExApiKey: z.string().optional(), // 0x Swap API v2 key (live quotes)
  liquidityChainId: z.coerce.number().int().positive().default(42161),
  followers: z.array(address).default([]), // demo follower set (FOLLOWERS=0x..,0x..)
  pollMs: z.coerce.number().int().positive().default(10_000), // TP/SL poll interval
  defaultSlippageBps: z.coerce.number().int().min(1).max(10_000).default(100),
  statePath: z.string().optional(), // optional JSON persist path for NON-secret position metadata
  // HTTP publish endpoint (leader UI POSTs signals here; CDR encryption is server-only)
  httpPort: z.coerce.number().int().positive().default(8787), // HTTP_PORT
  webOrigin: z.string().default("http://localhost:5173"), // WEB_ORIGIN — CORS allow-origin for the web app
});

export type AgentConfig = z.infer<typeof AgentConfigSchema> & {
  agentPk: Hex;
  cdrKey: Hex;
  registryAddress: Hex;
  factoryAddress: Hex;
  strategyIpId?: Hex;
};

/** Parse process.env into a validated AgentConfig. Throws (with field paths) if anything is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = AgentConfigSchema.parse({
    agentPk: env.AGENT_PK,
    cdrKey: env.CDR_KEY,
    storyApiUrl: env.STORY_API_URL,
    storyRpcUrl: env.STORY_RPC_URL,
    liquidityRpcUrl: env.LIQUIDITY_RPC_URL,
    registryAddress: env.REGISTRY_ADDRESS,
    factoryAddress: env.FACTORY_ADDRESS,
    strategyIpId: env.STRATEGY_IP_ID,
    operatorLicenseTokenId: env.OPERATOR_LICENSE_TOKEN_ID,
    zeroExApiKey: env.ZEROX_API_KEY,
    liquidityChainId: env.LIQUIDITY_CHAIN_ID,
    followers: env.FOLLOWERS ? env.FOLLOWERS.split(",").map((s: string) => s.trim()) : undefined,
    pollMs: env.POLL_MS,
    defaultSlippageBps: env.DEFAULT_SLIPPAGE_BPS,
    statePath: env.STATE_PATH,
    httpPort: env.HTTP_PORT,
    webOrigin: env.WEB_ORIGIN,
  });
  return parsed as AgentConfig;
}

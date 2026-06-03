import { z } from "zod";
import type { Hex } from "viem";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/, "expected 0x-hex");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an address");

/**
 * Agent configuration, loaded from env. Validated with zod; values are NEVER logged.
 * On-chain addresses are read from env so the agent runs against whatever is already deployed
 * (the deploy/live wiring is done separately).
 */
export const AgentConfigSchema = z
  .object({
    // keys
    agentPk: hex, // AGENT_PK — executor key (bounded executeSwap / HL spot order only; never withdraws)
    cdrKey: hex, // CDR_KEY — decrypt key; holds the operator license(s) the agent decrypts with
    // endpoints
    storyApiUrl: z.string().url(), // Story-API REST base for CDR DKG partials (threshold decryption)
    storyRpcUrl: z.string().url(), // Story L1 RPC (SubscriptionRegistry reads)
    // Arbitrum-only: forked Arbitrum RPC (anvil) — swaps execute here. Optional so the Hyperliquid
    // venue doesn't require Arbitrum wiring; required when executionVenue === "arbitrum" (see refine).
    liquidityRpcUrl: z.string().url().optional(),
    // contracts / ids
    registryAddress: address, // SubscriptionRegistry on Story L1
    factoryAddress: address.optional(), // CopyVaultFactory on the liquidity chain (Arbitrum venue only)
    // MULTI-LEADER: the agent no longer watches a single strategy — it discovers leaders from
    // PlanCreated and the licenses it holds. Both fields are optional seeds (e.g. the demo leader).
    strategyIpId: address.optional(), // optional: a configured demo strategy IP
    operatorLicenseTokenId: z.coerce.bigint().optional(), // optional: a pre-known operator license id
    // EXECUTION VENUE: which Executor the agent wires. "arbitrum" = CopyVault + 0x (default,
    // unchanged); "hyperliquid" = HyperCore spot order book. Additive — Arbitrum stays a fallback.
    executionVenue: z.enum(["arbitrum", "hyperliquid"]).default("arbitrum"), // EXECUTION_VENUE
    // optional (Arbitrum venue)
    zeroExApiKey: z.string().optional(), // 0x Swap API v2 key (live quotes)
    liquidityChainId: z.coerce.number().int().positive().default(42161),
    // Hyperliquid venue
    // HYPERLIQUID_TESTNET (default testnet for the demo). NB: z.coerce.boolean treats "false" as
    // true, so parse the string explicitly: only "false"/"0"/"" disable testnet.
    hyperliquidTestnet: z
      .preprocess((v) => (typeof v === "string" ? !["false", "0", ""].includes(v.toLowerCase()) : v), z.boolean())
      .default(true),
    hyperliquidAgentPk: hex.optional(), // HYPERLIQUID_AGENT_PK — HL agent key; falls back to agentPk
    // Per-trade cap in uniform 1e8 USD units (e.g. $15 cap = 1_500_000_000). Replaces the on-chain
    // CopyVault cap, which has no HL equivalent. Required for the HL venue (see refine).
    hyperliquidPerTradeCap: z.coerce.bigint().optional(), // HYPERLIQUID_PER_TRADE_CAP
    // Maps a signal's EVM-style token address -> the HL spot coin symbol (e.g. {"0x..":"HYPE"}).
    // HL spot has no ERC-20 addresses, so the agent translates Hex tokens to HL coins via this map.
    hyperliquidTokens: z.record(z.string(), z.string()).optional(), // HYPERLIQUID_TOKENS (JSON)
    // DEMO-ONLY: treat every address in `followers` as an active subscriber, bypassing the on-chain
    // SubscriptionRegistry.isActive check. Default OFF — production must use real subscriptions.
    trustConfiguredFollowers: z
      .preprocess((v) => (typeof v === "string" ? ["true", "1"].includes(v.toLowerCase()) : v), z.boolean())
      .default(false), // TRUST_CONFIGURED_FOLLOWERS
    followers: z.array(address).default([]), // demo follower set (FOLLOWERS=0x..,0x..)
    pollMs: z.coerce.number().int().positive().default(10_000), // TP/SL poll interval
    defaultSlippageBps: z.coerce.number().int().min(1).max(10_000).default(100),
    statePath: z.string().optional(), // optional JSON persist path for NON-secret position metadata
    // HTTP publish endpoint (leader UI POSTs signals here; CDR encryption is server-only)
    httpPort: z.coerce.number().int().positive().default(8787), // HTTP_PORT
    // WEB_ORIGIN — CORS allow-origin(s) for the web app. Comma-separated list; the server echoes the
    // request's Origin when it matches. Defaults cover the common Vite dev ports (5173 and 8080).
    webOrigin: z.string().default("http://localhost:5173,http://localhost:8080"),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.executionVenue === "arbitrum") {
      if (!cfg.liquidityRpcUrl)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["liquidityRpcUrl"], message: "required when executionVenue=arbitrum" });
      if (!cfg.factoryAddress)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["factoryAddress"], message: "required when executionVenue=arbitrum" });
    } else {
      // HYPERLIQUID_TOKENS is now OPTIONAL: signals carry the spot coin symbol directly, so the agent
      // resolves any coin live from spotMeta. The map remains as an optional legacy address→symbol override.
      if (cfg.hyperliquidPerTradeCap === undefined)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hyperliquidPerTradeCap"], message: "required when executionVenue=hyperliquid" });
    }
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema> & {
  agentPk: Hex;
  cdrKey: Hex;
  registryAddress: Hex;
  factoryAddress?: Hex;
  strategyIpId?: Hex;
  hyperliquidAgentPk?: Hex;
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
    executionVenue: env.EXECUTION_VENUE,
    zeroExApiKey: env.ZEROX_API_KEY,
    liquidityChainId: env.LIQUIDITY_CHAIN_ID,
    hyperliquidTestnet: env.HYPERLIQUID_TESTNET,
    hyperliquidAgentPk: env.HYPERLIQUID_AGENT_PK,
    hyperliquidPerTradeCap: env.HYPERLIQUID_PER_TRADE_CAP,
    hyperliquidTokens: env.HYPERLIQUID_TOKENS ? JSON.parse(env.HYPERLIQUID_TOKENS) : undefined,
    trustConfiguredFollowers: env.TRUST_CONFIGURED_FOLLOWERS,
    followers: env.FOLLOWERS ? env.FOLLOWERS.split(",").map((s: string) => s.trim()) : undefined,
    pollMs: env.POLL_MS,
    defaultSlippageBps: env.DEFAULT_SLIPPAGE_BPS,
    statePath: env.STATE_PATH,
    httpPort: env.HTTP_PORT,
    // Empty string wouldn't trigger the zod default — coerce blank to undefined so the default applies.
    webOrigin: env.WEB_ORIGIN || undefined,
  });
  return parsed as AgentConfig;
}

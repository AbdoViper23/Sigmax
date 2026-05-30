import { createPublicClient, defineChain, http, type Hex, type PublicClient } from "viem";
import { STORY_AENEID } from "@sigmax/shared";
import { SUBSCRIPTION_REGISTRY_ABI } from "./abis.js";
import type { SubscriberSource } from "./ports.js";

export interface RegistrySubscriberSourceConfig {
  storyRpcUrl: string;
  registryAddress: Hex;
  followers: Hex[]; // demo follower set
  chainId?: number; // default Story Aeneid
}

/**
 * Eligibility gate. Reads `SubscriptionRegistry.isActive(follower, strategyId)` directly from Story L1
 * (a cross-chain view call — no messaging needed; doc 31). The follower set is supplied by config for
 * the demo (production would index it). The agent reads this on Story while it executes on the L2 fork.
 */
export class RegistrySubscriberSource implements SubscriberSource {
  private readonly publicClient: PublicClient;
  private readonly cfg: RegistrySubscriberSourceConfig;

  constructor(cfg: RegistrySubscriberSourceConfig) {
    this.cfg = cfg;
    const chain = defineChain({
      id: cfg.chainId ?? STORY_AENEID.id,
      name: STORY_AENEID.name,
      nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
      rpcUrls: { default: { http: [cfg.storyRpcUrl] } },
    });
    this.publicClient = createPublicClient({ chain, transport: http(cfg.storyRpcUrl) });
  }

  async isActive(follower: Hex, strategyId: Hex): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.cfg.registryAddress,
      abi: SUBSCRIPTION_REGISTRY_ABI,
      functionName: "isActive",
      args: [follower, strategyId],
    });
  }

  async listFollowers(_strategyId: Hex): Promise<Hex[]> {
    return this.cfg.followers;
  }
}

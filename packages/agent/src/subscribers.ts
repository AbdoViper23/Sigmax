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

  /**
   * Followers of a strategy, discovered on-chain by scanning `Subscribed(strategyId)` events on Story
   * (multi-leader: each strategy gets its own subscriber set). The pipeline still gates each one with
   * `isActive` before executing, so returning ever-subscribed addresses (a superset) is safe. Any
   * `cfg.followers` are merged in as a local-dev override.
   */
  async listFollowers(strategyId: Hex): Promise<Hex[]> {
    const set = new Set<Hex>(this.cfg.followers.map((f) => f.toLowerCase() as Hex));
    try {
      const logs = await this.publicClient.getContractEvents({
        address: this.cfg.registryAddress,
        abi: SUBSCRIPTION_REGISTRY_ABI,
        eventName: "Subscribed",
        args: { strategyId },
        fromBlock: "earliest",
        toBlock: "latest",
      });
      for (const l of logs) {
        const subscriber = (l.args as { subscriber?: Hex }).subscriber;
        if (subscriber) set.add(subscriber.toLowerCase() as Hex);
      }
    } catch {
      // On a query failure, fall back to the configured set (don't crash the run).
    }
    return [...set];
  }
}

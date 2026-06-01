import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, parseUnits, zeroAddress, type Hex } from "viem";
import { env } from "@/lib/env";
import { SUBSCRIPTION_REGISTRY_ABI } from "@/lib/abis";
import { PRICE_SCALE, type Signal } from "@sigmax/shared";

const WIP_DECIMALS = 18;
const STORY = env.storyChainId;

/** Form shape emitted by PublishSignalForm. */
export interface PublishForm {
  action: "ENTRY" | "EXIT";
  token: string;
  sizePercent: number;
  maxEntryPrice?: string;
  takeProfitPrice?: string;
  stopLossPrice?: string;
  slippagePercent: number;
  expiresInHours: number;
}

/** Human USD price → integer string scaled by 10^PRICE_SCALE (the on-chain signal encoding). */
function scalePrice(p?: string): string {
  if (!p || p.trim() === "") return "0";
  return parseUnits(p as `${number}`, PRICE_SCALE).toString();
}

/**
 * Plan read + createPlan() on Story for the single configured strategy. `registered` means a plan
 * already exists (its leader is set). The IP Asset itself is registered out-of-band (deploy script);
 * here the leader only creates the subscription plan in SubscriptionRegistry.
 */
export function useLeaderPlan() {
  const { writeContractAsync } = useWriteContract();
  const pub = usePublicClient({ chainId: STORY });
  const strategyId = env.strategyIpId;

  const plan = useReadContract({
    address: env.registryAddress,
    abi: SUBSCRIPTION_REGISTRY_ABI,
    functionName: "plans",
    args: strategyId ? [strategyId] : undefined,
    chainId: STORY,
    query: { enabled: Boolean(strategyId && env.registryAddress) },
  });

  const leader = plan.data?.[0];
  const monthlyPrice = plan.data?.[2] ?? 0n;
  const active = Boolean(plan.data?.[4]);
  const registered = Boolean(leader && leader !== zeroAddress);

  const createPlan = async (v: {
    username: string;
    displayName: string;
    monthlyPriceWip: string;
  }): Promise<void> => {
    if (!pub || !strategyId || !env.registryAddress) throw new Error("registry not configured");
    // username/displayName are cosmetic (off-chain profile, persisted by the caller via
    // lib/leaderProfiles.ts) — SubscriptionRegistry stores no name on-chain, only the price.
    const price = parseUnits(v.monthlyPriceWip, WIP_DECIMALS);
    const hash = await writeContractAsync({
      address: env.registryAddress,
      abi: SUBSCRIPTION_REGISTRY_ABI,
      functionName: "createPlan",
      args: [strategyId, env.wip, price, env.platformFeeBps, v.username, v.displayName],
      chainId: STORY,
    });
    await pub.waitForTransactionReceipt({ hash });
    await plan.refetch();
  };

  return {
    ipId: strategyId,
    registered,
    active,
    monthlyPriceWip: formatUnits(monthlyPrice, WIP_DECIMALS),
    createPlan,
  };
}

/**
 * Strategy stats derived from `Subscribed` events on Story (there is no on-chain counter):
 *  - `subscribers`: unique subscriber addresses.
 *  - `totalEarnedWip`: the leader's cumulative take = sum(paid) × (1 − platformFeeBps) — the exact
 *    split the registry transfers to the leader on every subscribe/renew (no claim step; see
 *    SubscriptionRegistry.subscribe). This is real, not an indexer estimate.
 * Returns zeros while loading / when not configured.
 */
export function useStrategyStats(strategyIdArg?: Hex) {
  const pub = usePublicClient({ chainId: STORY });
  const strategyId = strategyIdArg ?? env.strategyIpId;

  const q = useQuery({
    queryKey: ["strategy-stats", strategyId, env.platformFeeBps],
    enabled: Boolean(pub && strategyId && env.registryAddress),
    queryFn: async (): Promise<{ subscribers: number; totalEarnedWip: string }> => {
      if (!pub || !strategyId || !env.registryAddress) {
        return { subscribers: 0, totalEarnedWip: "0" };
      }
      const logs = await pub.getContractEvents({
        address: env.registryAddress,
        abi: SUBSCRIPTION_REGISTRY_ABI,
        eventName: "Subscribed",
        args: { strategyId },
        fromBlock: "earliest",
        toBlock: "latest",
      });
      const set = new Set<string>();
      let grossPaid = 0n;
      for (const l of logs) {
        const { subscriber, paid } = l.args as { subscriber?: string; paid?: bigint };
        if (subscriber) set.add(subscriber.toLowerCase());
        if (paid) grossPaid += paid;
      }
      const leaderShare = (grossPaid * BigInt(10_000 - env.platformFeeBps)) / 10_000n; // matches on-chain split
      return { subscribers: set.size, totalEarnedWip: formatUnits(leaderShare, WIP_DECIMALS) };
    },
  });

  return {
    subscribers: q.data?.subscribers ?? 0,
    totalEarnedWip: q.data?.totalEarnedWip ?? "0",
    loading: q.isLoading,
  };
}

/**
 * Publish a signal. CDR encryption is server-only (needs the CDR key + Node deps + WASM, and the
 * leader's TP/SL must never be exposed on a public surface — CLAUDE.md rule 3). So the browser
 * builds the structured Signal and POSTs it to the agent's publish endpoint, which encrypts it.
 * When `VITE_AGENT_API_URL` is unset we stay mock so the page still works without the daemon.
 */
export function usePublishSignal(strategyIdArg?: Hex) {
  const { address } = useAccount();
  const strategyId = strategyIdArg ?? env.strategyIpId;

  const publish = async (
    form: PublishForm,
  ): Promise<{ signalId: string; uuid?: number; at: string }> => {
    const signalId = crypto.randomUUID();
    const issuedAt = Math.floor(Date.now() / 1000);
    const signal: Signal = {
      version: 1,
      signalId,
      strategyId: (strategyId ?? zeroAddress) as string,
      chainId: env.liquidityChainId,
      action: form.action,
      token: form.token,
      quoteToken: env.usdc as string,
      sizeBps: Math.round(form.sizePercent * 100),
      maxEntryPrice: scalePrice(form.maxEntryPrice),
      takeProfitPrice: scalePrice(form.takeProfitPrice),
      stopLossPrice: scalePrice(form.stopLossPrice),
      issuedAt,
      expiresAt: issuedAt + form.expiresInHours * 3600,
    };

    // No agent endpoint configured → keep it mock (UI-only; no real encryption).
    if (!env.agentApiUrl) {
      return { signalId, at: new Date().toISOString() };
    }

    const res = await fetch(`${env.agentApiUrl}/signals/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(address ? { "x-leader-address": address } : {}),
      },
      body: JSON.stringify(signal),
    });
    if (!res.ok) throw new Error(`publish failed (${res.status})`);
    const { uuid } = (await res.json()) as { uuid: number };
    return { signalId, uuid, at: new Date().toISOString() };
  };

  return { publish };
}

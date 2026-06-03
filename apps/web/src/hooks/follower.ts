import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { env } from "@/lib/env";
import {
  COPY_VAULT_ABI,
  COPY_VAULT_FACTORY_ABI,
  ERC20_ABI,
  SUBSCRIPTION_REGISTRY_ABI,
} from "@/lib/abis";
import type { PositionRow } from "@/components/sigmax/PositionsTable";
import { useState } from "react";
import { toast } from "sonner";
import { useAgentApproval, useApproveAgent } from "@/hooks/hyperliquid";
import { useLeaders } from "@/hooks/leaders";
import type { Leader } from "@/lib/leaders";

const USDC_DECIMALS = 6;
const WIP_DECIMALS = 18;
const STORY = env.storyChainId;
const ARB = env.liquidityChainId;

function fmtUsdc(v: bigint): string {
  return Number(formatUnits(v, USDC_DECIMALS)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function tokenSymbol(addr: Address): string {
  const a = addr.toLowerCase();
  if (a === env.usdc.toLowerCase()) return "USDC";
  if (a === env.weth.toLowerCase()) return "WETH";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Subscription state + subscribe() (approve $WIP → registry.subscribe) on Story. */
export function useSubscription(strategyId: Hex | undefined) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const pub = usePublicClient({ chainId: STORY });
  const enabled = Boolean(address && strategyId);

  const plan = useReadContract({
    address: env.registryAddress,
    abi: SUBSCRIPTION_REGISTRY_ABI,
    functionName: "plans",
    args: strategyId ? [strategyId] : undefined,
    chainId: STORY,
    query: { enabled: Boolean(strategyId && env.registryAddress) },
  });
  const active = useReadContract({
    address: env.registryAddress,
    abi: SUBSCRIPTION_REGISTRY_ABI,
    functionName: "isActive",
    args: address && strategyId ? [address, strategyId] : undefined,
    chainId: STORY,
    query: { enabled },
  });
  const expiry = useReadContract({
    address: env.registryAddress,
    abi: SUBSCRIPTION_REGISTRY_ABI,
    functionName: "expiryOf",
    args: address && strategyId ? [address, strategyId] : undefined,
    chainId: STORY,
    query: { enabled },
  });

  const monthlyPrice = plan.data?.[2] ?? 0n;
  const payToken = plan.data?.[1];
  const expirySec = expiry.data ? Number(expiry.data) : 0;

  const refetch = async (): Promise<void> => {
    await Promise.all([active.refetch(), expiry.refetch()]);
  };

  const subscribe = async (): Promise<void> => {
    if (!pub || !strategyId || !env.registryAddress || !payToken)
      throw new Error("subscription not configured");
    if (!address) throw new Error("Connect your wallet first");
    if (monthlyPrice > 0n) {
      // Only sign an approve when the existing allowance doesn't already cover the price — saves
      // a signature on renewals / when the user has approved before.
      const allowance = (await pub.readContract({
        address: payToken,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, env.registryAddress],
      })) as bigint;
      if (allowance < monthlyPrice) {
        const approveHash = await writeContractAsync({
          address: payToken,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [env.registryAddress, monthlyPrice],
          chainId: STORY,
        });
        const approveRcpt = await pub.waitForTransactionReceipt({ hash: approveHash });
        if (approveRcpt.status === "reverted") throw new Error("$WIP approval failed on-chain.");
      }
    }
    const hash = await writeContractAsync({
      address: env.registryAddress,
      abi: SUBSCRIPTION_REGISTRY_ABI,
      functionName: "subscribe",
      args: [strategyId],
      chainId: STORY,
    });
    // viem does NOT throw on an on-chain revert here — it resolves with status "reverted". Without
    // this check a failed subscribe looked like success: the button never flipped and a misleading
    // toast fired. Surfacing it is the core fix for "I signed but nothing happened".
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status === "reverted")
      throw new Error("Subscription failed on-chain — check your $WIP balance and the plan price.");
    await refetch();
  };

  const cancel = async (): Promise<void> => {
    if (!pub || !strategyId || !env.registryAddress) throw new Error("subscription not configured");
    const hash = await writeContractAsync({
      address: env.registryAddress,
      abi: SUBSCRIPTION_REGISTRY_ABI,
      functionName: "cancel",
      args: [strategyId],
      chainId: STORY,
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status === "reverted") throw new Error("Cancel failed on-chain.");
    await refetch();
  };

  return {
    status: (active.data ? "active" : "idle") as "idle" | "subscribing" | "active",
    active: Boolean(active.data),
    activeUntil: expirySec > 0 ? new Date(expirySec * 1000).toISOString() : undefined,
    monthlyPriceWip: formatUnits(monthlyPrice, WIP_DECIMALS),
    subscribe,
    cancel,
    refetch,
  };
}

export type CopyTradePhase = "idle" | "subscribing" | "authorizing" | "active";

/**
 * One-click "subscribe + start copying". Subscribes on Story (approving $WIP only if needed), then —
 * if the shared platform agent isn't authorized yet — chains the Hyperliquid agent approval, so the
 * follower never has to hunt for a separate "Authorize" button. Errors surface via toast (and rethrow
 * so the calling button shows them inline). `cancel` is per-leader (contract `cancel`); it does NOT
 * revoke the shared agent — that would stop copying every leader.
 */
export function useCopyTrade(strategyId: Hex | undefined) {
  const { address } = useAccount();
  const sub = useSubscription(strategyId);
  const approval = useAgentApproval(address);
  const { approve } = useApproveAgent();
  const [phase, setPhase] = useState<CopyTradePhase>("idle");

  const start = async (): Promise<void> => {
    try {
      if (!sub.active) {
        setPhase("subscribing");
        await sub.subscribe();
      }
      // Authorize the agent in the same flow when configured and not already approved.
      if (env.hlAgentAddress && !approval.approved) {
        setPhase("authorizing");
        await approve();
        await approval.refetch();
      }
      setPhase("idle");
    } catch (e) {
      setPhase("idle");
      toast.error(e instanceof Error ? e.message : "Couldn't start copy-trading");
      throw e;
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      await sub.cancel();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't cancel the subscription");
      throw e;
    }
  };

  return {
    active: sub.active,
    activeUntil: sub.activeUntil,
    monthlyPriceWip: sub.monthlyPriceWip,
    agentApproved: approval.approved,
    phase,
    start,
    cancel,
  };
}

export interface MySubscription {
  leader: Leader;
  expiry?: string;
}

/**
 * The leaders the connected wallet is *actively* subscribed to. Discovers all leaders (PlanCreated)
 * then reads `isActive(me, strategyId)` for each on Story — keeps the "what am I copying" dashboard
 * in sync with the on-chain gate the agent uses.
 */
export function useMySubscriptions(): { subs: MySubscription[]; loading: boolean } {
  const { address } = useAccount();
  const { leaders, loading: leadersLoading } = useLeaders();
  const pub = usePublicClient({ chainId: STORY });
  const ids = leaders.map((l) => l.id).join(",");

  const q = useQuery({
    queryKey: ["my-subscriptions", address, ids],
    enabled: Boolean(address && pub && env.registryAddress && leaders.length > 0),
    refetchInterval: 30_000,
    queryFn: async (): Promise<MySubscription[]> => {
      if (!pub || !address || !env.registryAddress) return [];
      const out: MySubscription[] = [];
      for (const leader of leaders) {
        const [isActive, expiry] = await Promise.all([
          pub.readContract({
            address: env.registryAddress,
            abi: SUBSCRIPTION_REGISTRY_ABI,
            functionName: "isActive",
            args: [address, leader.id as Hex],
          }) as Promise<boolean>,
          pub.readContract({
            address: env.registryAddress,
            abi: SUBSCRIPTION_REGISTRY_ABI,
            functionName: "expiryOf",
            args: [address, leader.id as Hex],
          }) as Promise<bigint>,
        ]);
        if (isActive) {
          const sec = Number(expiry);
          out.push({ leader, expiry: sec > 0 ? new Date(sec * 1000).toISOString() : undefined });
        }
      }
      return out;
    },
  });

  return { subs: q.data ?? [], loading: leadersLoading || q.isLoading };
}

/** Vault address (factory.vaultOf) + createVault() on Arbitrum. */
export function useVault() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const pub = usePublicClient({ chainId: ARB });

  const vaultOf = useReadContract({
    address: env.factoryAddress,
    abi: COPY_VAULT_FACTORY_ABI,
    functionName: "vaultOf",
    args: address ? [address] : undefined,
    chainId: ARB,
    query: { enabled: Boolean(address && env.factoryAddress) },
  });

  const vaultAddress =
    vaultOf.data && vaultOf.data !== zeroAddress ? (vaultOf.data as Hex) : undefined;

  const createVault = async (v: { perTradeCapUsdc: string }): Promise<void> => {
    if (!pub || !env.factoryAddress || !env.agentAddress)
      throw new Error("factory/agent not configured");
    const cap = parseUnits(v.perTradeCapUsdc, USDC_DECIMALS);
    const hash = await writeContractAsync({
      address: env.factoryAddress,
      abi: COPY_VAULT_FACTORY_ABI,
      functionName: "createVault",
      args: [env.agentAddress, [env.usdc, env.weth], env.routers, cap],
      chainId: ARB,
    });
    await pub.waitForTransactionReceipt({ hash });
    await vaultOf.refetch();
  };

  return {
    vaultAddress,
    status: (vaultAddress ? "created" : "idle") as "idle" | "creating" | "created",
    createVault,
  };
}

/** Wallet + vault USDC balances and deposit() (approve USDC → vault.deposit) on Arbitrum. */
export function useBalances(vault: Hex | undefined) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const pub = usePublicClient({ chainId: ARB });

  const wallet = useReadContract({
    address: env.usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: ARB,
    query: { enabled: Boolean(address) },
  });
  const vaultBal = useReadContract({
    address: env.usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: vault ? [vault] : undefined,
    chainId: ARB,
    query: { enabled: Boolean(vault) },
  });

  const deposit = async (amountUsdc: string): Promise<void> => {
    if (!pub || !vault) throw new Error("vault not configured");
    const amount = parseUnits(amountUsdc, USDC_DECIMALS);
    const approveHash = await writeContractAsync({
      address: env.usdc,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vault, amount],
      chainId: ARB,
    });
    await pub.waitForTransactionReceipt({ hash: approveHash });
    const hash = await writeContractAsync({
      address: vault,
      abi: COPY_VAULT_ABI,
      functionName: "deposit",
      args: [env.usdc, amount],
      chainId: ARB,
    });
    await pub.waitForTransactionReceipt({ hash });
    await Promise.all([wallet.refetch(), vaultBal.refetch()]);
  };

  return {
    walletUsdc: wallet.data !== undefined ? fmtUsdc(wallet.data) : "0.00",
    vaultUsdc: vaultBal.data !== undefined ? fmtUsdc(vaultBal.data) : "0.00",
    deposit,
  };
}

/** paused() + isExecutor(agent) reads and pause/revoke writes on Arbitrum. */
export function useVaultControls(vault: Hex | undefined) {
  const { writeContractAsync } = useWriteContract();
  const pub = usePublicClient({ chainId: ARB });

  const paused = useReadContract({
    address: vault,
    abi: COPY_VAULT_ABI,
    functionName: "paused",
    chainId: ARB,
    query: { enabled: Boolean(vault) },
  });
  const agentAuth = useReadContract({
    address: vault,
    abi: COPY_VAULT_ABI,
    functionName: "isExecutor",
    args: env.agentAddress ? [env.agentAddress] : undefined,
    chainId: ARB,
    query: { enabled: Boolean(vault && env.agentAddress) },
  });

  const togglePause = async (next: boolean): Promise<void> => {
    if (!pub || !vault) throw new Error("vault not configured");
    const hash = await writeContractAsync({
      address: vault,
      abi: COPY_VAULT_ABI,
      functionName: "setPaused",
      args: [next],
      chainId: ARB,
    });
    await pub.waitForTransactionReceipt({ hash });
    await paused.refetch();
  };

  const revoke = async (): Promise<void> => {
    if (!pub || !vault || !env.agentAddress) throw new Error("vault/agent not configured");
    const hash = await writeContractAsync({
      address: vault,
      abi: COPY_VAULT_ABI,
      functionName: "setExecutor",
      args: [env.agentAddress, false],
      chainId: ARB,
    });
    await pub.waitForTransactionReceipt({ hash });
    await agentAuth.refetch();
  };

  return {
    paused: Boolean(paused.data),
    agentAuthorized: Boolean(agentAuth.data),
    togglePause,
    revoke,
  };
}

/**
 * Positions reconstructed from the vault's `Swapped` events (results only — never TP/SL). USDC→token
 * opens a position; token→USDC closes it (FIFO per token). PnL is best-effort: realized for closed
 * positions, omitted ("—") for open ones (live mark-to-market needs a price feed — pass 2).
 */
export function usePositions(vault: Hex | undefined) {
  const pub = usePublicClient({ chainId: ARB });

  const q = useQuery({
    queryKey: ["positions", vault],
    enabled: Boolean(vault && pub),
    queryFn: async (): Promise<PositionRow[]> => {
      if (!pub || !vault) return [];
      const logs = await pub.getContractEvents({
        address: vault,
        abi: COPY_VAULT_ABI,
        eventName: "Swapped",
        fromBlock: "earliest",
        toBlock: "latest",
      });
      // Block timestamps (unique blocks only).
      const blocks = [
        ...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null)),
      ];
      const tsByBlock = new Map<bigint, number>();
      await Promise.all(
        blocks.map(async (b) => {
          const blk = await pub.getBlock({ blockNumber: b });
          tsByBlock.set(b, Number(blk.timestamp) * 1000);
        }),
      );

      const usdc = env.usdc.toLowerCase();
      const openByToken = new Map<string, PositionRow[]>();
      const rows: PositionRow[] = [];

      logs.forEach((log, i) => {
        const { tokenIn, amountIn, tokenOut, received } = log.args as {
          tokenIn: Address;
          amountIn: bigint;
          tokenOut: Address;
          received: bigint;
        };
        const at = log.blockNumber ? (tsByBlock.get(log.blockNumber) ?? Date.now()) : Date.now();
        const openedAt = new Date(at).toISOString();
        const txUrl = `${env.explorers.arbitrum}/tx/${log.transactionHash}`;
        const id = `${log.transactionHash}-${i}`;

        if (tokenIn.toLowerCase() === usdc) {
          const row: PositionRow = {
            id,
            pair: `USDC → ${tokenSymbol(tokenOut)}`,
            amountIn: `${fmtUsdc(amountIn)} USDC`,
            currentValue: "—",
            pnlPct: 0,
            pnlUsd: "—",
            openedAt,
            status: "open",
            txUrl,
          };
          rows.push(row);
          const list = openByToken.get(tokenOut.toLowerCase()) ?? [];
          list.push(row);
          openByToken.set(tokenOut.toLowerCase(), list);
        } else if (tokenOut.toLowerCase() === usdc) {
          const match = openByToken.get(tokenIn.toLowerCase())?.shift();
          if (match) {
            const entry = Number(match.amountIn.replace(/[^\d.-]/g, ""));
            const exit = Number(fmtUsdc(received).replace(/,/g, ""));
            const pnl = exit - entry;
            match.status = "closed";
            match.currentValue = `${fmtUsdc(received)} USDC`;
            match.pnlUsd = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
            match.pnlPct = entry > 0 ? Number(((pnl / entry) * 100).toFixed(2)) : 0;
            match.txUrl = txUrl;
          }
        }
      });

      return rows.reverse(); // newest first
    },
  });

  return { positions: q.data ?? [], loading: q.isLoading };
}

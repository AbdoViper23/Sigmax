/**
 * The Flare control plane, from the browser — everything that is NOT publishing a signal.
 *
 * On Coston2 there is only one chain. Subscriptions, the per-follower vaults, the swap venue and the
 * enclave all live here, so every hook below talks to a single `publicClient` and there is no
 * cross-chain hop to reason about. That is the whole reason this file is shorter than the Story-era
 * equivalents it replaces (`hooks/leaders.ts`, the Story halves of `hooks/follower.ts`), which had to
 * read plans on Story and trades on Arbitrum and reconcile the two.
 *
 * Publishing lives in `hooks/flare.ts` — it is the one flow with a confidentiality requirement, and
 * keeping it separate keeps that requirement visible.
 */

import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { env, flareConfigReady } from "@/lib/env";
import {
  COPY_VAULT_FLARE_ABI,
  COPY_VAULT_FLARE_FACTORY_ABI,
  ERC20_ABI,
  SUBSCRIPTION_REGISTRY_ABI,
  TEST_USD_ABI,
} from "@/lib/abis";
import type { Leader, LeaderPerformance } from "@/lib/leaders";

const FLARE = env.flareChainId;

/** FXRP and testUSD are both 6 decimals on Coston2. */
const TOKEN_DECIMALS = 6;

/** Default per-trade cap for a new vault: 1 FXRP. The follower can raise it on their own vault. */
const DEFAULT_CAP = parseUnits("1", TOKEN_DECIMALS);

export function formatToken(v: bigint): string {
  return formatUnits(v, TOKEN_DECIMALS);
}

export function parseToken(v: string): bigint {
  return parseUnits((v || "0") as `${number}`, TOKEN_DECIMALS);
}

/** The token/router set every vault is created with — FXRP↔testUSD through BlazeSwap. */
function vaultCreationArgs(cap: bigint) {
  return [[env.fxrp, env.flareQuoteToken], [env.blazeSwapRouter], cap] as const;
}

// ---------------------------------------------------------------- leaders

type Swap = { tokenIn: Address; amountIn: bigint; tokenOut: Address; received: bigint };

/**
 * FIFO realized PnL in the QUOTE token across a leader's subscribers' vaults.
 *
 * A vault's `Swapped` events carry no strategy tag, so when one follower copies several leaders this
 * attribution is an approximation — correct in the common one-leader case. Same documented seam as the
 * Story-era implementation; it is a property of the event, not of this code.
 */
function fifoStats(swapsByVault: Swap[][], quote: string): LeaderPerformance {
  let realizedPnl = 0;
  let costBasis = 0;
  let closedTrades = 0;
  let wins = 0;

  const num = (x: bigint) => Number(formatUnits(x, TOKEN_DECIMALS));

  for (const swaps of swapsByVault) {
    const openByToken = new Map<string, number[]>();
    for (const s of swaps) {
      if (s.tokenIn.toLowerCase() === quote) {
        // Entry: spent quote to acquire the base.
        const q = openByToken.get(s.tokenOut.toLowerCase()) ?? [];
        q.push(num(s.amountIn));
        openByToken.set(s.tokenOut.toLowerCase(), q);
      } else if (s.tokenOut.toLowerCase() === quote) {
        // Exit: sold the base back into quote — pair it with the oldest open entry.
        const entry = openByToken.get(s.tokenIn.toLowerCase())?.shift();
        if (entry !== undefined) {
          const exit = num(s.received);
          realizedPnl += exit - entry;
          costBasis += entry;
          closedTrades += 1;
          if (exit > entry) wins += 1;
        }
      }
    }
  }

  return {
    verifiedReturnPct: costBasis > 0 ? Number(((realizedPnl / costBasis) * 100).toFixed(2)) : null,
    winRatePct: closedTrades > 0 ? Math.round((wins / closedTrades) * 100) : null,
    maxDrawdownPct: null, // not derivable on-chain without an equity time series
    closedTrades,
  };
}

/**
 * Every leader, discovered entirely from Coston2: `PlanCreated` for the roster and price,
 * `Subscribed` for the subscriber set, and those subscribers' vaults' `Swapped` events for the track
 * record. No indexer, no off-chain roster.
 */
export function useFlareLeaders(): { leaders: Leader[]; loading: boolean } {
  const client = usePublicClient({ chainId: FLARE });

  const q = useQuery({
    queryKey: ["flare-leaders", env.flareSubscriptionRegistry, env.flareVaultFactory],
    enabled: Boolean(client && env.flareSubscriptionRegistry && env.flareVaultFactory),
    staleTime: 30_000,
    queryFn: async (): Promise<Leader[]> => {
      if (!client || !env.flareSubscriptionRegistry || !env.flareVaultFactory) return [];
      const quote = env.flareQuoteToken.toLowerCase();

      const [planLogs, subLogs] = await Promise.all([
        client.getContractEvents({
          address: env.flareSubscriptionRegistry,
          abi: SUBSCRIPTION_REGISTRY_ABI,
          eventName: "PlanCreated",
          fromBlock: "earliest",
          toBlock: "latest",
        }),
        client.getContractEvents({
          address: env.flareSubscriptionRegistry,
          abi: SUBSCRIPTION_REGISTRY_ABI,
          eventName: "Subscribed",
          fromBlock: "earliest",
          toBlock: "latest",
        }),
      ]);

      const subsByStrategy = new Map<string, Set<string>>();
      for (const l of subLogs) {
        const { strategyId, subscriber } = l.args as { strategyId?: string; subscriber?: string };
        if (!strategyId || !subscriber) continue;
        const key = strategyId.toLowerCase();
        const set = subsByStrategy.get(key) ?? new Set<string>();
        set.add(subscriber.toLowerCase());
        subsByStrategy.set(key, set);
      }

      // owner → vault, so a subscriber's trades can be found without an extra call each.
      const vaultByOwner = new Map<string, Address>();
      try {
        const vaultLogs = await client.getContractEvents({
          address: env.flareVaultFactory,
          abi: COPY_VAULT_FLARE_FACTORY_ABI,
          eventName: "VaultCreated",
          fromBlock: "earliest",
          toBlock: "latest",
        });
        for (const l of vaultLogs) {
          const { owner, vault } = l.args as { owner?: Address; vault?: Address };
          if (owner && vault) vaultByOwner.set(owner.toLowerCase(), vault);
        }
      } catch {
        // No vaults yet, or the range was rejected — leaders still list, just without trade metrics.
      }

      const swapsCache = new Map<string, Swap[]>();
      const vaultSwaps = async (vault: Address): Promise<Swap[]> => {
        const key = vault.toLowerCase();
        const cached = swapsCache.get(key);
        if (cached) return cached;
        let swaps: Swap[] = [];
        try {
          const logs = await client.getContractEvents({
            address: vault,
            abi: COPY_VAULT_FLARE_ABI,
            eventName: "Swapped",
            fromBlock: "earliest",
            toBlock: "latest",
          });
          swaps = logs.map((l) => l.args as Swap);
        } catch {
          // one unreadable vault must not sink the whole leaderboard
        }
        swapsCache.set(key, swaps);
        return swaps;
      };

      const leaders: Leader[] = [];
      for (const p of planLogs) {
        const { strategyId, leader, monthlyPrice, username, displayName } = p.args as {
          strategyId?: Address;
          leader?: Address;
          monthlyPrice?: bigint;
          username?: string;
          displayName?: string;
        };
        if (!strategyId || !leader) continue;

        const subs = subsByStrategy.get(strategyId.toLowerCase()) ?? new Set<string>();
        const swapsByVault: Swap[][] = [];
        for (const sub of subs) {
          const vault = vaultByOwner.get(sub);
          if (vault) swapsByVault.push(await vaultSwaps(vault));
        }

        leaders.push({
          id: strategyId,
          leaderAddress: leader,
          username: username || strategyId.slice(0, 8),
          displayName: displayName || `Strategy ${strategyId.slice(0, 6)}…`,
          monthlyPriceWip: formatToken(monthlyPrice ?? 0n),
          performance: fifoStats(swapsByVault, quote),
          subscribers: subs.size,
        });
      }
      return leaders;
    },
  });

  return { leaders: q.data ?? [], loading: q.isLoading };
}

/** One leader by strategy id (route param). */
export function useFlareLeader(id: string): { leader: Leader | undefined; loading: boolean } {
  const { leaders, loading } = useFlareLeaders();
  return { leader: leaders.find((l) => l.id.toLowerCase() === id.toLowerCase()), loading };
}

// ---------------------------------------------------------------- leader: the plan

/**
 * The leader's own subscription plan on Coston2. `createPlan` makes the caller the plan's leader, so
 * a leader's identity is established by the transaction itself — nothing to assign, nothing to trust.
 *
 * A strategy id is just an address key here. On Story it was an ERC-6551 IP account; on Coston2 the
 * leader's own address is used, which keeps registration to a single signature.
 */
export function useFlarePlan(strategyIdArg?: Hex) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: FLARE });
  const qc = useQueryClient();

  // A leader's strategy id defaults to their own address — one strategy per leader.
  const strategyId = strategyIdArg ?? (address as Hex | undefined);

  const plan = useReadContract({
    address: env.flareSubscriptionRegistry,
    abi: SUBSCRIPTION_REGISTRY_ABI,
    functionName: "plans",
    args: strategyId ? [strategyId] : undefined,
    chainId: FLARE,
    query: { enabled: Boolean(strategyId && env.flareSubscriptionRegistry) },
  });

  const leader = plan.data?.[0];
  const monthlyPrice = plan.data?.[2] ?? 0n;
  const registered = Boolean(leader && leader !== zeroAddress);

  const createPlan = async (v: {
    username: string;
    displayName: string;
    monthlyPrice: string;
  }): Promise<void> => {
    if (!client || !strategyId || !env.flareSubscriptionRegistry) {
      throw new Error("Flare subscription registry is not configured");
    }
    const hash = await writeContractAsync({
      address: env.flareSubscriptionRegistry,
      abi: SUBSCRIPTION_REGISTRY_ABI,
      functionName: "createPlan",
      args: [
        strategyId,
        env.flareQuoteToken,
        parseToken(v.monthlyPrice),
        env.platformFeeBps,
        v.username,
        v.displayName,
      ],
      chainId: FLARE,
    });
    await client.waitForTransactionReceipt({ hash });
    await plan.refetch();
    await qc.invalidateQueries({ queryKey: ["flare-leaders"] });
  };

  return {
    strategyId,
    registered,
    active: Boolean(plan.data?.[4]),
    monthlyPrice: formatToken(monthlyPrice),
    createPlan,
    loading: plan.isLoading,
  };
}

// ---------------------------------------------------------------- follower: subscription

/**
 * Subscription state and `subscribe()` for one strategy. Payment is in testUSD, and the registry
 * splits it to the leader at pay time — there is no claim step.
 */
export function useFlareSubscription(strategyId: Hex | undefined) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: FLARE });
  const enabled = Boolean(address && strategyId && env.flareSubscriptionRegistry);

  const plan = useReadContract({
    address: env.flareSubscriptionRegistry,
    abi: SUBSCRIPTION_REGISTRY_ABI,
    functionName: "plans",
    args: strategyId ? [strategyId] : undefined,
    chainId: FLARE,
    query: { enabled: Boolean(strategyId && env.flareSubscriptionRegistry) },
  });

  const active = useReadContract({
    address: env.flareSubscriptionRegistry,
    abi: SUBSCRIPTION_REGISTRY_ABI,
    functionName: "isActive",
    args: address && strategyId ? [address, strategyId] : undefined,
    chainId: FLARE,
    query: { enabled },
  });

  const expiry = useReadContract({
    address: env.flareSubscriptionRegistry,
    abi: SUBSCRIPTION_REGISTRY_ABI,
    functionName: "expiryOf",
    args: address && strategyId ? [address, strategyId] : undefined,
    chainId: FLARE,
    query: { enabled },
  });

  const monthlyPrice = plan.data?.[2] ?? 0n;

  const subscribe = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!client || !strategyId || !env.flareSubscriptionRegistry) {
        throw new Error("Flare subscription registry is not configured");
      }
      if (monthlyPrice === 0n) throw new Error("this strategy has no price set");

      // Approve exactly one month's price, not an unbounded allowance: the registry only ever needs
      // to pull this much, and a leftover infinite approval is a standing risk for no benefit.
      const allowance = await client.readContract({
        address: env.flareQuoteToken,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address!, env.flareSubscriptionRegistry],
      });
      if (allowance < monthlyPrice) {
        const approveHash = await writeContractAsync({
          address: env.flareQuoteToken,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [env.flareSubscriptionRegistry, monthlyPrice],
          chainId: FLARE,
        });
        await client.waitForTransactionReceipt({ hash: approveHash });
      }

      const hash = await writeContractAsync({
        address: env.flareSubscriptionRegistry,
        abi: SUBSCRIPTION_REGISTRY_ABI,
        functionName: "subscribe",
        args: [strategyId],
        chainId: FLARE,
      });
      await client.waitForTransactionReceipt({ hash });
      await Promise.all([active.refetch(), expiry.refetch()]);
    },
  });

  return {
    active: Boolean(active.data),
    expiresAt: expiry.data ? Number(expiry.data) : 0,
    monthlyPrice: formatToken(monthlyPrice),
    priceRaw: monthlyPrice,
    subscribe: subscribe.mutateAsync,
    subscribing: subscribe.isPending,
    loading: active.isLoading || plan.isLoading,
  };
}

export interface MyFlareSubscription {
  leader: Leader;
  /** ISO timestamp, or undefined when the registry reports no expiry. */
  expiry?: string;
}

/**
 * The strategies the connected wallet is ACTIVELY subscribed to.
 *
 * Deliberately reads `isActive` per leader rather than trusting the `Subscribed` event log: an event
 * proves someone paid once, not that the subscription is still live. This is the same gate the
 * enclave applies when it decides whom to trade for, so the dashboard cannot claim you are being
 * copied when the enclave would skip you.
 */
export function useMyFlareSubscriptions(): { subs: MyFlareSubscription[]; loading: boolean } {
  const { address } = useAccount();
  const { leaders, loading: leadersLoading } = useFlareLeaders();
  const client = usePublicClient({ chainId: FLARE });
  const ids = leaders.map((l) => l.id).join(",");

  const q = useQuery({
    queryKey: ["my-flare-subscriptions", address, ids],
    enabled: Boolean(address && client && env.flareSubscriptionRegistry && leaders.length > 0),
    refetchInterval: 30_000,
    queryFn: async (): Promise<MyFlareSubscription[]> => {
      if (!client || !address || !env.flareSubscriptionRegistry) return [];
      const out: MyFlareSubscription[] = [];
      for (const leader of leaders) {
        const [isActive, expiry] = await Promise.all([
          client.readContract({
            address: env.flareSubscriptionRegistry,
            abi: SUBSCRIPTION_REGISTRY_ABI,
            functionName: "isActive",
            args: [address, leader.id as Hex],
          }),
          client.readContract({
            address: env.flareSubscriptionRegistry,
            abi: SUBSCRIPTION_REGISTRY_ABI,
            functionName: "expiryOf",
            args: [address, leader.id as Hex],
          }),
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

/** Cancel one subscription. Independent of the vault: the funds stay put, only copying stops. */
export function useCancelFlareSubscription() {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: FLARE });
  const qc = useQueryClient();

  const cancel = useMutation({
    mutationFn: async (strategyId: Hex): Promise<void> => {
      if (!client || !env.flareSubscriptionRegistry) throw new Error("registry is not configured");
      const hash = await writeContractAsync({
        address: env.flareSubscriptionRegistry,
        abi: SUBSCRIPTION_REGISTRY_ABI,
        functionName: "cancel",
        args: [strategyId],
        chainId: FLARE,
      });
      await client.waitForTransactionReceipt({ hash });
      await qc.invalidateQueries({ queryKey: ["my-flare-subscriptions"] });
    },
  });

  return { cancel: cancel.mutateAsync, cancelling: cancel.isPending };
}

// ---------------------------------------------------------------- follower: the vault

export interface FlareVaultState {
  /** The follower's vault address, or undefined when they have not created one. */
  vault: Address | undefined;
  exists: boolean;
  /** FXRP held by the vault — what a signal actually trades. */
  fxrp: bigint;
  /** testUSD held by the vault. */
  quote: bigint;
  perTradeCap: bigint;
  paused: boolean;
}

/**
 * The follower's vault: read its state, create-and-fund it in one signature, top it up, withdraw.
 *
 * The non-custodial claim is visible right here — there is no path in this hook that moves the
 * follower's funds anywhere except into their own vault or back to their own wallet. Trading is
 * authorized by the enclave's signature and executed by a keeper; the browser never touches it.
 */
export function useFlareVault() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: FLARE });
  const qc = useQueryClient();

  const state = useQuery({
    queryKey: ["flare-vault", address, env.flareVaultFactory],
    enabled: Boolean(client && address && env.flareVaultFactory),
    refetchInterval: 15_000,
    queryFn: async (): Promise<FlareVaultState> => {
      const empty: FlareVaultState = {
        vault: undefined,
        exists: false,
        fxrp: 0n,
        quote: 0n,
        perTradeCap: 0n,
        paused: false,
      };
      if (!client || !address || !env.flareVaultFactory) return empty;

      const vault = await client.readContract({
        address: env.flareVaultFactory,
        abi: COPY_VAULT_FLARE_FACTORY_ABI,
        functionName: "vaultOf",
        args: [address],
      });
      if (vault === zeroAddress) return empty;

      const [fxrp, quote, perTradeCap, paused] = await Promise.all([
        client.readContract({ address: env.fxrp, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] }),
        client.readContract({
          address: env.flareQuoteToken,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [vault],
        }),
        client.readContract({ address: vault, abi: COPY_VAULT_FLARE_ABI, functionName: "perTradeCap" }),
        client.readContract({ address: vault, abi: COPY_VAULT_FLARE_ABI, functionName: "paused" }),
      ]);

      return { vault, exists: true, fxrp, quote, perTradeCap, paused };
    },
  });

  const refresh = async () => {
    await state.refetch();
    await qc.invalidateQueries({ queryKey: ["flare-leaders"] });
  };

  /** Approve `spender` for exactly `amount` if the current allowance is short. */
  const ensureAllowance = async (token: Address, spender: Address, amount: bigint): Promise<void> => {
    if (!client || !address) throw new Error("connect a wallet first");
    const allowance = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [address, spender],
    });
    if (allowance >= amount) return;
    const hash = await writeContractAsync({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
      chainId: FLARE,
    });
    await client.waitForTransactionReceipt({ hash });
  };

  /**
   * Create the vault and fund it with FXRP in ONE transaction (plus the ERC-20 approval the token
   * standard forces). Splitting this into create-then-deposit made "create a vault" a step the
   * follower had to understand before they could do the thing they came for.
   */
  const createAndFund = useMutation({
    mutationFn: async (v: { fxrpAmount: string; capAmount?: string }): Promise<void> => {
      if (!client || !address || !env.flareVaultFactory) throw new Error("vault factory is not configured");
      const amount = parseToken(v.fxrpAmount);
      if (amount === 0n) throw new Error("enter an amount to fund");
      const cap = v.capAmount ? parseToken(v.capAmount) : DEFAULT_CAP;

      // The factory pulls the tokens straight through to the new vault; it never holds a balance.
      await ensureAllowance(env.fxrp, env.flareVaultFactory, amount);

      const hash = await writeContractAsync({
        address: env.flareVaultFactory,
        abi: COPY_VAULT_FLARE_FACTORY_ABI,
        functionName: "createVaultAndDeposit",
        args: [...vaultCreationArgs(cap), env.fxrp, amount],
        chainId: FLARE,
      });
      await client.waitForTransactionReceipt({ hash });
      await refresh();
    },
  });

  /** Top up an existing vault. */
  const deposit = useMutation({
    mutationFn: async (v: { token?: Address; amount: string }): Promise<void> => {
      const vault = state.data?.vault;
      if (!client || !vault) throw new Error("create a vault first");
      const token = v.token ?? env.fxrp;
      const amount = parseToken(v.amount);
      if (amount === 0n) throw new Error("enter an amount to deposit");

      await ensureAllowance(token, vault, amount);
      const hash = await writeContractAsync({
        address: vault,
        abi: COPY_VAULT_FLARE_ABI,
        functionName: "deposit",
        args: [token, amount],
        chainId: FLARE,
      });
      await client.waitForTransactionReceipt({ hash });
      await refresh();
    },
  });

  /** Withdraw to the owner's wallet. Only the owner can call this — enforced in the contract. */
  const withdraw = useMutation({
    mutationFn: async (v: { token?: Address; amount: string }): Promise<void> => {
      const vault = state.data?.vault;
      if (!client || !vault) throw new Error("no vault to withdraw from");
      const hash = await writeContractAsync({
        address: vault,
        abi: COPY_VAULT_FLARE_ABI,
        functionName: "withdraw",
        args: [v.token ?? env.fxrp, parseToken(v.amount)],
        chainId: FLARE,
      });
      await client.waitForTransactionReceipt({ hash });
      await refresh();
    },
  });

  return {
    ...(state.data ?? {
      vault: undefined,
      exists: false,
      fxrp: 0n,
      quote: 0n,
      perTradeCap: 0n,
      paused: false,
    }),
    loading: state.isLoading,
    ready: flareConfigReady,
    createAndFund: createAndFund.mutateAsync,
    creating: createAndFund.isPending,
    deposit: deposit.mutateAsync,
    depositing: deposit.isPending,
    withdraw: withdraw.mutateAsync,
    withdrawing: withdraw.isPending,
    refresh,
  };
}

// ---------------------------------------------------------------- the follower's own wallet

/**
 * The follower's wallet balances plus the testUSD faucet.
 *
 * Coston2 has no real stablecoin and no exchange to buy one from, so without a faucet in the UI a
 * follower cannot subscribe at all. `mint()` is public on this test token.
 */
export function useFlareWallet() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: FLARE });

  const q = useQuery({
    queryKey: ["flare-wallet", address],
    enabled: Boolean(client && address),
    refetchInterval: 15_000,
    queryFn: async (): Promise<{ fxrp: bigint; quote: bigint }> => {
      if (!client || !address) return { fxrp: 0n, quote: 0n };
      const [fxrp, quote] = await Promise.all([
        client.readContract({ address: env.fxrp, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
        client.readContract({
          address: env.flareQuoteToken,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }),
      ]);
      return { fxrp, quote };
    },
  });

  const mintQuote = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!client) throw new Error("no client");
      const hash = await writeContractAsync({
        address: env.flareQuoteToken,
        abi: TEST_USD_ABI,
        functionName: "mint",
        chainId: FLARE,
      });
      await client.waitForTransactionReceipt({ hash });
      await q.refetch();
    },
  });

  return {
    fxrp: q.data?.fxrp ?? 0n,
    quote: q.data?.quote ?? 0n,
    loading: q.isLoading,
    mintQuote: mintQuote.mutateAsync,
    minting: mintQuote.isPending,
    refresh: q.refetch,
  };
}

/** The follower's realized trades, read from their own vault's `Swapped` events. */
export function useFlareVaultTrades(vault: Address | undefined) {
  const client = usePublicClient({ chainId: FLARE });

  const q = useQuery({
    queryKey: ["flare-vault-trades", vault],
    enabled: Boolean(client && vault),
    refetchInterval: 20_000,
    queryFn: async () => {
      if (!client || !vault) return [];
      const logs = await client.getContractEvents({
        address: vault,
        abi: COPY_VAULT_FLARE_ABI,
        eventName: "Swapped",
        fromBlock: "earliest",
        toBlock: "latest",
      });
      const quote = env.flareQuoteToken.toLowerCase();
      return logs.map((l, i) => {
        const a = l.args as Swap;
        const isEntry = a.tokenIn.toLowerCase() === quote;
        return {
          id: `${l.transactionHash}-${i}`,
          txHash: l.transactionHash,
          isEntry,
          amountIn: a.amountIn,
          received: a.received,
          tokenIn: a.tokenIn,
          tokenOut: a.tokenOut,
        };
      });
    },
  });

  return { trades: q.data ?? [], loading: q.isLoading };
}

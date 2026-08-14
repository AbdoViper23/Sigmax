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
import { mockLeaders, testLeaders } from "@/lib/mock";
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

/**
 * Which side of the pair an action targets.
 *
 * Both legs matter, and getting this wrong is invisible: the enclave sizes an ENTRY against the QUOTE
 * balance (it buys FXRP with testUSD) and an EXIT against FXRP. A vault holding only one of them has
 * every signal in the other direction sized to zero and skipped — no trade, no error. Funding was
 * FXRP-only before, so the publish form's default action could never execute.
 */
export type VaultLeg = "fxrp" | "quote";

const tokenForLeg = (leg: VaultLeg = "fxrp"): Address =>
  leg === "fxrp" ? env.fxrp : env.flareQuoteToken;

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
 * Every leader, from two `eth_call`s.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS UNUSABLE: it scanned `PlanCreated`, `Subscribed` and
 * `VaultCreated` from `earliest`, then one `Swapped` scan per subscriber vault. The public Coston2 RPC
 * caps `eth_getLogs` at 30 blocks, so "since deploy" is thousands of sequential requests from a
 * browser — the page span for a long time and then rendered nothing, because the rejected ranges were
 * swallowed by the catch. Slowness was the symptom; using logs for enumeration was the cause.
 *
 * `SubscriptionRegistry.listPlans` now returns the roster directly. The subscriber count and the track
 * record — the two things that genuinely need history — are loaded SEPARATELY per leader, so the list
 * paints from the first response instead of waiting on every leader's trade history.
 */
const PAGE = 50;

export function useFlareLeaders(): { leaders: Leader[]; loading: boolean } {
  const client = usePublicClient({ chainId: FLARE });

  const q = useQuery({
    queryKey: ["flare-leaders", env.flareSubscriptionRegistry],
    enabled: Boolean(client && env.flareSubscriptionRegistry),
    // The roster changes only when someone registers, so it is worth holding for a while; a stale
    // list is far better than a blank one while it refetches.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Leader[]> => {
      if (!client || !env.flareSubscriptionRegistry) return [];

      const leaders: Leader[] = [];
      // Page until short. No count read first — `listPlans` clamps rather than reverting past the end.
      for (let start = 0; ; start += PAGE) {
        const [ids, plans] = await client.readContract({
          address: env.flareSubscriptionRegistry,
          abi: SUBSCRIPTION_REGISTRY_ABI,
          functionName: "listPlans",
          args: [BigInt(start), BigInt(PAGE)],
        });

        for (const [i, id] of ids.entries()) {
          const plan = plans[i];
          if (!plan || plan.leader === zeroAddress) continue;
          leaders.push({
            id,
            leaderAddress: plan.leader,
            // The registry stores no labels (they live only in the PlanCreated log, to keep plan reads
            // cheap). Showing a truncated id beats blocking the whole list on a log lookup per leader;
            // the strategy page fetches the real label with a single indexed filter.
            username: id.slice(2, 10).toLowerCase(),
            displayName: `Strategy ${id.slice(0, 6)}…${id.slice(-4)}`,
            monthlyPrice: formatToken(plan.monthlyPrice),
            // Filled in by useFlareLeaderStats, which runs per leader and does not block this list.
            performance: {
              verifiedReturnPct: null,
              winRatePct: null,
              maxDrawdownPct: null,
              closedTrades: 0,
            },
            subscribers: 0,
          });
        }

        if (ids.length < PAGE) break;
      }
      return leaders;
    },
  });

  /*
   * Seeded leaders, appended.
   *
   * A fresh deployment has no plans, so the marketplace renders an empty state and none of the card,
   * sorting, or track-record UI can be seen or judged. These fixtures fill that gap and every one
   * carries `flaggedForTesting`, which renders a "Test" badge, dashes the card border, and skips the
   * on-chain stats fetch — so they are visibly demo data at a glance and are never presented as a
   * verified record. Turn them off with `VITE_SHOW_DEMO_LEADERS=false` before a real launch.
   */
  const demo = env.showDemoLeaders ? testLeaders : [];

  // Unconfigured (or SSR): show the full mock roster so the page always has something to render.
  if (!flareConfigReady) {
    return { leaders: [...mockLeaders, ...demo], loading: false };
  }

  /*
   * `loading` means "there is nothing to show yet" — not "a request is in flight". The seeded leaders are
   * available synchronously, so reporting loading while they exist made the page render skeletons for
   * content it already had, on every visit and through every refetch. This is the difference between the
   * list appearing instantly and appearing to hang.
   */
  const onChain = q.data ?? [];
  return {
    leaders: [...onChain, ...demo],
    loading: q.isLoading && onChain.length === 0 && demo.length === 0,
  };
}

/** One leader by strategy id (route param). */
export function useFlareLeader(id: string): { leader: Leader | undefined; loading: boolean } {
  const { leaders, loading } = useFlareLeaders();
  return { leader: leaders.find((l) => l.id.toLowerCase() === id.toLowerCase()), loading };
}

/**
 * Subscriber count, on-chain labels and track record for ONE strategy — loaded after the roster.
 *
 * Kept out of `useFlareLeaders` deliberately. These need log history, and history is the expensive part;
 * folding them into the list query meant nothing rendered until every leader's trades had been read.
 * Now the list appears immediately and each card fills in.
 *
 * Every scan here is bounded by `flareFromBlock` (the registry's deploy block) and filtered to one
 * indexed `strategyId`, so it is a narrow query rather than a full-history sweep — and any rejection
 * degrades to "no metrics yet" instead of an empty leaderboard.
 */
export function useFlareLeaderStats(strategyId: string | undefined) {
  const client = usePublicClient({ chainId: FLARE });

  const q = useQuery({
    queryKey: ["flare-leader-stats", strategyId],
    enabled: Boolean(client && strategyId && env.flareSubscriptionRegistry),
    staleTime: 2 * 60_000,
    queryFn: async () => {
      const empty = {
        subscribers: 0,
        username: undefined as string | undefined,
        displayName: undefined as string | undefined,
        performance: {
          verifiedReturnPct: null,
          winRatePct: null,
          maxDrawdownPct: null,
          closedTrades: 0,
        } as LeaderPerformance,
      };
      if (!client || !strategyId || !env.flareSubscriptionRegistry) return empty;
      const fromBlock = env.flareFromBlock;

      // Labels + subscribers: both single-strategy filters on the registry, run together.
      const [planLogs, subLogs] = await Promise.all([
        client
          .getContractEvents({
            address: env.flareSubscriptionRegistry,
            abi: SUBSCRIPTION_REGISTRY_ABI,
            eventName: "PlanCreated",
            args: { strategyId: strategyId as Hex },
            fromBlock,
            toBlock: "latest",
          })
          .catch(() => []),
        client
          .getContractEvents({
            address: env.flareSubscriptionRegistry,
            abi: SUBSCRIPTION_REGISTRY_ABI,
            eventName: "Subscribed",
            args: { strategyId: strategyId as Hex },
            fromBlock,
            toBlock: "latest",
          })
          .catch(() => []),
      ]);

      const labels = planLogs[0]?.args as { username?: string; displayName?: string } | undefined;
      const subscribers = new Set<string>();
      for (const l of subLogs) {
        const s = (l.args as { subscriber?: string }).subscriber;
        if (s) subscribers.add(s.toLowerCase());
      }

      // Track record, if the vaults are readable. Capped: the point is a representative figure on a
      // card, and an unbounded fan-out here would reintroduce exactly the stall this split removed.
      const quote = env.flareQuoteToken.toLowerCase();
      const swapsByVault: Swap[][] = [];
      if (env.flareVaultFactory) {
        const owners = [...subscribers].slice(0, 10);
        const vaults = await Promise.all(
          owners.map((owner) =>
            client
              .readContract({
                address: env.flareVaultFactory!,
                abi: COPY_VAULT_FLARE_FACTORY_ABI,
                functionName: "vaultOf",
                args: [owner as Hex],
              })
              .catch(() => zeroAddress),
          ),
        );
        const scans = await Promise.all(
          vaults
            .filter((v) => v !== zeroAddress)
            .map((vault) =>
              client
                .getContractEvents({
                  address: vault,
                  abi: COPY_VAULT_FLARE_ABI,
                  eventName: "Swapped",
                  fromBlock,
                  toBlock: "latest",
                })
                .then((logs) => logs.map((l) => l.args as Swap))
                .catch(() => [] as Swap[]),
            ),
        );
        swapsByVault.push(...scans);
      }

      return {
        subscribers: subscribers.size,
        username: labels?.username || undefined,
        displayName: labels?.displayName || undefined,
        performance: fifoStats(swapsByVault, quote),
      };
    },
  });

  return { stats: q.data, loading: q.isLoading };
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
  /** The TEE identity this vault verifies authorizations against. */
  teeAddress: Address | undefined;
  /** The identity the factory currently stamps into new vaults — i.e. the live enclave. */
  factoryTeeAddress: Address | undefined;
  /**
   * True when this vault trusts a RETIRED enclave identity.
   *
   * A simulated enclave re-keys on every restart, so this is not an edge case — it is the normal state
   * after the stack is restarted, and the symptom is every trade silently reverting with
   * `BadTeeSignature`. Surfacing it as a repairable condition beats letting the follower conclude the
   * product is broken.
   */
  teeStale: boolean;
}

const EMPTY_VAULT: FlareVaultState = {
  vault: undefined,
  exists: false,
  fxrp: 0n,
  quote: 0n,
  perTradeCap: 0n,
  paused: false,
  teeAddress: undefined,
  factoryTeeAddress: undefined,
  teeStale: false,
};

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
      if (!client || !address || !env.flareVaultFactory) return EMPTY_VAULT;

      const factoryTeeAddress = await client.readContract({
        address: env.flareVaultFactory,
        abi: COPY_VAULT_FLARE_FACTORY_ABI,
        functionName: "teeAddress",
      });

      const vault = await client.readContract({
        address: env.flareVaultFactory,
        abi: COPY_VAULT_FLARE_FACTORY_ABI,
        functionName: "vaultOf",
        args: [address],
      });
      if (vault === zeroAddress) return { ...EMPTY_VAULT, factoryTeeAddress };

      const [fxrp, quote, perTradeCap, paused, teeAddress] = await Promise.all([
        client.readContract({ address: env.fxrp, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] }),
        client.readContract({
          address: env.flareQuoteToken,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [vault],
        }),
        client.readContract({ address: vault, abi: COPY_VAULT_FLARE_ABI, functionName: "perTradeCap" }),
        client.readContract({ address: vault, abi: COPY_VAULT_FLARE_ABI, functionName: "paused" }),
        client.readContract({ address: vault, abi: COPY_VAULT_FLARE_ABI, functionName: "teeAddress" }),
      ]);

      return {
        vault,
        exists: true,
        fxrp,
        quote,
        perTradeCap,
        paused,
        teeAddress,
        factoryTeeAddress,
        teeStale:
          factoryTeeAddress !== zeroAddress &&
          teeAddress.toLowerCase() !== factoryTeeAddress.toLowerCase(),
      };
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
    mutationFn: async (v: { amount: string; leg?: VaultLeg; capAmount?: string }): Promise<void> => {
      if (!client || !address || !env.flareVaultFactory) throw new Error("vault factory is not configured");
      const amount = parseToken(v.amount);
      if (amount === 0n) throw new Error("enter an amount to fund");
      const cap = v.capAmount ? parseToken(v.capAmount) : DEFAULT_CAP;
      const token = tokenForLeg(v.leg);

      // The factory pulls the tokens straight through to the new vault; it never holds a balance.
      await ensureAllowance(token, env.flareVaultFactory, amount);

      const hash = await writeContractAsync({
        address: env.flareVaultFactory,
        abi: COPY_VAULT_FLARE_FACTORY_ABI,
        functionName: "createVaultAndDeposit",
        args: [...vaultCreationArgs(cap), token, amount],
        chainId: FLARE,
      });
      await client.waitForTransactionReceipt({ hash });
      await refresh();
    },
  });

  /** Top up an existing vault. */
  const deposit = useMutation({
    mutationFn: async (v: { leg?: VaultLeg; amount: string }): Promise<void> => {
      const vault = state.data?.vault;
      if (!client || !vault) throw new Error("create a vault first");
      const token = tokenForLeg(v.leg);
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
    mutationFn: async (v: { leg?: VaultLeg; amount: string }): Promise<void> => {
      const vault = state.data?.vault;
      if (!client || !vault) throw new Error("no vault to withdraw from");
      const hash = await writeContractAsync({
        address: vault,
        abi: COPY_VAULT_FLARE_ABI,
        functionName: "withdraw",
        args: [tokenForLeg(v.leg), parseToken(v.amount)],
        chainId: FLARE,
      });
      await client.waitForTransactionReceipt({ hash });
      await refresh();
    },
  });

  /**
   * Repoint the vault at the enclave identity the factory currently advertises.
   *
   * Owner-only in the contract, which is the point: nobody — not the platform, not the factory admin —
   * can change what an existing vault trusts. The follower chooses to follow a re-attested enclave.
   */
  const repointTee = useMutation({
    mutationFn: async (): Promise<void> => {
      const vault = state.data?.vault;
      const target = state.data?.factoryTeeAddress;
      if (!client || !vault) throw new Error("no vault to repoint");
      if (!target || target === zeroAddress) throw new Error("the factory has no TEE address set");

      const hash = await writeContractAsync({
        address: vault,
        abi: COPY_VAULT_FLARE_ABI,
        functionName: "setTeeAddress",
        args: [target],
        chainId: FLARE,
      });
      await client.waitForTransactionReceipt({ hash });
      await refresh();
    },
  });

  return {
    ...(state.data ?? EMPTY_VAULT),
    loading: state.isLoading,
    ready: flareConfigReady,
    createAndFund: createAndFund.mutateAsync,
    creating: createAndFund.isPending,
    deposit: deposit.mutateAsync,
    depositing: deposit.isPending,
    withdraw: withdraw.mutateAsync,
    withdrawing: withdraw.isPending,
    repointTee: repointTee.mutateAsync,
    repointing: repointTee.isPending,
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
      // Bounded like every other scan: `earliest` here is rejected outright by the public RPC's
      // 30-block getLogs cap, which showed up as a permanently empty trade list rather than an error.
      const logs = await client
        .getContractEvents({
          address: vault,
          abi: COPY_VAULT_FLARE_ABI,
          eventName: "Swapped",
          fromBlock: env.flareFromBlock,
          toBlock: "latest",
        })
        .catch(() => []);
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

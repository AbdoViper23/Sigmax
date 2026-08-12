import { useAccount, useWalletClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { AbstractWallet } from "@nktkas/hyperliquid/signing";
import { deriveHlAgentAddress } from "@sigmax/enclave-crypto";
import { env } from "@/lib/env";
import type { PositionRow } from "@/components/sigmax/PositionsTable";
import {
  buildMarkets,
  type MarketInfo,
  type SpotMetaRaw,
  type SpotAssetCtx,
} from "@/lib/hyperliquid/markets";

/**
 * Hyperliquid copy-trading hooks (the abstracted follower experience). Reads use a wallet-less
 * InfoClient; the one signed action (authorize / revoke the trading agent) uses an ExchangeClient
 * built from the connected wagmi wallet. The agent the follower authorizes can place trades but can
 * NEVER withdraw — that always needs the follower's own signature.
 */

const AGENT_LABEL = "sigmax"; // the agent "name" on Hyperliquid (used to replace/revoke later)
const POLL_MS = 15_000;
const APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // agent authorization lifetime (see useApproveAgent)

// The SDK's accepted wallet type (viem account / wallet client / ethers signer).
type HlWallet = AbstractWallet;

function infoClient() {
  return new InfoClient({ transport: new HttpTransport({ isTestnet: env.hlTestnet }) });
}

/** Spendable USDC in the follower's own Hyperliquid spot account (for the fund-check + dashboard). */
export function useHlBalance(address?: Address) {
  const q = useQuery({
    queryKey: ["hl-balance", address, env.hlTestnet],
    enabled: Boolean(address),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const state = await infoClient().spotClearinghouseState({ user: address! });
      const usdc = state.balances.find((b) => b.coin === "USDC");
      return usdc ? Math.max(0, Number(usdc.total) - Number(usdc.hold)) : 0;
    },
  });
  return { usdc: q.data ?? 0, loading: q.isLoading, refetch: q.refetch };
}

/**
 * The agent address THIS follower must approve, derived in the browser from the enclave's published
 * master public key.
 *
 * Two things make this the right shape. First, each follower gets their own agent address: Hyperliquid
 * tracks nonces per signer and keeps only the 100 highest, so a single shared agent would put every
 * follower in one window and start dropping orders under fan-out. Second, the derivation is
 * recomputed here rather than fetched — the follower is about to grant an address permission to trade
 * on their account, and verifying that address beats trusting a server that returned it.
 *
 * Returns `null` while the enclave has no key injected, which is also the honest answer: until then
 * there is no agent to approve and Hyperliquid signals are rejected.
 */
export function useHlAgentAddress(address?: Address) {
  const q = useQuery({
    queryKey: ["hl-agent-address", address, env.flareProxyUrl],
    enabled: Boolean(address && env.flareProxyUrl),
    staleTime: 60_000,
    queryFn: async (): Promise<{ agentAddress: string; masterPubkey: string } | null> => {
      const res = await fetch(`${env.flareProxyUrl}/state`);
      if (!res.ok) return null;
      const body = (await res.json()) as { state?: { hlAgentMasterPubkey?: string | null } };
      const masterPubkey = body.state?.hlAgentMasterPubkey;
      if (!masterPubkey) return null; // no key injected in the enclave yet
      return { agentAddress: deriveHlAgentAddress(masterPubkey, address!), masterPubkey };
    },
  });

  return {
    agentAddress: q.data?.agentAddress,
    masterPubkey: q.data?.masterPubkey,
    loading: q.isLoading,
  };
}

/** Whether this follower's derived agent is currently approved (and not expired) on their account. */
export function useAgentApproval(address?: Address) {
  const { agentAddress } = useHlAgentAddress(address);

  const q = useQuery({
    queryKey: ["hl-agent-approval", address, agentAddress, env.hlTestnet],
    enabled: Boolean(address && agentAddress),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const agents = await infoClient().extraAgents({ user: address! });
      const target = agentAddress!.toLowerCase();
      const agent = agents.find(
        (a) => a.address.toLowerCase() === target && a.validUntil > Date.now(),
      );
      // The agent is authorized for APPROVAL_TTL_MS, so it was approved at (validUntil − TTL). Copy
      // trades can only exist from that moment on — used to filter the follower's fills.
      return {
        approved: Boolean(agent),
        copyTradingSince: agent ? agent.validUntil - APPROVAL_TTL_MS : undefined,
      };
    },
  });
  return {
    approved: q.data?.approved ?? false,
    copyTradingSince: q.data?.copyTradingSince,
    loading: q.isLoading,
    refetch: q.refetch,
  };
}

/**
 * The FULL Hyperliquid spot market list as "BASE/QUOTE" pairs, built exactly like the Menese reference
 * (spotMetaAndAssetCtxs → buildMarkets). No quote filter — every pair. Wallet-less, cached 5 min.
 * Callers filter (by quote tab) + sort (by 24h volume) at render time, like the reference's selector.
 */
export function useHlMarkets() {
  const q = useQuery({
    queryKey: ["hl-markets", env.hlTestnet],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<MarketInfo[]> => {
      const [meta, ctxs] = (await infoClient().spotMetaAndAssetCtxs()) as unknown as [
        SpotMetaRaw,
        SpotAssetCtx[],
      ];
      return buildMarkets(meta, ctxs);
    },
  });
  return { markets: q.data ?? [], loading: q.isLoading };
}

interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: string; // "B" | "A"
  dir?: string; // e.g. "Buy" | "Sell"
  time: number;
  closedPnl?: string;
  hash?: string;
  oid?: number;
}

/**
 * The follower's recent COPIED trades, mapped to the shared PositionRow shape for PositionsTable.
 * `userFills` returns every fill on the account — including the follower's own manual trades — so we
 * keep only fills at/after `since` (the agent's authorization time). Before the agent was approved it
 * couldn't have traded, so this cleanly excludes pre-existing history. `since` undefined → no filter.
 */
export function useHlPositions(address?: Address, since?: number) {
  const q = useQuery({
    queryKey: ["hl-fills", address, since, env.hlTestnet],
    enabled: Boolean(address),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const all = (await infoClient().userFills({ user: address! })) as unknown as HlFill[];
      const fills = since ? all.filter((f) => f.time >= since) : all;
      return fills.slice(0, 25).map((f, i): PositionRow => {
        const value = Number(f.sz) * Number(f.px);
        const pnl = f.closedPnl ? Number(f.closedPnl) : 0;
        const isBuy = (f.dir ?? "").toLowerCase().includes("buy") || f.side === "B";
        return {
          id: String(f.oid ?? `${f.time}-${i}`),
          pair: f.coin,
          amountIn: `${isBuy ? "Buy" : "Sell"} ${f.sz} @ ${f.px}`,
          currentValue: `${value.toFixed(2)} USDC`,
          pnlPct: 0,
          pnlUsd: pnl !== 0 ? `${pnl > 0 ? "+" : ""}${pnl.toFixed(2)}` : "—",
          openedAt: new Date(f.time).toISOString(),
          status: isBuy ? "open" : "closed",
          txUrl: f.hash ? `https://app.hyperliquid-testnet.xyz/explorer/tx/${f.hash}` : "#",
        };
      });
    },
  });
  return { positions: q.data ?? [], loading: q.isLoading, refetch: q.refetch };
}

function exchangeFrom(wallet: HlWallet) {
  return new ExchangeClient({ transport: new HttpTransport({ isTestnet: env.hlTestnet }), wallet });
}

/**
 * Authorize this follower's own enclave-derived agent to trade for them (wallet signs `approveAgent`).
 *
 * The approved key lives inside the TEE and can only place spot orders — Hyperliquid itself rejects a
 * withdrawal signed by an agent key, so this permission cannot move funds out. It expires on its own
 * and is revocable at any time.
 */
export function useApproveAgent() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { agentAddress } = useHlAgentAddress(address);

  const approve = async (): Promise<void> => {
    if (!walletClient) throw new Error("Connect your wallet first");
    if (!agentAddress) {
      throw new Error("The enclave has no trading key yet — copy-trading is not available");
    }
    const validUntil = Date.now() + APPROVAL_TTL_MS;
    await exchangeFrom(walletClient as unknown as HlWallet).approveAgent({
      agentAddress: agentAddress as Address,
      agentName: `${AGENT_LABEL} valid_until ${validUntil}`,
    });
  };

  return { approve, agentAddress };
}

/**
 * Revoke the agent: re-approve the same agent name with a throwaway address, which Hyperliquid treats
 * as a replacement — deregistering our agent. The burner key is never used, so trading is disabled.
 */
export function useRevokeAgent() {
  const { data: walletClient } = useWalletClient();
  const revoke = async (): Promise<void> => {
    if (!walletClient) throw new Error("Connect your wallet first");
    const burner = privateKeyToAccount(generatePrivateKey()).address;
    await exchangeFrom(walletClient as unknown as HlWallet).approveAgent({
      agentAddress: burner,
      agentName: AGENT_LABEL,
    });
  };
  return { revoke };
}

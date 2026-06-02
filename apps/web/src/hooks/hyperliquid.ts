import { useWalletClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { AbstractWallet } from "@nktkas/hyperliquid/signing";
import { env } from "@/lib/env";
import type { PositionRow } from "@/components/sigmax/PositionsTable";

/**
 * Hyperliquid copy-trading hooks (the abstracted follower experience). Reads use a wallet-less
 * InfoClient; the one signed action (authorize / revoke the trading agent) uses an ExchangeClient
 * built from the connected wagmi wallet. The agent the follower authorizes can place trades but can
 * NEVER withdraw — that always needs the follower's own signature.
 */

const AGENT_LABEL = "sigmax"; // the agent "name" on Hyperliquid (used to replace/revoke later)
const POLL_MS = 15_000;

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

/** Whether the configured platform agent is currently approved (and not expired) on the account. */
export function useAgentApproval(address?: Address) {
  const q = useQuery({
    queryKey: ["hl-agent-approval", address, env.hlAgentAddress, env.hlTestnet],
    enabled: Boolean(address && env.hlAgentAddress),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const agents = await infoClient().extraAgents({ user: address! });
      const target = env.hlAgentAddress!.toLowerCase();
      return agents.some((a) => a.address.toLowerCase() === target && a.validUntil > Date.now());
    },
  });
  return { approved: q.data ?? false, loading: q.isLoading, refetch: q.refetch };
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

/** The follower's recent copied trades, mapped to the shared PositionRow shape for PositionsTable. */
export function useHlPositions(address?: Address) {
  const q = useQuery({
    queryKey: ["hl-fills", address, env.hlTestnet],
    enabled: Boolean(address),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const fills = (await infoClient().userFills({ user: address! })) as unknown as HlFill[];
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

/** Authorize the platform agent to trade on the follower's behalf (wallet signs `approveAgent`). */
export function useApproveAgent() {
  const { data: walletClient } = useWalletClient();
  const approve = async (): Promise<void> => {
    if (!walletClient) throw new Error("Connect your wallet first");
    if (!env.hlAgentAddress) throw new Error("Copy-trading agent is not configured");
    const validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
    await exchangeFrom(walletClient as unknown as HlWallet).approveAgent({
      agentAddress: env.hlAgentAddress,
      agentName: `${AGENT_LABEL} valid_until ${validUntil}`,
    });
  };
  return { approve };
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

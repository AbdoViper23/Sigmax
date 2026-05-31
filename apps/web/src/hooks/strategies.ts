import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Address } from "viem";
import { chainConfigReady, env } from "@/lib/env";
import { COPY_VAULT_ABI, COPY_VAULT_FACTORY_ABI } from "@/lib/abis";

const ARB = env.liquidityChainId;
const USDC_DECIMALS = 6;
const usdcNum = (x: bigint) => Number(formatUnits(x, USDC_DECIMALS));

/**
 * Verified performance for the configured strategy, computed from real on-chain trades — no indexer,
 * no mock. Every follower vault copies the same signals, so the strategy's track record is the
 * aggregate of all vaults' realized swaps: scan `VaultCreated` on the factory → each vault's
 * `Swapped` events → match USDC→token (open) with token→USDC (close) FIFO → realized PnL.
 *
 *  - `verifiedReturnPct` = Σ realized PnL ÷ Σ cost basis.
 *  - `winRatePct`        = closed trades in profit ÷ closed trades.
 *  - `maxDrawdownPct`    = null — needs an equity time series we don't track on-chain (honest "—").
 * All null until at least one position has closed.
 */
export function useStrategyPerformance() {
  const pub = usePublicClient({ chainId: ARB });

  const q = useQuery({
    queryKey: ["strategy-performance", env.factoryAddress, env.usdc],
    enabled: Boolean(pub && chainConfigReady && env.factoryAddress),
    queryFn: async () => {
      if (!pub || !env.factoryAddress) {
        return { verifiedReturnPct: null, winRatePct: null, closedTrades: 0 };
      }
      const vaultLogs = await pub.getContractEvents({
        address: env.factoryAddress,
        abi: COPY_VAULT_FACTORY_ABI,
        eventName: "VaultCreated",
        fromBlock: "earliest",
        toBlock: "latest",
      });
      const vaults = [
        ...new Set(
          vaultLogs
            .map((l) => (l.args as { vault?: Address }).vault?.toLowerCase())
            .filter((v): v is string => Boolean(v)),
        ),
      ] as Address[];

      const usdc = env.usdc.toLowerCase();
      let realizedPnl = 0;
      let costBasis = 0;
      let closedTrades = 0;
      let wins = 0;

      for (const vault of vaults) {
        const swaps = await pub.getContractEvents({
          address: vault,
          abi: COPY_VAULT_ABI,
          eventName: "Swapped",
          fromBlock: "earliest",
          toBlock: "latest",
        });
        const openByToken = new Map<string, number[]>(); // token → FIFO queue of entry USDC
        for (const s of swaps) {
          const { tokenIn, amountIn, tokenOut, received } = s.args as {
            tokenIn: Address;
            amountIn: bigint;
            tokenOut: Address;
            received: bigint;
          };
          if (tokenIn.toLowerCase() === usdc) {
            const queue = openByToken.get(tokenOut.toLowerCase()) ?? [];
            queue.push(usdcNum(amountIn));
            openByToken.set(tokenOut.toLowerCase(), queue);
          } else if (tokenOut.toLowerCase() === usdc) {
            const entry = openByToken.get(tokenIn.toLowerCase())?.shift();
            if (entry !== undefined) {
              const exit = usdcNum(received);
              realizedPnl += exit - entry;
              costBasis += entry;
              closedTrades += 1;
              if (exit > entry) wins += 1;
            }
          }
        }
      }

      return {
        verifiedReturnPct:
          costBasis > 0 ? Number(((realizedPnl / costBasis) * 100).toFixed(2)) : null,
        winRatePct: closedTrades > 0 ? Math.round((wins / closedTrades) * 100) : null,
        closedTrades,
      };
    },
  });

  return {
    verifiedReturnPct: q.data?.verifiedReturnPct ?? null,
    winRatePct: q.data?.winRatePct ?? null,
    maxDrawdownPct: null as number | null, // not derivable on-chain without an equity time series
    closedTrades: q.data?.closedTrades ?? 0,
    loading: q.isLoading,
  };
}

// The leaderboard now lists ALL leaders (mock + the configured live strategy) via `useLeaders()`
// (hooks/leaders.ts) — it is the marketplace source of truth. `useStrategyPerformance` above stays
// the per-strategy track-record primitive consumed by useLeaders, the leader page, and the detail page.

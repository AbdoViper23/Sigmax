/**
 * Live health of the two things a demo actually depends on: the enclave, and the pool the vaults
 * trade against. Both are judge-visible trust signals — the status pill in the nav proves the TEE
 * is a running machine holding state, and the pool↔oracle gap tells a leader whether a Flare swap
 * can clear the vault's 1% FTSO bound *before* they spend gas finding out.
 */
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits, parseAbi, type Hex } from "viem";
import { readEnclaveState, type EnclaveState } from "@/lib/enclave";
import { env } from "@/lib/env";

export type EnclaveHealth =
  | { status: "live"; state: EnclaveState }
  | { status: "no-key"; state: EnclaveState }
  | { status: "offline" };

/** Poll the enclave's /state through the failover fetcher. */
export function useEnclaveStatus(refetchMs = 15_000) {
  const q = useQuery({
    queryKey: ["enclave-status"],
    refetchInterval: refetchMs,
    // The pill must never look "loading" forever on a dead tunnel; readEnclaveState never throws.
    queryFn: async (): Promise<EnclaveHealth> => {
      const state = await readEnclaveState();
      if (!state) return { status: "offline" };
      return state.hasKey ? { status: "live", state } : { status: "no-key", state };
    },
  });
  return { health: q.data ?? null, loading: q.isLoading };
}

const ROUTER_ABI = parseAbi(["function pairFor(address,address) view returns (address)"]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const FTSO_ABI = parseAbi([
  "function getFeedById(bytes21) view returns (uint256,int8,uint64)",
]);

export interface PoolOracleGap {
  /** Signed gap in percent: pool price vs FTSO. +0.9 means the pool is 0.9% above the oracle. */
  gapPct: number;
  poolPrice: number;
  oraclePrice: number;
  /**
   * Whether an ENTRY (buy of FXRP) is expected to clear the vault's minOut. The bound is 1%, and a
   * buy pays the gap plus the 0.3% AMM fee plus impact — so anything above ~+0.6% is already in
   * revert territory. A pool sitting below the oracle gives a buy headroom.
   */
  entryLikelyExecutes: boolean;
}

/** Compare the BlazeSwap pool price to the FTSO feed the vaults bound execution against. */
export function usePoolOracleGap(refetchMs = 30_000) {
  const client = usePublicClient({ chainId: env.flareChainId });

  const q = useQuery({
    queryKey: ["pool-oracle-gap", env.fxrp, env.flareQuoteToken],
    refetchInterval: refetchMs,
    enabled: Boolean(client),
    queryFn: async (): Promise<PoolOracleGap | null> => {
      if (!client) return null;
      const pair = await client.readContract({
        address: env.blazeSwapRouter,
        abi: ROUTER_ABI,
        functionName: "pairFor",
        args: [env.fxrp, env.flareQuoteToken],
      });

      const [fxrpRaw, usdRaw, fxrpDec, usdDec, feed] = await Promise.all([
        client.readContract({ address: env.fxrp, abi: ERC20_ABI, functionName: "balanceOf", args: [pair] }),
        client.readContract({ address: env.flareQuoteToken, abi: ERC20_ABI, functionName: "balanceOf", args: [pair] }),
        client.readContract({ address: env.fxrp, abi: ERC20_ABI, functionName: "decimals" }),
        client.readContract({ address: env.flareQuoteToken, abi: ERC20_ABI, functionName: "decimals" }),
        client.readContract({
          address: env.ftsoV2,
          abi: FTSO_ABI,
          functionName: "getFeedById",
          args: [env.ftsoXrpUsdFeedId as Hex],
        }),
      ]);

      const fxrp = Number(formatUnits(fxrpRaw, fxrpDec));
      const usd = Number(formatUnits(usdRaw, usdDec));
      if (!(fxrp > 0) || !(usd > 0)) return null; // pool unseeded — nothing to compare

      const poolPrice = usd / fxrp;
      const oraclePrice = Number(feed[0]) / 10 ** Number(feed[1]);
      const gapPct = (poolPrice / oraclePrice - 1) * 100;
      return { gapPct, poolPrice, oraclePrice, entryLikelyExecutes: gapPct <= 0.6 };
    },
  });

  return { gap: q.data ?? null, loading: q.isLoading };
}

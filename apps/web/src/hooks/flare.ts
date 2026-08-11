/**
 * Flare (Coston2) hooks — publishing a signal and reading the FTSO price.
 *
 * The defining difference from the Story path in `hooks/leader.ts`: the signal is ECIES-encrypted
 * **in this browser** against the enclave's public key, and only the ciphertext is sent — as a
 * transaction the leader signs themselves. No server ever sees the strategy. If the enclave key
 * cannot be fetched we fail loudly rather than fall back to a plaintext path.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { formatUnits, zeroAddress, type Hex } from "viem";
import { EnclaveSignalSealer, ProxyEnclaveKeySource } from "@sigmax/enclave-crypto";
import type { Signal } from "@sigmax/shared";
import { env, flareConfigReady } from "../lib/env";

const INSTRUCTION_SENDER_ABI = [
  {
    type: "function",
    name: "publishSignal",
    stateMutability: "payable",
    inputs: [
      { name: "_strategyId", type: "address" },
      { name: "_uri", type: "string" },
      { name: "_ciphertext", type: "bytes" },
    ],
    outputs: [{ name: "index", type: "uint256" }],
  },
] as const;

const FTSO_V2_ABI = [
  {
    type: "function",
    name: "getFeedById",
    stateMutability: "view",
    inputs: [{ name: "_feedId", type: "bytes21" }],
    outputs: [
      { name: "_value", type: "uint256" },
      { name: "_decimals", type: "int8" },
      { name: "_timestamp", type: "uint64" },
    ],
  },
] as const;

/** Lazily built so a missing proxy URL surfaces at publish time, not at module load. */
function makeCdr(): EnclaveSignalSealer {
  if (!env.flareProxyUrl) {
    throw new Error("VITE_FLARE_PROXY_URL is not set — cannot fetch the enclave key to encrypt against");
  }
  return new EnclaveSignalSealer(new ProxyEnclaveKeySource(env.flareProxyUrl));
}

let cdrInstance: EnclaveSignalSealer | null = null;
function cdr(): EnclaveSignalSealer {
  if (cdrInstance === null) cdrInstance = makeCdr();
  return cdrInstance;
}

export interface FlarePublishResult {
  signalId: string;
  txHash: Hex;
  ciphertextBytes: number;
  at: string;
}

/**
 * Encrypt a signal to the enclave and publish the ciphertext on Coston2. One wallet signature; the
 * same transaction records the commitment and routes the ciphertext to the TEE.
 */
export function useFlarePublishSignal(strategyIdArg?: Hex) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const strategyId = strategyIdArg ?? env.strategyIpId ?? zeroAddress;

  const mutation = useMutation({
    mutationFn: async (signal: Signal): Promise<FlarePublishResult> => {
      if (!walletClient || !address) throw new Error("connect a wallet first");
      if (!env.flareInstructionSender) throw new Error("VITE_FLARE_INSTRUCTION_SENDER is not set");

      // Client-side encryption. Plaintext never leaves this function.
      const { ciphertext, byteLength } = await cdr().encryptSignal(signal);

      const txHash = await walletClient.writeContract({
        address: env.flareInstructionSender,
        abi: INSTRUCTION_SENDER_ABI,
        functionName: "publishSignal",
        args: [strategyId as Hex, "", ciphertext],
        chain: walletClient.chain,
        account: address,
      });

      return { signalId: signal.signalId, txHash, ciphertextBytes: byteLength, at: new Date().toISOString() };
    },
  });

  return {
    publish: mutation.mutateAsync,
    publishing: mutation.isPending,
    error: mutation.error,
    ready: flareConfigReady,
  };
}

export interface FtsoPrice {
  /** Human-readable price, e.g. "1.019291". */
  formatted: string;
  value: bigint;
  decimals: number;
  /** Unix seconds of the feed's last update. */
  timestamp: number;
}

/**
 * Live XRP/USD from FTSO — the same feed that bounds `minOut` inside the enclave, so the follower
 * sees exactly what the execution guarantee is priced against. Fee-free view call.
 */
export function useFtsoXrpUsd(refetchMs = 15_000) {
  const client = usePublicClient({ chainId: env.flareChainId });

  const q = useQuery({
    queryKey: ["ftso-xrp-usd", env.ftsoV2],
    refetchInterval: refetchMs,
    queryFn: async (): Promise<FtsoPrice | null> => {
      if (!client) return null;
      const [value, decimals, timestamp] = await client.readContract({
        address: env.ftsoV2,
        abi: FTSO_V2_ABI,
        functionName: "getFeedById",
        args: [env.ftsoXrpUsdFeedId as Hex],
      });
      if (decimals < 0) return null; // negative exponents aren't used by this feed
      return {
        value,
        decimals: Number(decimals),
        formatted: formatUnits(value, Number(decimals)),
        timestamp: Number(timestamp),
      };
    },
  });

  return { price: q.data ?? null, loading: q.isLoading, error: q.error };
}

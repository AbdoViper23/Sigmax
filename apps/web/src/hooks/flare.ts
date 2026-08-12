/**
 * Flare (Coston2) hooks — publishing a signal and reading the FTSO price.
 *
 * The signal is ECIES-encrypted **in this browser** against the enclave's public key, and only the
 * ciphertext is sent — as a transaction the leader signs themselves. No server ever sees the strategy.
 * If the enclave key cannot be fetched we fail loudly rather than fall back to a plaintext path.
 *
 * That is the whole point of replacing the Story path this supersedes, where the browser POSTed the
 * plaintext signal — take-profit and stop-loss included — to a server that encrypted it on the
 * leader's behalf. Encryption has to happen before the strategy leaves the leader's machine, or the
 * confidentiality claim is about who we promise to be rather than what the system can do.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { formatUnits, parseUnits, zeroAddress, type Hex } from "viem";
import { EnclaveSignalSealer, ProxyEnclaveKeySource } from "@sigmax/enclave-crypto";
import { PRICE_SCALE, type Signal, type SignalVenueT } from "@sigmax/shared";
import { env, flareConfigReady } from "../lib/env";

/**
 * What `PublishSignalForm` emits. Defined here rather than imported from the legacy Story hooks so
 * the Flare path carries no dependency on the stack it replaces.
 */
export interface PublishForm {
  action: "ENTRY" | "EXIT";
  venue: SignalVenueT;
  /** Flare/Arbitrum: an EVM address. Hyperliquid: the spot coin symbol (e.g. "USOL"). */
  token: string;
  /** Hyperliquid only: the market's quote symbol. Defaults to USDC. */
  quoteToken?: string;
  sizePercent: number;
  maxEntryPrice?: string;
  takeProfitPrice?: string;
  stopLossPrice?: string;
  slippagePercent: number;
  expiresInHours: number;
}

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

/**
 * The form-shaped publish the leader page actually calls: build the structured `Signal` from the
 * form, then encrypt-and-publish it.
 *
 * This lives here rather than in the route because the mapping is where a confidentiality mistake
 * would hide. Note what does NOT happen: the take-profit and stop-loss are read from the form
 * straight into the object that gets encrypted, and no intermediate copy is sent anywhere.
 */
export function useFlarePublish(strategyIdArg?: Hex) {
  const { publish, publishing, error, ready } = useFlarePublishSignal(strategyIdArg);
  const strategyId = strategyIdArg ?? env.strategyIpId ?? zeroAddress;

  const publishForm = async (form: PublishForm): Promise<FlarePublishResult> => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const signal: Signal = {
      version: 1,
      signalId: crypto.randomUUID(),
      strategyId: strategyId as string,
      // On Coston2 the control plane and the settlement venue are the same chain.
      chainId: env.flareChainId,
      venue: form.venue,
      action: form.action,
      // Flare trades ERC-20 addresses; Hyperliquid trades coin symbols.
      token: form.token,
      quoteToken:
        form.venue === "hyperliquid" ? (form.quoteToken ?? "USDC") : (env.flareQuoteToken as string),
      sizeBps: Math.round(form.sizePercent * 100),
      maxEntryPrice: scalePrice(form.maxEntryPrice),
      takeProfitPrice: scalePrice(form.takeProfitPrice),
      stopLossPrice: scalePrice(form.stopLossPrice),
      issuedAt,
      expiresAt: issuedAt + form.expiresInHours * 3600,
    };
    return publish(signal);
  };

  return { publish: publishForm, publishing, error, ready };
}

/** Human USD price → integer string scaled by 10^PRICE_SCALE (the on-chain signal encoding). */
function scalePrice(p?: string): string {
  if (!p || p.trim() === "") return "0";
  return parseUnits(p as `${number}`, PRICE_SCALE).toString();
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

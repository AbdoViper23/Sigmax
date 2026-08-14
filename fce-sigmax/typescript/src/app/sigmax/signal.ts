/**
 * Sigmax signal decoding + validation (vendored from packages/shared/src/signal.ts).
 *
 * The ABI layout MUST stay byte-identical to the leader-side encoder — the leader ABI-encodes the
 * signal, ECIES-encrypts it to the enclave key, and this module decodes the plaintext inside the TEE.
 * Validation mirrors the shared Zod schema without the zod dependency (untrusted external input:
 * every field is checked before use).
 *
 * HARD RULE (SPOT ONLY): there is intentionally NO leverage / short / margin / side field.
 */

import { decodeAbiParameters, type Hex } from "viem";

export const SIGNAL_ABI = [
  { type: "uint16", name: "version" },
  { type: "bytes16", name: "signalId" },
  { type: "address", name: "strategyId" },
  { type: "uint32", name: "chainId" },
  { type: "uint8", name: "venue" },
  { type: "uint8", name: "action" },
  { type: "string", name: "token" },
  { type: "string", name: "quoteToken" },
  { type: "uint16", name: "sizeBps" },
  { type: "uint256", name: "maxEntryPrice" },
  { type: "uint256", name: "takeProfitPrice" },
  { type: "uint256", name: "stopLossPrice" },
  { type: "uint64", name: "issuedAt" },
  { type: "uint64", name: "expiresAt" },
] as const;

export type SignalVenue = "arbitrum" | "hyperliquid" | "flare";
const U8_TO_VENUE: readonly SignalVenue[] = ["arbitrum", "hyperliquid", "flare"];

export interface Signal {
  version: number;
  signalId: string; // uuid
  strategyId: `0x${string}`;
  chainId: number;
  venue: SignalVenue;
  action: "ENTRY" | "EXIT";
  token: string;
  quoteToken: string;
  sizeBps: number;
  maxEntryPrice: string;
  takeProfitPrice: string;
  stopLossPrice: string;
  issuedAt: number;
  expiresAt: number;
}

const addressRe = /^0x[0-9a-fA-F]{40}$/;

function bytes16ToUuid(b: Hex): string {
  const h = b.slice(2);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Decode the ABI-encoded signal and validate every field. Throws with a field-scoped message. */
export function decodeSignal(data: Hex): Signal {
  const d = decodeAbiParameters(SIGNAL_ABI, data);

  const version = Number(d[0]);
  if (version < 1 || version > 65535) throw new Error("version out of range");

  const chainId = Number(d[3]);
  if (chainId <= 0) throw new Error("chainId must be positive");

  const venueU8 = Number(d[4]);
  const venue = U8_TO_VENUE[venueU8];
  if (venue === undefined) throw new Error(`unknown venue code ${venueU8}`);

  const actionU8 = Number(d[5]);
  if (actionU8 !== 0 && actionU8 !== 1) throw new Error(`unknown action code ${actionU8}`);

  const token = d[6];
  const quoteToken = d[7];
  if (venue === "arbitrum" || venue === "flare") {
    if (!addressRe.test(token)) throw new Error(`${venue} token must be an EVM address`);
    if (!addressRe.test(quoteToken)) throw new Error(`${venue} quoteToken must be an EVM address`);
  } else {
    if (token.length === 0) throw new Error("token must not be empty");
    if (quoteToken.length === 0) throw new Error("quoteToken must not be empty");
  }

  // Mirrors MAX_SIZE_BPS in @sigmax/shared (the enclave cannot import it — it builds standalone).
  // An EXIT must be able to close the whole position; an ENTRY stays a bounded fraction.
  const action = actionU8 === 0 ? "ENTRY" : "EXIT";
  const maxSizeBps = action === "EXIT" ? 10_000 : 2000;
  const sizeBps = Number(d[8]);
  if (sizeBps < 1 || sizeBps > maxSizeBps) {
    throw new Error(`sizeBps out of range (1..${maxSizeBps} for ${action})`);
  }

  const issuedAt = Number(d[12]);
  const expiresAt = Number(d[13]);
  if (issuedAt < 0 || expiresAt < 0) throw new Error("timestamps must be non-negative");

  return {
    version,
    signalId: bytes16ToUuid(d[1]),
    strategyId: d[2],
    chainId,
    venue,
    action: actionU8 === 0 ? "ENTRY" : "EXIT",
    token,
    quoteToken,
    sizeBps,
    maxEntryPrice: d[9].toString(),
    takeProfitPrice: d[10].toString(),
    stopLossPrice: d[11].toString(),
    issuedAt,
    expiresAt,
  };
}

import { encodeAbiParameters, decodeAbiParameters, type Hex } from "viem";
import { z } from "zod";

/** Prices are integers scaled by 10^PRICE_SCALE (publisher and agent MUST agree). */
export const PRICE_SCALE = 8;

const addressRe = /^0x[0-9a-fA-F]{40}$/;
const uintStr = z.string().regex(/^\d+$/, "must be a non-negative integer string");

export const SignalAction = z.enum(["ENTRY", "EXIT"]);
export type SignalActionT = z.infer<typeof SignalAction>;

/**
 * The structured spot signal.
 *
 * HARD RULE 1 (SPOT ONLY): there is intentionally NO leverage / short / margin / side field.
 * Adding one would break the spot-only invariant — reject any such field in review.
 * Keep the ABI-encoded size < 1024 bytes (the CDR on-chain payload limit on Aeneid).
 */
export const SignalSchema = z.object({
  version: z.number().int().min(1).max(65535).default(1),
  signalId: z.string().uuid(),
  strategyId: z.string().regex(addressRe), // Story ipId (ERC-6551 address)
  chainId: z.number().int().positive(),
  action: SignalAction,
  token: z.string().regex(addressRe), // target token: buy on ENTRY, sell on EXIT
  quoteToken: z.string().regex(addressRe), // explicit reference token (e.g. USDC) — never implicit
  sizeBps: z.number().int().min(1).max(10000).default(10000), // % of vault balance, in basis points
  maxEntryPrice: uintStr.default("0"), // "0" = none
  takeProfitPrice: uintStr.default("0"), // "0" = none
  stopLossPrice: uintStr.default("0"), // "0" = none
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type Signal = z.infer<typeof SignalSchema>;

const SIGNAL_ABI = [
  { type: "uint16", name: "version" },
  { type: "bytes16", name: "signalId" },
  { type: "address", name: "strategyId" },
  { type: "uint32", name: "chainId" },
  { type: "uint8", name: "action" },
  { type: "address", name: "token" },
  { type: "address", name: "quoteToken" },
  { type: "uint16", name: "sizeBps" },
  { type: "uint256", name: "maxEntryPrice" },
  { type: "uint256", name: "takeProfitPrice" },
  { type: "uint256", name: "stopLossPrice" },
  { type: "uint64", name: "issuedAt" },
  { type: "uint64", name: "expiresAt" },
] as const;

function uuidToBytes16(uuid: string): Hex {
  return ("0x" + uuid.replace(/-/g, "")) as Hex;
}

function bytes16ToUuid(b: Hex): string {
  const h = b.slice(2);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Validate, then ABI-encode the signal into the bytes stored in the CDR vault. */
export function encodeSignal(input: Signal): Hex {
  const s = SignalSchema.parse(input);
  return encodeAbiParameters(SIGNAL_ABI, [
    s.version,
    uuidToBytes16(s.signalId),
    s.strategyId as Hex,
    s.chainId,
    s.action === "ENTRY" ? 0 : 1,
    s.token as Hex,
    s.quoteToken as Hex,
    s.sizeBps,
    BigInt(s.maxEntryPrice),
    BigInt(s.takeProfitPrice),
    BigInt(s.stopLossPrice),
    BigInt(s.issuedAt),
    BigInt(s.expiresAt),
  ]);
}

/** Decode bytes from the CDR vault and RE-VALIDATE before acting on them. */
export function decodeSignal(data: Hex): Signal {
  const d = decodeAbiParameters(SIGNAL_ABI, data);
  return SignalSchema.parse({
    version: Number(d[0]),
    signalId: bytes16ToUuid(d[1]),
    strategyId: d[2],
    chainId: Number(d[3]),
    action: Number(d[4]) === 0 ? "ENTRY" : "EXIT",
    token: d[5],
    quoteToken: d[6],
    sizeBps: Number(d[7]),
    maxEntryPrice: d[8].toString(),
    takeProfitPrice: d[9].toString(),
    stopLossPrice: d[10].toString(),
    issuedAt: Number(d[11]),
    expiresAt: Number(d[12]),
  });
}

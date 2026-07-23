import { encodeAbiParameters, decodeAbiParameters, type Hex } from "viem";
import { z } from "zod";

/** Prices are integers scaled by 10^PRICE_SCALE (publisher and agent MUST agree). */
export const PRICE_SCALE = 8;

const addressRe = /^0x[0-9a-fA-F]{40}$/;
const uintStr = z.string().regex(/^\d+$/, "must be a non-negative integer string");

export const SignalAction = z.enum(["ENTRY", "EXIT"]);
export type SignalActionT = z.infer<typeof SignalAction>;

/**
 * Where the swap executes. arbitrum = ERC-20 swap in the follower's CopyVault; hyperliquid = HyperCore
 * spot; flare = FXRP↔USDT0 swap on a Coston2 DEX inside the follower's CopyVaultFlare.
 */
export const SignalVenue = z.enum(["arbitrum", "hyperliquid", "flare"]);
export type SignalVenueT = z.infer<typeof SignalVenue>;

/** Stable venue ↔ uint8 map for ABI encoding (append-only; never renumber existing venues). */
const VENUE_TO_U8: Record<SignalVenueT, number> = { arbitrum: 0, hyperliquid: 1, flare: 2 };
const U8_TO_VENUE = ["arbitrum", "hyperliquid", "flare"] as const;

/**
 * The structured spot signal.
 *
 * HARD RULE 1 (SPOT ONLY): there is intentionally NO leverage / short / margin / side field.
 * Adding one would break the spot-only invariant — reject any such field in review.
 * Keep the ABI-encoded size < 1024 bytes (the CDR on-chain payload limit on Aeneid).
 *
 * `token`/`quoteToken` are venue-dependent (see superRefine): on arbitrum they are EVM addresses;
 * on hyperliquid they are spot coin SYMBOLS (e.g. "HYPE" / "USDC"), resolved live against spotMeta.
 */
export const SignalSchema = z
  .object({
    version: z.number().int().min(1).max(65535).default(1),
    signalId: z.string().uuid(),
    strategyId: z.string().regex(addressRe), // Story ipId (ERC-6551 address)
    chainId: z.number().int().positive(),
    venue: SignalVenue.default("hyperliquid"), // execution venue (per-signal)
    action: SignalAction,
    token: z.string().min(1), // target: buy on ENTRY, sell on EXIT (address on arbitrum, symbol on HL)
    quoteToken: z.string().min(1), // explicit reference token (address on arbitrum, symbol on HL)
    sizeBps: z.number().int().min(1).max(2000).default(500), // % of vault balance, in basis points (max 20%)
    maxEntryPrice: uintStr.default("0"), // "0" = none
    takeProfitPrice: uintStr.default("0"), // "0" = none
    stopLossPrice: uintStr.default("0"), // "0" = none
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .superRefine((s, ctx) => {
    // arbitrum + flare execute ERC-20 swaps → token/quoteToken MUST be EVM addresses. Hyperliquid trades
    // spot markets by coin symbol → any non-empty symbol (validated live against spotMeta in the agent).
    if (s.venue === "arbitrum" || s.venue === "flare") {
      if (!addressRe.test(s.token))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["token"], message: `${s.venue} token must be an EVM address` });
      if (!addressRe.test(s.quoteToken))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quoteToken"], message: `${s.venue} quoteToken must be an EVM address` });
    }
  });
export type Signal = z.infer<typeof SignalSchema>;

const SIGNAL_ABI = [
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
    VENUE_TO_U8[s.venue],
    s.action === "ENTRY" ? 0 : 1,
    s.token,
    s.quoteToken,
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
    venue: U8_TO_VENUE[Number(d[4])],
    action: Number(d[5]) === 0 ? "ENTRY" : "EXIT",
    token: d[6],
    quoteToken: d[7],
    sizeBps: Number(d[8]),
    maxEntryPrice: d[9].toString(),
    takeProfitPrice: d[10].toString(),
    stopLossPrice: d[11].toString(),
    issuedAt: Number(d[12]),
    expiresAt: Number(d[13]),
  });
}

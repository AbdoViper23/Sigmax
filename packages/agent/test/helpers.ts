import type { Hex } from "viem";
import { SignalSchema, ARBITRUM_ADDRESSES, encodeSignal, decodeSignal, type Signal } from "@sigmax/shared";
import type { Executor, PriceSource, SubscriberSource } from "../src/ports.js";
import { type CdrPort, ReadConditionDenied } from "@sigmax/cdr";

export const STRATEGY = "0x77319B4031e6eF1250907aa00018B8B1c67a244b" as Hex;
export const USDC = ARBITRUM_ADDRESSES.usdc as Hex;
export const WETH = ARBITRUM_ADDRESSES.weth as Hex;

/** Secret thresholds used across tests — assert these strings never leak. */
export const TP = "300000000000"; // $3000 (1e8)
export const SL = "250000000000"; // $2500 (1e8)

export function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return SignalSchema.parse({
    signalId: "11111111-2222-3333-4444-555555555555",
    strategyId: STRATEGY,
    chainId: 42161,
    venue: "arbitrum", // these fixtures use EVM addresses; HL-specific tests override venue + token
    action: "ENTRY",
    token: WETH,
    quoteToken: USDC,
    sizeBps: 5000,
    takeProfitPrice: TP,
    stopLossPrice: SL,
    issuedAt: 1_900_000_000,
    expiresAt: 1_900_086_400,
    ...overrides,
  });
}

export interface SwapCall {
  vault: Hex;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
}

export class FakeExecutor implements Executor {
  swaps: SwapCall[] = [];
  constructor(
    private readonly opts: {
      balance?: bigint;
      cap?: bigint;
      vaultFor?: (f: Hex) => Hex;
      throwForVault?: (vault: Hex) => boolean;
      received?: (amountIn: bigint) => bigint;
    } = {},
  ) {}

  async vaultOf(follower: Hex): Promise<Hex> {
    return this.opts.vaultFor ? this.opts.vaultFor(follower) : (("0x" + follower.slice(2)) as Hex);
  }
  async balanceOf(): Promise<bigint> {
    return this.opts.balance ?? 1_000_000_000n;
  }
  async perTradeCap(): Promise<bigint> {
    return this.opts.cap ?? 1_000_000_000n;
  }
  async quoteAndSwap(a: { vault: Hex; tokenIn: string; tokenOut: string; amountIn: bigint }): Promise<{ txHash: Hex; received: bigint }> {
    if (this.opts.throwForVault?.(a.vault)) throw new Error("swap reverted");
    this.swaps.push({ vault: a.vault, tokenIn: a.tokenIn, tokenOut: a.tokenOut, amountIn: a.amountIn });
    return { txHash: ("0x" + "cd".repeat(32)) as Hex, received: this.opts.received ? this.opts.received(a.amountIn) : a.amountIn / 2n };
  }
}

export class FakePrice implements PriceSource {
  constructor(private price: bigint) {}
  set(p: bigint) {
    this.price = p;
  }
  async getPrice(): Promise<bigint> {
    return this.price;
  }
}

export class FakeSubscribers implements SubscriberSource {
  constructor(
    private readonly followers: Hex[],
    private readonly activeSet: Set<string> = new Set(followers.map((f) => f.toLowerCase())),
  ) {}
  async isActive(follower: Hex): Promise<boolean> {
    return this.activeSet.has(follower.toLowerCase());
  }
  async listFollowers(): Promise<Hex[]> {
    return this.followers;
  }
}

/** A log sink that records every emitted line for redaction assertions. */
export function recordingSink(): { lines: string[]; sink: (l: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (l: string) => lines.push(l) };
}

/**
 * In-memory CDR double for tests — stores the ABI-encoded signal and gates reads on a flag, mirroring
 * the on-chain LicenseReadCondition (revert when the caller lacks a valid license). Test-only and NOT
 * confidential; the product path is always RealCdr (live threshold encryption on Story Aeneid).
 */
export class FakeCdr implements CdrPort {
  private vaults = new Map<number, Hex>();
  private nextUuid = 1;
  constructor(private readonly opts: { hasLicense: boolean } = { hasLicense: true }) {}
  async publishSignal(signal: Signal): Promise<{ uuid: number }> {
    const uuid = this.nextUuid++;
    this.vaults.set(uuid, encodeSignal(signal)); // validates on encode
    return { uuid };
  }
  async accessSignal(uuid: number): Promise<Signal> {
    if (!this.opts.hasLicense) throw new ReadConditionDenied();
    const data = this.vaults.get(uuid);
    if (!data) throw new Error(`vault ${uuid} not found`);
    return decodeSignal(data); // re-validates on decode
  }
}

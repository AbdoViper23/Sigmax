import type { Hex } from "viem";
import { type StoryIpPort, StoryIpError } from "./port.js";

const BPS_DENOMINATOR = 10000;

interface MockTerms {
  monthlyPrice: bigint;
  revShareBps: number;
}

/**
 * Deterministic, credential-free Story IP stack. Mirrors the real flow so tests and the demo can run
 * without a funded Aeneid wallet: registering yields a stable pseudo-`ipId`; minting a license accrues
 * the monthly price into the IP's (in-memory) royalty vault; claiming splits it leader/platform by
 * `revShareBps`. Clearly NOT on-chain — for continuity only.
 */
export class MockStoryIp implements StoryIpPort {
  private ipCounter = 0;
  private termsCounter = 0;
  private tokenCounter = 0;
  private readonly terms = new Map<string, MockTerms>();
  private readonly accrued = new Map<string, bigint>();

  async registerStrategyIp(): Promise<{ ipId: Hex }> {
    this.ipCounter += 1;
    // Deterministic 20-byte address derived from the counter.
    const ipId = (`0x${this.ipCounter.toString(16).padStart(40, "0")}`) as Hex;
    this.accrued.set(ipId.toLowerCase(), 0n);
    return { ipId };
  }

  async attachSubscriptionTerms(params: {
    ipId: Hex;
    monthlyPrice: bigint;
    revShareBps: number;
  }): Promise<{ licenseTermsId: bigint }> {
    if (params.revShareBps < 0 || params.revShareBps > BPS_DENOMINATOR) {
      throw new StoryIpError(`revShareBps out of range: ${params.revShareBps}`);
    }
    this.termsCounter += 1;
    this.terms.set(params.ipId.toLowerCase(), {
      monthlyPrice: params.monthlyPrice,
      revShareBps: params.revShareBps,
    });
    return { licenseTermsId: BigInt(this.termsCounter) };
  }

  async mintLicense(params: {
    ipId: Hex;
    licenseTermsId: bigint;
    receiver: Hex;
    maxFee?: bigint;
  }): Promise<{ licenseTokenId: bigint }> {
    const key = params.ipId.toLowerCase();
    const terms = this.terms.get(key);
    if (!terms) throw new StoryIpError(`no terms attached for ${params.ipId}`);
    if (params.maxFee !== undefined && terms.monthlyPrice > params.maxFee) {
      throw new StoryIpError(`minting fee ${terms.monthlyPrice} exceeds maxFee ${params.maxFee}`);
    }
    // Minting pays the fee into the royalty vault.
    this.accrued.set(key, (this.accrued.get(key) ?? 0n) + terms.monthlyPrice);
    this.tokenCounter += 1;
    return { licenseTokenId: BigInt(this.tokenCounter) };
  }

  async claimRevenue(params: { ipId: Hex }): Promise<{ leaderAmount: bigint; platformAmount: bigint }> {
    const key = params.ipId.toLowerCase();
    const terms = this.terms.get(key);
    if (!terms) throw new StoryIpError(`no terms attached for ${params.ipId}`);
    const total = this.accrued.get(key) ?? 0n;
    this.accrued.set(key, 0n);
    // Mirrors RealStoryIp: full claim attributed to the leader; the platform's 15% settles in
    // SubscriptionRegistry, and royalty-token allocation to the treasury is deferred (doc 94).
    return { leaderAmount: total, platformAmount: 0n };
  }
}

import type { Hex } from "viem";

/**
 * The Story IP boundary Sigmax depends on. One interface, two implementations:
 * - `RealStoryIp` — wraps @story-protocol/core-sdk (register IP, attach PIL, mint license, claim royalty).
 * - `MockStoryIp` — deterministic, no creds; lets tests/demo exercise the full flow without a funded wallet.
 *
 * Wrapping the SDK here means version churn touches one file (doc 02 §3 / doc cdr-story/21).
 *
 * Model (doc 82 §D1, doc 21): the strategy is registered as a Story IP Asset (its `ipId` is the
 * ERC-6551 address used everywhere as `strategyId`). A PIL commercial-use term is attached with the
 * monthly price as the minting fee. Minting a license token IS a subscription/operator grant and pays
 * the fee into the IP's Royalty Vault; `claimRevenue` claims the accrued royalties.
 *
 * IMPORTANT — where the 85/15 split lives: the platform's revenue cut is settled on-chain by
 * `SubscriptionRegistry` (the locked source of truth, doc 82 §D1), NOT here. `revShareBps` maps to the
 * PIL `commercialRevShare` (the licensor/derivative revenue share) and is independent of that cut.
 * `claimRevenue` therefore attributes the full claim to the leader; allocating royalty tokens to a
 * platform treasury (doc 21 approach a) is the deferred "proper IP" path (doc 94).
 */
export interface StoryIpPort {
  /** Register the strategy as a Story IP Asset. Returns the stable `ipId` (ERC-6551 address). */
  registerStrategyIp(params?: { metadataUri?: string; metadataHash?: Hex }): Promise<{ ipId: Hex }>;

  /** Attach PIL commercial terms: `monthlyPrice` as minting fee, `revShareBps` as PIL commercialRevShare. */
  attachSubscriptionTerms(params: {
    ipId: Hex;
    monthlyPrice: bigint;
    revShareBps: number;
  }): Promise<{ licenseTermsId: bigint }>;

  /**
   * Mint one license token for `receiver` (operator grant or follower subscription). Pays the terms'
   * minting fee. `maxFee` caps what the caller will pay (defends against a repriced/replaced term);
   * omit only when the fee is known to be 0.
   */
  mintLicense(params: {
    ipId: Hex;
    licenseTermsId: bigint;
    receiver: Hex;
    maxFee?: bigint;
  }): Promise<{ licenseTokenId: bigint }>;

  /** Claim accrued royalties for the IP (attributed to the leader; platform cut settles in the registry). */
  claimRevenue(params: { ipId: Hex }): Promise<{ leaderAmount: bigint; platformAmount: bigint }>;
}

export class StoryIpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryIpError";
  }
}

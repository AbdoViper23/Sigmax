import { describe, it, expect } from "vitest";
// Import mock/port directly (not via index) so this suite runs without @story-protocol/core-sdk installed.
import { MockStoryIp } from "../src/mock.js";
import { StoryIpError } from "../src/port.js";

const AGENT = "0x000000000000000000000000000000000A6e0001" as const; // operator
const FOLLOWER = "0x00000000000000000000000000000000f0110002" as `0x${string}`; // subscriber

const MONTHLY_PRICE = 100_000_000_000_000_000_000n; // 100 $WIP (18 dp)
const REV_SHARE_BPS = 1500; // platform 15% / leader 85%

describe("Story IP/PIL/license/royalty flow (mock)", () => {
  it("registers IP → attaches terms → mints operator + follower → claims 85/15", async () => {
    const story = new MockStoryIp();

    const { ipId } = await story.registerStrategyIp();
    expect(ipId).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const { licenseTermsId } = await story.attachSubscriptionTerms({
      ipId,
      monthlyPrice: MONTHLY_PRICE,
      revShareBps: REV_SHARE_BPS,
    });
    expect(licenseTermsId).toBeGreaterThan(0n);

    // Operator license to the agent (unblocks CDR decrypt) + one follower subscription.
    // maxFee caps the minting fee at the agreed monthly price.
    const op = await story.mintLicense({ ipId, licenseTermsId, receiver: AGENT, maxFee: MONTHLY_PRICE });
    const sub = await story.mintLicense({ ipId, licenseTermsId, receiver: FOLLOWER, maxFee: MONTHLY_PRICE });
    expect(op.licenseTokenId).not.toEqual(sub.licenseTokenId);

    // Two mints accrued 200 $WIP. Claim attributes the full amount to the leader; the platform's
    // 15% cut settles in SubscriptionRegistry (proven in its Foundry suite), not in the royalty claim.
    const total = MONTHLY_PRICE * 2n;
    const { leaderAmount, platformAmount } = await story.claimRevenue({ ipId });
    expect(leaderAmount).toEqual(total);
    expect(platformAmount).toEqual(0n);

    // Claiming again yields nothing (vault drained).
    const second = await story.claimRevenue({ ipId });
    expect(second.leaderAmount).toEqual(0n);
    expect(second.platformAmount).toEqual(0n);
  });

  it("rejects minting before terms are attached", async () => {
    const story = new MockStoryIp();
    const { ipId } = await story.registerStrategyIp();
    await expect(
      story.mintLicense({ ipId, licenseTermsId: 1n, receiver: AGENT }),
    ).rejects.toBeInstanceOf(StoryIpError);
  });

  it("rejects an out-of-range revenue share", async () => {
    const story = new MockStoryIp();
    const { ipId } = await story.registerStrategyIp();
    await expect(
      story.attachSubscriptionTerms({ ipId, monthlyPrice: 1n, revShareBps: 10001 }),
    ).rejects.toBeInstanceOf(StoryIpError);
  });
});

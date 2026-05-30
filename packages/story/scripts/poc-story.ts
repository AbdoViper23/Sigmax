/**
 * PoC — Story IP lifecycle: register strategy IP → attach PIL terms → mint operator license
 * (+ optional follower license & revenue claim).
 *
 * Live (real Aeneid) when these env vars are set:
 *   STORY_IP_KEY            funded Aeneid wallet (the leader); pays gas + $WIP minting fees
 *   AGENT_ADDRESS           address the operator license is minted to (the agent)
 * Optional:
 *   STORY_RPC_URL, SPG_NFT_CONTRACT, WIP_ADDRESS, MONTHLY_PRICE_WIP (default "1"),
 *   REV_SHARE_BPS (default 1500 = 15%), FOLLOWER_ADDRESS (mint a follower license + claim)
 *
 * Prints ipId + operatorLicenseTokenId — feed these into the CDR-live step
 * (STRATEGY_IP_ID + OPERATOR_LICENSE_TOKEN_ID) to close the Day-1 round-trip.
 * Otherwise runs the deterministic MockStoryIp path.
 */
import { parseEther, type Hex } from "viem";
import { MockStoryIp, RealStoryIp, type StoryIpPort } from "../src/index.js";

async function main() {
  const live = Boolean(process.env.STORY_IP_KEY && process.env.AGENT_ADDRESS);
  const revShareBps = Number(process.env.REV_SHARE_BPS ?? 1500);
  const monthlyPrice = parseEther(process.env.MONTHLY_PRICE_WIP ?? "1");
  const agent = (process.env.AGENT_ADDRESS ?? "0x000000000000000000000000000000000A6e0001") as Hex;
  const follower = process.env.FOLLOWER_ADDRESS as Hex | undefined;

  let story: StoryIpPort;
  if (live) {
    console.log("▶ LIVE Story IP on Aeneid");
    story = new RealStoryIp({
      privateKey: process.env.STORY_IP_KEY as Hex,
      rpcUrl: process.env.STORY_RPC_URL,
      spgNftContract: process.env.SPG_NFT_CONTRACT as Hex | undefined,
      currency: process.env.WIP_ADDRESS as Hex | undefined,
    });
  } else {
    console.log("▶ MOCK Story IP (no creds). To run live set: STORY_IP_KEY, AGENT_ADDRESS");
    story = new MockStoryIp();
  }

  const { ipId } = await story.registerStrategyIp();
  console.log(`ipId=${ipId}`);

  const { licenseTermsId } = await story.attachSubscriptionTerms({ ipId, monthlyPrice, revShareBps });
  console.log(`licenseTermsId=${licenseTermsId}  (mintingFee=${monthlyPrice} wei, revShare=${revShareBps}bps)`);

  const { licenseTokenId } = await story.mintLicense({ ipId, licenseTermsId, receiver: agent, maxFee: monthlyPrice });
  console.log(`OPERATOR_LICENSE_TOKEN_ID=${licenseTokenId}  (minted to agent ${agent})`);

  if (follower) {
    const sub = await story.mintLicense({ ipId, licenseTermsId, receiver: follower, maxFee: monthlyPrice });
    console.log(`followerLicenseTokenId=${sub.licenseTokenId}  (minted to ${follower})`);
    const { leaderAmount, platformAmount } = await story.claimRevenue({ ipId });
    console.log(`claimed: leader=${leaderAmount}  platform=${platformAmount}`);
  }

  console.log("\nNext → CDR live:");
  console.log(`  STRATEGY_IP_ID=${ipId}`);
  console.log(`  OPERATOR_LICENSE_TOKEN_ID=${licenseTokenId}`);
  console.log("PoC (story) done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

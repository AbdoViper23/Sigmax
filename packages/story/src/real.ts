import { http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  StoryClient,
  type StoryConfig,
  PILFlavor,
  WIP_TOKEN_ADDRESS,
} from "@story-protocol/core-sdk";
import { STORY_AENEID_ADDRESSES } from "@sigmax/shared";
import { type StoryIpPort, StoryIpError } from "./port.js";

export interface RealStoryIpConfig {
  privateKey: Hex; // funded Aeneid wallet (the leader); pays gas + minting fees in $WIP
  rpcUrl?: string; // Story RPC (default Aeneid public via SDK)
  chainId?: StoryConfig["chainId"]; // default "aeneid"
  spgNftContract?: Hex; // SPG collection used to mint the IP-backing NFT (default public Aeneid)
  currency?: Hex; // PIL payment currency (default $WIP)
}

const BPS_DENOMINATOR = 10000;

/**
 * Wraps @story-protocol/core-sdk for the strategy-IP lifecycle: register IP → attach PIL commercial
 * terms (minting fee = monthly price, revenue share = platform cut) → mint license (operator/follower)
 * → claim royalties. Method shapes follow the TypeScript SDK docs (register-ip-asset, attach-terms,
 * mint-license, claim-revenue); confirm the installed version's types — tracked in doc 94.
 *
 * Note: the on-chain 85/15 revenue split that the demo *settles* lives in `SubscriptionRegistry`
 * (the locked source of truth, doc 82 §D1). Here `claimRevenue` claims the IP's accrued minting-fee
 * royalties to the leader; allocating royalty tokens to the platform treasury (doc 21 approach a) is
 * the deferred "proper IP" path and is noted in doc 94.
 */
export class RealStoryIp implements StoryIpPort {
  private readonly client: StoryClient;
  private readonly cfg: Required<Pick<RealStoryIpConfig, "spgNftContract" | "currency">> & {
    leader: Hex;
  };

  constructor(cfg: RealStoryIpConfig) {
    const account = privateKeyToAccount(cfg.privateKey);
    const config: StoryConfig = {
      account,
      transport: http(cfg.rpcUrl),
      chainId: cfg.chainId ?? "aeneid",
    };
    this.client = StoryClient.newClient(config);
    this.cfg = {
      spgNftContract: cfg.spgNftContract ?? (STORY_AENEID_ADDRESSES.spgNftDefault as Hex),
      currency: cfg.currency ?? (WIP_TOKEN_ADDRESS as Hex),
      leader: account.address,
    };
  }

  async registerStrategyIp(params?: { metadataUri?: string; metadataHash?: Hex }): Promise<{ ipId: Hex }> {
    const res = await this.client.ipAsset.registerIpAsset({
      nft: { type: "mint", spgNftContract: this.cfg.spgNftContract },
      ...(params?.metadataUri
        ? {
            ipMetadata: {
              ipMetadataURI: params.metadataUri,
              ipMetadataHash: params.metadataHash,
            },
          }
        : {}),
    });
    if (!res.ipId) throw new StoryIpError("registerIpAsset returned no ipId");
    return { ipId: res.ipId as Hex };
  }

  async attachSubscriptionTerms(params: {
    ipId: Hex;
    monthlyPrice: bigint;
    revShareBps: number;
  }): Promise<{ licenseTermsId: bigint }> {
    if (params.revShareBps < 0 || params.revShareBps > BPS_DENOMINATOR) {
      throw new StoryIpError(`revShareBps out of range: ${params.revShareBps}`);
    }
    // SDK's commercialRevShare is a whole-number percentage (e.g. 15 = 15%); bps must be a multiple of 100.
    if (params.revShareBps % 100 !== 0) {
      throw new StoryIpError(`revShareBps (${params.revShareBps}) must be a whole-percent (multiple of 100)`);
    }
    const commercialRevShare = params.revShareBps / 100;
    const terms = await this.client.license.registerPILTerms(
      PILFlavor.commercialRemix({
        commercialRevShare,
        defaultMintingFee: params.monthlyPrice,
        currency: this.cfg.currency,
      }),
    );
    if (terms.licenseTermsId === undefined) throw new StoryIpError("registerPILTerms returned no licenseTermsId");
    const licenseTermsId = terms.licenseTermsId;
    await this.client.license.attachLicenseTerms({ ipId: params.ipId, licenseTermsId });
    return { licenseTermsId };
  }

  async mintLicense(params: {
    ipId: Hex;
    licenseTermsId: bigint;
    receiver: Hex;
    maxFee?: bigint;
  }): Promise<{ licenseTokenId: bigint }> {
    const res = await this.client.license.mintLicenseTokens({
      licensorIpId: params.ipId,
      licenseTermsId: params.licenseTermsId,
      receiver: params.receiver,
      amount: 1,
      // Cap what the caller pays at the agreed fee; 0n means "no cap" so only pass it when fee is known 0.
      maxMintingFee: params.maxFee ?? 0n,
      maxRevenueShare: 100,
    });
    const id = res.licenseTokenIds?.[0];
    if (id === undefined) throw new StoryIpError("mintLicenseTokens returned no token id");
    return { licenseTokenId: BigInt(id) };
  }

  async claimRevenue(params: { ipId: Hex }): Promise<{ leaderAmount: bigint; platformAmount: bigint }> {
    const res = await this.client.royalty.claimAllRevenue({
      ancestorIpId: params.ipId,
      claimer: this.cfg.leader,
      currencyTokens: [this.cfg.currency],
      childIpIds: [],
      royaltyPolicies: [],
      claimOptions: {
        autoTransferAllClaimedTokensFromIp: true,
        autoUnwrapIpTokens: false,
      },
    });
    const claimed = res.claimedTokens?.[0]?.amount ?? 0n;
    // Platform-cut via royalty-token allocation is deferred (doc 94); full claim attributed to leader.
    return { leaderAmount: BigInt(claimed), platformAmount: 0n };
  }
}

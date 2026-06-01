import { useCallback, useState } from "react";
import { http, parseUnits, type Hex } from "viem";
import { usePublicClient, useWalletClient, useWriteContract } from "wagmi";
import { StoryClient, PILFlavor, WIP_TOKEN_ADDRESS } from "@story-protocol/core-sdk";
import { STORY_AENEID_ADDRESSES } from "@sigmax/shared";
import { env } from "@/lib/env";
import { SUBSCRIPTION_REGISTRY_ABI } from "@/lib/abis";

const WIP_DECIMALS = 18;
const STORY = env.storyChainId;

export type RegisterStep =
  | "idle"
  | "registering-ip"
  | "attaching-terms"
  | "minting-license"
  | "creating-plan"
  | "done";

export interface RegisterLeaderInput {
  username: string;
  displayName: string;
  monthlyPriceWip: string;
}

export interface RegisterLeaderResult {
  ipId: Hex;
  licenseTermsId: string;
  licenseTokenId: string;
}

/**
 * Self-serve leader registration, fully on-chain from the connected wallet (WS4):
 *   1. register a Story IP Asset (the strategy id)
 *   2. attach minimal PIL terms (fee 0 / revShare 0 — the license is only the CDR access token;
 *      subscription payment is handled by SubscriptionRegistry, not Story royalties)
 *   3. mint one license token to the AGENT so it can decrypt this leader's CDR signals
 *   4. createPlan(ipId, WIP, price, feeBps, username, displayName) on SubscriptionRegistry
 *
 * The Story SDK runs in the browser via `newClientUseWallet` with the wagmi wallet client.
 */
export function useRegisterLeader() {
  const { data: walletClient } = useWalletClient({ chainId: STORY });
  const pub = usePublicClient({ chainId: STORY });
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState<RegisterStep>("idle");
  const [error, setError] = useState<string | null>(null);

  const register = useCallback(
    async (input: RegisterLeaderInput): Promise<RegisterLeaderResult> => {
      if (!walletClient) throw new Error("Connect a wallet on Story Aeneid first");
      if (!pub || !env.registryAddress) throw new Error("Registry not configured");
      if (!env.agentAddress) throw new Error("Agent address not configured");
      setError(null);

      try {
        const story = StoryClient.newClientUseWallet({
          wallet: walletClient,
          transport: http(env.storyRpcUrl),
          chainId: "aeneid",
        });

        // 1. Register the strategy's IP asset (mints the backing NFT via the default SPG collection).
        setStep("registering-ip");
        const reg = await story.ipAsset.registerIpAsset({
          nft: { type: "mint", spgNftContract: STORY_AENEID_ADDRESSES.spgNftDefault as Hex },
        });
        const ipId = reg.ipId as Hex;
        if (!ipId) throw new Error("registerIpAsset returned no ipId");

        // 2. Minimal PIL terms, then attach. Fee/revShare are 0 — the token is purely the CDR gate.
        setStep("attaching-terms");
        const terms = await story.license.registerPILTerms(
          PILFlavor.commercialRemix({
            commercialRevShare: 0,
            defaultMintingFee: 0n,
            currency: WIP_TOKEN_ADDRESS,
          }),
        );
        const licenseTermsId = terms.licenseTermsId;
        if (licenseTermsId === undefined) throw new Error("registerPILTerms returned no id");
        await story.license.attachLicenseTerms({ ipId, licenseTermsId });

        // 3. Mint the operator license to the agent so it can decrypt this leader's signals.
        setStep("minting-license");
        const mint = await story.license.mintLicenseTokens({
          licensorIpId: ipId,
          licenseTermsId,
          receiver: env.agentAddress,
          amount: 1,
          maxMintingFee: 0n,
          maxRevenueShare: 100,
        });
        const licenseTokenId = mint.licenseTokenIds?.[0];
        if (licenseTokenId === undefined) throw new Error("mintLicenseTokens returned no token id");

        // 4. Create the subscription plan on Story (username/displayName emitted in PlanCreated).
        setStep("creating-plan");
        const price = parseUnits(input.monthlyPriceWip as `${number}`, WIP_DECIMALS);
        const hash = await writeContractAsync({
          address: env.registryAddress,
          abi: SUBSCRIPTION_REGISTRY_ABI,
          functionName: "createPlan",
          args: [ipId, env.wip, price, env.platformFeeBps, input.username, input.displayName],
          chainId: STORY,
        });
        await pub.waitForTransactionReceipt({ hash });

        setStep("done");
        return {
          ipId,
          licenseTermsId: licenseTermsId.toString(),
          licenseTokenId: licenseTokenId.toString(),
        };
      } catch (err) {
        setStep("idle");
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      }
    },
    [walletClient, pub, writeContractAsync],
  );

  return { register, step, error };
}

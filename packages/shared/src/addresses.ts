import type { Hex } from "viem";

/** Story Aeneid (chain 1315) — all verified on-chain 2026-05-30 (doc 82 §2). */
export const STORY_AENEID_ADDRESSES = {
  wip: "0x1514000000000000000000000000000000000000",
  ipAssetRegistry: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  licensingModule: "0x04fbd8a2e56dd85CFD5500A4A4DfA955B9f1dE6f",
  pilTemplate: "0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316",
  royaltyModule: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
  licenseToken: "0xFe3838BFb30B34170F00030B52eA4893d8aAC6bC",
  // CDR access-condition contracts (Option A — reuse, zero new Solidity)
  ownerWriteCondition: "0x4C9bFC96d7092b590D497A191826C3dA2277c34B",
  licenseReadCondition: "0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3",
  // Public SPG NFT collection for minting IP-backing NFTs on Aeneid (Story docs, register-ip-asset).
  spgNftDefault: "0xc32A8a0FF3beDDDa58393d022aF433e78739FAbc",
} as const satisfies Record<string, Hex>;

/** Arbitrum One (chain 42161) — whitelisted spot tokens for the demo. */
export const ARBITRUM_ADDRESSES = {
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // native USDC
  weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
} as const satisfies Record<string, Hex>;

/**
 * Flare Coston2 (chain 114) — all confirmed on-chain 2026-07-23 / 2026-08-08
 * (docs/flare/reference/phase-0-findings.md). Per-deployment addresses (our own contracts) are NOT
 * here; they come from env so a redeploy never needs a code change.
 */
export const COSTON2_ADDRESSES = {
  fxrp: "0x0b6A3645c240605887a5532109323A3E12273dc7", // FTestXRP, 6 decimals
  /**
   * testUSD (6 decimals) — the quote leg of the FXRP pool we seeded, and the subscription pay token.
   * Coston2 has no real stablecoin, and this one exposes a public `mint()`, which is what makes a
   * self-serve demo possible. Fixed for this testnet, so it belongs here rather than in env.
   */
  testUsd: "0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73",
  assetManagerFxrp: "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA",
  contractRegistry: "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019",
  ftsoV2: "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d",
  blazeSwapRouter: "0x8D29b61C41CF318d15d031BE2928F79630e068e6",
  blazeSwapFactory: "0xF0f5e4CdE15b22A423E995415f373FEDC1f8F431",
  /** FCC diamond (redeployed 2026-07-22; the pre-redeploy 0x004224fa… is dead). */
  flareTeeManager: "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE",
} as const satisfies Record<string, Hex>;

/** FTSO feed ids (bytes21). XRP/USD bounds `minOut` for FXRP swaps. */
export const FTSO_FEED_IDS = {
  xrpUsd: "0x015852502f55534400000000000000000000000000",
} as const;

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

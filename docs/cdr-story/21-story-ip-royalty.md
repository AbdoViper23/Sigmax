# 21 — Story IP, Licensing & Royalty (the revenue engine)

> How a leader's strategy becomes licensable IP, how a subscription is sold, and how subscription
> revenue auto-splits between the leader and the platform — all using Story's native primitives.
> Pairs with `contracts/12-subscription-registry.md` (monthly expiry) and `business/90-business-model.md`.

> ⚠️ VERIFY `@story-protocol/core-sdk` version and method names against the installed package before
> relying on signatures here (`94-risks-and-unknowns.md`).

---

## 1. Why use Story's IP stack at all

We could split payments with a plain contract (and the MVP can — see `contracts/12 §6`). But Story's
native stack gives us, for free: a standard **licensable IP** object, **transferable license NFTs**,
and an **automatic, permissionless royalty split**. It's also exactly what the CDR hackathon judges
want to see composed, and it makes the leader's strategy a real, tradable asset. So: model the
strategy as IP, the subscription as a license, and revenue via the Royalty Vault.

## 2. The primitives (what each piece is)

- **IP Asset** — an ERC-721 NFT registered in Story's IP Asset Registry; registering also deploys an
  ERC-6551 **IP Account** whose address is the **`ipId`** (this is the `ipId` you encode into the
  CDR read condition in `contracts/11`).
- **PIL (Programmable IP License)** — standardized license terms attached to the IP. Relevant terms:
  `defaultMintingFee` (price to mint a license), `commercialUse`, `commercialRevShare` (the % of
  derivative/related revenue routed upward), `currency` (the payment token, `$WIP`), `expiration`.
- **License Token** — an ERC-721 minted against the IP under chosen PIL terms. **This is the
  "subscription"** in Option A (`contracts/11`). Can be transferable or not.
- **Royalty Module + IP Royalty Vault** — every commercialized IP has a Royalty Vault with exactly
  **100 Royalty Tokens** (each = 1% of revenue flowing into that vault). Pay in via
  `payRoyaltyOnBehalf`; claim out (permissionlessly) via `claimAllRevenue`. Royalty Tokens are
  ERC-20 and transferable/sellable — this is how we take a platform fee (we hold a slice).

## 3. Setup flow (leader onboarding)

```ts
import { StoryClient } from "@story-protocol/core-sdk";
// 1) register the strategy as an IP Asset (mint + register in one call)
const { ipId } = await story.ipAsset.mintAndRegisterIp({
  spgNftContract: SPG_NFT_CONTRACT,          // public Aeneid test collection exists; deploy your own for prod
  ipMetadata: { ipMetadataURI, ipMetadataHash, nftMetadataURI, nftMetadataHash },
});

// 2) attach PIL commercial terms: price = monthly sub fee, revShare = platform/upward cut
const { licenseTermsId } = await story.license.registerPilTermsAndAttach({
  ipId,
  terms: pilCommercialUse({
    defaultMintingFee: parseEther("MONTHLY_PRICE_IN_WIP"),
    currency: WIP_TOKEN_ADDRESS,
    commercialRevShare: PLATFORM_REVSHARE_PERCENT,  // e.g. 15
  }),
});
```
`ipId` is now the value used in the CDR read condition (`contracts/11`), tying decryption to holding
a license for this exact strategy.

## 4. Subscription = mint a License Token (follower side)

```ts
const { licenseTokenIds } = await story.license.mintLicenseTokens({
  licensorIpId: ipId,
  licenseTermsId,
  amount: 1,
  receiver: followerAddress,
  maxMintingFee: parseEther("MONTHLY_PRICE_IN_WIP"),   // pays into the IP Royalty Vault
});
```
This **pays the minting fee in `$WIP`** (which lands in the strategy's Royalty Vault) and gives the
follower a license token. In Option A this token is what the read condition checks. To make it
**monthly**, either set PIL `expiration` to 30 days and re-mint monthly, or pair it with the
`SubscriptionRegistry` (Option B) for clean expiry without re-minting (recommended — see `contracts/12`).

## 5. Revenue split (the platform fee, done natively)

Two equivalent ways to take the platform's cut:

**(a) Royalty-Token split (simplest to reason about):**
At IP setup, transfer N of the 100 Royalty Tokens to the **platform treasury** (e.g. 15 → 15%).
Now every `$WIP` paid into the Royalty Vault is claimable proportionally: the leader claims 85%, the
platform claims 15% — both via `claimAllRevenue`, permissionlessly.
```ts
// platform (or anyone) triggers distribution; funds go to Royalty Token holders pro-rata
await story.royalty.claimAllRevenue({
  ancestorIpId: ipId,
  currencyTokens: [WIP_TOKEN_ADDRESS],
  // claimer = whoever holds royalty tokens
});
```

**(b) Platform-as-parent (revShare upward):**
Model the platform as a parent IP and set `commercialRevShare` so a cut flows to the platform IP's
vault automatically. More "Story-idiomatic" but more setup; use later.

> For the MVP, **(a)** is clearest: split the 100 Royalty Tokens at onboarding (e.g. 85 leader / 15
> platform), and everyone claims from the vault. No custom money code.

## 6. How payment, subscription, and decryption connect

```
Follower ──mintLicenseTokens (pays $WIP)──► IP Royalty Vault ──claimAllRevenue──► Leader (85) + Platform (15)
        │
        └─ holds License Token ──► satisfies CDR LicenseReadCondition ──► agent allowed to decrypt for them
                                   AND/OR writes expiry into SubscriptionRegistry (monthly) ─► agent executes for them
```

- **Decryption gate:** license ownership (Option A) — `contracts/11`.
- **Execution eligibility (monthly):** `SubscriptionRegistry.isActive` — `contracts/12`.
- **Money:** flows through the Royalty Vault; platform fee = a slice of the 100 Royalty Tokens.

## 7. `$WIP` and tokens
- `$WIP` is the wrapped IP token used as the PIL `currency` / royalty payment token on Story.
- Followers need `$WIP` to subscribe; the web app should offer a wrap step (IP → $WIP) in the
  subscribe flow. (Confirm the current $WIP address per network from Story docs at build time.)

## 8. The verifiable track record (a product feature this enables)
Because each signal is a CDR vault committed **before** the outcome, and each resulting trade is an
on-chain swap in the follower vaults, you can compute a **tamper-proof performance history** per
strategy IP. Surface it on the leaderboard (`frontend/60`). This is the "can't fake your record"
half of the value prop (`00-overview §2`). Store derived stats in Supabase for display, but the
**source of truth is on-chain** (signal timestamps + swap events).

## 9. MVP vs defer
- **MVP:** register IP + attach PIL + mint license as the subscription + split 100 Royalty Tokens
  (85/15) + `claimAllRevenue`. Optionally skip the Royalty Vault entirely and use the direct split
  in `SubscriptionRegistry` (`contracts/12 §6`) if Story royalty wiring eats too much time — but the
  Royalty path is the stronger hackathon story.
- **Defer:** platform-as-parent revShare, transferable/secondary-market license dynamics, royalty-
  token sale to investors, multi-tier PILs.

## 10. Acceptance
- ✅ register a strategy IP; get a stable `ipId` (ERC-6551 address)
- ✅ attach PIL with `defaultMintingFee` + `commercialRevShare` + `$WIP` currency
- ✅ follower mints a license (pays `$WIP`); funds land in the Royalty Vault
- ✅ platform holds 15 Royalty Tokens; `claimAllRevenue` pays leader 85% / platform 15%
- ✅ the minted license satisfies the CDR `LicenseReadCondition` for that `ipId` (integration with `20`)
- ✅ leaderboard reads on-chain signal timestamps + swap events to show a verifiable record

→ Next: `22-signal-template.md` (the exact signal schema the leader fills and the agent parses).

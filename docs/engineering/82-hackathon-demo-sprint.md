# 82 — Hackathon Demo Sprint (the ~4-day thin slice)

> **This file is NOT the product plan.** `80-mvp-scope.md` + `81-engineering-plan.md` describe the real
> product (timeline-relaxed, by design). THIS file is a separate, disposable artifact: the smallest
> demo that proves the thesis for the **CDR Hackathon** (projects due **2026-06-03**, Demo Day **06-05**;
> re-confirm on build.usecdr.dev — `94 V10`). Today is **2026-05-30** → ~4 working days.
>
> Rule of this doc: **prove the thesis, fake everything else, and be honest about what's faked.**
> When demo-scope and product-scope disagree, demo-scope wins *here only*; the product docs stay as-is.

---

## 0. The thesis the demo must prove (and nothing more)

```
Leader publishes an ENCRYPTED spot signal on Story (Aeneid, real chain)
  → agent decrypts it privately (CDR, validator SGX)
  → checks the follower paid
  → executes a real spot swap inside the follower's own non-custodial vault (forked Arbitrum)
  → monitors a secret exit (TP/SL) and sells
  → follower sees a RESULT, never the strategy
  → click "Revoke" → agent can no longer trade
```
If a stranger watches this run once, the demo is done. **One leader, one follower, one signal, one exit.**

---

## 1. Locked decisions (baked in — do not re-litigate during the sprint)

These close the three real seams flagged in review (`#4 who-decrypts`, `#7 registry location`, `#1 TEE`)
and the `#6 verifiable-record` point. All four are decided for the demo:

| # | Decision | Why |
|---|---|---|
| **D1 — Decryption gate ≠ eligibility gate (two separate mechanisms)** | **Decrypt gate** = Option A `LicenseReadCondition`; the **agent holds an *operator* License Token** for the strategy `ipId` (minted once to the agent at onboarding). It gates *"is this the operator?"* — that's enough, because confidentiality holds (only the agent ever decrypts). **Eligibility gate** = the agent reads `SubscriptionRegistry.isActive(follower, strategyId)` **in software** before each swap. | Verified: `LicenseReadCondition` checks license ownership for an `ipId`, nothing per-follower. So `registry.isActive(agent,…)` (the reverting path in `11 §5`) is **deleted** — the registry is keyed on the *follower*, read by the agent. Per-follower eligibility is relayer-trust in MVP (not a confidentiality hole) → on-chain guard in v2. |
| **D2 — `SubscriptionRegistry` lives on Story L1** | Resolves the `01 §2` vs `03 §2` vs `42` contradiction. | Keeps Rule 4 intact (Story holds subscription + revenue) and keeps the Option-B on-chain `SubscriptionReadCondition` path open (a Story-side condition can only read a Story-side registry). |
| **D3 — Plain daemon, narrative = "TEE-ready", not "TEE-secured"** | Agent runs as a Dockerized daemon (no plaintext in logs/state). No Phala TDX in the demo. | A real attested enclave solo in 4 days is the wrong bet. The **confidential layer the hackathon cares about (CDR threshold-decryption inside validator SGX) is real and free** by using CDR. Say exactly that; don't claim operator-blindness we haven't shipped. |
| **D4 — Verifiable record = the on-chain CDR publish tx on Aeneid** | The commit-before-outcome proof is the timestamped `uploadCDR` tx (real public chain). Demo PnL is computed from forked execution and **labeled "demo PnL (forked)"**. | The commit is genuinely verifiable; only PnL-from-real-trades is eroded by the fork (mainnet would put trades on a real public L2). Honest and still compelling. |

---

## 2. Verified facts to code against (no need to re-verify — confirmed 2026-05-30)

| Thing | Value | 
|---|---|
| `@piplabs/cdr-sdk` | **0.2.1** (latest). `uploadCDR`/`accessCDR` exist as convenience over allocate/write. |
| `@story-protocol/core-sdk` | **1.4.4**. Use `client.license.registerPILTerms(PILFlavor.commercialRemix({commercialRevShare, defaultMintingFee, currency}))` + `client.license.attachLicenseTerms({licenseTermsId, ipId})` (no combined `registerPilTermsAndAttach`). Revenue: `client.royalty.claimAllRevenue({ancestorIpId, claimer, currencyTokens, …})` (permissionless, **manual** tx — not auto). |
| Story Aeneid | chain id **1315**, RPC `https://aeneid.storyrpc.io`, explorer `https://aeneid.storyscan.io` |
| `OwnerWriteCondition` (Aeneid) | `0x4C9bFC96d7092b590D497A191826C3dA2277c34B` ✅ |
| `LicenseReadCondition` (Aeneid) | `0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3` ✅ |
| `LicenseToken` (Aeneid) | `0xFe3838BFb30B34170F00030B52eA4893d8aAC6bC` |
| `$WIP` token | `0x1514000000000000000000000000000000000000` (testnet + mainnet) |
| IP Asset Registry / Licensing / PILTemplate / RoyaltyModule | confirmed in `deployed-smart-contracts` (record exact in `addresses.ts`) |
| **CDR payload limit** | **1024 bytes** on Aeneid (`maxEncryptedDataSize`). Signal (~416 B) fits → **direct ABI encoding works**. Keep `SignalSchema` < ~1 KB. |
| 0x Swap API v2 | `GET https://api.0x.org/swap/allowance-holder/quote`; `taker` **required**; approve **`allowanceTarget` (AllowanceHolder)**, *never the Settler*. |
| CoW | live on **Arbitrum AND Base** (so chain choice is no longer forced by CoW; out of demo scope anyway). |

Read condition encoding: `readConditionData = abi.encode(licenseTokenAddress, ipId)`, caller supplies token ids via `accessAuxData = abi.encode(uint256[] tokenIds)`. Write: `OwnerWriteCondition` with encoded owner.

---

## 3. The 4-day plan (single builder + Claude; sequential, risk-first)

### Day 1 — Scaffold + prove the two riskiest things in isolation
- Scaffold `pnpm + turborepo`: `packages/{shared,cdr,story,contracts,agent}` + `apps/web`. `.env.example`.
- `packages/shared`: `SignalSchema` (zod, closed enum ENTRY/EXIT, no leverage/short fields) + ABI encode/decode + `chains.ts` + `addresses.ts` (paste verified values from §2).
- **PoC #1 (CDR — the novel part):** `uploadCDR` → `accessCDR` round-trip on **real Aeneid**, gated by `LicenseReadCondition` + agent operator license. Recover the exact signal. Negative test: a wallet without the license **fails** to decrypt. Measure `accessCDR` latency (set `timeoutMs`).
- **PoC #2 (execution):** minimal `CopyVault.executeSwap` + a real **0x v2** quote swapping USDC→WETH inside the vault on **forked Arbitrum** (`anvil --fork-url`). **This resolves "does 0x quote execute on a fork?"** — if 0x rejects fork state, fall back to a direct Uniswap v3 `exactInputSingle` router call.
- **Gate:** both PoCs green → the rest is integration. If PoC #1 blocks → switch to the mock-CDR fallback (§5) so the demo survives.

### Day 2 — Finish contracts + Story integration
- `CopyVault` + `CopyVaultFactory` (`contracts/10`): deposit, `executeSwap` (token+router whitelist, `perTradeCap`, on-chain `minOut` via balance-delta, `forceApprove`→reset-0, `nonReentrant`), `withdraw` onlyOwner, `setExecutor` revoke, `pause`. **Foundry tests for the demo-critical paths only:** whitelist, cap, withdraw-only-owner, revoked-executor-cannot-swap, minOut. (Deeper abuse tests → backlog §6.)
- `SubscriptionRegistry` **on Story** (`contracts/12`): `subscribe`, `isActive(follower, strategyId)` (+grace).
- `packages/story`: register strategy IP, `registerPILTerms`(commercialRemix: fee=$WIP price, revShare=platform) + `attachLicenseTerms`, mint **follower** license, mint **operator** license to the agent (D1).

### Day 3 — The agent loop (joins the tracks)
- `packages/agent`: watch Story for a new signal → `accessCDR` decrypt **inside the daemon, no plaintext logs/state** → read `isActive(follower)` → 0x quote (`minOut`) → `CopyVault.executeSwap` on the fork. Idempotent by `signalId` (no double-execute on restart).
- TP/SL monitor: poll a price (mock or 0x indicative / Chainlink if the pair has a feed) → exit swap when crossed. Persist only non-secret position metadata; **re-derive TP/SL by re-reading the CDR vault on boot** (no plaintext at rest — D3-consistent).
- **Gate:** published ENTRY → detected → decrypted → executed into the follower vault → TP/SL exit fires. Redaction test: grep logs/state for any signal/TP/SL value → none.

### Day 4 — Minimal frontend + demo hardening
- Next.js + wagmi/viem/RainbowKit, **two chains** (Aeneid 1315 + a forked-Arbitrum RPC) with network-switch prompts.
  - Leader: publish form (1 template, **client-side encrypt** via cdr-sdk).
  - Follower: subscribe (mint license on Story) → `createVault` one-tx (whitelist+caps+executor) → deposit USDC → positions view (**results only**, no pending exit target) → **Revoke** button.
  - "Verifiable record" panel = link to the Story `uploadCDR` tx (the D4 commit) + demo PnL labeled forked.
- Wire end-to-end. Run the §0 script **repeatedly** until reliable. Write a runbook (fork command, fund gas wallet, start agent). **Record the demo video** (don't rely on a live run on Demo Day).
- Reserve the back half of Day 4 as **integration-debugging buffer** — this is where time actually goes.

---

## 4. Demo script (what you show on stage)
1. Leader publishes a signal → show the encrypted vault on Aeneid (ciphertext, unreadable) + the publish tx (= the verifiable commit).
2. Agent log: detected → decrypted (privately) → follower active → swap executed (tx on forked Arbitrum).
3. Follower dashboard: position appears — **result only, no strategy**.
4. Price hits the secret TP/SL → agent exits → demo PnL shown.
5. Click **Revoke** → show the agent can no longer trade. Funds were always in the follower's vault.
6. One line of honesty: "signal confidentiality is real (CDR + validator SGX); settled swaps are public; operator-side TEE and on-chain eligibility guard are the post-hackathon hardening."

---

## 5. Pre-planned fallbacks (decide the trigger, not on the day)
- **CDR SDK misbehaves / too slow:** swap `packages/cdr` for a mock that AES-encrypts/decrypts with a gated key — keeps the *flow* demoable; note it's mocked. (Last resort; PoC #1 should prevent this.)
- **0x rejects the fork:** direct Uniswap v3 router call (already the PoC #2 fallback).
- **Price feed flaky:** mocked price ticker for the TP/SL trigger.
- **Time crunch:** pre-fund the vault and pre-mint licenses via a seed script so the live demo starts at "publish".

---

## 6. Explicitly OUT of the demo (and the must-fix backlog before mainnet)

**Out of demo (build later, per product docs):** CoW batch execution, ERC-4337/EIP-7702 session keys, Base, cross-chain messaging, multi-strategy discovery, rich charts, perf-fee, real Phala TDX TEE, audit, fan-out batching (nothing to batch at 1 follower).

**Must-fix BEFORE holding real funds (backlog — not demo blockers):**
- `executeSwap`: per-router validation that proceeds stay in the vault (0x AllowanceHolder recipient semantics); reject non-whitelisted `deposit`.
- Daily-cap rolling-window 2× boundary; `createPlan` must verify caller owns the Story IP (anti-squat); `setMonthlyPrice` front-running (max-price arg / timelock).
- `GRACE` currently widens the *decrypt* window too — separate decrypt-gate from soft-grace execution.
- Replace relayer-trust eligibility with an on-chain guard / messaging (removes D1's software trust).
- Real TEE + remote attestation consumed by something (operator-blindness).
- Aggregated trade-history leakage (the alpha is reconstructable at scale — `security/70`).
- Legal review (automated trading of others' funds; royalty-token securities framing) before scaling past the first users.

---

## 7. Acceptance (demo is "done")
- ✅ full §0 loop runs end-to-end: Aeneid (Story) + forked Arbitrum (execution)
- ✅ non-subscriber cannot decrypt; subscriber's trade executes automatically
- ✅ TP/SL exit fires; positions show results only (no secret, no pending target)
- ✅ Revoke works; funds always in the follower's vault
- ✅ no log/state/API exposes signal logic / TP / SL (redaction test passes)
- ✅ demo video recorded; runbook written; the honesty line is in the pitch

→ Product continuation after the hackathon: resume `81-engineering-plan.md` from P9 (TEE) / P11 (audit).

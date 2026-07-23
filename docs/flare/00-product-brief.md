# Sigmax on Flare — Project & Hackathon Brief

> **Purpose of this document.** This is a complete, self-contained briefing on (1) the hackathon we are entering and (2) the product we are building for it. It is meant to be read **together with the companion file** — *"Sigmax on Flare — Verified Technical Blueprint"* — which covers component availability, exact APIs/addresses, contract interfaces, the risk table, and the week-by-week build plan. This document gives the **what / why / context**; the blueprint gives the **is-it-feasible / how-technically**. A reader with both files has the full picture.

---

## 0. How to use this document

- **This file** = product vision, the problem, the solution, the architecture at a conceptual level, the hackathon rules and judging criteria, scope decisions, and the reasoning behind the choice.
- **Companion file** ("Verified Technical Blueprint") = per-component availability verdicts (available now / needs day-1 verification / not available + fallback), the exact FSA flow, TEE/attestation design, per-venue execution mechanics, Solidity interfaces, the reuse map, the risk table, and the 4-week plan.
- If anything in this brief and the blueprint appear to conflict on a technical fact, **the blueprint wins** (it is the verified source).

---

## 1. Executive summary

We are building **Sigmax on Flare**: a **non-custodial, confidential copy-trading platform** where a trader (the *leader*) publishes **encrypted** trading signals, and an agent running **inside a TEE (Trusted Execution Environment)** is the only thing that can decrypt them — and only to execute the trade on each subscriber's behalf. Subscribers copy the *result*, never the *recipe*, so the leader's edge cannot be screenshotted, forwarded, or resold. The leader's track record can still be verified.

- **Hackathon:** Flare Summer Signal (organized by Flare, hosted on DoraHacks). Submission deadline **August 14, 2026**.
- **Primary bounty:** **Bounty 2 — Confidential Compute Apps** (the confidential/TEE angle is the natural fit). A secondary framing also touches **Bounty 1 — Interoperable Asset Products** via FXRP + Flare Smart Accounts onboarding.
- **The core bet / moat:** Flare acts as the **control plane** (identity, subscriptions, permissions, revenue split, and — critically — an **XRPL-native onboarding experience via Flare Smart Accounts**), while other chains (Hyperliquid spot, EVM, etc.) remain **execution layers**. The single hardest-to-copy advantage is that an XRP holder with only an XRPL wallet (e.g. Xaman) can participate with **one XRPL signature, no EVM wallet, no gas** — which is not reproducible on Base/Solana with the same UX.
- **Reuse:** This is a **port/re-architecture of an existing project ("Sigmax")** built for a previous hackathon (Story Protocol's Confidential Data Rails). ~60–80% of the stack already exists; the new work is the Flare integration. (The hackathon explicitly allows bringing/porting existing projects if new work is clearly separated.)
- **Honest caveat:** The product is **two-sided** (needs leaders *and* followers) and the confidential/cross-chain moat is real but the "verifiable track record via FDC" is thin on mainnet today. See §12 and the blueprint's risk table.

---

## 2. The hackathon — Flare Summer Signal (full details)

**Organizer:** Flare. **Platform:** DoraHacks. **Format:** open, online/virtual hackathon. **Prize pool:** **$12,000 USD total.**

**Two bounties, $6,000 each:**

| Bounty | Theme | 1st | 2nd |
|---|---|---|---|
| **Bounty 1** | Interoperable Asset Products | $4,000 | $2,000 |
| **Bounty 2** | Confidential Compute Apps | $4,000 | $2,000 |

**Timeline:**
- **June 29, 2026** — registration + development opens
- **August 14, 2026** — final submission deadline
- **August 15–21, 2026** — judging period
- **August 24, 2026** — winner announcement

**Networks you can deploy to:** Coston2 (testnet), Songbird (canary), or Flare Mainnet.

**What you can build:** from scratch, **bring an existing project, or port an existing product to Flare.** Existing projects are explicitly welcome. Teams porting/bringing a project must clearly separate: what existed before, what was newly built during the hackathon, and what was ported/integrated/improved on Flare, and why the new work is meaningful.

**Submission requirements (each submission should include):**
- Project name
- Selected bounty/bounties
- Short product description
- Target user
- Demo link, video, or working app link
- GitHub repo / technical materials
- Explanation of how the project uses Flare
- Explanation of what was newly built, ported, integrated, or improved during the program
- Smart contract addresses / deployment details, if applicable
- Short roadmap / next steps

**Encouraged (not strictly required, but weighed):** whether deployed on Coston2/Songbird/Mainnet; how far you got with **user acquisition, distribution, testing, or real user feedback**; any early usage, community interest, pilot users, partner conversations, or traction signals. *(The judges asking about real users is a strong signal that they reward "product," not "prototype.")*

**Judging criteria (in the order Flare lists them):**
1. **Product usefulness** — does it solve a real user/developer/ecosystem/infrastructure problem?
2. **Flare integration quality** — is Flare used in a meaningful way, or is the integration superficial?
3. **Technical execution** — does the demo work? Is the architecture credible and understandable?
4. **Evidence of new work** — did the team clearly show what was newly built/ported/integrated/improved?
5. **Clarity and future potential** — can the team explain the product/user/integration/next steps clearly? Is there a credible path beyond the hackathon?

**Useful links:**
- Hackathon detail page: `https://dorahacks.io/hackathon/flaresummersignal/detail`
- Flare Hackathon Telegram: `https://t.me/+5Vn6ZKhr6KI3NjIx`
- Developer docs: `https://dev.flare.network/`

**How we intend to win it:** deep, non-superficial use of Flare primitives (FSA as load-bearing, not decoration); a working demo of the full loop; a clearly-separated "new work on Flare" story (since we're porting Sigmax); and, if possible, a few real pilot users. Primary submission target: **Bounty 2 (Confidential Compute)** — lower expected competition than Bounty 1, and it plays to the project's genuine strength (TEE).

---

## 3. Flare in 60 seconds + the primitives (the building blocks)

**Flare** is an EVM-compatible Layer-1 whose thesis is **"XRPFi"** — making assets that lack native smart contracts (XRP first, later BTC/DOGE) programmable. Its differentiator is a set of **enshrined protocols** built into the core and secured by the whole network:

- **FSA — Flare Smart Accounts:** lets an XRPL user act on Flare using **only their XRPL Payment signature** — gasless, no EVM wallet, non-custodial. Each XRPL address maps to a Flare-side `PersonalAccount`. Custom actions are encoded as EIP-4337 `PackedUserOperations`. **This is our onboarding moat.** *(Note: FSA controls a Flare-side account only — it cannot sign approvals on other chains like Hyperliquid/Sui. Per-chain trade approvals happen on each execution chain.)*
- **FAssets / FXRP:** trust-minimized, over-collateralized representation of XRP (and later BTC/DOGE) on Flare. **FXRP is live on mainnet.** Used here as a settlement/subscription asset and for the XRPL-native flow.
- **FTSO — Flare Time Series Oracle:** enshrined, block-latency (~1.8s) decentralized price feeds. Used here for price bounds / min-out slippage protection on swaps.
- **FDC — Flare Data Connector:** enshrined oracle that **proves an external/cross-chain/Web2 event happened** (e.g. an XRPL payment, or an EVM transaction) with on-chain Merkle proofs. Used here (optionally) to build a **verifiable leader track record**. *(Caveat: on mainnet, EVMTransaction attestation supports ETH/FLR/SGB source chains; Hyperliquid-fill attestation needs Web2Json, which is testnet-only today — so the track-record feature is limited at launch. See blueprint.)*
- **FCC — Flare Confidential Compute:** Flare's own TEE layer. **NOT production-ready** (canary/Songbird, unaudited, full rollout targeted Q3 2026). **We do NOT depend on it.** Our TEE runs off-Flare on Google Cloud Confidential Space, with attestation verified on Flare.

---

## 4. The problem

Every trader who sells signals hits the same wall:
- **Share the strategy and it leaks.** The moment a leader posts calls in a paid group, one member can screenshot, forward, or resell the entire feed. Paid-signal leakage/reselling on Telegram is a documented, large-scale fraud vector. The edge is copied and devalued the instant it's shared.
- **Keep the strategy secret and nobody trusts you.** Without a verifiable record, followers can't distinguish a real trader from a scammer, so they won't pay.

Today you can't have both: protect the alpha and lose trust, or prove the record and lose the alpha.

---

## 5. The solution — Sigmax on Flare

Sigmax removes the trade-off:
- **The signal is encrypted end-to-end.** Each signal is encrypted to the TEE's public key. No one — not other followers, not the public, not our own backend — can read it.
- **Only a TEE agent ever decrypts it.** The agent decrypts inside the enclave, purely to place the trade. The strategy/entry/exit never appear on-chain and never leave the enclave.
- **Followers copy the result, not the recipe.** Each follower's trade executes automatically against their own funds; they never receive the underlying strategy — nothing to screenshot, leak, or resell.
- **The record stays provable.** Signals are committed on-chain (a hash) and executed trades can be attested, so a leader's performance is independently verifiable without exposing *how* they trade.
- **Non-custodial throughout.** The agent can **execute** trades but can **never withdraw** funds (on Hyperliquid via trade-only agent wallets; on EVM via a per-follower vault where only the owner can withdraw).

The result: **a secret strategy and a provable track record at the same time.**

---

## 6. How it works (actors + sequence)

**Actors:**
- **Leader** — publishes encrypted signals; owns the subscription revenue.
- **Follower / Subscriber** — pays a subscription; pre-approves trade-only execution on each execution chain; their own funds are what trade.
- **Platform** — Flare control-plane contracts + the off-chain TEE agent.
- **TEE Agent** — the sole decryptor and executor; runs inside a Confidential Space enclave; holds trade-only approvals; never custodies funds.
- **Executor / Relayer** — bridges XRPL payments to Flare (via FDC) for the FSA onboarding flow.

**Sequence:**
1. **Publish.** The leader composes a signal — e.g. `swap X/Y at Z% of balance on chain A` (chain chosen from a supported list). It is encrypted to the enclave's public key and a commitment (`SignalPublished(leader, planId, ciphertextHash, uri)`) is posted on Flare. The on-chain event is the canonical trigger/timestamp.
2. **Decrypt in TEE.** The attested agent — and only it — decrypts the signal inside the enclave.
3. **Subscription check.** The agent reads the on-chain `SubscriptionRegistry` to enumerate active subscribers and their per-chain trade approvals.
4. **Fan-out execution.** The agent executes the **spot** swap for **all** subscribers **simultaneously**, on the specified chain, sized as a bounded % of each follower's balance. Followers are isolated — one failure never blocks the others.
5. **(Optional) Verifiable receipt.** Executed swaps (where supported) are attested back to Flare via FDC to build the leader's track record.
6. **Exit (optional).** A take-profit/stop-loss monitor can auto-exit when a price threshold is crossed (spot sell).

---

## 7. Architecture

**Flare = control plane. Off-chain TEE = the confidential brain. Other chains = execution layers.**

```
        ┌──────────────── FLARE CONTROL PLANE (on-chain) ────────────────┐
        │ LeaderRegistry · SubscriptionRegistry (fee-split) ·            │
        │ AgentAttestationGate (verify TEE attestation → gate            │
        │   decrypt/execute) · optional TrackRecord (FDC receipts) ·     │
        │ FSA MasterAccountController → per-XRPL PersonalAccount         │
        └───────▲───────────────────────────────────▲───────────────────┘
                │ publish/subscribe events           │ attestation + enclave pubkey
   XRPL (Xaman) │                          ┌─────────┴───────────┐
   Payment+memo─┘ (FDC XRP-payment proof)  │  OFF-FLARE TEE AGENT │
   → executor → PersonalAccount.subscribe  │ Google Confidential  │
                                           │ Space · HPKE decrypt │
                                           │ · KMS key release    │
                                           └─────────┬────────────┘
                                                     │ trade-only signing
        ┌──────────── EXECUTION CHAINS ──────────────┴──────────────┐
        │ Hyperliquid spot (approveAgent) · EVM (per-follower vault) │
        │ · one Flare DEX (FXRP) [Sui / XRPL-DEX = out of scope v2]  │
        └────────────────────────────────────────────────────────────┘
```

---

## 8. What already exists (the original "Sigmax") + the migration map

**Original Sigmax** was built for **Story Protocol's Confidential Data Rails (CDR)** hackathon. It already implements the entire confidential copy-trading loop; only the confidentiality/access primitive and the "control plane" need to move from Story to Flare.

**Already built (reused):**
- TypeScript **TEE-ready agent** with a per-follower pipeline: subscription check → live balance → position sizing → execution → tracking, plus a TP/SL monitor. Confidentiality enforced (signal never logged).
- **Hyperliquid execution** via `@nktkas/hyperliquid`, authorized through Hyperliquid's native **`approveAgent`** (trade-only; the agent can place orders but **cannot withdraw**).
- **`CopyVault.sol`** — a non-custodial per-follower EVM vault: only the owner can `withdraw`; the agent has a scoped role that can `executeSwap` only, constrained by token whitelist, router whitelist, per-trade cap, and on-chain min-out. **`CopyVaultFactory.sol`** — one deterministic vault per follower (CREATE2).
- **`SubscriptionRegistry.sol`** — leaders create plans (price + platform fee); followers subscribe; payment splits leader/platform; `isActive` gates execution with a grace period.
- **Web app** — Vite + React + wagmi/viem.
- Test suites for agent pipeline, contracts (Foundry), and encrypt/decrypt round-trips.

**Migration map — Story/CDR → Flare:**

| In original Sigmax (Story) | In Sigmax on Flare |
|---|---|
| CDR threshold encryption | **Encrypt-to-enclave (HPKE)** to the attested TEE public key |
| CDR storage of ciphertext | Off-chain + **on-chain hash commitment** on Flare (small ciphertext could also go on-chain) |
| Story **License Token** = read/decrypt gate | **AgentAttestationGate + SubscriptionRegistry** on Flare (only the attested agent decrypts; only active subscribers get executed) |
| Story IP/PIL/royalty = business model | **SubscriptionRegistry fee-split** on Flare |
| (no chain-abstracted onboarding) | **NEW: Flare Smart Accounts** — XRPL-signature onboarding, gasless, non-custodial (**the moat**) |
| Execution on Hyperliquid / EVM | Same (unchanged) |
| — | **Optional NEW: FDC** verifiable track record; **FTSO** min-out bounds |

**Newly built for Flare (the "new work" story for judges):** LeaderRegistry + `publishSignal`; **AgentAttestationGate** (verify TEE attestation, gate decryption/execution); **HPKE encrypt-to-enclave** layer + enclave key lifecycle; **Confidential Space** deployment + attestation → Flare verification + KMS key release; **FSA** subscription flow (executor + PersonalAccount + memo-encoded instruction); optional **TrackRecord/FDC** verifier.

---

## 9. Load-bearing primitive & the "why Flare / why not Base" defense

**The load-bearing primitive is FSA (Flare Smart Accounts)** — chosen deliberately over FDC. Test: *"if I removed it, would the product still work with the same value?"*
- Remove **FDC** → the product still works (the track record is a bonus). So FDC is **not** load-bearing; it's an optional trust layer.
- Remove **FSA** → we lose the thing no other chain can replicate: an XRP holder subscribing and acting with **one XRPL signature, no EVM wallet, no gas.** That XRPL-native onboarding is the moat.

**"Why not Base / Solana / any EVM chain?"** The copy-trading logic and the TEE are portable — but **only Flare** lets a native XRP holder (with just an XRPL wallet like Xaman) participate self-custodially with a single XRPL signature, via FSA + FAssets. That onboarding experience does not exist elsewhere. The pitch is therefore about **who can effortlessly onboard**, not about the automation logic.

**The confidentiality (TEE) is the product's reason to exist; FSA is why it lives on Flare specifically.**

---

## 10. Non-negotiable design constraints (build rules)

These are **hard product constraints** — the build must respect all of them. They are internal design rules, **not** a marketing angle, and should **not** be surfaced as a selling point in the pitch:
- **Spot only.** No perpetual futures, no leverage, no margin. Leaders trade spot on spot venues (Hyperliquid spot, DEX spot). Signals are spot swaps.
- **Non-custodial only.** The agent executes but can never withdraw/transfer user funds out (Hyperliquid `approveAgent`; EVM per-follower vault with owner-only withdraw).
- **No interest / lending-for-yield.** Revenue comes from **subscription/service fees**, not from lending user funds for interest.
- **No gambling, no betting, no prediction markets.**
- **Monetization:** subscription fees (leader/platform split) and optionally spot execution fees / a Hyperliquid builder-code on the sell side. **No performance fees** (also reduces regulatory "asset management" risk).

---

## 11. Hackathon scope (what's IN, what's CUT) + bounty

**Primary bounty:** **Bounty 2 — Confidential Compute Apps.** (Confidential, TEE-based; lower expected competition; plays to the project's real strength.) Secondary framing touches **Bounty 1** via FXRP + FSA onboarding.

**IN scope for the 4-week hackathon build:**
- Encrypt-to-enclave (HPKE) signal encryption + on-chain commitment on Flare.
- Off-chain TEE agent on **Google Cloud Confidential Space**, attestation verified on Flare (with an **off-chain-verification fallback** if on-chain vTPM verification isn't ready).
- Flare control-plane contracts: LeaderRegistry, SubscriptionRegistry (ported), AgentAttestationGate.
- **Hyperliquid spot** execution (primary venue) via `approveAgent` fan-out.
- **One EVM chain** via the existing CopyVault pattern.
- **One Flare DEX** (SparkDEX/Enosys) FXRP swap with FTSO min-out.
- **FSA** subscription flow (XRPL-signature onboarding) — the moat demo. *(Day-1 spike gates this; fallback is WalletConnect/EVM onboarding.)*

**CUT to v2 (post-hackathon):**
- Sui execution (feasible but multi-day: Move vault-object + capability role + sponsored tx).
- XRPL-DEX execution (would require custody of the XRPL signing key → violates non-custodial).
- Multi-EVM execution beyond one chain.
- Native **FCC** (not production-ready).
- On-chain vTPM attestation verification (**stretch**; ship off-chain-verified gate first).
- FDC verifiable track record for Hyperliquid fills (Web2Json is testnet-only today; keep FDC receipts limited to ETH/FLR/SGB as a stretch demo).

---

## 12. Why this idea (decision rationale + honest caveats)

This project was chosen after an extensive elimination process against alternatives (a consumer "make Flare invisible" app; a DCA/accumulation product called "Cadence"; a cross-chain execution platform; agent-payments; verifiable-data infra; and others). Summary of why **Sigmax on Flare** was selected:
- **High code reuse** (~60–80% exists) → realistic to ship a polished demo solo in 4 weeks.
- **Plays to a rare, differentiated strength** (TEE / confidential execution) and targets the **lower-competition Bounty 2**.
- **The "liquidity" objection was retired:** an earlier concern was that Flare's shallow DEX liquidity would sink it — but execution happens on **deep external venues (Hyperliquid spot / EVM)**, not on Flare, so Flare's own liquidity is irrelevant to execution quality.
- **A genuine moat via FSA** (XRPL-native onboarding) answers "why Flare / why not Base."

**Honest caveats the receiving agent should keep in mind (don't re-litigate — plan around them):**
- **Two-sided market.** Needs leaders *and* followers (cold-start from both sides). Mitigation: launch with a small curated set (e.g. ~5 leaders, ~100 followers) rather than an open marketplace.
- **Spot narrows the leader pool.** Most copy-trading demand is perps-centric; spot-only is a real (accepted) constraint that shrinks the addressable leader/strategy set.
- **Verifiable track record is thin on mainnet today** (FDC can't cleanly attest Hyperliquid fills yet). Treat it as optional/stretch, not a headline.
- **Attestation-on-chain is unverified.** `flare-vtpm-attestation` is experimental; ship the off-chain-verification fallback.
- **Positioning discipline:** pitch it as a focused product ("confidential spot copy-trading") — **not** as an open-ended "execution network for everything." The platform generalization is a *future* story, not the hackathon scope.

---

## 13. Open questions / day-1 verification (see blueprint for detail)

The companion blueprint contains the full component-availability table and fallbacks. The two items that most affect the plan, to verify on **day 1**:
1. **FSA developer access + end-to-end round-trip on Coston2** (derive a PersonalAccount for a test XRPL address, encode a `subscribe()` custom instruction, run your own executor, confirm execution). **Continue with FSA only if this round-trips in <1 day**; otherwise fall back to WalletConnect/EVM onboarding and keep FSA as a stretch demo.
2. **TEE attestation → Flare:** stand up a Confidential Space container, get an attestation token, and decide **on-chain verification** (`flare-vtpm-attestation`) vs the **off-chain-verified relayer** fallback within 2 days.

---

## 14. What we'd like from you (the receiving agent)

Using **this brief + the Verified Technical Blueprint**, help produce/refine any of: a detailed 4-week execution plan with daily tasks; the Solidity contracts (LeaderRegistry, SubscriptionRegistry port, AgentAttestationGate, optional TrackRecord); the HPKE encrypt-to-enclave module and enclave key-lifecycle code; the Confidential Space deployment + attestation-verification wiring; the FSA subscription flow (executor + memo encoding); the Hyperliquid fan-out execution layer; and the demo script + submission write-up (clearly separating pre-existing Sigmax work from new Flare work, per the hackathon rules). Respect the non-negotiable design constraints in §10. Where the blueprint flags something as unverified, prefer the stated fallback.

---

## 15. Companion document & key links

**Companion file (read together):** *"Sigmax on Flare — Verified Technical Blueprint"* — component availability table, FSA deep-dive + day-1 spike, TEE/attestation design, per-venue execution mechanics, contract interfaces, reuse map, risk table, 4-week plan, full link pack.

**Hackathon:**
- Detail page: `https://dorahacks.io/hackathon/flaresummersignal/detail`
- Telegram: `https://t.me/+5Vn6ZKhr6KI3NjIx`

**Flare developer resources:**
- Dev hub: `https://dev.flare.network/` (Smart Accounts: `/smart-accounts/overview` · FDC: `/fdc/overview` · FAssets/FXRP: `/fassets/overview` · FTSO: `/ftso/overview` · FCC: `/fcc/overview`)
- Starters: `flare-hardhat-starter`, `flare-foundry-starter` (github.com/flare-foundation)
- FlareContractRegistry: `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`
- Faucet: `https://faucet.flare.network` · Explorer: `https://flare-explorer.flare.network`

**External:**
- Hyperliquid docs (agent wallets, builder codes, exchange endpoint): `https://hyperliquid.gitbook.io/hyperliquid-docs`
- `@nktkas/hyperliquid` SDK: `https://github.com/nktkas/hyperliquid`
- Google Cloud Confidential Space: `https://docs.cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-overview`
- Flare AI Kit (Confidential Space scaffolding, alpha): `https://github.com/flare-foundation/flare-ai-kit`

---

*End of brief. Pair with the Verified Technical Blueprint for the complete picture.*
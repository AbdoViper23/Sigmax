# Sigmax — Confidential Copy-Trading on Story Protocol

> **Copy a trader's alpha. Never know their strategy.**

Sigmax is a copy-trading platform built on [Story Protocol](https://story.foundation) and powered by [CDR (Confidential Data Repository)](https://docs.story.foundation). A leader publishes an encrypted trading signal to a CDR vault on Story. Followers subscribe, and an autonomous agent running in a TEE decrypts and executes that signal as a spot swap — inside each follower's own non-custodial vault — without ever revealing the strategy on-chain.

Built for the **[CDR Hackathon](https://build.usecdr.dev)** Story Protocol.

---

## The Problem

Copy-trading platforms today force traders to choose between two bad options:

1. **Keep the strategy secret** → followers have no way to verify past performance. Trust is blind.
2. **Publish the strategy on-chain** → the alpha leaks the moment it's readable. The edge is gone.

Sigmax removes this tradeoff.

---

## How CDR Makes It Possible

CDR (Confidential Data Repository) is Story Protocol's threshold-encryption primitive. A signal encrypted into a CDR vault:

- **Cannot be read by any single party** — decryption requires a quorum of validators, inside SGX enclaves.
- **Is gated by an on-chain condition** — our `ReadCondition` returns `true` only for active subscribers.
- **Is decrypted exclusively inside the TEE agent** — the plaintext signal never touches a log, a database, or the chain.

The result: the leader's take-profit, stop-loss, and entry logic are **never exposed**, but the resulting trades are **permanently on-chain** and attributable to the strategy. You can audit the track record without reading the playbook.

```
Leader fills signal template
  └─► App encrypts it → uploadCDR → CDR vault on Story
                                          │
                              ReadCondition: "is the caller a subscriber?"
                                          │
                                    Agent (TEE)
                                      └─► accessCDR → threshold-decrypt (inside SGX)
                                          │  plaintext signal lives here only, briefly
                                          └─► execute spot swap in follower's CopyVault
                                              on Arbitrum / Base
```

---

## Architecture

Sigmax runs across two chains and one off-chain agent.

### Story L1 — the strategy layer

| Component | What it does |
|---|---|
| **CDR Vault** | Holds the threshold-encrypted signal (token, entry, TP, SL) |
| **ReadCondition** | Grants `accessCDR` only to wallets with an active subscription |
| **IP Asset + PIL** | The strategy registered as licensable IP; `defaultMintingFee` = monthly price |
| **License Token** | An ERC-721 minted when a follower subscribes — this IS the subscription |
| **IP Royalty Vault** | Auto-splits every subscription payment: 85% leader / 15% platform |
| **SubscriptionRegistry** | Tracks `follower → expiry timestamp` for monthly eligibility checks |

### Liquidity Chain (Arbitrum One / Base) — the execution layer

| Component | What it does |
|---|---|
| **CopyVault** | Per-follower contract; holds their spot funds (e.g. USDC) |
| **EXECUTOR_ROLE** | Given to the agent — scoped to `executeSwap` only, within token whitelist + caps |
| **DEX / Aggregator** | 0x Swap API v2 for slippage-protected spot quotes |

### The Agent (TEE)

The agent is the only bridge between the two chains. It:
1. Watches Story for new CDR vaults (or updates).
2. Calls `accessCDR` → decrypts inside the TEE.
3. Reads `SubscriptionRegistry` → builds the list of active followers.
4. Fetches a 0x quote per follower, enforces `minOut` for slippage protection.
5. Submits `CopyVault.executeSwap(...)` on the liquidity chain.
6. Monitors price for TP/SL in TEE memory — exits without ever writing the target price on-chain.

The agent **holds no funds**. Custody is impossible by contract design.

---

## Trust Model

```
Follower trusts the agent to execute honestly
  → contract prevents theft: agent can only swap whitelisted tokens within caps
  → TEE prevents tampering: even the platform operator can't see the signal

Leader trusts CDR to keep the signal secret
  → threshold encryption: no single validator decrypts alone

Platform trusts no one with money
  → revenue flows through Story's Royalty Vault, not a platform wallet
  → anyone can claim permissionlessly via claimAllRevenue
```

---

## Non-Custodial by Design

- The follower's funds live in **their own CopyVault** — the follower deploys it and only they can withdraw.
- The agent holds a scoped `EXECUTOR_ROLE` that is **immediately revocable** by the follower.
- Token whitelist and per-swap caps are set by the follower at vault setup.
- One call — `revokeExecutor(agentAddress)` — and the agent can never touch the vault again.

---

## Verifiable Track Record

Because every signal is committed to a CDR vault **before** its outcome is known, and every resulting trade is a permanent on-chain swap in follower vaults, Sigmax can surface a **tamper-proof performance history** per strategy:

- Signal timestamp: on Story (before outcome)
- Trade result: on Arbitrum/Base (after execution)
- Nobody — not the leader, not the platform — can retroactively edit either.

The leaderboard is backed by on-chain data, not self-reported stats.

---

## Spot-Only (and Halal)

Sigmax executes **only spot swaps between two whitelisted tokens**. No leverage, no perpetuals, no shorts, no borrowing. This is enforced at the contract level in `CopyVault.executeSwap` — the agent cannot express any other trade type even if compromised. This constraint is both a product invariant and an explicit halal-compliance boundary.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Encrypted signals | `@piplabs/cdr-sdk` (uploadCDR / accessCDR) |
| IP, licensing, royalties | `@story-protocol/core-sdk` (IP Asset, PIL, License Tokens, Royalty Vault) |
| Smart contracts | Solidity + Foundry |
| EVM client | viem (no ethers) |
| Agent runtime | TypeScript, TEE-ready (Gramine / DCAP) |
| Swap routing | 0x Swap API v2 |
| Liquidity chain | Arbitrum One (primary) / Base |
| Frontend | Next.js + wagmi + RainbowKit |
| Monorepo | pnpm workspaces + Turborepo |

---

## Repo Structure

```
packages/
  shared/        ← signal schema, chain addresses, shared types
  contracts/     ← Solidity (CopyVault, SubscriptionRegistry, conditions) + Foundry tests
  agent/         ← TypeScript agent (watch → decrypt → execute → monitor)
  web/           ← Next.js frontend (leader publish + follower subscribe/deposit/authorize)
docs/            ← full design documentation (28 files, one topic each)
```

---

## Running Locally

```bash
# Install dependencies
pnpm install

# Contracts (Foundry)
forge build
forge test -vvv

# Agent
pnpm --filter agent dev

# Frontend
pnpm --filter web dev

# Full monorepo build
pnpm -r build
```

> **Note:** Swap execution is demoed against a **forked Arbitrum** (`anvil --fork-url`). Aeneid testnet has no real spot liquidity.

---

## The End-to-End Demo

1. Leader publishes a signal (UI) → encrypted vault appears on Story (ciphertext only).
2. Agent logs: `detected → decrypted (TEE) → follower active → swap executed` (tx on forked Arbitrum).
3. Follower dashboard: open position appears — trade result shown, strategy never shown.
4. Price hits TP → agent exits → PnL visible.
5. Leaderboard: verifiable record (signal committed before outcome + on-chain trades).
6. Click "Revoke Agent" → agent can no longer trade on that vault.

---

## Why CDR + Story Is the Right Stack

| Need | Story / CDR primitive |
|---|---|
| Keep the strategy secret | CDR threshold encryption + ReadCondition |
| Prove the track record | On-chain signal commits (CDR vault timestamps) + swap events |
| Sell the strategy as IP | Story IP Asset + PIL license terms |
| Monthly subscriptions | License Token mint (ERC-721) + SubscriptionRegistry |
| Revenue split without code | IP Royalty Vault (100 Royalty Tokens, permissionless claim) |
| Compliance / access control | WriteCondition (leader-only publish) + ReadCondition (subscriber-only decrypt) |

Every component of the business model maps to a Story primitive. No custom payment contracts needed.

---


*Sigmax · built for the CDR Hackathon · Story Protocol · 2026*

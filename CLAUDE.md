# CLAUDE.md — Sigmax

> This file is the entry point for Claude Code. Read it fully before doing anything in this repo.
> It tells you what Sigmax is, the rules you must never break, how the docs are organized,
> and which file to read for any given task.

---

## 1. What Sigmax is (one paragraph)

Sigmax is a **confidential, spot-only copy-trading platform**. A *leader* (trader) encrypts a
structured spot trading signal into a **CDR vault on Story Protocol**. *Followers* pay a monthly
subscription. An off-chain **agent** (running in a TEE) decrypts each signal, and executes the
corresponding **spot swap** on a high-liquidity EVM chain (Arbitrum One or Base) **inside each
follower's own non-custodial vault contract**. The follower never sees the raw strategy, and the
agent never holds the follower's funds. The strategy stays secret (no leakage of the leader's
alpha) while the leader's track record is verifiable on-chain.

This project is being built for the **CDR Hackathon** (build.usecdr.dev, presented by Story,
27 May → 5 June 2026) and is intended to continue as a real product after the hackathon.

---

## 2. Hard rules — NEVER violate these

These are product invariants. If a task would require breaking one of these, STOP and flag it.

1. **SWAP-ONLY EXECUTION.** No leverage, perpetuals, shorting, margin, or borrowing — anywhere,
   ever. The only on-chain trading action is a swap between two whitelisted tokens. This is enforced
   at the contract level via the single `executeSwap` primitive (see `docs/contracts/10-copyvault.md`),
   which keeps the permission/attack surface tiny and reduces regulatory "asset-management /
   derivatives" exposure.
2. **NON-CUSTODIAL.** The agent must NEVER hold, custody, or be able to withdraw follower funds.
   Funds live in the follower's own `CopyVault`. The agent gets only a scoped executor role that
   can call `executeSwap` within a token whitelist + caps. Only the vault owner can withdraw.
   (See `docs/key-management/50-non-custodial.md`.)
3. **CONFIDENTIALITY IS THE PRODUCT.** The leader's strategy/signal must stay encrypted until
   it is decrypted *inside the agent's runtime (TEE)*. Never write the plaintext strategy, the
   take-profit, or the stop-loss to any public on-chain location. If a feature would expose these
   values on-chain, it defeats the entire product — flag it. (See `docs/security/70-leakage-mitigation.md`.)
4. **TWO CHAINS, TWO ROLES.** Story L1 holds the encrypted strategy + access conditions + IP/royalty
   (subscription revenue). The liquidity chain (Arbitrum/Base) holds the CopyVaults + executes swaps.
   Do not try to execute swaps on Story (no real spot liquidity there).

---

## 3. How the docs are organized (read map)

All design docs live under `docs/`. Each file covers exactly ONE topic in depth. Numbering is
stable; reference files by number.

```
docs/00-overview.md            → problem, idea, value prop, the 3 layers
docs/01-architecture.md        → full architecture + end-to-end data/sequence flow
docs/02-tech-stack.md          → every tool/library/version + why
docs/03-repo-structure.md      → monorepo layout (each service standalone) + conventions

contracts/
  10-copyvault.md         → CopyVault.sol (deposit, executeSwap, caps, roles, withdraw)
  11-cdr-conditions.md    → Story read/write condition contracts (License + Subscription)
  12-subscription-registry.md → monthly subscription registry, renewal, expiry

cdr-story/
  20-cdr-sdk.md           → @piplabs/cdr-sdk usage (uploadCDR/accessCDR, encryption flow)
  21-story-ip-royalty.md  → IP Asset, PIL terms, License Tokens, Royalty Vault, revenue split
  22-signal-template.md   → the structured signal schema (token, priceIn, takeProfit, stopLoss)

agent/
  30-agent-overview.md    → what the agent is, architecture, TEE, lifecycle
  31-agent-execution-flow.md → the loop: watch → decrypt → parse → fan-out → quote → execute
  32-agent-tp-sl-monitor.md → take-profit / stop-loss monitoring inside the TEE

execution/
  40-chain-choice.md      → Arbitrum vs Base, liquidity, the decision
  41-dex-swaps.md         → spot swaps via 0x / Uniswap / Sushi, slippage/minOut
  42-cross-chain.md       → linking Story to the liquidity chain (trusted relayer model)

key-management/
  50-non-custodial.md     → CopyVault role vs ERC-4337 / EIP-7702 session keys, gas, revocation

frontend/
  60-frontend-stack.md    → Next.js + wagmi/viem + RainbowKit, leader & follower flows

security/
  70-leakage-mitigation.md → on-chain strategy-leakage problem + mitigations

engineering/
  80-mvp-scope.md         → what's in / out of the MVP + dependency graph
  81-engineering-plan.md  → phased build plan + acceptance criteria per phase

business/
  90-business-model.md    → revenue model, pricing, unit economics
  91-costs.md             → itemized USD costs to run the product
  92-startup-roadmap.md   → hackathon → launch → first 20 users → growth
  93-gtm-first-20-users.md → how to get the first 20 real users
  94-risks-and-unknowns.md → technical + business + legal risks and things to verify
```

---

## 4. Which doc to read for which task

| If you are asked to…                                  | Read first…                                            |
|-------------------------------------------------------|--------------------------------------------------------|
| Write/modify the vault contract                       | `docs/contracts/10-copyvault.md` + `docs/key-management/50-non-custodial.md` |
| Write a Story access condition                        | `docs/contracts/11-cdr-conditions.md` + `docs/cdr-story/20-cdr-sdk.md` |
| Build subscriptions                                   | `docs/contracts/12-subscription-registry.md` + `docs/cdr-story/21-story-ip-royalty.md` |
| Touch CDR encryption / decryption                     | `docs/cdr-story/20-cdr-sdk.md`                              |
| Define or change the signal format                    | `docs/cdr-story/22-signal-template.md`                      |
| Build/modify the agent                                | `agent/30`, `agent/31`, `agent/32`                     |
| Implement swaps / pick a DEX                           | `docs/execution/41-dex-swaps.md` + `docs/execution/40-chain-choice.md` |
| Wire Story↔liquidity chain                            | `docs/execution/42-cross-chain.md`                          |
| Build the web app                                     | `docs/frontend/60-frontend-stack.md`                        |
| Plan the build / sequence work                        | `docs/engineering/80-mvp-scope.md` + `docs/engineering/81-engineering-plan.md` |
| Anything about money, pricing, costs                  | `business/90`, `business/91`                           |

### External references (official docs — fetch on demand)

- **`cdr` skill (source of truth for `@piplabs/cdr-sdk`):** invoke the **`cdr` skill BEFORE writing
  or reviewing ANY code that touches `@piplabs/cdr-sdk`** (allocating vaults, `uploadCDR`/`accessCDR`,
  conditions, IPFS upload). It pins the working facts: SDK **v0.2.1**; `network` is **`"testnet"`**
  for Aeneid (NEVER `"aeneid"`); `apiUrl` is required (Aeneid `http://172.192.41.96:1317`); call
  `await initWasm()` before encrypt/decrypt; inline payloads ≤ ~1024 bytes (else `uploadFile`); the
  two deployed condition contracts (`OwnerWriteCondition` `0x4C9b…c34B`, `LicenseReadCondition`
  `0xC064…f7a3`, `LicenseToken` `0xFe38…C6bC`); EOA-as-condition needs `skipConditionValidation:true`
  + the low-level `allocate`→`encryptDataKey`→`write` path. (`packages/cdr` wraps all of this.)
- **Story Protocol / CDR docs index:** https://docs.story.foundation/llms.txt
  When a task touches Story, CDR, IP Assets, PIL / License, or Royalty behavior, open this index
  first and fetch the specific page's `.md` before writing code — do NOT rely on memory for the
  SDK or contract APIs.
- The local design docs (the read map above) describe *our* design and intent. The official Story
  docs are the source of truth for Story/CDR **APIs and behavior**. When the two disagree, follow
  the official docs and note the discrepancy in `94-risks-and-unknowns.md`.

---

## 5. Conventions Claude Code must follow

- **Language/tooling:** Solidity + Foundry for contracts; TypeScript everywhere off-chain
  (agent + web). Use **viem** (not ethers) for all EVM I/O. Full versions in `docs/02-tech-stack.md`.
- **Monorepo:** pnpm workspaces. Each service is its own package and deploys independently
  (see `docs/03-repo-structure.md`). Never create cross-service imports except through `packages/shared`.
- **Contracts:** every external/public function needs a NatSpec comment. Every state-changing
  function that the agent can call must have an explicit access-control modifier and bounds checks.
  Write Foundry tests for every contract before considering it done.
- **Secrets:** never hardcode private keys, RPC keys, or API keys. Use `.env` (provide
  `.env.example`). The agent's signing key and the CDR access key are loaded from env only.
- **Plaintext signals:** the decrypted signal object exists only in agent memory. Never log it,
  never persist it, never send it to the frontend. Log trade *results* only (token pair, amount,
  tx hash), never the strategy logic, takeProfit, or stopLoss values.
- **Tests / acceptance:** a task is "done" only when its acceptance criteria in
  `docs/engineering/81-engineering-plan.md` pass. Don't mark work complete without running the tests.
- **Commits:** small, scoped commits. Reference the doc number in the message,
  e.g. `feat(contracts): CopyVault.executeSwap with caps [10-copyvault]`.

---

## 6. Common commands (fill in as the repo is built)

```bash
# Contracts (Foundry)
forge build
forge test -vvv
forge fmt

# Agent (TypeScript)
pnpm --filter agent dev
pnpm --filter agent test

# Web app (Next.js)
pnpm --filter web dev
pnpm --filter web build

# Whole monorepo
pnpm install
pnpm -r build
pnpm -r test
```

---

## 7. Status / verify-first notes

- **CDR SDK confirmed:** `@piplabs/cdr-sdk@0.2.1` (+ `@piplabs/cdr-contracts@0.2.1`) is installed and
  verified against the `cdr` skill. Key fact that bit us once: `Network = "mainnet" | "testnet"`, so
  Aeneid is **`"testnet"`** — passing `"aeneid"` (or hiding it with `as never`) breaks live calls.
  For any CDR change, invoke the **`cdr` skill** first (see §4).
- Aeneid testnet has **no real spot liquidity** — swaps must be demoed against a **forked**
  Arbitrum/Base (Anvil `--fork-url`). (Tracked in `94-risks-and-unknowns.md`.)
- When a doc and reality disagree, reality wins — update the doc and note it in
  `94-risks-and-unknowns.md`.

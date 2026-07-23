# Sigmax — Master Handoff Document

> **ملاحظة (بالعربي):** الملف ده هو "الذاكرة الكاملة" للبروجكت. أي AI agent (أو أي حد) يقرأه يقدر يفهم
> Sigmax كله — الفكرة، المعمارية، اللي اتعمل فعلاً، اللي لسه، وكل القرارات اللي اتكلمنا فيها — ويكمّل
> التطوير من نفس النقطة. الملف طويل عن قصد. **القاعدة الذهبية:** لو في تعارض، **الكود هو الحقيقة**، بعده
> الـ`README.md`، وبعدهم ملفات `docs/` (لأنها قديمة في كذا حتة). كل العناوين والأرقام في الملف ده
> اتأكدنا منها من الكود نفسه يوم **2026-06-06**.

> **For AI agents:** This is the single source of truth for continuing Sigmax development. It reconciles
> the design docs against the actual shipped code. **Precedence when sources disagree: live code > `README.md` > `docs/`.**
> Every address, env var, and behavior below was verified against the repo on **2026-06-06**. Do not print
> or commit secret key values — only variable *names* and *public* addresses appear here.

---

## 0. TL;DR — read this first

**Sigmax** (formerly "AlphaVault") is a **confidential, spot-only copy-trading platform**. A *leader* encrypts a
structured trading signal into a **CDR vault on Story Protocol L1** (Aeneid testnet). *Followers* pay a monthly
on-chain subscription. An off-chain **agent** decrypts each signal and executes the corresponding **spot swap**
inside each follower's own **non-custodial** account — on **Hyperliquid** (the live venue) or an **Arbitrum
CopyVault** (built, fork-only). The follower never sees the plaintext strategy; the agent never holds funds;
the take-profit / stop-loss never touch any public chain. The leader's track record stays verifiable on-chain
because every signal is committed (encrypted) *before* its outcome.

- **Built for the CDR Hackathon** (build.usecdr.dev, presented by Story, 27 May → 5 Jun 2026). Per the
  owner's own session history Sigmax **won** the hackathon and did a Demo Day (~5 Jun 2026); note the repo
  README itself does **not** assert "won" — treat that as external context, not a code fact.
- **Status in one line:** the full loop (encrypt → subscribe → decrypt → execute → TP/SL exit) is **live on
  Hyperliquid testnet** end-to-end; the Arbitrum/EVM CopyVault path is fully built + tested but only runs
  against a local Arbitrum mainnet fork; everything runs on testnet/fork (no mainnet, no audit, no TEE yet).
- **Stack:** pnpm-workspaces + Turborepo monorepo; TypeScript everywhere off-chain (viem, not ethers);
  Solidity 0.8.24 + Foundry for contracts; Vite + React 19 + TanStack Start + wagmi/viem for the web app.

### Three things that will trip you up if you don't read them

1. **The live agent loads `packages/agent/.env`** (its `start` script is `tsx --env-file=.env src/main.ts`,
   run from the package dir), and that file sets **`EXECUTION_VENUE=hyperliquid`**. The **root `.env`** is a
   *different* file used by the PoC scripts and the Foundry deploy script; it has no Hyperliquid keys, so a
   process that loads root `.env` would build the **Arbitrum** venue only. Always be explicit about which
   `.env` a given process reads.
2. **There are three distinct wallets** (NOT single-wallet — older notes are stale). See
   [§7.3 Wallet topology](#73-wallet-topology--the-three-wallets).
3. **The design docs (`docs/00`–`03`, `12`, `20`–`22`, `30`–`31`, `40`–`41`, `60`) are systematically stale.**
   They predate the Hyperliquid venue, the real-CDR switch, the Vite frontend, and the multi-leader/two-wallet
   topology. Use them for *intent*, not for APIs or current state. See [§10 Design vs Reality](#10-design-vs-reality-master-table).

---

## 1. The product

### 1.1 The problem
The trading-signals / copy-trading market has two linked failures:
- **Leakage:** a paying subscriber screenshots a leader's call and re-shares it, destroying the leader's edge
  and revenue.
- **Fake track records:** "I'm up 300%" is unverifiable; scammers thrive.

### 1.2 The solution
- The follower **never sees the plaintext signal**. The agent decrypts it inside its runtime and executes the
  trade *on the follower's behalf*, in the follower's own account.
- Every signal is **committed on-chain (encrypted) before its outcome is known**, so the leader's record is
  cryptographically auditable and cannot be faked after the fact.
- **CDR (Confidential Data Rails) is load-bearing, not a feature.** If a design change removes the need for
  encryption, the moat is gone — flag it.

### 1.3 The honest limitation (state this when pitching)
Spot swaps settle **publicly** on the execution venue, so a watcher *can* lag-copy a leader *after* a trade
lands. CDR protects the signal *before* execution — the rule, the TP/SL, the next signal. The real moat is
**timing + automation + leak-proof forward signals**, not perfect privacy. The docs explicitly tell devs not
to over-claim privacy.

### 1.4 Hard rules — product invariants (NEVER violate)
These are enforced in code and are non-negotiable. If a task requires breaking one, STOP and flag it.

1. **SPOT ONLY.** No leverage, perps, shorting, margin, or borrowing — anywhere. The only on-chain action is
   a swap between two spot tokens. Enforced by: the absence of any `side`/`leverage`/`margin` field in
   `SignalSchema` (a comment forbids adding one); `CopyVault.executeSwap` being the single trading primitive;
   and the Hyperliquid executor's `assertSpotAsset(assetId >= 10000)` guard plus the deliberate absence of any
   `withdraw`/`usdSend`/`updateLeverage`/`usdClassTransfer` method.
2. **NON-CUSTODIAL.** The agent never holds, custodies, or can withdraw follower funds. On Arbitrum funds live
   in the follower's own `CopyVault` (only `owner` can `withdraw`); on Hyperliquid funds stay in the follower's
   own master account and the agent only gets a trade-only `approveAgent` grant. The agent has a *scoped
   executor role*, nothing more.
3. **CONFIDENTIALITY IS THE PRODUCT.** The strategy/TP/SL stays encrypted until decrypted inside the agent.
   Never write the plaintext strategy, take-profit, or stop-loss to any public on-chain location, log, or the
   frontend. The agent's logger is *structurally incapable* of logging a `Signal` or its TP/SL (allowlist by
   construction) — preserve that.
4. **TWO CHAINS, TWO ROLES.** Story L1 holds the encrypted strategy + access conditions + IP/royalty.
   The liquidity venue (Hyperliquid / Arbitrum) holds the funds + executes swaps. Don't try to execute swaps
   on Story (no real spot liquidity there).

---

## 2. Architecture

### 2.1 The three layers

| Layer | What it is | Reality |
|---|---|---|
| **L1 — Story Aeneid (chain 1315)** | Confidentiality + money: CDR vaults (encrypted signal), reused on-chain access conditions, Story IP Asset + PIL license (the decryption gate), `SubscriptionRegistry` (the payment + eligibility source of truth) | **Live.** Real CDR (no mock path). |
| **L2 — The Agent (off-chain Node daemon)** | Watches/receives a signal → decrypts in memory → checks active subscribers → sizes a spot entry per follower → executes the swap → monitors secret TP/SL and exits. Holds only a scoped executor key. | **Live.** Plain Node process; "TEE-ready" but **no TEE/attestation yet**. |
| **L3 — Liquidity venue** | Where the swap actually happens. **(a) Hyperliquid** spot (live demo path). **(b) Arbitrum `CopyVault`** (built, Foundry-tested, fork-only). | HL live; EVM fork-only. |

Why the split: Story has confidentiality + native licensing/royalty but no spot liquidity; the liquidity venue
has deep spot markets but no confidentiality; the agent is the trusted-but-minimized, non-custodial bridge.

### 2.2 End-to-end sequence (the *real* runtime flow)

**Setup (once per leader / follower):**
1. **Leader registers** their strategy as a **Story IP Asset**, attaches **PIL terms**, and mints **one
   operator License Token to the agent's CDR wallet**. In the live product this is the frontend hook
   `useRegisterLeader` (`apps/web/src/hooks/useStoryIp.ts`), which uses `@story-protocol/core-sdk` with the
   browser wallet. **Important:** the live PIL terms are attached with `defaultMintingFee: 0` and
   `commercialRevShare: 0` — **the License Token is purely the CDR decryption gate; it carries no price and
   routes no money.** Subscription revenue is entirely handled by `SubscriptionRegistry`.
2. **Leader creates a subscription plan** on `SubscriptionRegistry.createPlan(strategyId, payToken, monthlyPrice,
   platformFeeBps, username, displayName)` (Story L1).
3. **Follower subscribes** (`SubscriptionRegistry.subscribe(strategyId)`, paying `$WIP`) and **one-click
   authorizes the agent**: on Hyperliquid that's `approveAgent` (trade-only); on Arbitrum it would be
   creating a `CopyVault` + `setExecutor(agent)` + whitelist + cap (the EVM onboarding UI exists but is
   currently orphaned — see [§6.6](#66-orphaned--dead-frontend-code)).

**Per signal (repeats):**
4. **Leader publishes** a signal from the web app. The browser builds the `Signal` object and **POSTs it to the
   agent** at `POST {VITE_AGENT_API_URL}/signals/publish`. **Encryption is server-side in the agent**, never in
   the browser (the browser never holds CDR keys). The agent ABI-encodes the signal, threshold-encrypts it, and
   writes a **fresh CDR vault** on Story (read-gated to that leader's IP). It returns `{ uuid, txHashes: { allocate, write } }`
   — the two Story tx hashes are the public, verifiable "commit-before-outcome" proof.
5. **The publish call immediately triggers processing** (fire-and-forget `agent.processSignal(uuid)`). **There is
   no on-chain event watcher** (the docs claim one; it doesn't exist). The other trigger is the CLI:
   `pnpm --filter @sigmax/agent start <uuid>`.
6. Agent **decrypts** via `accessCDR`, presenting **all** license token ids it holds (so the on-chain read
   condition matches whichever leader's IP owns the vault — this is the multi-leader mechanism). Plaintext lives
   only in memory.
7. Agent re-validates the decoded signal with Zod, dedupes by `signalId`, drops stale ENTRYs (`expiresAt`).
8. Agent resolves **active followers** via `SubscriptionRegistry.isActive(follower, strategyId)` (or, in demo,
   `TRUST_CONFIGURED_FOLLOWERS=true` bypasses the check).
9. **Per follower (isolated):** read balance → `amountIn = balance × sizeBps / 10000`, clamped to the per-trade
   cap → quote with `minOut`/slippage → execute the swap (HL IOC order or `CopyVault.executeSwap`) → record the
   open position **with the secret TP/SL in memory only**.
10. The **TP/SL monitor** polls the venue price every `POLL_MS` (default 10s) and submits a **market exit** when
    `price >= takeProfitPrice` or `price <= stopLossPrice`. TP/SL are never written on-chain or logged.

---

## 3. The canonical data model — the Signal

**Source of truth:** [`packages/shared/src/signal.ts`](packages/shared/src/signal.ts). This is the contract
between leader, CDR, and agent. The design doc `docs/cdr-story/22-signal-template.md` is **stale** (it describes
a different, older schema) — the code below is authoritative.

```ts
// SignalSchema (Zod) — fields, with the secret ones marked
version          uint16   1..65535, default 1       // schema version
signalId         uuid                                // idempotency key (→ bytes16 on-chain)
strategyId       address                             // Story IP Asset (ERC-6551) addr; ALSO the read-gate target
chainId          uint32                              // liquidity chain id
venue            "arbitrum" | "hyperliquid"  default "hyperliquid"   // per-signal execution venue
action           "ENTRY" | "EXIT"
token            string                              // EVM address on arbitrum; spot coin SYMBOL ("HYPE") on HL
quoteToken       string                              // same venue-dependence
sizeBps          uint16   1..2000, default 500       // % of vault balance in bps — HARD-CAPPED at 2000 = 20%
maxEntryPrice    uint256-string  "0"=none            // "0" => market; non-zero => limit (HL only; ignored on Arbitrum)
takeProfitPrice  uint256-string  "0"=none   <-- SECRET (never on-chain plaintext / never logged)
stopLossPrice    uint256-string  "0"=none   <-- SECRET
issuedAt         uint64 (unix s)
expiresAt        uint64 (unix s)  0 = never
```

- **`PRICE_SCALE = 8`** — all prices are integers scaled by 10^8, in quote-token terms. Publisher and agent
  MUST agree on this.
- **SPOT-ONLY by construction:** there is intentionally no `side`/`leverage`/`margin` field. A comment in the
  file flags adding one as a hard-rule violation.
- **`superRefine`:** on `venue === "arbitrum"`, `token`/`quoteToken` must be EVM addresses; on `hyperliquid`
  they're spot coin symbols validated live against `spotMeta`.
- **Encoding:** `encodeSignal(Signal): Hex` (Zod-parse then `encodeAbiParameters` over `SIGNAL_ABI`) /
  `decodeSignal(Hex): Signal` (decode then **re-validate**). `venue` encodes as `uint8` (arbitrum=0,
  hyperliquid=1); `action` as `uint8` (ENTRY=0, EXIT=1); `signalId` packs to `bytes16`.
- **Size limit:** the ABI-encoded payload must stay **< 1024 bytes** (the CDR inline data-key limit on Aeneid).
  This is currently enforced only by a test (`packages/shared/test/signal.test.ts`), **not at runtime** — adding
  a long string field could silently break live uploads. *TODO: add a runtime length assert in `encodeSignal`.*

---

## 4. Repository map

```
story/  (root package name: "sigmax", private, pnpm@11, node >=22, Turborepo)
├── apps/
│   └── web/                         @sigmax/web — Vite + React 19 + TanStack Start (NOT Next.js)
├── packages/
│   ├── shared/                      @sigmax/shared — Signal schema, chains, addresses (the spine)
│   ├── cdr/                         @sigmax/cdr   — RealCdr: confidentiality core (wraps @piplabs/cdr-sdk)
│   ├── story/                       @sigmax/story — RealStoryIp/MockStoryIp: IP/PIL/license/royalty
│   ├── agent/                       @sigmax/agent — the off-chain executor daemon (+ HL & EVM executors, scripts)
│   └── contracts/                   Foundry — CopyVault, CopyVaultFactory, SubscriptionRegistry (no node pkg name)
├── docs/                            design docs (STALE in places — intent only; see §10)
├── brand/                           sigmax logo/icon SVGs
├── CLAUDE.md                        agent operating contract + the 4 hard rules + doc read-map
├── README.md                        authoritative current-state narrative (more accurate than docs/)
├── .env / .env.example              root env (PoC scripts + Foundry deploy)
└── sigmax.md                        ← THIS FILE
```

Conventions: pnpm workspaces (`packages/*`, `apps/*`); never cross-import between services except through
`@sigmax/shared`; viem (not ethers) for all EVM I/O; ESM throughout; packages run from `src/` via `tsx` (not
from `dist/`). `docs/business/`, `.claude/`, `.agents/`, `docs/story-docs.md` are git-ignored.

---

## 5. The contracts (`packages/contracts`, Solidity 0.8.24 + Foundry)

Exactly **3 source files**. No condition contracts were written (see [§5.4](#54-cdr-conditions--reused-not-written)).

### 5.1 `CopyVault.sol` — per-follower non-custodial spot vault
`contract CopyVault is ReentrancyGuard` (`using SafeERC20`).

State: `address public immutable owner` (the follower); `mapping isExecutor` (the agent(s));
`mapping tokenWhitelisted`; `mapping routerWhitelisted`; `uint256 perTradeCap` (max `amountIn` per swap);
`bool paused`.

Functions:
- `constructor(owner, executor, tokens[], routers[], cap)` — wires everything in one tx.
- Owner-only config: `setExecutor`, `setTokenWhitelist`, `setRouterWhitelist`, `setPerTradeCap`, `setPaused`.
- `deposit(token, amount)` — permissionless, but reverts `TokenNotWhitelisted` if token not whitelisted.
  **Emits no event** (frontend/indexers must read ERC-20 `Transfer` instead).
- `withdraw(token, amount)` — **`onlyOwner`. The only fund-exit path.** Emits `Withdrawn`.
- **`executeSwap(tokenIn, amountIn, tokenOut, minOut, router, swapData)` — `onlyExecutor nonReentrant`** —
  the single trading primitive. Guard chain (exact order): `paused` → both tokens whitelisted → router
  whitelisted → `amountIn <= perTradeCap` → measure `balBefore` → `forceApprove(router, amountIn)` →
  `router.call(swapData)` → `forceApprove(router, 0)` → `received = balAfter - balBefore` → `received >= minOut`
  → emit `Swapped(tokenIn, amountIn, tokenOut, received)`. **`minOut` is enforced on-chain via the measured
  balance delta**, independent of the off-chain quote.

> **Note the ABI arg order:** `(tokenIn, amountIn, tokenOut, minOut, router, swapData)`. `docs/execution/41`
> shows a different order — the **code is authoritative**.

### 5.2 `CopyVaultFactory.sol`
`mapping(address => address) public vaultOf`; `createVault(executor, tokens[], routers[], cap)` deploys one
deterministic vault per follower via **CREATE2, salt = the follower address**, reverts `"VAULT_EXISTS"` on a
second call, emits `VaultCreated(owner, vault)`.

### 5.3 `SubscriptionRegistry.sol` — the money + eligibility source of truth (Story L1)
`contract SubscriptionRegistry is ReentrancyGuard`. Constants: `PERIOD = 30 days`, `GRACE = 2 days`,
`MAX_FEE_BPS = 3000` (30% ceiling), `BPS_DENOMINATOR = 10000`. Immutable `platformTreasury`.

- `struct Plan { address leader; address payToken; uint256 monthlyPrice; uint16 platformFeeBps; bool active; }`
- `struct Sub { uint64 expiry; uint64 startedAt; uint32 renewals; }`
- **`strategyId` is an `address`** (the Story IP Asset / ERC-6551 address), matching `SignalSchema.strategyId`
  and the CDR read-condition encoding. (`docs/contracts/12` still says `uint256` — stale.)

Functions: `createPlan(strategyId, payToken, monthlyPrice, platformFeeBps, username, displayName)` (caller
becomes leader; `username`/`displayName` are **emitted only, not stored** — clients discover leaders by scanning
`PlanCreated`); `setPlanActive` / `setMonthlyPrice` (`onlyLeader`); **`subscribe(strategyId)`** (checks-effects-
interactions, `nonReentrant`: writes expiry first, then pulls `monthlyPrice` and splits `fee = price*platformFeeBps/10000`
→ treasury, remainder → leader; early renewals stack onto the current expiry); **`cancel(strategyId)`** (sets
`expiry = 0` immediately, no refund — added 2026-06-03, which forced a registry redeploy); `isActive(subscriber,
strategyId)` (`expiry != 0 && now <= expiry + GRACE` — the gate the agent reads before every entry);
`expiryOf(subscriber, strategyId)`.

> **The 85/15 revenue split happens here, at pay time** — NOT via the Story Royalty Vault. The Royalty-Vault
> split that `docs/21`/`docs/00` describe is **unbuilt and deferred**. `RealStoryIp.claimRevenue` hardcodes
> `platformAmount: 0n`. Don't expect the Royalty Vault to hold subscription money.

### 5.4 CDR conditions — reused, NOT written
Sigmax wrote **zero** Solidity condition contracts. It reuses two **pre-deployed** Story CDR condition contracts:
`OwnerWriteCondition` (`0x4C9b…c34B`) and `LicenseReadCondition` (`0xC064…f7a3`). The custom
`SubscriptionReadCondition`/`LeaderWriteCondition` in `docs/contracts/11` are aspirational. This means on-chain
**decrypt access is gated by holding a license token** (Option A), and the *subscription expiry* governs only
the agent's **execution eligibility**, not on-chain decrypt access.

### 5.5 Deploy scripts
Only **`script/DeploySubscriptionRegistry.s.sol`** exists (reads `STORY_IP_KEY` + `PLATFORM_TREASURY`).
**Must run with `--legacy`** (Story RPC rejects EIP-1559). **There is NO deploy script for
CopyVault/CopyVaultFactory** — they're deployed ad-hoc via `forge create` onto an Anvil fork. *This is a
handoff gap: the live `FACTORY_ADDRESS` has no deploy script or broadcast artifact, and the fork is ephemeral.*

### 5.6 Test coverage (Foundry)
**28 tests total**, all passing: `SubscriptionRegistry.t.sol` 15 (offline), `CopyVaultFactory.t.sol` 6 (offline),
`CopyVault.t.sol` 7 (**fork-only**). ⚠️ **`CopyVault.t.sol` `setUp()` reverts off-fork** (it uses `deal` on real
Arbitrum USDC), so plain `forge test` reports a failing suite (21/22). **CI must run
`forge test --fork-url $ARBITRUM_RPC_URL`.** Not tested: reentrancy/malicious-router, `setPaused`-blocks-swap,
`RouterNotWhitelisted` revert, any CDR-condition behavior.

---

## 6. The frontend (`apps/web`)

### 6.1 Stack & origin
**Lovable.dev–generated TanStack Start (SSR) app** — NOT the Next.js the design doc describes. React 19.2,
`@tanstack/react-router` + `@tanstack/react-start`, `@tanstack/react-query` 5, **wagmi 2 + viem 2 + RainbowKit
2**, `@story-protocol/core-sdk` 1.4.4, `@nktkas/hyperliquid` 0.32.2, **Tailwind v4 + shadcn/ui**, `sonner`,
`recharts`, `react-hook-form`, Zod. Vite 7 + Nitro. Build via `@lovable.dev/vite-tanstack-config`
(`vite.config.ts`). `wagmiConfig` registers `[storyAeneid, arbitrum]`, `ssr: true`.

### 6.2 Routes (`src/routes/`, file-based)
| URL | What |
|---|---|
| `/` | Landing hero + trust pillars (static). |
| `/leaderboard` | Marketplace: discovers all leaders on-chain via `useLeaders()`; grid/table, search, sort. |
| `/leader` | Leader dashboard. `LeaderLive` vs `LeaderMock` based on `chainConfigReady && isConnected`. Publish form here. |
| `/follower` | "My subscriptions" dashboard (Hyperliquid-centric): HL balance, copied leaders, per-leader unsubscribe, "Revoke all access" kill-switch. |
| `/strategy/:id` | Public strategy page: header + FIFO track record + `SubscribeCard` (one-click `useCopyTrade`). |

No API route handlers / no Supabase / no backend — **all reads are direct on-chain via viem from the browser**.

### 6.3 Leader publish flow
`PublishSignalForm.tsx`: Action (ENTRY/EXIT), **Venue** toggle (Hyperliquid/Arbitrum), token picker (for HL,
`HlPairCombobox` over every live HL market), **size slider clamped 1–20%**, order type MARKET/LIMIT (ENTRY only),
an **"Encrypted — never visible to followers"** block holding TP/SL (cleared from React state immediately after
publish), slippage, expiry. `usePublishSignal` builds the `Signal` and **POSTs it to the agent**
(`/signals/publish`, header `x-leader-address`). If `VITE_AGENT_API_URL` is unset, publish stays mock. On
success it shows a "Published" chip linking the **`signal`** (write tx) and **`vault`** (allocate tx) on the
Story explorer, and stores non-secret metadata (`signalId`, `uuid`, `action`, timestamp, txHashes) in
`localStorage` only.

### 6.4 Follower subscribe flow (one-click, Hyperliquid)
`SubscribeCard` → `useCopyTrade(id).start()` does, in one chain: (1) `subscribe()` on `SubscriptionRegistry`
(approving `$WIP` if needed), then (2) `approveAgent` on Hyperliquid (if `VITE_HL_AGENT_ADDRESS` set & not
already approved). Phases: `idle → subscribing → authorizing → idle`. "Revoke all access" re-approves the same
agent name with a throwaway burner address (HL treats same-named agent as a replacement). **viem revert handling
is load-bearing** — `subscribe`/`cancel` explicitly check `rcpt.status === "reverted"` because viem resolves
(does not throw) on revert.

### 6.5 On-chain data & self-serve registration
`useLeaders()` discovers leaders entirely from chain (`PlanCreated` + `Subscribed` events) and computes each
leader's track record as **FIFO realized PnL** from each subscriber vault's `Swapped` events (degrades
gracefully if the execution chain is unreachable). `useRegisterLeader` (`useStoryIp.ts`) is the fully self-serve
on-chain leader onboarding (registerIP → registerPILTerms+attach → mintLicense to agent → `createPlan`), using a
dynamically-imported, `process.cwd`-shimmed Story SDK. Seeded `testLeaders` are always appended (flagged "Test");
`mockLeaders` are the disconnected fallback.

### 6.6 Orphaned / dead frontend code
The original **Arbitrum CopyVault** onboarding flow is fully coded but **imported by nothing** (superseded by
the Hyperliquid flow): components `CreateVaultCard`, `DepositCard`, `AuthorizeAgentCard`, `Stepper`,
`FundStatusCard`, `RevokeControl`, `RevokePauseControls`; hooks `useVault`, `useBalances`, `useVaultControls`,
`usePositions`, `useLeaderPlan`, `useStrategyPerformance`. **Decision needed:** delete them, or revive them to
finish the Arbitrum venue. They still compile and pull in the `COPY_VAULT_*` ABIs.

---

## 7. Deployment & config cheat-sheet

### 7.1 Chains & fixed addresses (`packages/shared/src/{chains,addresses}.ts`)

- **Story Aeneid:** chain id **1315**, RPC `https://aeneid.storyrpc.io`, explorer `https://aeneid.storyscan.io`,
  native currency `IP`.
- **Arbitrum One:** chain id **42161**, RPC `https://arb1.arbitrum.io/rpc`. Demoed via a local Anvil fork
  (`anvil --fork-url https://arb1.arbitrum.io/rpc --port 8545`).
- **CDR Story-API (`apiUrl`):** `http://172.192.41.96:1317` — **a raw HTTP IP that "may change between
  deployments."** Single point of failure for all decrypts; check it first if CDR breaks.

| Story Aeneid constant | Address |
|---|---|
| `wip` ($WIP token) | `0x1514000000000000000000000000000000000000` |
| `ipAssetRegistry` | `0x77319B4031e6eF1250907aa00018B8B1c67a244b` |
| `licensingModule` | `0x04fbd8a2e56dd85CFD5500A4A4DfA955B9f1dE6f` |
| `pilTemplate` | `0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316` |
| `royaltyModule` | `0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086` |
| `licenseToken` (ERC-721) | `0xFe3838BFb30B34170F00030B52eA4893d8aAC6bC` |
| `ownerWriteCondition` (CDR) | `0x4C9bFC96d7092b590D497A191826C3dA2277c34B` |
| `licenseReadCondition` (CDR) | `0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3` |
| `spgNftDefault` (SPG NFT collection) | `0xc32A8a0FF3beDDDa58393d022aF433e78739FAbc` |
| Arbitrum `usdc` (native) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Arbitrum `weth` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| Uniswap SwapRouter02 (in vault tests) | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |

### 7.2 Live deployed instances (public addresses)

| What | Value | Notes |
|---|---|---|
| **SubscriptionRegistry** (Story L1) | `0x46B5acc9006CA5a609B122aa10bE64841464d242` | Redeployed 2026-06-03 to add `cancel()`. **Plans/subs at the old `0xB87483f12388e97Abd0Cb6329814efA8bd542B96` are orphaned** — re-`createPlan` + re-`subscribe` for any demo. |
| **CopyVaultFactory** (Arbitrum fork) | `0x4C7D20565687A308135a7B38eA0b26a5e292B4c4` | **Ephemeral** — dies on `anvil` restart; no deploy script/broadcast exists. |
| **Strategy IP id** (`STRATEGY_IP_ID`) | `0xE454Ba72093007d514AB3DDbc1caB11581227f3C` | licenseTermsId 2840. |
| **Operator License Token id** | `72680` | The live decryption gate (agent has also discovered `72755`, `72781` → 3 licenses on boot). |

### 7.3 Wallet topology — THE three wallets

> **NOT single-wallet.** Older memory notes saying "single-wallet" are stale. Verify which wallet holds license
> `72680` before relying on any of these for a redeploy.

| Wallet | Address | Role | Derived from |
|---|---|---|---|
| **CDR / license / leader** | `0xfddE1Ae513448669a5Cb47AFdB576b7903f57f61` | Holds operator licenses; signs CDR allocate/write/read; registers IP/PIL; deploys/owns the registry & is treasury in the live HL config. = web `VITE_AGENT_ADDRESS`. | `CDR_KEY` (= `STORY_IP_KEY`), key in root `.env` & `packages/agent/.env` |
| **Hyperliquid signer** | `0xC22615B78021218591160DDF67A4446a449D2c32` | Signs HL spot IOC orders only; holds no funds, no licenses. = web `VITE_HL_AGENT_ADDRESS`. | `HYPERLIQUID_AGENT_PK` (falls back to `AGENT_PK`) in `packages/agent/.env` |
| **Root-`.env` agent/treasury** | `0x3d244593294aB2eF8DD2Cd74Dbc86374cc780170` | Root `.env` `AGENT_ADDRESS` == `PLATFORM_TREASURY` — the license-mint target / treasury used by the **PoC scripts** path. **Likely a stale leftover** from an earlier single-wallet setup (≠ the web `VITE_AGENT_ADDRESS`). | root `.env` |

### 7.4 Which process loads which `.env` (critical)

| Process | Command | `.env` loaded | Resulting venue |
|---|---|---|---|
| **Agent daemon (live)** | `pnpm --filter @sigmax/agent start` → `tsx --env-file=.env src/main.ts` | **`packages/agent/.env`** | **`EXECUTION_VENUE=hyperliquid`** |
| PoC scripts (`poc-story`, `poc-cdr`, `sub-*`, `hl-*`) | `tsx scripts/…` reading `process.env` | the shell's env (typically root `.env`) | n/a |
| Foundry deploy | `forge script … DeploySubscriptionRegistry --legacy` | root `.env` (`STORY_IP_KEY`, `PLATFORM_TREASURY`) | n/a |
| Web app | `pnpm --filter @sigmax/web dev` | `apps/web/.env` (build-time `VITE_*`) | n/a |

### 7.5 Live `packages/agent/.env` values (non-secret, verified)
`EXECUTION_VENUE=hyperliquid` · `HYPERLIQUID_TESTNET=true` · **`HYPERLIQUID_PER_TRADE_CAP=50000000000` (= $500
in 1e8 units — NOTE: the `.env.hl.example` shows `1500000000` = $15; the live file is $500)** ·
`HYPERLIQUID_TOKENS={"0x82aF…(WETH)":"PURR","0xaf88…(USDC)":"USDC"}` (legacy address→symbol override still in
use: maps the web's WETH publishable token to HL-testnet "PURR") · `TRUST_CONFIGURED_FOLLOWERS=false` ·
`FOLLOWERS=` (empty → relies on real on-chain subscriptions) · `POLL_MS=10000` · `DEFAULT_SLIPPAGE_BPS=100` (1%)
· `HTTP_PORT=8787` · `WEB_ORIGIN=http://localhost:5173,http://localhost:8080`. Keys present: `AGENT_PK`,
`CDR_KEY`, `HYPERLIQUID_AGENT_PK`.

### 7.6 Full env var reference (names + purpose; values never shown)

**Agent (`packages/agent/src/config.ts`, Zod, never logged):**
`AGENT_PK` (executor key — bounded swap only, never withdraws) · `CDR_KEY` (decrypt key; CDR wallet holds the
operator licenses) · `STORY_API_URL` (CDR DKG REST base, **required**) · `STORY_RPC_URL` (Story L1 RPC,
**required**) · `LIQUIDITY_RPC_URL` (forked Arbitrum RPC — required iff venue=arbitrum) · `REGISTRY_ADDRESS`
(**required**) · `FACTORY_ADDRESS` (required iff venue=arbitrum) · `STRATEGY_IP_ID` (optional seed) ·
`OPERATOR_LICENSE_TOKEN_ID` (optional seed for license discovery) · `EXECUTION_VENUE` (`arbitrum|hyperliquid`,
**schema default `arbitrum`**) · `ZEROX_API_KEY` (optional 0x v2 key) · `LIQUIDITY_CHAIN_ID` (default 42161) ·
`HYPERLIQUID_TESTNET` (default true; only `false`/`0`/`""` disable — `z.coerce.boolean` footgun handled
manually) · `HYPERLIQUID_AGENT_PK` (falls back to `AGENT_PK`) · `HYPERLIQUID_PER_TRADE_CAP` (1e8 USD units,
required iff venue=hyperliquid) · `HYPERLIQUID_TOKENS` (optional JSON addr→symbol override) ·
`TRUST_CONFIGURED_FOLLOWERS` (DEMO bypass of `isActive`, default false) · `FOLLOWERS` (CSV) · `POLL_MS`
(default 10000) · `DEFAULT_SLIPPAGE_BPS` (default 100, range 1–10000) · `STATE_PATH` (optional JSON persist
path for **non-secret** position metadata) · `HTTP_PORT` (default 8787) · `WEB_ORIGIN` (CORS allowlist).

**Root `.env` (PoC scripts + Foundry deploy):** `STORY_RPC_URL`, `STORY_API_URL`, `CDR_KEY`, `STRATEGY_IP_ID`,
`OPERATOR_LICENSE_TOKEN_ID`, `STORY_IP_KEY` (leader: registers IP, deploys registry, pays $WIP fees),
`AGENT_ADDRESS` (license-mint target), `PLATFORM_TREASURY`, `ARBITRUM_RPC_URL`, `LIQUIDITY_RPC_URL`,
`LIQUIDITY_CHAIN_ID`, `FACTORY_ADDRESS`, `REGISTRY_ADDRESS`, `AGENT_PK`, `ZEROX_API_KEY`, `HTTP_PORT`,
`WEB_ORIGIN`, `MONTHLY_PRICE_WIP` (1), `REV_SHARE_BPS` (1500).

**Web (`apps/web/.env`, all `VITE_*`):** `VITE_REGISTRY_ADDRESS`, `VITE_FACTORY_ADDRESS`, `VITE_STRATEGY_IP_ID`,
`VITE_AGENT_ADDRESS` (= CDR wallet), `VITE_HL_AGENT_ADDRESS` (= HL signer; follower approves it),
`VITE_HL_TESTNET`, `VITE_AGENT_API_URL` (agent publish endpoint; unset → publish stays mock), `VITE_ROUTERS`,
`VITE_PLATFORM_FEE_BPS` (default 1500), `VITE_LIQUIDITY_RPC_URL`, plus optional `VITE_*_RPC_URL`,
`VITE_WIP/USDC/WETH_ADDRESS`, `VITE_WALLETCONNECT_PROJECT_ID` (default `"sigmax-demo"`), `VITE_STRATEGY_NAME`.
Readiness gates: `chainConfigReady = registry && factory && strategyIp && agentAddress`;
`hlConfigReady = registry && strategyIp && hlAgentAddress`. When unready/disconnected → UI renders **mock data**.

> **`.env.example` files are stale/incomplete:** the root `.env.example` is missing every HL/venue var; there is
> **no `packages/agent/.env.example`** (only `.env.hl.example`); `apps/web/.env.example` omits
> `VITE_HL_AGENT_ADDRESS`/`VITE_HL_TESTNET`/`VITE_STRATEGY_NAME`. Don't treat them as runnable as-is.

---

## 8. How to run it (canonical runbook)

There are two tracks. **Track A (Hyperliquid) is the live, recommended demo.** Track B (Arbitrum) is for devs.

### Prereqs
`pnpm install` at root; Node ≥22; Foundry (for contracts); a funded Aeneid wallet (native `IP` for gas + `$WIP`
for license/subscription fees); for HL, a Hyperliquid **testnet** account with USDC.

### Track A — Hyperliquid (live)
1. **Generate the HL agent key:** `pnpm --filter @sigmax/agent exec tsx scripts/hl-gen-agent.ts` → prints
   `HL_AGENT_ADDRESS` (public, to approve) + `HYPERLIQUID_AGENT_PK` (secret → into `packages/agent/.env`).
2. **Follower approves the agent (non-custodial onboarding):** `tsx scripts/hl-approve.ts` — the follower's
   *master* wallet signs `approveAgent` (trade-only). TTL encoded in the agent name (script default
   `HL_TTL_DAYS=1`; the web flow uses 30 days). ⚠️ when the TTL expires, trades silently fail — no auto-renewal.
3. **Set up Story IP + license + plan** (once): run `pnpm --filter @sigmax/story poc` (`poc-story.ts`) to
   register the IP, attach PIL terms, and mint the operator license to the agent's CDR wallet — it prints
   `STRATEGY_IP_ID` + `OPERATOR_LICENSE_TOKEN_ID` to wire in. Then `tsx scripts/sub-create-plan.ts` (leader
   creates the plan; **legacy tx**). (Or do leader registration via the web `/leader` page.)
4. **Eligibility:** either followers run `tsx scripts/sub-subscribe.ts` (real on-chain subscription), **or** set
   `TRUST_CONFIGURED_FOLLOWERS=true` + `FOLLOWERS=0x…` in `packages/agent/.env` for a fast demo (⚠️ payment
   bypass — never in prod).
5. **Start the agent:** `pnpm --filter @sigmax/agent start` → boots, discovers held licenses, starts the TP/SL
   monitor, serves `GET /health` + `POST /signals/publish` on `:8787`.
6. **Publish a signal:** either the web `/leader` publish form, or `tsx scripts/hl-publish.ts` with env knobs
   `HL_TOKEN` (e.g. `HYPE`), `HL_QUOTE` (`USDC`), `HL_ACTION` (`ENTRY`), `HL_SIZE_BPS` (≤2000), `HL_MAX_ENTRY`
   (0=market), `HL_TP`/`HL_SL` (human USD, scaled ×1e8 by the script). The agent encrypts → publishes the CDR
   vault → decrypts → executes the IOC order for each active follower → monitors TP/SL.
7. **Web app:** `pnpm --filter @sigmax/web dev` (point `apps/web/.env` at the deployed addresses + agent URL).

### Track B — Arbitrum / EVM (built, fork-only)
1. `anvil --fork-url https://arb1.arbitrum.io/rpc --port 8545`.
2. Deploy `CopyVaultFactory` via `forge create` (⚠️ **no script exists** — do it by hand), put its address in
   `FACTORY_ADDRESS` / `VITE_FACTORY_ADDRESS` (re-do after every anvil restart).
3. Deploy `SubscriptionRegistry` on Story: `forge script script/DeploySubscriptionRegistry.s.sol --legacy …`.
4. Set `EXECUTION_VENUE=arbitrum` + `LIQUIDITY_RPC_URL=http://127.0.0.1:8545` + `FACTORY_ADDRESS`; the EVM
   onboarding UI is currently orphaned, so vault create/deposit/authorize must be scripted.
5. Publish a signal with `venue: "arbitrum"` and EVM token addresses.

### Deployment history / decision (discussed)
Hosted deployment (Railway, then Vercel) was **explored and then cancelled — reverted to local development**.
Reasons captured: the agent is a **long-running daemon** (incompatible with Vercel serverless); the web app is
**TanStack Start SSR** (needs a Node server; a static-SPA build emitted `_shell.html` instead of `index.html`).
Current posture: **run everything locally** for the demo. `DEPLOY-RAILWAY.md` notes and config tweaks were
reverted. If hosting is revisited: agent → a always-on container (Railway/Fly/a small VM); web → a Node SSR host
or fix the SPA build; the Anvil fork can't be hosted ephemerally (use a persistent fork or skip the EVM track).

---

## 9. Tests & verification surface

- **Vitest: 60 tests pass** across packages — `shared` 7, `story` 3 (mock-only), `cdr` 2 (offline), `agent` 48.
  Agent suite: `sizing` 3, `hyperliquid-meta` 20, `hyperliquid-executor` 4, `pipeline` 8, `redaction` 1,
  `state` 2, `tpsl` 7, `agent-boot` 3. Run: `pnpm -r test` or `pnpm --filter @sigmax/agent test`.
- **The strongest evidence in the project:** the agent suite asserts the invariants directly —
  - SPOT-ONLY: `assertSpotAsset` accepts ids ≥10000 / rejects <10000; the HL executor exposes no
    `withdraw`/`usdSend`/`spotSend`/`agentSendAsset`/`updateLeverage`/`usdClassTransfer`.
  - NON-CUSTODIAL: HL `vaultOf(follower) == follower` (the follower's own account is the "vault").
  - CONFIDENTIALITY: `redaction.test.ts` runs the full entry→TP-exit loop and asserts neither the logs nor the
    persisted state file ever contain the TP/SL values or even the field names; `state.test.ts` proves secrets
    are never persisted (re-derived from CDR on `reconcile`).
- **Foundry: 28 pass** — but **only with `--fork-url`** (see [§5.6](#56-test-coverage-foundry)).
- **What's NOT tested (real gaps):** the **live confidentiality guarantee** is only proven against `FakeCdr`,
  never `RealCdr`; `ZeroExExecutor.quoteAndSwap` (real 0x quote + on-chain `executeSwap`) — 0 tests;
  `HyperliquidExecutor` live order placement — 0 tests; `server.ts` (the `POST /signals/publish` + CORS path) —
  0 tests; `subscribers.ts`, `licenses.ts`, `price.ts`, `hyperliquid/price.ts` — 0 tests. No `vitest.config.ts`,
  no coverage gate.

---

## 10. Design vs Reality master table

The design docs are intent; the code is truth. Biggest divergences a continuing dev must internalize:

| Topic | Docs say | Reality |
|---|---|---|
| **Execution venue** | Arbitrum/Base CopyVault + 0x/CoW | **Hyperliquid is the live primary venue** (`@nktkas/hyperliquid`, IOC, `approveAgent`); Arbitrum is built but fork-only. HL is **absent from docs 00–03/40–42**. |
| **Web framework** | Next.js (App Router) on Vercel | **Vite + React 19 + TanStack Start (SSR)**, Lovable-generated. No `next` dependency. |
| **CDR encryption location** | client-side in the browser | **server-side in the agent** (`POST /signals/publish` → `RealCdr`); browser never holds CDR keys. |
| **`CDR_MODE` switch** | implied real/mock toggle (and a user memory note) | **Does not exist in code.** The agent hardcodes `RealCdr`. No mock CDR in `packages/cdr` (deleted in commit `a5df153`). The only test double is `FakeCdr` in agent tests. Switching to mock = a code change. |
| **Revenue split** | via Story Royalty Vault (85/15 royalty tokens) | **In `SubscriptionRegistry.subscribe` at pay-time.** `claimRevenue` hardcodes `platformAmount: 0n`; live PIL terms are fee 0 / revShare 0. Royalty-Vault split is deferred. |
| **PIL / License Token** | the subscription itself (pays into royalty vault) | **Purely the CDR decryption gate** (zero-priced). Subscription = `SubscriptionRegistry`, a separate contract. |
| **CDR condition contracts** | custom `SubscriptionReadCondition`/`LeaderWriteCondition` Solidity | **None written.** Reuses pre-deployed Story `OwnerWriteCondition` + `LicenseReadCondition` (Option A). |
| **Access control** | OZ `AccessControl` + `EXECUTOR_ROLE` | Plain `mapping isExecutor`/`isOwner` + custom modifiers (+ a router whitelist not in the docs). |
| **Daily cap** | `dailyCap` rolling 24h bucket | **Not implemented.** Only `perTradeCap`. Re-add candidate. |
| **Agent infra** | BullMQ + Redis + Supabase + event watcher + pino | **None.** In-memory `Map`/`Set`, `setInterval` poller, Node `http`, bespoke allowlist logger. **No on-chain event watcher** — publish/CLI triggers processing. |
| **`strategyId` type** | `uint256` (docs 11/12) | `address` (ERC-6551 IP Asset). |
| **TEE** | "runs in a TEE with attestation" | **Aspirational.** Plain Node daemon; no Dockerfile, no attestation. Confidentiality rests on threshold encryption + redaction discipline. |
| **Single-leader / single-wallet** | one leader, one strategy | **Multi-leader** (license discovery) + **three wallets**. |
| **`$10` min notional** | (prompt assumption) | Implemented **only** in the HL `planSpotOrder` (rejects orders < $10); the generic pipeline has **no min-notional floor** (only zero-size skip). |
| **Limit entries (`maxEntryPrice`)** | — | **HL only.** `ZeroExExecutor` accepts but ignores it (Arbitrum is market-only). Exits are always market. |
| **`forge test`** | passes | **fails off-fork** (CopyVault `setUp` needs `--fork-url`). |

When you reconcile any of these, update the relevant `docs/` file and log the delta in
`docs/business/94-risks-and-unknowns.md` (the project's living risk register).

---

## 11. Gotchas & footguns (operational)

1. **Story RPC rejects EIP-1559.** Every Story L1 write must send a **legacy tx** (`--legacy` for forge/cast;
   the `sub-*` scripts supply `gasPrice` explicitly). viem/Story SDKs are fine; `forge`/`cast` are not.
2. **CDR `network` must be `"testnet"` for Aeneid — never `"aeneid"`.** (In-code comments saying "aeneid
   expected" are misleading; the correct value is `"testnet"`. This bit the team before.)
3. **`STORY_API_URL` is a raw HTTP IP** (`http://172.192.41.96:1317`, "may change"). If decrypts fail, check
   this first. Single point of failure, no fallback.
4. **The Anvil fork is ephemeral** — `CopyVaultFactory` dies on restart; re-deploy + re-fill
   `FACTORY_ADDRESS`/`VITE_FACTORY_ADDRESS`.
5. **The registry was redeployed** (`0x46B5…d242`); old plans/subs (`0xB874…2B96`) are orphaned, and **old CDR
   vaults are incompatible** with the new per-venue signal tuple. For any demo: re-`createPlan`, re-`subscribe`,
   re-publish.
6. **`TRUST_CONFIGURED_FOLLOWERS=true` is a payment bypass** (skips `isActive`). Demo only; must be `false` in
   prod (it is, in the live `.env`).
7. **`STATE_PATH` is unset in the live `.env`** → no persistence: positions, idempotency, and TP/SL recovery are
   **lost on restart**. Production must set it (and note `persist()` is non-atomic — a crash mid-write could
   truncate the file).
8. **`POST /signals/publish` has no auth beyond CORS.** Anyone who can reach the port can publish + execute a
   signal. The TEE/network isolation assumed in the design is not enforced here.
9. **`listFollowers` and `LicenseDiscovery` scan `fromBlock:"earliest"` every call** — O(history); will hit RPC
   log-range limits at scale. Needs a block cursor/cache.
10. **Arbitrum price source has ONE hardcoded Chainlink feed** (WETH→ETH/USD). Any other Arbitrum token's TP/SL
    exit throws "no price feed configured." Arbitrum TP/SL is effectively WETH-only today.
11. **HL `approveAgent` TTL** (script default 1 day, web 30 days) — when it expires, trades silently fail; no
    auto-renewal. Reconcile the TTL discrepancy.
12. **HL `received` on sells is approximate** (computed from fill avg price, not a balance read). HL units are
    `quantity × 1e8` (uniform USD units), NOT ERC-20 smallest units — mixing the two across venues would
    silently mis-size.
13. **Stale `packages/cdr/dist/mock.*` artifacts** still reference `MockCdr` — harmless (package runs from
    `src/`) but misleading; delete them.
14. **`HYPERLIQUID_TESTNET=0`** is the only safe way to point HL at mainnet (string-parse footgun).
15. **WalletConnect projectId defaults to `"sigmax-demo"`** — fine for injected wallets, but mobile pairing
    needs a real `VITE_WALLETCONNECT_PROJECT_ID`.

---

## 12. Known bugs, open questions & what's left (TODO backlog)

### 12.1 Known bugs / fragile windows (carry forward)
- **`executor.ts` `received = balAfter - balBefore`** — corruptible by concurrent same-vault activity.
  Production fix: read the `Swapped` event from the receipt.
- **Pipeline crash window** between swap landing and `persist()` — small unguarded double-entry risk; v2 fix is
  an on-chain per-signal nonce. Acceptable at demo scale.
- **No retry/backoff on `accessSignal` decrypt** — a single failure logs `decrypt_failed` and **drops the whole
  signal**.
- **`ReadConditionDenied` detection is string-matching** on the error message — brittle; prefer matching SDK
  error types.

### 12.2 Open questions (discussed, not yet decided — from `docs/94 §7`)
- Mirror subscription eligibility on the L2 (self-gating vault) vs the current trusted-relayer model?
- Fresh-vault-per-signal (current: `updatable:false`) vs one updatable vault — confirm permanent.
- Exact exit-slippage policy (currently entry and exit share `defaultSlippageBps`; doc 41 wanted looser exits).
- Clamp-to-cap vs skip when a follower's size > cap (code **clamps**; confirm).

### 12.3 Must-fix-before-mainnet (from `docs/82` + risk register)
- Add a **deploy script** for `CopyVault`/`CopyVaultFactory` (+ a persistent liquidity-chain deployment).
- **On-chain eligibility guard** at swap time (don't rely solely on the relayer reading `isActive`).
- `createPlan` should **verify the caller owns the Story IP** (anti-squatting).
- `setMonthlyPrice` front-running protection (max-price / timelock).
- Per-router **recipient validation** on `executeSwap`.
- **Real TEE + attestation** (Phala TDX) for the agent.
- **Re-add `dailyCap`** (defense against a compromised executor doing unlimited per-trade-cap-sized churn).
- **Contract audit** (gated behind validated demand — see roadmap).
- Update the stale design docs + log deltas in `docs/94`.
- **Decide the README working-tree change** (a staged edit dropped the "Roadmap"/"Security model"/"Deployed
  addresses" sections — commit or restore; the roadmap content is preserved in [§14](#14-forward-roadmap-from-the-readme-roadmap-section)).
- Clean up orphaned frontend code ([§6.6](#66-orphaned--dead-frontend-code)) and stale `dist/mock.*`.

---

## 13. Business & GTM context (for product reasoning)

> Docs `docs/business/90`–`94` (git-ignored, local only) still use the old name "AlphaVault." Names are
> interchangeable.

- **Revenue model:** **monthly subscription** first; platform takes a cut of subscription revenue (default
  **1500 bps = 15%**; contract ceiling **3000 bps = 30%**). Performance-fee model is **post-MVP** (needs an
  on-chain PnL ledger with high-water marks that doesn't exist yet).
- **Unit economics (illustrative):** leader prices $20–$50/mo; at $30/mo the platform earns ~$4.50/follower/mo.
  20 followers ≈ $90/mo; 50 ≈ $225; 200 ≈ $900; 1000 ≈ $4,500. **Infra break-even ≈ 45–55 paying followers.**
- **Costs:** MVP ~$0 (testnet/fork). At launch: TEE (Phala TDX) ~$100/mo; RPC $0–$199; web/host $20–$45; gas
  wallet $5–$100. One-time audit **$6k–$18k** — deliberately gated behind demand proof.
- **Roadmap (5 gated stages, no calendar):** Stage 0 Hackathon → Stage 1 Validate demand free (testnet/fork —
  **gates the audit spend**) → Stage 2 Production-harden (TEE + audit) → Stage 3 Mainnet soft launch (**KPI: 20
  paying followers**) → Stage 4 Break-even (~50 followers, ≥3 leaders) → Stage 5 Growth (perf-fee, Base, "IPFi").
- **GTM wedge (most important strategic input):** the first 20 users come from landing **1–2 leaders**, not cold
  follower acquisition. Primary channel = the **Muslim crypto-trader community**, where Sigmax's
  spot-only/no-leverage/no-interest constraint is a genuine fit — plus the leak-proof (protects leader revenue)
  and verifiable-track-record (anti-scam) angles. Top of funnel: a **free, shareable verifiable-track-record
  tool** before any paid auto-copy. Founder-led onboarding; skip paid ads. First 20 = validation, not break-even.
- **Legal flags (unaddressed, "not legal advice"):** never promise returns; signals-selling regulation;
  money-transmission/custody; securities framing of any royalty-token "IPFi"; AML/KYC at fiat ramps; never store decrypted
  signals.

---

## 14. Forward roadmap (from the README "Roadmap" section)

Captured here because a staged README edit removed this section from the working tree (it still lives in the
last commit). These are the **planned, not-yet-built** directions, in the owner's words/intent:

1. **Decentralized signal-validation model** — validate every signal *before* followers copy it: token TVL /
   on-chain activity, legitimacy, a risk/panic score, sentiment. Goal: neutralize a leader pumping an illiquid
   token and dumping on followers. (This is a notable new product direction the owner wants.)
2. **More venues:** **DeepBook on Sui** as an added execution venue; **Base** as a second EVM chain.
3. **Native exchange-level TP/SL** to replace the off-chain polling loop (lower latency, more robust).
4. **Batched / atomic fan-out** (CoW-style) to mitigate front-running and the aggregated-trade-history leakage
   at scale.
5. **Production TEE** (Phala TDX) with remote attestation for the agent.
6. **Session-key onboarding** (EIP-7702 / ERC-4337) for smoother, safer follower authorization.
7. **Contract audit + mainnet launch.**
8. **Subscription auto-renewal.**

---

## 15. Quick reference — key files for the next agent

- **Signal schema (data contract):** [`packages/shared/src/signal.ts`](packages/shared/src/signal.ts)
- **Chains & addresses (source of truth):** [`packages/shared/src/chains.ts`](packages/shared/src/chains.ts),
  [`packages/shared/src/addresses.ts`](packages/shared/src/addresses.ts)
- **CDR confidentiality core:** [`packages/cdr/src/real.ts`](packages/cdr/src/real.ts),
  [`packages/cdr/src/port.ts`](packages/cdr/src/port.ts)
- **Story IP/PIL/license:** [`packages/story/src/real.ts`](packages/story/src/real.ts) (PoC path) +
  [`apps/web/src/hooks/useStoryIp.ts`](apps/web/src/hooks/useStoryIp.ts) (the **live** leader-registration path)
- **Agent env contract:** [`packages/agent/src/config.ts`](packages/agent/src/config.ts)
- **Agent wiring (venue/CDR/license selection):** [`packages/agent/src/agent.ts`](packages/agent/src/agent.ts)
- **Core loop:** [`packages/agent/src/pipeline.ts`](packages/agent/src/pipeline.ts);
  TP/SL: [`packages/agent/src/tpsl.ts`](packages/agent/src/tpsl.ts);
  state: [`packages/agent/src/state.ts`](packages/agent/src/state.ts);
  publish endpoint: [`packages/agent/src/server.ts`](packages/agent/src/server.ts)
- **Executors:** EVM/0x [`packages/agent/src/executor.ts`](packages/agent/src/executor.ts);
  Hyperliquid [`packages/agent/src/hyperliquid/executor.ts`](packages/agent/src/hyperliquid/executor.ts) +
  [`meta.ts`](packages/agent/src/hyperliquid/meta.ts) (pure spot math/guards, well unit-tested)
- **Operator scripts:** [`packages/agent/scripts/`](packages/agent/scripts/) — `hl-gen-agent`, `hl-approve`,
  `hl-publish`, `sub-create-plan`, `sub-subscribe`
- **Contracts:** [`packages/contracts/src/CopyVault.sol`](packages/contracts/src/CopyVault.sol),
  [`CopyVaultFactory.sol`](packages/contracts/src/CopyVaultFactory.sol),
  [`SubscriptionRegistry.sol`](packages/contracts/src/SubscriptionRegistry.sol)
- **Web routes:** [`apps/web/src/routes/`](apps/web/src/routes/); env+wagmi+abis:
  [`apps/web/src/lib/`](apps/web/src/lib/); hooks: [`apps/web/src/hooks/`](apps/web/src/hooks/)
- **Authoritative narrative:** [`README.md`](README.md); operating rules + doc map:
  [`CLAUDE.md`](CLAUDE.md); risk register: `docs/business/94-risks-and-unknowns.md`
- **For any `@piplabs/cdr-sdk` work:** invoke the **`cdr` skill** first (pins SDK 0.2.1 facts, `network:"testnet"`,
  `apiUrl`, `initWasm`, the 1024B cap, condition addresses).

---

*Generated 2026-06-06 from a full-repo audit (signal/contracts/CDR/Story/agent/frontend/deployment + design
docs), cross-checked against first-hand reads of the spine files and the live `.env` config. When in doubt,
the live code wins.*

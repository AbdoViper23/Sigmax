# 81 — Engineering Plan (Phases)

> The phased build plan with explicit **acceptance criteria** (definition of done) per phase, written
> for Claude Code to execute. Phases are ordered by dependency and by "prove the riskiest thing
> first" (`80 §5`). No fixed day counts — each phase is "done when its acceptance passes."
> Pairs with `80-mvp-scope.md` and every component doc.

---

## How to use this doc (Claude Code)
- Work **one phase at a time, top to bottom**. Don't start a phase until the previous phase's
  acceptance criteria pass.
- For each task, read the linked component doc first (per `CLAUDE.md §4`).
- A phase is **done** only when every ✅ in its acceptance list passes (tests run, not assumed).
- Commit per task referencing the doc number.

---

## Phase 0 — Repo & foundation
**Goal:** a working monorepo skeleton.
- Scaffold pnpm + Turborepo per `03-repo-structure.md`; create `packages/{contracts,agent,cdr,story,shared}` + `apps/web`.
- `packages/shared`: implement `SignalSchema` + encode/decode + `chains.ts` + `addresses.ts` (`cdr-story/22`, `02`).
- Root `.env.example`, CI (`forge test` + `pnpm -r test`), lint/format/husky.
- **Verify SDK versions:** run `npm view @piplabs/cdr-sdk version` and `@story-protocol/core-sdk`; pin; record in `94`.
**Acceptance:** `pnpm install && pnpm -r build` succeeds; `SignalSchema` round-trip test passes; CI green; SDK versions pinned + noted.

## Phase 1 — CDR publish/decrypt (PROVE THE RISKIEST THING)
**Goal:** encrypt a signal and decrypt it only when authorized, on Aeneid.
- `packages/cdr`: wrap `CDRClient`, `initWasm`, `uploadCDR`, `accessCDR` (`cdr-story/20`).
- Use deployed `LicenseReadCondition` + `OwnerWriteCondition` (Option A, `contracts/11`).
- Script: publish a `Signal` → decrypt with a holder of the license → recover identical signal.
**Acceptance:**
- ✅ publish + decrypt round-trip recovers the exact signal on Aeneid
- ✅ a wallet without the license **fails** to decrypt
- ✅ decoded signal passes `SignalSchema`; malformed payload rejected
- ✅ startup logs the installed CDR SDK version

## Phase 2 — Story IP, license, royalty
**Goal:** strategy = IP; subscription = license; revenue splits.
- `packages/story`: `registerStrategyIp`, `attachSubscriptionTerms`, `mintSubscription`, `claimRevenue` (`cdr-story/21`).
- Split 100 royalty tokens 85 leader / 15 platform.
**Acceptance:**
- ✅ register IP → stable `ipId`; attach PIL with `$WIP` fee + revShare
- ✅ follower mints a license (pays `$WIP`) → funds in Royalty Vault
- ✅ `claimAllRevenue` pays leader 85% / platform 15%
- ✅ the minted license satisfies the Phase-1 read condition for that `ipId`

## Phase 3 — CopyVault + swap on a forked chain (PARALLEL to 1–2)
**Goal:** a non-custodial vault that performs a real spot swap.
- `packages/contracts`: `CopyVault` + `CopyVaultFactory` (`contracts/10`); Foundry tests (full checklist in `10 §8`).
- `execution/41`: 0x Swap API v2 quote → `executeSwap`; fork Arbitrum (`anvil --fork-url`).
**Acceptance:**
- ✅ all `CopyVault.t.sol` tests pass (caps, whitelist, role, withdraw-only-owner, minOut, reentrancy, approval reset)
- ✅ fork test: real 0x quote swaps USDC→WETH inside the vault; received ≥ minOut
- ✅ non-executor cannot swap; revoked executor cannot swap

## Phase 4 — SubscriptionRegistry
**Goal:** monthly subscription truth.
- `SubscriptionRegistry` (`contracts/12`): `createPlan`, `subscribe`, `isActive`, expiry+grace, fee split.
**Acceptance:**
- ✅ subscribe pulls payment, splits fee, sets +30d; early renewal stacks
- ✅ `isActive` true within period(+grace), false after; fee cap enforced
- ✅ (if Option B) `SubscriptionReadCondition.isActive` matches the registry

## Phase 5 — The agent (relayer) — JOINS the tracks
**Goal:** the loop runs without UI.
- `packages/agent`: watcher, decryptor (TEE-ready), subscribers (registry), executor (0x→executeSwap), state, queue (`agent/30,31`, `execution/42`).
- Trusted-relayer cross-chain: read Story `isActive` + signal → execute on forked Arbitrum.
**Acceptance:**
- ✅ published ENTRY → detected → decrypted → executed into a follower vault on the fork
- ✅ idempotent (no double-execute on restart/duplicate event)
- ✅ inactive subscriber: no new entry; open position still manageable
- ✅ one follower's revert doesn't block others; signal/TP/SL never logged (redaction test)

## Phase 6 — TP/SL monitor
**Goal:** automatic exits at secret levels.
- `tpsl-monitor.ts`: price source (Chainlink/TWAP), poll, exit via executor; persist positions encrypted/re-derivable (`agent/32`).
**Acceptance:**
- ✅ position closes on TP and on SL (mocked price)
- ✅ thresholds never in plaintext logs/state-at-rest
- ✅ exit fires even after subscription expiry; restart reconciles + still fires pending exits

## Phase 7 — Frontend (LAST)
**Goal:** demo-able UI for both roles + leaderboard.
- Next.js + wagmi/viem + RainbowKit; two-chain config; leader publish (1 template); follower subscribe/deposit/authorize; positions; 1-strategy leaderboard (`frontend/60`).
**Acceptance:**
- ✅ leader registers + publishes (client-side encrypt); follower subscribes + funds vault + authorizes agent (guided)
- ✅ positions/history render from on-chain events (results only; no secrets)
- ✅ revoke/pause works; leaderboard shows a verifiable record
- ✅ no page/API exposes signal logic / TP / SL

## Phase 8 — End-to-end demo hardening
**Goal:** the `80 §6` demo script runs reliably start to finish.
- Wire everything; run the full loop; add MVP leakage mitigations (batching + jitter, on-chain minOut) (`security/70`).
**Acceptance:**
- ✅ full demo script passes repeatedly (publish → decrypt → execute → TP/SL exit → leaderboard → revoke)
- ✅ Story on real Aeneid; execution on forked Arbitrum
- ✅ runbook written (start agent, fund gas wallet, fork command)

---

## Post-MVP phases (launch track — see `business/92`)
- **P9 TEE:** Dockerize agent → deploy to Phala TDX (`agent/30`, `business/91`).
- **P10 Mainnet:** deploy contracts to Arbitrum One mainnet; Story Homer; real $WIP.
- **P11 Audit:** audit `CopyVault` (+ registry) before holding real funds (`business/91`).
- **P12 Leakage hardening:** CoW batch executor on Arbitrum (`security/70`).
- **P13 Auth UX:** EIP-7702/4337 session keys (`key-management/50`).
- **P14 Subscriptions v2:** `SubscriptionReadCondition` + Royalty-Vault payment path; auto-renew.

## Global definition of done (every phase)
- Tests written and passing (Foundry for contracts, vitest for TS).
- No secret (signal/TP/SL) logged, persisted in plaintext, or sent to the frontend.
- Spot-only invariant intact (`security/71`).
- Component doc updated if reality differed; discrepancies logged in `94`.

→ Next: `business/90-business-model.md`.

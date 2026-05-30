# 80 — MVP Scope & Dependency Graph

> Exactly what is in the MVP, what is deferred, and the order to build it. The MVP's job: demo the
> **full loop end-to-end** (one leader, one follower, one spot signal, real CDR decryption, real
> swap on a forked liquidity chain) and show a **verifiable record**.
> Pairs with `81-engineering-plan.md` (phases + acceptance) and every component doc.

---

## 1. MVP definition (the loop that must work)

```
Leader publishes an encrypted spot signal on Story
   → Agent (TEE-ready) detects + decrypts it
   → checks the follower is an active subscriber
   → executes the spot swap inside the follower's CopyVault on a forked Arbitrum
   → monitors TP/SL and exits
   → revenue split is visible
```
If a stranger can watch this loop run once, the MVP is done.

## 2. In scope (build these)

| Area | MVP item | Doc |
|---|---|---|
| Contracts | `CopyVault` + `CopyVaultFactory` (deposit, executeSwap, caps, roles, withdraw) | `contracts/10` |
| Contracts | `SubscriptionRegistry` (subscribe, isActive, expiry) | `contracts/12` |
| Contracts | reuse deployed `LicenseReadCondition` + `OwnerWriteCondition` (Option A) | `contracts/11` |
| CDR | publish (`uploadCDR`) + decrypt (`accessCDR`) round-trip on Aeneid | `cdr-story/20` |
| Story | register IP + PIL + mint license (subscription) + 85/15 royalty split | `cdr-story/21` |
| Signal | `SignalSchema` + encode/decode in `packages/shared` | `cdr-story/22` |
| Agent | watch → decrypt → eligibility → size → 0x quote → executeSwap | `agent/31` |
| Agent | TP/SL monitor (poll price, exit) | `agent/32` |
| Execution | 0x Swap API v2 on a **forked Arbitrum** | `execution/41`, `40` |
| Cross-chain | trusted-relayer (agent reads Story, executes on liquidity chain) | `execution/42` |
| Frontend | leader publish (1 template) + follower subscribe/deposit/authorize + positions + 1-strategy leaderboard | `frontend/60` |
| Non-custodial | Pattern A (CopyVault role) + instant revoke | `key-management/50` |

## 3. Deferred (NOT in MVP)

- Custom `SubscriptionReadCondition` (Option B) — MVP uses license-gating (Option A).
- TEE deployment (build TEE-ready; demo as plain daemon if time-short).
- CoW batch execution + private order flow (MVP = 0x + batching + jitter).
- ERC-4337 / EIP-7702 session keys (MVP = CopyVault role).
- Cross-chain messaging (LayerZero/CCIP) — MVP = trusted relayer.
- Royalty-Vault payment path if it's slow to wire — fallback to direct split in `SubscriptionRegistry`.
- Multi-strategy discovery, charts, notifications, Base deployment, auto-renew, partial exits, fiat
  on-ramp, ZK leakage proofs.

## 4. Dependency graph (build order)

```
[shared: signal schema, addresses, chains]         ← foundational, build first
        │
        ├──► [CDR publish/decrypt round-trip]       ← PROVE THIS FIRST (hardest/novel)   (cdr-story/20)
        │          │
        │          └──► [Story IP + license + royalty]  (cdr-story/21)  ← gates decryption + revenue
        │
        ├──► [CopyVault + factory + 0x swap on fork]     (contracts/10, execution/41)  ← PARALLEL track
        │          │
        │          └──► [SubscriptionRegistry]            (contracts/12)
        │
        └──► [Agent: relayer joining the two]            (agent/31, execution/42)  ← needs both tracks
                   │
                   └──► [Agent: TP/SL monitor]            (agent/32)
                            │
                            └──► [Frontend: flows + leaderboard]  (frontend/60)  ← last
```

Two parallel tracks (CDR/Story and Contracts/Swap) converge at the Agent. Frontend last.

## 5. The "prove the riskiest thing first" rule

Before building UI or polish, **prove the CDR publish→decrypt loop on Aeneid** (the novel,
uncertain part — version drift, condition wiring) and **prove a real swap in a CopyVault on a forked
Arbitrum** (the execution part). If both work in isolation, the rest is integration. Don't invert
this and build the frontend first.

## 6. Demo script (what you show)
1. Leader publishes a signal (UI) → show the encrypted vault on Story (ciphertext, not readable).
2. Agent logs: detected → decrypted (in TEE) → follower active → swap executed (tx on forked Arbitrum).
3. Follower dashboard: open position appears (results only; no strategy shown).
4. Price hits TP → agent exits → PnL shown.
5. Leaderboard: the strategy's verifiable record (commit-before-outcome + on-chain trades).
6. Click "Revoke agent" → show the agent can no longer trade.

## 7. Acceptance (MVP-level)
- ✅ the full loop runs end-to-end on Aeneid (Story) + forked Arbitrum (execution)
- ✅ a non-subscriber cannot decrypt; a subscriber's trade executes automatically
- ✅ TP/SL exit fires; revenue split is demonstrable
- ✅ revoke works; funds are always in the follower's vault
- ✅ leaderboard shows a record sourced from on-chain data

→ Next: `81-engineering-plan.md` (phases + per-phase acceptance).

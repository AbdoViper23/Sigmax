# 71 — Spot-Only Constraint (and how it's enforced)

> Sigmax is **spot only** — by product choice and as a halal (Islamic-finance) constraint. This
> doc states what "spot only" means here, why it's enforced at the contract level, and the checklist
> that keeps the whole system inside the line.
> Pairs with `contracts/10` (the vault enforcement) and `cdr-story/22` (the signal schema).

---

## 1. What "spot only" means here

The **only** financial action Sigmax ever performs is an **immediate swap between two
whitelisted spot tokens** (e.g. USDC ↔ WETH) at market, settled now, fully asset-backed. Explicitly
**excluded everywhere, always:**
- ❌ leverage / margin
- ❌ perpetuals / futures
- ❌ shorting (no borrowing an asset to sell)
- ❌ borrowing / lending / interest (riba)
- ❌ options / derivatives
- ❌ any position that can be liquidated

If a feature would require any of the above, it violates the constraint — STOP and flag (`CLAUDE.md`
rule 1).

## 2. Why this is a feature, not a limitation

- **Smaller attack/permission surface:** the agent can only swap; no liquidation engine, no debt,
  no oracle-driven margin calls. Easier to secure and audit (`contracts/10`, `business/91`).
- **Halal alignment:** spot, asset-backed, no interest → fits an Islamic-finance audience. This is
  also a sharp **go-to-market wedge** — a tight, reachable, underserved community (`93-gtm`).
- **Simpler UX & risk story:** "the bot buys and sells tokens you already approve, with your own
  money, no leverage" is a trust-building sentence.

## 3. Where it's enforced (defense in depth)

| Layer | Enforcement |
|---|---|
| **CopyVault contract** | `executeSwap` is the only trading primitive; no borrow/leverage/short functions exist; tokens + routers are whitelisted; proceeds stay in-vault (`contracts/10`) |
| **Signal schema** | `SignalSchema` has only ENTRY/EXIT spot fields — no `leverage`, `side: short`, `margin`, `collateral` (`cdr-story/22`) |
| **Token whitelist** | only plain spot ERC-20s (USDC + curated majors); no derivative/LP/margin tokens (`execution/41 §6`) |
| **Agent logic** | builds only USDC↔token swaps; has no code path to any lending/perp protocol (`agent/31`) |
| **Frontend** | leader publish form exposes no leverage/short controls (`frontend/60 §4`) |

Because it's enforced at the **contract** level (the lowest layer), even a buggy agent or a
malicious signal cannot produce a non-spot action — the vault simply has no function for it.

## 4. Halal compliance notes (scope = how we keep it spot)

Per your instruction, the only constraint to encode is **spot trading only** — that's the core of
the halal posture here (asset-backed, no riba, no leverage, no shorting). Practical guardrails:
- **Whitelist policy:** curate the target-token whitelist to plain spot assets; exclude tokens whose
  primary purpose is interest-bearing/lending or synthetic leverage. Keep the list reviewable.
- **No interest anywhere:** the platform never lends idle vault funds for yield; idle USDC sits in
  the vault (no auto-staking/lending) unless a future explicitly-halal, clearly-disclosed option is
  added.
- **Transparency:** the on-chain trade record (spot swaps only) is itself the compliance evidence —
  anyone can verify no leverage/derivatives were used.

> We are not making a religious ruling — we're enforcing a clean, auditable **spot-only** technical
> constraint that maps to the halal requirement you set. If deeper certification is pursued later,
> the spot-only enforcement is the foundation it would build on.

## 5. Tests / acceptance
- ✅ the CopyVault ABI contains **no** function that borrows, leverages, shorts, or opens margin
- ✅ `SignalSchema` rejects any non-spot field; the type is closed (no leverage/side/margin keys)
- ✅ attempting to whitelist a disallowed token category is caught by the curation policy/test
- ✅ the agent has no import of / call path to any lending or perp protocol (grep test in CI)
- ✅ end-to-end demo performs only USDC↔token spot swaps; the on-chain record shows nothing else

## 6. Marketing line (honest)
"Sigmax is **spot-only**: real tokens, your own funds, no leverage, no shorting, no interest —
fully asset-backed and verifiable on-chain." (Use in `93-gtm` for the halal-trader wedge.)

→ Next batch: `engineering/80`, `81` + `business/90–94`.

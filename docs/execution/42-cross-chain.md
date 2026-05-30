# 42 — Cross-Chain (linking Story to the liquidity chain)

> The CDR vault + access conditions + subscriptions live on **Story L1**; execution happens on the
> **liquidity chain** (Arbitrum/Base). This doc explains how the two are connected and why the MVP
> uses a **trusted-relayer** model rather than a bridge.
> Pairs with `agent/30–31` (the relayer is the agent), `contracts/12` (subscription state), `security/70`.

---

## 1. The problem

The thing that says "follower X is allowed" (subscription) and the thing that holds the secret
(encrypted signal) are on **Story**. The thing that executes (CopyVault + DEX) is on **another
chain**. Something must carry the decision "this active subscriber should get this trade" from Story
to the liquidity chain. Three ways:

| Model | How | MVP? |
|---|---|---|
| **Trusted relayer (the agent)** | agent reads Story state, then executes on the liquidity chain | ✅ **MVP** |
| **Cross-chain messaging** | mirror subscription state to the liquidity chain (LayerZero/CCIP/Hyperlane) so the vault self-enforces | defer |
| **Subscription on the exec chain** | put payment/subscription on the liquidity chain; only the encrypted strategy on Story | alt |

## 2. MVP: the agent as trusted relayer (recommended)

The agent already must decrypt the signal (off-chain) and already holds the executor key. So let it
also be the relayer:

```
Story (read):                          Liquidity chain (write):
  - accessCDR(uuid) -> signal           - CopyVault.executeSwap(...)
  - registry.isActive(follower) -> bool
        │                                      ▲
        └──────── agent decides & relays ──────┘
```

- The agent reads `SubscriptionRegistry.isActive(follower, strategyId)` on Story (a plain view call
  over RPC) and the decrypted signal, then calls `executeSwap` on the liquidity chain.
- **Trust assumption:** the agent honestly checks Story state before executing. This is acceptable
  because the agent is *already* trusted to execute correctly and to decrypt — and (in production)
  runs in a **TEE with remote attestation**, so its behavior is verifiable and it can't be silently
  tampered with. It still **cannot steal** (CopyVault bounds it — `key-management/50`).
- **No bridge, no message-passing, minimal surface.** This is the single biggest MVP simplification.

### Why this is safe enough
The worst a malicious/buggy relayer can do is execute a bounded honest-price swap for the wrong
follower or skip a valid one — annoying, not fund-loss. It cannot withdraw, cannot exceed caps,
cannot trade non-whitelisted tokens. Combined with a TEE + attestation, the relayer's correctness is
verifiable. For higher assurance later, move to model 3 below.

## 3. Production option: cross-chain messaging (defer)

To remove the trust that the agent checks subscriptions honestly, **mirror subscription state to the
liquidity chain** so the CopyVault (or a guard contract) enforces "only execute for an active
subscriber" itself:
- **LayerZero / Hyperlane** — fast (seconds–minutes), message-passing; relay a compact proof/flag
  "follower active until T for strategy S" to the liquidity chain.
- **Chainlink CCIP** — slower (~min) but safety-first (Risk Management Network); good if you want
  conservative guarantees.

This makes execution eligibility **trustless** at the cost of real complexity (you maintain a
messaging integration + handle reorgs/finality). The user's background (HTLC, CCTP, LayerZero,
Stargate) makes this a realistic v2 — but it's **not** needed to ship or to get the first users.

## 4. Alt option: subscription on the execution chain

Put the `SubscriptionRegistry` on the **liquidity chain** instead of Story; keep only the encrypted
strategy on Story. Then the CopyVault can check `isActive` locally (no cross-chain, no relayer trust
for eligibility). Downside: it splits the "money/subscription" story away from Story's native
IP/royalty (`cdr-story/21`), weakening the on-protocol revenue narrative. Reasonable engineering
choice, weaker Story-native story — note it as a tradeoff.

> **Hybrid we may actually want:** keep IP + license + royalty on Story (the revenue + the verifiable
> record), and ALSO keep a lightweight subscription/eligibility check on the liquidity chain (synced
> by the relayer or by messaging) so the vault can self-gate. Decide at launch; MVP = pure relayer.

## 5. State the agent reads cross-chain (read-only, cheap)

| From Story | Used for |
|---|---|
| the encrypted signal (`accessCDR`) | what to trade |
| `SubscriptionRegistry.isActive` | who to trade for |
| license ownership (Option A) | decryption right |
| `Subscribed` events | maintain the follower index in Supabase |

All are **view reads** over a Story RPC; no funds move on Story (except subscription payments, which
followers send directly — `cdr-story/21`).

## 6. Failure modes
- **Story RPC down:** agent can't read eligibility/signal → pauses execution (safe; funds untouched).
  Use a backup Story RPC; alert.
- **Clock/finality skew between chains:** treat subscription expiry with a grace window
  (`contracts/12` `GRACE`) so a borderline-expired follower isn't wrongly cut mid-signal.
- **Relayer dishonesty (the trust we accept in MVP):** mitigated by TEE + attestation; eliminated
  only by moving to messaging (model 3).

## 7. Acceptance
- ✅ agent reads `isActive` from Story and the signal via CDR, then executes on a forked liquidity chain — full relay loop
- ✅ Story RPC outage pauses execution without losing/locking funds
- ✅ expiry grace prevents wrongful mid-signal cutoff
- ✅ the "submit eligibility check" is abstracted so a future messaging/guard contract can replace the relayer check without touching the executor

→ Next: `key-management/50-non-custodial.md`.

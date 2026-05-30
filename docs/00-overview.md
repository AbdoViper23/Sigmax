# 00 — Overview

> Read this first. It explains the problem Sigmax solves, the core idea, why it's defensible,
> and the three layers the whole system is built from. Everything else in the docs is a detail of
> one of these three layers.

---

## 1. The problem

There is a large, active market for **trading signals / "alpha"**: people who are good at trading
sell their calls to followers (paid Telegram groups, Discord servers, "VIP" channels). This market
has two problems that kill it:

1. **Leakage.** The moment a paying subscriber receives a signal, they can screenshot it and
   re-share it for free. One leaker destroys the seller's whole business.
2. **Fake track records.** Anyone can claim "I'm up 300% this year." Nobody can verify it. The
   market is full of scammers, so buyers don't trust anyone — which suppresses the whole market.

These two problems are linked: because signals leak and records are fake, the honest sellers can't
charge fairly and the buyers can't tell who's real.

## 2. The idea

**Sigmax makes the signal impossible to leak and the track record impossible to fake.**

- The leader's signal is **encrypted** (via Story's Confidential Data Rails) and is **never shown
  to the follower as text**. Instead, an automated agent decrypts it privately and **executes the
  spot trade directly** inside the follower's own wallet/vault. The follower receives the *result*
  (a trade was placed), not the *reasoning* (the rule, the entry, the take-profit, the stop-loss).
  → You can't re-share what you never saw.
- Every signal is committed on-chain *before* the outcome is known, and the resulting trades are
  on-chain, so the leader's performance is **verifiable and tamper-proof**.
  → You can't fake a record that's written on-chain in advance.

We focus on **spot trading only** — swaps between tokens, no leverage, no shorting. This keeps the
permission surface tiny, makes the product safer, and aligns with a halal (asset-backed, no riba)
constraint that also defines a clean, reachable initial audience.

## 3. Why this is defensible (what's genuinely new)

It is *not* "another signals group." The new things are:

- **Leak-proof by construction**, not by promise. Telegram "no-sharing" rules are unenforceable;
  here the follower physically never has the plaintext.
- **Verifiable, un-fakeable track record** baked into the protocol.
- **Confidentiality is load-bearing.** The product is *impossible* without CDR — you cannot do
  "reveal the secret only to people who paid, where even the operator can't leak it, and the
  reveal triggers an action" with a normal database or a simple on-chain commit. This is exactly
  what CDR's threshold encryption + on-chain access conditions provide. (If a design ever makes
  the encryption unnecessary, the product has lost its moat — see `CLAUDE.md` rule 3.)

## 4. The honest limitation (state it openly)

Spot swaps settle on a public chain, so a watcher can see *that* a follower bought token X after
the fact and try to lag-copy. CDR protects the signal **before** execution (the rule, the next
signal, the exits) — it cannot make an **already-settled** swap private. We mitigate this with
batching + private/auction execution (see `security/70-leakage-mitigation.md`), and the real moat
is **timing + automation** (followers execute at the same instant as the leader, before the public
can react), not the secrecy of which token was bought. We do not over-claim perfect privacy.

## 5. The three layers (the mental model for the whole system)

Everything in Sigmax belongs to exactly one of these three layers. Keep them separate.

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — STORY L1 (confidentiality + money)                          │
│  • CDR vault holding the encrypted signal                              │
│  • Read/Write access-condition contracts                               │
│  • Story IP Asset + PIL license = the "subscription"                   │
│  • IP Royalty Vault = automatic subscription-revenue split             │
│  Docs: cdr-story/*, contracts/11, contracts/12                         │
└──────────────────────────────────────────────────────────────────────┘
                              │ (encrypted signal + "who paid?")
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 2 — THE AGENT (off-chain, in a TEE)                             │
│  • Watches Story for new signals                                       │
│  • Decrypts the signal privately (CDR accessCDR)                       │
│  • Knows which followers have an active subscription                   │
│  • Builds the swap + monitors take-profit / stop-loss                  │
│  • Holds NO funds; only a scoped executor key                          │
│  Docs: agent/*                                                         │
└──────────────────────────────────────────────────────────────────────┘
                              │ (executeSwap calls, bounded)
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 3 — LIQUIDITY CHAIN (Arbitrum One or Base)                      │
│  • One CopyVault contract per follower (holds their spot funds)        │
│  • executeSwap runs the actual spot swap via a DEX/aggregator          │
│  • Only the owner can withdraw; agent can only swap within limits      │
│  Docs: contracts/10, execution/*, key-management/50                    │
└──────────────────────────────────────────────────────────────────────┘
```

**Why the split:** Story gives us confidentiality + native licensing/royalties but no real spot
liquidity. The liquidity chain gives us deep spot markets but no confidentiality. The agent is the
trusted-but-minimized bridge that connects "who is allowed + what is the secret signal" (Story) to
"execute the trade" (liquidity chain) — without ever holding user funds or exposing the strategy.

## 6. The actors

- **Leader** — a trader. Registers a strategy as a Story IP Asset, sets a monthly price, and
  publishes encrypted spot signals. Earns subscription revenue (auto-split via the Royalty Vault).
- **Follower** — a subscriber. Pays monthly, deposits spot funds into their own CopyVault,
  authorizes the agent's scoped executor key. Their trades mirror the leader automatically.
- **Agent** — our off-chain executor (in a TEE). Decrypts signals, executes for all active
  followers, monitors exits. Trusted to execute honestly; structurally unable to steal funds.
- **Platform (you)** — operates the agent + app, takes a fee (a slice of subscription revenue).

## 7. One-line summary

> Encrypted spot signals on Story + a non-custodial executor agent + per-follower vaults on a
> liquidity chain = copy-trading where the strategy can't leak and the track record can't be faked.

→ Next: `01-architecture.md` for the full component map and the end-to-end sequence.

# 70 — Strategy-Leakage Mitigation

> The honest, hard problem: settled spot swaps are public, so watchers can try to lag-copy or
> front-run. What CDR protects, what it can't, and the concrete mitigations (with their limits).
> Pairs with `00-overview §4`, `execution/41` (CoW), `agent/31 §6` (batching).

---

## 1. What CDR protects vs what it can't (be precise)

| Data | Protected by CDR? |
|---|---|
| The strategy logic / rules | ✅ encrypted; only the agent decrypts (in TEE) |
| The **next** signal (not yet executed) | ✅ encrypted until published+decrypted |
| The take-profit / stop-loss levels | ✅ never on-chain; monitored in the TEE (`agent/32`) |
| Which token a follower **already** bought | ❌ **public** — it's a settled on-chain swap |
| The amounts of executed swaps | ❌ public |

**So the leak vector is post-execution observation:** a watcher sees "vault X bought token T at
time t" and tries to mimic. CDR cannot make a settled swap private — state this openly to users
(`00-overview §4`).

## 2. Why this is survivable (the real moat)

The product's value is **not** "which token to buy" (that leaks afterward). It's **timing +
automation**: the leader and all subscribers execute at (nearly) the same instant, before the public
can react. A watcher copying from observed trades is **always one step behind** — they miss the
entry price, don't get the exit, and don't know the next move or the rules. Lag-copying spot with
slippage is a much worse business than having the live signal. The moat is being **first and
automatic**, not secrecy of the token name.

## 3. Mitigations (best-first, with honest limits)

### A. Batch all followers into one order
Execute all subscribers' swaps together (multicall or a single batch) so observers see **one
aggregate trade**, not N identical signals fanning out from a leader. Reduces signal clarity and
shares gas. *Limit:* a determined analyst can still spot the aggregate.

### B. CoW Protocol batch auctions (strongest readily-available)
Route the batch through **CoW Protocol**: orders are collected over a short window and settled at a
**uniform clearing price** in one atomic transaction; order details are **hidden during the auction**
and matched peer-to-peer (Coincidence of Wants). Because within-batch ordering doesn't affect price,
front-running/sandwiching is **structurally prevented**. Live on **Arbitrum One** (`@cowprotocol/cow-sdk`),
which is part of why we chose it (`execution/40`). *Limit:* the settled result is still eventually
visible on-chain (it stops front-running, not after-the-fact observation).

### C. Private order flow / private mempool
**Flashbots Protect**-style private RPC (`eth_sendPrivateTransaction`) hides a tx from the **public
mempool** until inclusion, blocking mempool front-running. *Limit:* primarily an **Ethereum-mainnet**
tool; **L2 support is limited and depends on the sequencer** — treat as a mainnet/secondary measure,
not the L2 primary. On L2s, the sequencer ordering matters more; rely on B (CoW) there.

### D. Timing jitter & size obfuscation
Add small randomized delays and avoid publishing exact sizes/round numbers, so trades are harder to
attribute to a single leader signal. *Limit:* cosmetic; combine with A/B.

### E. Edge-decay framing
Favor strategies whose edge **decays fast** (the value is in the first seconds/minutes). Then even a
perfect observer who copies from the settled trade is too late. *Limit:* constrains strategy type;
slower/large-cap strategies leak more (say so to leaders).

## 4. What we ship when

- **MVP:** A (batching) + D (jitter) + on-chain `minOut` to limit any sandwich damage. Demo-able,
  honest.
- **Launch:** add **B (CoW batch)** on Arbitrum — architect the executor's "submit" step as an
  interface so we swap `ZeroXExecutor` → `CowBatchExecutor` without touching the rest (`execution/41 §7`).
- **Where applicable:** C (private flow) on any mainnet-Ethereum execution; not the L2 primary.

## 5. Future / advanced (note, don't build now)
- **ZK threshold proof:** the agent proves "price crossed the secret TP/SL" or "this trade matches
  the committed strategy" **without revealing** the levels/strategy, verified on-chain — makes the
  on-chain trigger trustless while keeping secrets. Overkill for MVP; a strong long-term
  differentiator (also referenced in `agent/32 §1`).
- **Intent-only execution / dark-pool-style venues** as they mature on L2s.

## 6. The follower-honesty principle
Never market "100% private trading." Market the truth: **the strategy and forward signals are
secret; settled trades are public; you win by being first + automatic, and front-running is blocked
by batch-auction execution.** Over-claiming privacy is both false and a trust risk. (`00-overview §4`.)

## 7. Acceptance
- ✅ executor "submit" is an interface; a `CowBatchExecutor` can replace `ZeroXExecutor`
- ✅ MVP batches followers per signal and adds bounded timing jitter
- ✅ on-chain `minOut` caps sandwich damage even without CoW
- ✅ user-facing copy states the honest privacy boundary (no "fully private" claims)
- ✅ CoW path verified on Arbitrum at launch (or documented why deferred)

→ See `docs/flare/` for the current (Flare) design.

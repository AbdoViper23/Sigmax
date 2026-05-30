# 31 — Agent Execution Flow

> The main loop, step by step: detect a new signal → decrypt → validate → find active followers →
> size → quote → execute the spot swap into each follower's vault → record the open position.
> Pairs with `22` (signal schema), `contracts/10` (executeSwap), `execution/41` (quotes),
> `contracts/12` (eligibility), `32` (the TP/SL side of the loop).

---

## 1. The loop at a glance

```
watcher: new signal vault on Story
   └─► enqueue {uuid, strategyId, signalId}
        └─► worker:
              1. accessCDR(uuid) → dataKey            [decrypt, in TEE]
              2. decodeSignal + SignalSchema.parse     [validate; reject if bad]
              3. dedupe by signalId                    [idempotency]
              4. staleness check (expiresAt)           [skip entry if stale]
              5. getActiveFollowers(strategyId)        [registry.isActive]
              6. for each follower (batched):
                   a. read CopyVault USDC balance
                   b. amountIn = balance * sizeBps/10000   (ENTRY)
                   c. quote(USDC→token) + minOut            (execution/41)
                   d. CopyVault.executeSwap(...)
                   e. record open position {token, entryPx, TP, SL} in TEE state
              7. hand TP/SL to the monitor (doc 32)
```

## 2. Step 1–3: detect, decrypt, validate

### Detect (watcher.ts)
Two ways to know a signal was published:
- **Event watch:** `viem.watchContractEvent` on the CDR contract (or your publish wrapper) over a
  websocket RPC — lowest latency.
- **Registry/notify:** the publish step writes the new `uuid` to a small on-chain "signal index" or
  off-chain notify (Supabase row / webhook). Robust fallback if event subscriptions flake.

Prefer event watch with a polling reconciliation fallback (catch missed events on reconnect).

### Decrypt (decryptor.ts, in TEE)
```ts
const { dataKey } = await cdr.consumer.accessCDR({ uuid, accessAuxData, timeoutMs: 120_000 });
const raw = decodeSignal(dataKey);
const signal = SignalSchema.parse(raw);     // throws on malformed/forged payload → never reaches execute
```
Retry policy: on timeout, retry with backoff and a higher `timeoutMs` (CDR reads can be slow if
validators lag — `cdr-story/20 §1`). Cap retries; after N failures, log a non-secret error and alert.

### Dedupe
Maintain a set of processed `signalId`s (Redis). If already processed, drop. This makes the worker
**idempotent** under re-reads, restarts, and duplicate events (`22 §5`).

## 3. Step 4: staleness

```ts
if (now > signal.expiresAt) {
  if (signal.action === "ENTRY") return skip("STALE_ENTRY");   // edge gone; don't chase
  // EXIT still proceeds — closing a position is always allowed
}
```

## 4. Step 5: who do we execute for?

```ts
const followers = await getFollowers(signal.strategyId);          // from Supabase index of subscribers
const active = followers.filter(f => registry.isActive(f, signal.strategyId)); // on-chain truth
```
- **ENTRY:** only `active` followers.
- **EXIT (or TP/SL trigger):** every follower with an **open position** in this token — including
  those whose subscription **just expired**, so we never strand someone mid-trade (`contracts/12 §5`).

## 5. Step 6: size, quote, execute (per follower)

### Size (ENTRY)
```ts
const usdc = await readBalance(vault, USDC);
const amountIn = (usdc * BigInt(signal.sizeBps)) / 10_000n;
if (amountIn === 0n) return skip("ZERO_SIZE");
```
- Respect the follower's `perTradeCap` / `dailyCap`: if `amountIn` exceeds `perTradeCap`, **clamp to
  the cap** (a partial copy is fine) or skip per policy — but never try to exceed it (the vault would
  revert anyway). Decide one policy and document it; default: **clamp to perTradeCap**, then the
  daily cap is enforced on-chain.

### Quote + minOut (execution/41)
```ts
const quote = await getQuote({ chainId: signal.chainId, sell: USDC, buy: signal.token, amountIn,
                               slippageBps: signal.maxSlippageBps, taker: vault });
// quote.to = router (must be whitelisted in the vault), quote.data = swapData, quote.minOut
```

### Execute
```ts
await writeContract(vault, "executeSwap", [
  quote.to, USDC, signal.token, amountIn, quote.minOut, quote.data,
]); // signed by AGENT_PK (executor role). minOut is also enforced on-chain as a backstop.
```

### Record the open position (TEE state)
```ts
await state.openPosition({
  follower, vault, token: signal.token,
  entryAmountIn: amountIn, entryTxHash,
  takeProfitPrice: signal.takeProfitPrice,   // kept in TEE only
  stopLossPrice: signal.stopLossPrice,       // kept in TEE only
  strategyId: signal.strategyId, signalId: signal.signalId,
});
```
This handoff is what the TP/SL monitor (`32`) watches.

## 6. Batching (scale + leakage resistance)

Executing N followers as N independent txs is fine for the MVP, but for scale and to reduce on-chain
signal clarity:
- **Multicall / batch:** group several `executeSwap` calls per block.
- **CoW batch order:** submit followers' swaps into one CoW batch auction (uniform clearing price,
  hidden pre-settlement) — the strongest anti-front-running/leakage path (`security/70`,
  `execution/41`). Defer to post-MVP but design the executor so the "submit" step is swappable
  (0x per-vault now; CoW batch later).

## 7. Concurrency & ordering
- One signal = one job; followers processed concurrently with a bounded pool (e.g. 5–10 at a time)
  to avoid RPC rate limits.
- Per-follower **serialize** (a follower's entry must precede its exit); use a per-follower lock key
  in Redis.
- Gas: the agent's gas wallet funds the txs (`key-management/50 §gas`); monitor its balance and
  alert when low.

## 8. Error handling (per follower, isolated)
A failure for one follower must not block others.
| Failure | Action |
|---|---|
| CopyVault reverts (cap/whitelist) | log `SKIPPED:<reason>`, continue; don't retry blindly |
| Quote API error | retry once with fresh quote; then skip + alert |
| RPC timeout on send | check receipt by nonce; avoid double-send (idempotency by signalId+follower) |
| minOut revert (price moved) | re-quote once; if still failing, skip (don't widen slippage) |
| accessCDR fails for the whole signal | retry/backoff; if persistent, alert — no follower executes |

## 9. Manual-mode note (optional, post-MVP)
If a leader wants followers to **see** the signal instead of auto-execute, the agent can deliver the
decrypted signal to that follower's authenticated session instead of executing. This re-introduces
re-share risk (`00-overview §2`) — keep it off by default; auto-execute is the safe, defensible mode.

## 10. Acceptance
- ✅ a published ENTRY signal is detected, decrypted, validated, and executed into one follower's vault on a forked chain
- ✅ duplicate event / restart does NOT double-execute (idempotency by signalId)
- ✅ inactive subscriber gets no new entry; an open position still exits
- ✅ one follower's revert doesn't block the others in the same signal
- ✅ stale ENTRY is skipped; EXIT always proceeds
- ✅ open position is recorded and visible to the TP/SL monitor (`32`)

→ Next: `32-agent-tp-sl-monitor.md`.

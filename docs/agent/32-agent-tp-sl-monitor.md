# 32 — TP/SL Monitor (private take-profit / stop-loss)

> How the agent watches live price and closes positions at the leader's **secret** take-profit /
> stop-loss levels — inside the TEE, so the levels never become public. This is the part that a
> plain smart contract *cannot* do without leaking the levels (we worked through why).
> Pairs with `22` (where TP/SL come from), `31` (which records open positions), `execution/41` (exit swaps).

---

## 1. Why this must live in the agent (not a public keeper)

We established the core tension: a smart contract can't watch price on its own, and a generic
on-chain keeper (Chainlink Automation/Gelato) would need the TP/SL **written on-chain to compare
against** — which exposes the leader's strategy. So the comparison "is price ≥ takeProfit?" must
happen somewhere that **knows the secret but doesn't reveal it**: the agent's **TEE**. That's the
whole reason the monitor is here and not a public automation job.

(Advanced future option: a ZK proof that "price crossed the secret threshold" without revealing it,
verified on-chain — overkill for now; noted in `security/70 §future`.)

## 2. What it does

For every open position (recorded by `31`), the monitor:
1. periodically reads the **current price** of the position's token (in USDC),
2. compares against the position's **secret** `takeProfitPrice` and `stopLossPrice`,
3. when either is crossed, submits an **EXIT** swap (token → USDC) for that follower's vault,
4. closes the position in TEE state.

## 3. Where the price comes from (spot)

Options, best-first for spot on the liquidity chain:
- **On-chain DEX price / oracle:** read the spot price from the same venue you trade on (e.g. a
  Uniswap v3 pool TWAP, or a Chainlink price feed for the pair). TWAP resists manipulation; a feed
  is simplest. Normalize to the signal's price scale (`22 §4`).
- **Aggregator quote as price probe:** ask 0x for a tiny indicative quote (token→USDC) and derive
  price. Easy, but rate-limited; fine as a fallback.

**Recommendation:** Chainlink price feed where the pair has one; else a Uniswap v3 TWAP read.
Document the source per token in `shared/constants.ts`. The price source is **not secret** — only
the thresholds are.

## 4. The poller (tpsl-monitor.ts)

```ts
// runs in TEE; thresholds are in TEE memory/state only, never logged or sent anywhere
async function tick() {
  const open = await state.openPositions();           // grouped by token to batch price reads
  for (const [token, positions] of groupByToken(open)) {
    const price = await getPrice(token);               // USDC per token, scaled (NOT secret)
    for (const p of positions) {
      const hitTP = p.takeProfitPrice && price >= BigInt(p.takeProfitPrice);
      const hitSL = p.stopLossPrice   && price <= BigInt(p.stopLossPrice);
      if (hitTP || hitSL) await enqueueExit(p, hitTP ? "TP" : "SL");
    }
  }
}
setInterval(tick, POLL_MS);   // e.g. 5–15s; tune per strategy timeframe
```
- **Grouping by token** means one price read serves all followers holding that token — cheap and
  consistent (everyone exits on the same observed price).
- **Exit reuses `31`'s execute path:** quote token→USDC with `minOut`, call `executeSwap`, close
  position. Exits proceed even if the follower's subscription expired (`contracts/12 §5`).

## 5. Polling vs event-driven

- **MVP:** simple interval poll (BullMQ repeatable job). Easy, robust.
- **Tighter latency:** subscribe to price-feed updates (Chainlink `AnswerUpdated` events) or pool
  `Swap` events and re-check thresholds on each tick — reacts faster than a fixed interval.
- Always also poll on a timer as a safety net (don't rely solely on events).

## 6. Slippage, partial exits, and gaps

- **Exit slippage:** use the position's `maxSlippageBps` (or a slightly looser exit slippage so a
  stop-loss actually fills in a fast move) → `minOut` on the exit. Document the exit-slippage policy.
- **Price gaps:** if price gaps through the SL (e.g. thin liquidity), the exit fills at market —
  that's expected for spot; the SL is a trigger, not a guaranteed fill price. Communicate this to
  followers (it's honest and standard).
- **Partial exits / scaling out:** post-MVP. MVP exits the full position on the first trigger.

## 7. Restart & consistency

- Open positions + their secret thresholds must survive a restart so exits aren't missed. Persist
  them **encrypted at rest** (or re-derive by re-reading the original signal vault via CDR on boot,
  which keeps the secret only in the TEE). On boot, reconcile against on-chain vault balances:
  - balance present but no recorded position → adopt/repair (read the originating signal),
  - recorded position but balance gone → it was exited; close the record.
- Never persist thresholds in plaintext outside the TEE.

## 8. Concurrency with entries
- A follower's **entry must be confirmed** before the monitor can exit it (per-follower lock from
  `31 §7`).
- If an EXIT signal (manual) and a TP/SL trigger race, the first to acquire the follower lock wins;
  the other sees "no open position" and no-ops.

## 9. What stays secret vs public here

| Item | Secret? |
|---|---|
| takeProfitPrice / stopLossPrice | **Secret** — TEE only, never on-chain/logged |
| current market price | Public (oracle/DEX) |
| the exit swap (token→USDC) | Public (on-chain), like any settled trade |
| the *fact* a position closed | Public (a swap happened) |

So the monitor preserves the invariant: the **levels** never leak; only the **resulting trade** is
visible (same honest limitation as entries — `00-overview §4`, `security/70`).

## 10. Acceptance
- ✅ a position with a TP closes when the (mocked) price reaches the TP; same for SL
- ✅ thresholds never appear in logs/state-at-rest in plaintext (assert in test)
- ✅ price read is grouped by token (one read → many followers) and uses the documented source
- ✅ exit fires even if the subscription expired after entry
- ✅ restart reconciles open positions and still fires pending TP/SL
- ✅ entry/exit race is serialized per follower (no double exit)

→ Next batch: `execution/` (`40`, `41`, `42`) + `key-management/50`.

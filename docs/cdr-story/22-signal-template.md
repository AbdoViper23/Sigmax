# 22 — The Signal Template (schema)

> The exact, structured shape of a spot signal the leader fills in and the agent executes. This is
> the contract between the leader (publisher) and the agent (consumer). It lives in
> `packages/shared/signal.ts` so both sides use one definition.
> Pairs with `cdr-story/20-cdr-sdk.md` (encrypt/decrypt) and `agent/31`/`agent/32` (execute/monitor).

---

## 1. Why a template (not free text)

We discussed this directly: a structured template (vs free-form text) makes the agent's job
**deterministic** — it parses fixed fields, never "interprets" prose. It also makes the leader's UX
a simple form, and lets us validate every decrypted signal with a schema before any money moves.
**It does not remove the agent** — the signal is still encrypted (so something off-chain must
decrypt it) and the TP/SL must be monitored privately (so it can't be a pure smart contract). The
template just makes the agent simpler and the strategy safer. (See the earlier discussion and
`agent/32 §1`.)

## 2. Spot-only field set

A signal is one of two **actions** on one whitelisted token, priced in the reference token (USDC).

```ts
// packages/shared/signal.ts
import { z } from "zod";

export const SignalSchema = z.object({
  v: z.literal(1),                               // schema version
  strategyId: z.number().int().nonnegative(),    // which strategy/plan this belongs to
  signalId: z.string().uuid(),                   // unique per signal (idempotency)
  issuedAt: z.number().int(),                    // unix seconds, set at publish
  expiresAt: z.number().int(),                   // ignore if not executed by then (stale guard)

  action: z.enum(["ENTRY", "EXIT"]),             // ENTRY = buy target with USDC; EXIT = sell target back to USDC

  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),// target token address (MUST be follower-whitelisted)
  chainId: z.number().int(),                     // liquidity chain (e.g. 42161 Arbitrum)

  // sizing (ENTRY only): fraction of the follower's USDC balance to deploy, in basis points
  sizeBps: z.number().int().min(1).max(10_000).optional(),

  // optional limit entry price (USDC per token, scaled) — if set, agent waits for price <= this
  maxEntryPrice: z.string().optional(),

  // exits — kept SECRET, monitored by the agent in the TEE, NEVER written on-chain
  takeProfitPrice: z.string().optional(),        // USDC per token, scaled; sell when price >= this
  stopLossPrice: z.string().optional(),          // USDC per token, scaled; sell when price <= this

  maxSlippageBps: z.number().int().min(1).max(2_000).default(100), // 100 = 1%
}).refine(s => s.action !== "ENTRY" || s.sizeBps !== undefined, {
  message: "ENTRY requires sizeBps",
});

export type Signal = z.infer<typeof SignalSchema>;
```

> **Spot-only invariant baked in:** there is no `side: short`, no `leverage`, no `collateral`, no
> `margin`. The only verbs are buy-target-with-USDC and sell-target-for-USDC. If a future field
> would imply leverage/borrowing, it violates `CLAUDE.md` rule 1 — reject it.

## 3. The template the leader sees (UX)

The leader doesn't write JSON. The web app shows a form with a **template picker** + fields:

| Field | Input | Notes |
|---|---|---|
| Token | searchable dropdown (whitelisted targets) | name + address; only assets followers can whitelist |
| Action | Entry / Exit | |
| Size | slider (1–100%) → `sizeBps` | ENTRY only |
| Entry price (optional) | number | limit entry; blank = market |
| Take profit (optional) | number | **secret**; monitored, never on-chain |
| Stop loss (optional) | number | **secret**; monitored, never on-chain |
| Max slippage | number (default 1%) | |

The app builds the `Signal`, validates with `SignalSchema`, encrypts it client-side, and publishes
via `uploadCDR` (`cdr-story/20`). Templates can be saved presets ("scalp", "swing") that pre-fill
defaults — pure UX sugar over the same schema.

## 4. Price scaling (avoid float bugs)

Prices (`maxEntryPrice`, `takeProfitPrice`, `stopLossPrice`) are **USDC per 1 target token**, encoded
as integer strings scaled to a fixed precision (e.g. 1e8) to avoid floating point. The agent compares
against an on-chain/oracle price normalized to the same scale (`agent/32`). Document the scale in
`shared/constants.ts` and use it on both sides.

## 5. Idempotency & staleness (safety)

- **`signalId`** — the agent tracks processed `signalId`s so a re-read or restart never double-executes.
- **`expiresAt`** — if the agent processes a signal after `expiresAt` (it was offline), it **skips
  the entry** (the edge is gone) but still honors exits for already-open positions.
- **`issuedAt`** — used for the verifiable track record (commit-before-outcome timestamp).

## 6. What the agent does with each field (preview of agent/31–32)

```
ENTRY:
  validate schema → check follower isActive (registry) → amountIn = USDC_balance * sizeBps/10000
  → if maxEntryPrice set, wait until price <= maxEntryPrice (TEE poller) → quote (minOut from maxSlippageBps)
  → CopyVault.executeSwap(USDC -> token) → record open position {token, entryPx, TP, SL} in TEE state
EXIT (explicit, or triggered by TP/SL):
  → quote (token -> USDC) → CopyVault.executeSwap → close position
```
The `takeProfitPrice`/`stopLossPrice` live in the agent's TEE memory/state for the life of the
position and are used by the monitor (`agent/32`). They are **never** emitted on-chain or logged.

## 7. Encoding for CDR

`encodeSignal`/`decodeSignal` (in `packages/shared`) serialize the validated `Signal` to bytes for
the CDR data-key vault and back. Keep it deterministic (sorted keys / fixed ABI tuple) so the same
signal always encodes identically. The agent **must** re-validate with `SignalSchema` after
`decodeSignal` before acting — a corrupted/forged payload must never reach `executeSwap`.

```ts
// shape used for ABI encoding (mirrors the zod type); keep in sync with SignalSchema
const SIGNAL_ABI = [{ type: "tuple", components: [
  { name: "v", type: "uint8" }, { name: "strategyId", type: "uint256" },
  { name: "signalId", type: "bytes16" }, { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" }, { name: "action", type: "uint8" }, // 0=ENTRY,1=EXIT
  { name: "token", type: "address" }, { name: "chainId", type: "uint256" },
  { name: "sizeBps", type: "uint16" }, { name: "maxEntryPrice", type: "uint256" },
  { name: "takeProfitPrice", type: "uint256" }, { name: "stopLossPrice", type: "uint256" },
  { name: "maxSlippageBps", type: "uint16" },
]}] as const;
```

## 8. Acceptance
- ✅ `SignalSchema` accepts a valid ENTRY and a valid EXIT; rejects ENTRY without `sizeBps`
- ✅ schema rejects any leverage/short-implying field (there are none — assert the shape is closed)
- ✅ `encodeSignal`→`decodeSignal` round-trips identically; agent re-validates after decode
- ✅ web form produces a schema-valid `Signal` for every template preset
- ✅ a signal processed after `expiresAt` is skipped for entry (unit test on the agent)

→ Next batch: `agent/` — `30-agent-overview.md`, `31-agent-execution-flow.md`, `32-agent-tp-sl-monitor.md`.

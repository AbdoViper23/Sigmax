# 60 — Frontend Stack & User Flows

> The web app: stack, the two-chain wallet setup, and the exact leader and follower flows screen by
> screen. Pairs with `frontend`-adjacent docs: `cdr-story/20` (client-side encrypt/publish),
> `cdr-story/21` (subscribe/mint), `contracts/10` (deposit/authorize), `agent/*` (what happens after).

---

## 1. Stack (from `02-tech-stack §6`)

- **Next.js (App Router)** on **Vercel**.
- **wagmi + viem + RainbowKit** for wallet connection and contract calls.
- **@story-protocol/core-sdk** (IP/license/royalty) and **@piplabs/cdr-sdk** (client-side encrypt &
  publish) — the leader's signal is encrypted **in the browser** so plaintext never hits our server.
- **Tailwind** for UI; **@tanstack/react-query** (wagmi peer) for data.
- **Supabase** for non-secret app data (subscriber index, leader profiles, cached trade history).

## 2. Two chains in one app (critical config)

```ts
// lib/wagmi.ts
import { createConfig, http } from "wagmi";
import { arbitrum } from "wagmi/chains";
const storyAeneid = { id: 1315, name: "Story Aeneid", /* rpc: aeneid.storyrpc.io */ };

export const config = createConfig({
  chains: [storyAeneid, arbitrum],   // Story = license/IP/subscribe; Arbitrum = vault/deposit/authorize
  transports: { [storyAeneid.id]: http(STORY_RPC), [arbitrum.id]: http(LIQUIDITY_RPC) },
});
```
The UI must guide chain switching: subscribing/publishing → Story; depositing/authorizing → liquidity
chain. Show a clear "switch network" prompt at each step so users aren't confused.

## 3. Pages / routes (`apps/web/app`)

```
/                  landing: what Sigmax is + leaderboard teaser
/leaderboard       verifiable track records (on-chain sourced) — the trust hook
/leader            leader dashboard: register strategy, set price, publish signals
/follower          follower dashboard: subscribe, deposit, authorize, see positions
/strategy/[id]     public strategy page: verified record + "Follow" CTA
```

## 4. Leader flow (step by step)

1. **Connect wallet** (Story network).
2. **Register strategy** → `mintAndRegisterIp` + `registerPilTermsAndAttach` (set monthly price in
   `$WIP`, platform revShare). Gets `ipId`. (`cdr-story/21`) One-time.
3. **Split royalty tokens** (e.g. 85 leader / 15 platform) so revenue auto-splits. (`cdr-story/21 §5`)
4. **Publish a signal:** pick a **template**, fill `{token, action, size, entry?, takeProfit?,
   stopLoss?, slippage}` (`cdr-story/22`). The app:
   - validates with `SignalSchema`,
   - **encrypts client-side** and calls `uploadCDR` (read=License, write=Owner condition) (`cdr-story/20`),
   - notifies the agent (event/index).
   - **The TP/SL the leader types are never sent to our server in plaintext** — they're inside the
     encrypted payload only.
5. **Track performance:** dashboard shows the strategy's verifiable record + subscriber count +
   revenue claimable (`claimAllRevenue`).

> Leader UX guardrail: the publish form has **no leverage/short fields** — spot only (`22`, `71`).

## 5. Follower flow (step by step)

1. **Connect wallet.**
2. **Discover** a strategy via `/leaderboard` or `/strategy/[id]` (verifiable record builds trust).
3. **Subscribe** (Story network): wrap IP→$WIP if needed, then `mintLicenseTokens` (pays monthly
   fee into the Royalty Vault) and/or `subscribe()` on the registry (sets 30-day expiry). (`cdr-story/21`,
   `contracts/12`)
4. **Set up the CopyVault** (liquidity chain): one transaction via `CopyVaultFactory.createVault`
   that deploys their vault, sets the token whitelist (USDC + chosen targets), caps (per-trade,
   daily), and authorizes the agent's executor address. (`contracts/10 §7`)
5. **Deposit** USDC into the vault. (`contracts/10`)
6. **Done — copying is automatic.** The dashboard shows: open positions (token, entry, current PnL),
   trade history (from `Swapped` events), subscription status ("active until {date}"), and a
   one-click **Revoke agent** / **Pause** (`key-management/50 §6`).

> Follower UX guardrail: prominent, plain-language security note — "funds stay in your vault; the bot
> can only swap within your limits; revoke anytime" (`key-management/50 §7`). This is a conversion
> driver, not legal fine print.

## 6. What the frontend must NOT do (secrets)
- Never request, display, or store the decrypted signal, takeProfit, or stopLoss for a **follower**
  (auto-execute = they never see it). (`CLAUDE.md` rule 3, `00-overview §2`.)
- For the **leader**, the TP/SL they enter are encrypted client-side and sent only inside the CDR
  payload — never logged or sent to our backend.
- Trade history shows results only (token pair, amounts, tx, PnL), never strategy logic.

## 7. Leaderboard (the trust engine)
Sourced from on-chain truth: each strategy's published-signal timestamps (commit-before-outcome) +
the resulting `Swapped` events → compute verified return, win rate, max drawdown (spot). Cache in
Supabase for speed but link to on-chain proofs. This is the "can't fake the record" feature that
drives `93-gtm-first-20-users.md`.

## 8. Backend (Next.js route handlers)
- `GET /api/strategies`, `GET /api/strategy/[id]` — public stats (no secrets).
- `GET /api/follower/[address]/positions` — reads on-chain + cached, results only.
- A small indexer (or the agent) writes non-secret trade results to Supabase for fast reads.
- No endpoint ever returns signal logic / TP / SL.

## 9. MVP vs defer
- **MVP:** connect, leader register+publish (one template), follower subscribe+deposit+authorize,
  positions view, basic leaderboard for one strategy. Enough to demo the full loop + show a record.
- **Defer:** rich charts, multi-strategy discovery/search, notifications, mobile polish, social
  features, fiat on-ramp for $WIP.

## 10. Acceptance
- ✅ wallet connects; app correctly prompts Story vs liquidity-chain switches at each step
- ✅ leader can register a strategy, set price, and publish a template signal (encrypted client-side)
- ✅ follower can subscribe, create+fund a CopyVault, and authorize the agent in guided steps
- ✅ positions + trade history render from on-chain events (results only; no secrets)
- ✅ revoke/pause works from the UI
- ✅ leaderboard shows a verifiable record sourced from on-chain data
- ✅ no API or page ever exposes signal logic / TP / SL

→ Next: `security/70-leakage-mitigation.md`.

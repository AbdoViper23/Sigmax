# 01 — Architecture

> The complete component map and the end-to-end flow, from the leader publishing a signal to the
> follower's swap executing and revenue splitting. Read `00-overview.md` first for the 3-layer
> mental model; this file is the detailed version.

---

## 1. Component map

```
                          STORY L1 (chain 1315 testnet / 1514 mainnet)
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  CDR Vault (encrypted signal)        Story IP/Licensing/Royalty           │
   │   ├─ ReadCondition  ◄── gates decrypt   ├─ IP Asset (the strategy)        │
   │   └─ WriteCondition ◄── gates publish   ├─ PIL terms (price = sub fee)    │
   │                                         ├─ License Token (= subscription) │
   │  SubscriptionRegistry (follower→expiry) └─ IP Royalty Vault (rev split)   │
   └───────────▲───────────────────────────────────────────▲──────────────────┘
               │ publish (uploadCDR)                         │ mint license / pay
               │                                             │
        ┌──────┴───────┐                              ┌──────┴───────┐
        │   LEADER     │                              │   FOLLOWER   │
        │ (web app)    │                              │ (web app)    │
        └──────────────┘                              └──────┬───────┘
                                                             │ deposit + authorize
               ┌─────────────────────────────────────┐      │
               │            THE AGENT (TEE)           │      │
               │  watch Story → accessCDR (decrypt)   │      │
               │  → check active subs → build swap    │      │
               │  → monitor TP/SL                     │      │
               │  holds NO funds; scoped executor key │      │
               └───────────────┬──────────────────────┘      │
                               │ executeSwap (bounded)        │
                               ▼                              ▼
                 LIQUIDITY CHAIN (Arbitrum One or Base, chain 42161 / 8453)
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  CopyVault (per follower)  ──approve+swap──►  DEX / Aggregator (0x, CoW)  │
   │   ├─ owner = follower (only owner withdraws)                              │
   │   ├─ EXECUTOR_ROLE = agent (executeSwap only, whitelist + caps)           │
   │   └─ holds the follower's spot funds (e.g. USDC)                          │
   └─────────────────────────────────────────────────────────────────────────┘
```

## 2. Responsibilities per component

| Component | Lives on | Job | Doc |
|---|---|---|---|
| **CDR Vault** | Story L1 | Holds the threshold-encrypted signal | `cdr-story/20` |
| **ReadCondition** | Story L1 | Returns true only if caller may decrypt | `contracts/11` |
| **WriteCondition** | Story L1 | Returns true only if caller may publish (leader) | `contracts/11` |
| **SubscriptionRegistry** | Story L1 | `follower → subscription expiry timestamp` | `contracts/12` |
| **IP Asset + PIL** | Story L1 | The strategy as licensable IP; price = minting fee | `cdr-story/21` |
| **License Token** | Story L1 | Proof of an active subscription (an NFT) | `cdr-story/21` |
| **IP Royalty Vault** | Story L1 | Auto-splits subscription revenue (leader + platform) | `cdr-story/21` |
| **Agent** | Off-chain (TEE) | Decrypt, decide, build & submit swaps, monitor exits | `agent/30–32` |
| **CopyVault** | Liquidity chain | Holds follower funds; executes bounded swaps | `contracts/10` |
| **DEX / Aggregator** | Liquidity chain | Provides spot liquidity + the swap route | `execution/41` |
| **Web app** | Vercel | Leader publish UI + follower subscribe/deposit/authorize UI | `frontend/60` |

## 3. Trust model (who can do what)

- **Follower trusts the agent to execute honestly**, but does **not** trust it with custody — the
  CopyVault contract makes theft impossible (agent can only swap whitelisted tokens within caps;
  only the follower withdraws). The agent runs in a **TEE** so that even the platform operator
  can't see the decrypted signal or tamper with execution. (See `key-management/50`, `agent/30`.)
- **Leader trusts CDR** to keep the signal encrypted until the agent decrypts it. CDR's guarantee
  is threshold encryption: no single validator can decrypt; a quorum must cooperate, inside SGX.
- **Platform trusts no one with money it shouldn't** — revenue flows through Story's Royalty Vault
  (permissionless claim), not through a platform-controlled wallet.

## 4. The two "secrets" and where they are allowed to exist

This is the most important invariant in the system.

| Data | Encrypted at rest? | Where plaintext is allowed | Never allowed |
|---|---|---|---|
| The signal (token, entry, TP, SL) | Yes (CDR) | In agent memory, briefly, inside the TEE | Any public on-chain field; any log; the frontend |
| "Did follower X pay?" | No (public OK) | SubscriptionRegistry / License Token on Story | — |
| The executed swap (token, amount) | No (inherently public) | On the liquidity chain | — |

If you ever find yourself writing the take-profit or stop-loss value to a place a third party can
read, you have broken the product. (See `CLAUDE.md` rule 3, `security/70`.)

## 5. End-to-end sequence (the full loop)

### Setup (once)
1. **Leader** connects wallet, registers the strategy as a **Story IP Asset**, attaches **PIL
   commercial terms** where `defaultMintingFee` = monthly price and `commercialRevShare` = platform
   cut. (`cdr-story/21`)
2. **Follower** subscribes by **minting a License Token** (pays the fee in $WIP → IP Royalty
   Vault). The mint also writes their expiry into the **SubscriptionRegistry**. (`contracts/12`)
3. **Follower** deploys/funds their **CopyVault** on the liquidity chain (deposits e.g. USDC) and
   calls `setExecutor(agentAddress, true)` + sets the token whitelist and caps. (`contracts/10`)

### Per signal (repeats all month)
4. **Leader** picks a template + fills `{token, priceIn, takeProfit, stopLoss, sizePct}`, the app
   encrypts it and calls **`uploadCDR`** → a CDR vault gated by the ReadCondition (subscription)
   and WriteCondition (leader-only). (`cdr-story/20`, `cdr-story/22`)
5. **Agent** detects the new/updated vault (event watch or poll). (`agent/31`)
6. **Agent** calls **`accessCDR`** and threshold-decrypts the signal **inside the TEE**. (`agent/31`)
7. **Agent** reads the **SubscriptionRegistry** and builds the list of **followers with an active
   subscription**. (`execution/42`, `contracts/12`)
8. For each active follower: read their CopyVault balance → compute `amountIn = balance * sizePct`
   → get an aggregator quote with `minOut` (slippage-protected). (`execution/41`)
9. **Agent** submits **`CopyVault.executeSwap(...)`** (batched / via CoW where possible) → the spot
   entry executes inside each follower's vault. (`contracts/10`, `security/70`)
10. **Agent** keeps the `{takeProfit, stopLoss}` in TEE memory and **monitors price**; when hit, it
    submits the exit swap for each follower. The TP/SL values are never written on-chain. (`agent/32`)

### Revenue (ongoing)
11. Subscription mints (and renewals) pay $WIP into the **IP Royalty Vault**; `claimAllRevenue`
    distributes to Royalty Token holders = the leader + the platform's slice. (`cdr-story/21`)

## 6. Sequence diagram (text)

```
Leader        Web        Story(CDR+IP)     Agent(TEE)     Registry      CopyVault     DEX
  │  publish   │             │                │              │             │           │
  │───────────►│ uploadCDR   │                │              │             │           │
  │            │────────────►│ (vault+conds)  │              │             │           │
  │            │             │                │ watch        │             │           │
  │            │             │◄───────────────│ accessCDR    │             │           │
  │            │             │ decrypt(TEE)──►│              │             │           │
  │            │             │                │ getActive────►│             │           │
  │            │             │                │◄──────────────│ [followers] │           │
  │            │             │                │ quote+minOut ─────────────────────────►│
  │            │             │                │ executeSwap ──────────────►│ swap ─────►│
  │            │             │                │ monitor TP/SL│             │           │
  │            │             │                │ exitSwap ─────────────────►│ swap ─────►│
```

## 7. Failure / edge handling (design intent — details in component docs)

- **CDR read times out** (too few validators): retry with backoff; raise `timeoutMs`. (`cdr-story/20`)
- **Subscription expired mid-position**: the agent still manages the *exit* of an already-open
  position (you don't strand a follower), but opens **no new entries** for them. (`contracts/12`)
- **Swap would exceed caps / token not whitelisted**: the CopyVault reverts; the agent logs and
  skips that follower (never silently widens limits). (`contracts/10`)
- **Quote stale / slippage**: `executeSwap` enforces `minOut` on-chain as a backstop even if the
  off-chain quote is wrong. (`execution/41`)
- **Agent down**: positions are safe (funds are in follower vaults); on restart the agent
  reconciles open positions from its own persisted state + on-chain balances. (`agent/30`)

→ Next batch: the contracts — `contracts/10-copyvault.md`, `11-cdr-conditions.md`, `12-subscription-registry.md`.

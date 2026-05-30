# 50 — Non-Custodial Execution & Key Management

> How the agent executes trades **without ever being able to steal funds**. This is the trust
> backbone of Sigmax. Three patterns, the recommended one for MVP, gas, and revocation.
> Pairs with `contracts/10` (the vault that enforces this) and `agent/30` (the agent's keys).

---

## 1. The principle

The agent must be able to **swap** a follower's funds (within bounds) but never **withdraw** them.
We achieve this by keeping funds in a contract the follower owns and giving the agent only a
**scoped capability**. Even a fully-compromised agent key results in (at worst) bounded, honest-price
swaps among whitelisted tokens — never theft.

## 2. The three patterns

| Pattern | Mechanism | Pros | Cons | Use |
|---|---|---|---|---|
| **A. CopyVault + EXECUTOR_ROLE** | funds in the follower's vault; agent has a role that can only call `executeSwap` | explicit, easy to audit, no AA infra | a contract per follower | **MVP (recommended)** |
| **B. ERC-4337 session keys** | smart account grants the agent a scoped session key | great UX, gasless options | needs AA stack (bundler/paymaster) | production UX |
| **C. EIP-7702 session keys** | EOA delegates scoped session key without changing address | followers keep their EOA | newer; L2 support varies | production UX |

### Pattern A — CopyVault (MVP)
Detailed in `contracts/10`. The agent holds `EXECUTOR_ROLE`; it can only call `executeSwap` bounded
by token whitelist + per-trade/daily caps; `withdraw` is `onlyOwner`; approval is exact and reset to
0 each swap. **Revocation:** `setExecutor(agent, false)` — instant. This is the strongest, simplest,
most auditable guarantee and needs no account-abstraction infrastructure. Ship this.

### Pattern B — ERC-4337 session keys
The follower uses a **smart account**; we install a **session key** for the agent scoped to: only the
swap function selector, only whitelisted routers/tokens, a value cap, and an expiry. Mature stacks:
**ZeroDev Kernel** (modular ERC-4337 with validators/executors/hooks and a permissions system),
**Safe + Rhinestone (`safe7579`)**. Best when followers already use smart accounts; enables gasless
UX via a paymaster. **Revocation:** uninstall/expire the session key.

### Pattern C — EIP-7702 session keys
**EIP-7702** (shipped in Ethereum's Pectra upgrade, May 2025) lets a plain **EOA delegate to contract
code** and expose **scoped, time-boxed session keys** without changing its address. Combined with
ERC-7579 modules (e.g. Rhinestone Smart Sessions) or MetaMask's Delegation Toolkit (ERC-7710/7715),
the agent gets a key scoped to "swap only, whitelisted routers/tokens, value cap, expiry." Elegant
and keeps the follower on their familiar EOA — but it's newer and **L2 7702 support varies by
chain/wallet**, so verify on the chosen liquidity chain before relying on it. (The user knows 7702
from EVM-internals work — natural v2.)

## 3. Recommendation

- **MVP:** **Pattern A** (CopyVault). No AA dependency, trivially auditable, instant revocation.
- **Production UX:** migrate authorization to **B or C** (session keys) for smoother onboarding and
  gasless flows, keeping the *capability model identical* ("swap-only, whitelisted, capped, expiring").
- Keep the authorization mechanism behind an interface so the agent's executor doesn't care which is
  in use.

## 4. The agent's keys (recap from `agent/30 §5`)

| Key | Power | If leaked |
|---|---|---|
| **Executor key** (`AGENT_PK`) | call `executeSwap` within bounds | bounded honest-price swaps only — no theft; followers can revoke instantly |
| **CDR access key** (`CDR_ACCESS_KEY`) | call `accessCDR` (decrypt) | can decrypt signals; touches no funds; rotate the operator license |

- Loaded from env; never hardcoded; in production provisioned **inside the TEE** so they exist only
  in the enclave.
- Rotate-able: the executor key is just an address with `EXECUTOR_ROLE`; followers can re-point to a
  new agent address; the platform can rotate the operator license.

## 5. Gas

The agent must pay gas to submit `executeSwap`. Options:
- **MVP:** an **agent gas wallet** on the liquidity chain (a small ETH balance, separate from any
  trading funds). Monitor balance; alert/refill when low. Cheap — L2 swaps are ~$0.02–0.05.
- **Production:** **ERC-4337 paymaster** (ZeroDev/Pimlico) for gasless follower UX, or sponsor gas
  from platform revenue. With Pattern A you can also have the vault reimburse a capped gas amount to
  the executor per swap (bounded, owner-configurable) — optional.

Never fund the gas wallet from follower vaults; gas is a platform/operational cost (`business/91`).

## 6. Revocation & incident response

- **Per follower:** `setExecutor(agent, false)` (Pattern A) or revoke the session key (B/C) — instant,
  follower-controlled. Add an owner-only `pause()` on the vault for an immediate freeze
  (`contracts/10 §10`).
- **Platform-wide:** rotate the executor key/operator license; followers re-authorize the new agent.
- **Compromise drill:** because funds are non-custodial, a key compromise is contained — document
  the runbook (revoke executor across vaults via the factory registry, rotate keys, notify users).

## 7. Why followers can trust this (the pitch)
- "Your funds stay in **your** vault. The bot can only **swap** them among tokens **you** whitelisted,
  within limits **you** set. It can **never** send them anywhere else. You can cut it off in one
  click. The bot runs in a sealed enclave, so not even we can see the strategy or tamper with it."
This sentence is the core of the follower-facing security story (`frontend/60`, `93-gtm`).

## 8. Acceptance
- ✅ Pattern A: agent swaps within bounds; cannot withdraw; revocation is instant (covered by `contracts/10` tests)
- ✅ executor key compromise simulated: attacker cannot extract funds, only bounded swaps
- ✅ gas wallet monitored; low-balance alert fires
- ✅ authorization is behind an interface so B/C can replace A without changing the executor
- ✅ documented incident runbook for key rotation + mass revocation

→ Next batch: `frontend/60` + `security/70`, `71`.

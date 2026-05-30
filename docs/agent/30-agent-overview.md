# 30 — The Agent: Overview

> What the "agent" actually is, its architecture, why it runs in a TEE, and its lifecycle. If you've
> never built one: an agent here is just a long-running TypeScript program (a daemon) with its own
> key that watches chains and submits transactions. Nothing mystical.
> Pairs with `31` (the execution loop) and `32` (TP/SL monitoring), and `key-management/50` (its key).

---

## 1. What the agent is (plain definition)

The agent is an **off-chain Node.js/TypeScript service** that:
- holds its own keypair (a **scoped executor key**, NOT a key that can withdraw funds — see `50`),
- **watches** Story for new encrypted signals,
- **decrypts** each signal privately (CDR `accessCDR`),
- figures out **which followers** have an active subscription,
- **builds and submits** the spot swap into each follower's `CopyVault` on the liquidity chain,
- **monitors** open positions for take-profit / stop-loss and submits exits.

It is **deterministic plumbing**, not an LLM. (You *could* later add an LLM for, say, signal
summaries, but the executor itself must be deterministic — money is involved.)

## 2. Why an agent is unavoidable (recap of the design constraint)

Two things force an off-chain actor (we worked through this earlier):
1. **Decryption is off-chain.** CDR plaintext is recovered client-side from validator partials; a
   smart contract cannot synchronously decrypt. So *something* off-chain must decrypt the signal.
2. **Secret TP/SL must be monitored privately.** If the take-profit/stop-loss were on-chain for a
   generic keeper to read, they'd be public — defeating the product. So a private (TEE) watcher must
   compare live price against the secret levels.

The agent is that off-chain actor, minimized in trust: it can decrypt and execute, but **cannot
steal** (the CopyVault bounds it) and **cannot see plaintext if run in a TEE that even we can't peek
into**.

## 3. Architecture options (and our choice)

| Option | What | Pros | Cons | Verdict |
|---|---|---|---|---|
| Server daemon | a Node process you run | simplest, full control | operator could see plaintext | **MVP** |
| Client-side | follower's browser decrypts/signs | maximally trustless | follower must be online at signal time → unusable for copy latency | ✗ |
| **TEE daemon** | same daemon inside Intel TDX/Nitro enclave | operator can't see plaintext; attestable | enclave packaging effort | **Production (recommended)** |

**Decision:** build a **server daemon that is TEE-ready from day one** (Dockerized, no plaintext in
logs/state), demo it as a plain daemon if time is short, then deploy the *same image* to a TEE for
launch.

## 4. Why a TEE (and which one)

A TEE (Trusted Execution Environment) is hardware-isolated memory where code runs such that even the
machine's operator can't read it, and it can **prove** (remote attestation) that the exact approved
code is running. This is the natural home for the decrypted signal: it means **even we (the
platform) can't leak the leader's alpha**, and followers/leaders can verify it.

Options (all support Dockerized workloads + on-chain attestation):
- **Phala Cloud (Intel TDX)** — Docker via `dstack`, on-chain attestation, ~**$0.14/hr (≈ $100/mo)**
  for a 2 vCPU CVM (cheaper tiers exist). Easiest path. (Cost in `business/91`.)
- **Marlin Oyster** — AWS Nitro + SGX with on-chain attestation verifiers.
- **Raw AWS Nitro Enclaves** — most control, most ops.

**Decision:** **Phala Cloud (TDX)** for launch — Dockerize the agent and deploy. CDR's own validators
run in SGX, so a TEE agent is thematically and practically aligned, and CDR can even gate decryption
on TEE attestation later.

## 5. The agent's keys (critical — detail in `key-management/50`)

- **Executor key (`AGENT_PK`)** — signs `CopyVault.executeSwap` calls. Scoped: it can only swap
  whitelisted tokens within caps; it **cannot withdraw** any follower's funds. If leaked, worst case
  is bounded honest-price swaps, not theft.
- **CDR access key (`CDR_ACCESS_KEY`)** — used to call `accessCDR`; tied to the operator license
  (`contracts/11 §5`). Lets the agent decrypt; does not touch funds.
- Both are loaded from env, never hardcoded. In a TEE they're provisioned via the enclave's secret
  management so they exist only inside the enclave.

## 6. Lifecycle

```
boot → load config/keys (env) → connect Story + liquidity RPC + Redis
     → reconcile state (read persisted open positions; verify against on-chain balances)
     → start watcher (new signals)  ──┐
     → start TP/SL monitor (poller) ──┼─► enqueue jobs to BullMQ
     → process jobs (decrypt/execute)─┘
     → on SIGTERM: stop intake, finish in-flight jobs, persist state, exit
```

- **Restart safety:** the agent persists only **non-secret** position metadata (follower, token
  pair, amounts, entry tx, and the secret TP/SL **encrypted at rest** or re-derivable by re-reading
  the signal vault). On restart it reconciles open positions so it doesn't lose track of exits.
- **Idempotency:** processed `signalId`s are recorded so a re-read never double-executes (`22 §5`).
- **Crash ⇒ funds safe:** funds live in follower vaults; a dead agent means trades pause, not loss.

## 7. What the agent must NEVER do (guardrails)
- Never log, persist in plaintext, or transmit the decrypted signal / TP / SL (`CLAUDE.md` rule 3).
- Never call anything but `executeSwap` on a CopyVault; never attempt withdrawals.
- Never widen a follower's caps/whitelist; if a swap would exceed them, skip and log a non-secret
  error (`SKIPPED: cap exceeded`), don't try to work around it.
- Never open a new entry for an inactive subscriber (registry check) — but DO manage their open
  position's exit (`contracts/12 §5`, `31`).

## 8. Tech (from `02-tech-stack §4`)
Node + TypeScript; **viem** for both chains; **@piplabs/cdr-sdk** for decrypt; **BullMQ + Redis**
for the queue/poller; **zod** to validate decrypted signals; **pino** with redaction (signal
excluded). Packaged as a Docker image for Phala TDX. Code layout in `03-repo-structure §2`.

## 9. Observability (without leaking secrets)
- Log: signal *received* (uuid, strategyId, signalId — all non-secret), per-follower execution
  result (token pair, amountIn, amountOut, tx hash), exits, errors.
- Never log: action rationale, token *choice reasoning*, TP/SL values, the decoded signal object.
- Metrics: signals/min, decrypt latency, swap success rate, followers processed, queue depth.

## 10. Acceptance
- ✅ boots, connects to both chains + Redis, loads keys from env
- ✅ survives restart: reconciles open positions from persisted state + on-chain balances
- ✅ never logs the decoded signal (assert via a log-capture test + pino redaction config)
- ✅ refuses to act for an inactive subscriber's new entry; still exits their open position
- ✅ Dockerfile builds; image runs identically locally and (later) on Phala TDX

→ Next: `31-agent-execution-flow.md` (the loop in detail).

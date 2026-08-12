# Hyperliquid as a second venue on the Flare stack

> **Branch:** `feat/hl-on-flare` · **Status:** phases 1–5 complete and green (99 extension tests).
> Not yet exercised against a live enclave — see *What is proven, and what is not* at the end.
> Companion to [01-technical-blueprint.md](01-technical-blueprint.md) and [RUNBOOK.md](RUNBOOK.md).

## The problem this solves

The repo currently contains **two parallel stacks**, not one platform:

| | Flare stack (current) | Hyperliquid stack (legacy) |
|---|---|---|
| Encryption | browser ECIES → enclave pubkey | Story CDR threshold encryption |
| Decryption runs in | FCC enclave, attested (`fce-sigmax/`) | plain Node daemon on an untrusted host (`packages/agent/`) |
| Subscriptions | `SubscriptionRegistry` on Coston2 | `SubscriptionRegistry` on Story Aeneid |
| Publish | one tx the leader signs | HTTP POST to a server that encrypts for them |

So Hyperliquid today has **no confidentiality guarantee**: the leader's `takeProfitPrice` /
`stopLossPrice` are decrypted into the heap of an ordinary process whose operator can read them, and
whose code nobody can verify.

This plan makes Hyperliquid a first-class venue **on the Flare stack**: same encrypted signal, same
attested enclave, same Coston2 control plane. Story is not involved anywhere in the new path.

## The key insight that makes it cheap

The extension framework **already** has the primitive an off-chain venue needs — key custody inside
the TEE. [`handlers.ts`](../../fce-sigmax/typescript/src/app/handlers.ts) registers:

- `KEY/UPDATE` — accepts a private key *encrypted to the enclave*, decrypts it inside, holds it in
  enclave memory only.
- `KEY/SIGN` — signs with it without the key ever leaving.

That is exactly what the Hyperliquid agent key needs. We are not building key custody; we are using it.

Two more things already line up:

- `venue` is already in the signal schema and already ABI-encoded ([signal.ts](../../packages/shared/src/signal.ts)),
  so the wire format needs no change.
- **A Hyperliquid account IS an EVM address.** The subscriber addresses `SubscriptionRegistry` on
  Coston2 already returns work as-is on Hyperliquid — no mapping table, no extra registry.

## Architecture

```
  leader (browser) — ECIES to the enclave key, picks venue
            │
            ▼
   InstructionSender (Coston2)              ← one publish path for both venues
            │
            ▼  ONE enclave, ONE code hash
   decrypt · read active subscribers (Coston2 SubscriptionRegistry) · FTSO reference price
            │
    ┌───────┴────────┐
    ▼                ▼
 venue=flare     venue=hyperliquid
 SwapAuth[]      sign the HL order with the KEY-injected agent key,
 signed by TEE   POST it to the HL API from inside the enclave
    │                │
 keeper relays       ▼
    ▼            receipt (follower, oid, status) — no strategy content
 CopyVaultFlare
 verifies on-chain
```

### Where the bounds are enforced — state this honestly

| | Flare | Hyperliquid |
|---|---|---|
| Execution authority | TEE signature | agent key held inside the enclave |
| Who enforces cap / slippage / spot-only | **the contract, on-chain** | **the enclave's code** |
| How a follower verifies | `ecrecover` — anyone can check | attestation — verify the code hash |
| Withdrawal | owner only | impossible — Hyperliquid rejects withdrawals signed by an agent key |

These are not the same guarantee and the docs must not imply they are. The honest line is: *on Flare
the chain enforces the bounds; on Hyperliquid attested code enforces them.* Both are a large
improvement on "an unverifiable process on someone's server enforces them".

### Two decisions taken up front

**1. No new dependency inside the enclave.** `@nktkas/hyperliquid` is 7.7 MB across 3 transitive
deps, for what is fundamentally *msgpack + EIP-712 + one HTTP POST*. Every byte in the enclave is
attested surface, so we implement the ~150 lines we actually need using `viem`, which is already a
dependency — and then **prove byte-equality against the real SDK in a differential test** that lives
in `packages/agent` (which already has the SDK). Confidence without the surface.

**1b. One agent key per follower, derived — not one shared key.** This was not in the original plan;
it came out of reading Hyperliquid's own docs mid-build, and it corrects a latent bug in the legacy
agent ([`hyperliquid/executor.ts`](../../packages/agent/src/hyperliquid/executor.ts) signs for every
follower with a single `agentPk`).

Hyperliquid tracks nonces **per signer address**, keeping only *"the 100 highest nonces"*, and
*"separate subaccounts signed by the same API wallet will share the nonce tracker of the API wallet"*.
Fanning one signal out to N followers through a single agent address therefore puts every follower
into one 100-slot window — under load, orders start being dropped silently. Hyperliquid additionally
states it is *"**strongly** suggested to not reuse their addresses"*, since a deregistered agent's
nonce set may be pruned and old actions replayed.

Injecting N secrets does not scale, so the enclave derives them from one, BIP32-style:

```
tweak     = HMAC-SHA256(masterPub, "sigmax/hl-agent/v1" ‖ follower) mod n
childPriv = (masterPriv + tweak) mod n      ← only the enclave can compute this
childPub  = masterPub + tweak·G             ← ANYONE can compute this
```

The asymmetry is the payoff: the enclave publishes only its master **public** key, and a follower's
wallet derives the agent address it is about to approve **itself**. It verifies the derivation rather
than trusting an address a server returned. Derivation is deterministic, so an enclave restart (which
clears the injected key) needs re-injection only — never re-approval by every follower.

**2. The agent key is injected, not enclave-generated — for now.** Three options exist:

| | mechanism | address after restart | who holds the key |
|---|---|---|---|
| A | generated inside the enclave | **changes** → every follower must re-approve | enclave only |
| B | injected via `KEY/UPDATE` from cold storage | stable | enclave **+ operator** |
| C | derived in-enclave from sealed material bound to the code hash | stable | enclave only |

**C is the destination**, but it depends on whether the FCC node exposes derived key material to the
extension — unverified, so it must not be built on before a spike. **B ships now.** The operator can
trade with it, but still cannot withdraw, and — the point — the *strategy plaintext* never leaves the
enclave. That is one shared secret instead of today's three (trade key + decrypt key + plaintext).

## Phases and acceptance criteria

A phase is done only when its criteria pass. No phase is "done" on inspection alone.

### Phase 1 — HL action signing inside the enclave (pure, offline)
`fce-sigmax/typescript/src/app/sigmax/hl/msgpack.ts`, `hl/sign.ts`

Deterministic msgpack subset (the types HL actions actually use), the L1 action hash
(msgpack ‖ nonce ‖ vault flag → keccak256), and the EIP-712 `Agent` signature.

- **Gate:** a differential test in `packages/agent` asserts our `actionHash` and signature are
  **byte-identical** to `@nktkas/hyperliquid`'s for the same order action, on both mainnet and
  testnet source values. A mismatch fails the build.

### Phase 2 — market math ported into the enclave (pure, offline)
`fce-sigmax/typescript/src/app/sigmax/hl/meta.ts`

Copy (not re-derive) the already-unit-tested pure helpers from
[`packages/agent/src/hyperliquid/meta.ts`](../../packages/agent/src/hyperliquid/meta.ts): pair
resolution, unit conversion, tick/lot rounding, order planning, the spot-only assertion.

- **Gate:** the ported tests pass unchanged inside the extension suite.

### Phase 3 — subscriber discovery split
`fce-sigmax/typescript/src/app/sigmax/chain.ts`

`readActiveFollowers` currently folds "who is subscribed" together with "what is their vault". Split
the first half out so the Hyperliquid path can reuse subscriber discovery (including its block-window
scanning and cache) without touching the vault factory.

- **Gate:** existing Flare handler tests stay green with no behavioural change.

### Phase 4 — the Hyperliquid execute path
`fce-sigmax/typescript/src/app/sigmax/hl/execute.ts`, plus a venue branch in `handler.ts`

Per active subscriber: read their spot balance, size against it with the shared sizing rule, plan a
spot IOC order, sign it with the injected key, POST it to the HL API. All network calls behind
injectable deps so the whole path is testable offline.

- **Gates:**
  - handler tests cover: happy path, no injected key, unknown coin, expired signal, zero-size follower,
    per-follower failure isolation.
  - a redaction test asserts **no log line and no returned byte** contains `takeProfitPrice`,
    `stopLossPrice`, or the coin — the same standard the Flare path is already held to.
  - the returned `resultData` is a receipt (`follower`, `oid`, `status`) and nothing else.

### Phase 5 — onboarding surface
Expose the enclave's HL agent address via `GET /state` so a follower can `approveAgent` to an address
that provably came from an attested enclave. Add `scripts/hl-inject-key.ts` (encrypt the agent key to
the enclave pubkey, send `KEY/UPDATE`).

- **Gate:** `/state` reports the address; injecting a known key yields the expected address.

## What the legacy Hyperliquid path was worth

The pre-Flare Hyperliquid stack (`packages/agent`, Story CDR) was reviewed rather than discarded. Two
things in it were solving problems the Flare path had not yet met:

**1. Idempotency — ported.** `PositionStore.isProcessed` deduped by `signalId`. The Flare path never
needed it: a `SwapAuth` is replay-protected by the vault itself (`keccak256(actionId, index) =>
consumed`). Hyperliquid has no such backstop — the enclave sends a real order the moment it decrypts
one, so a re-delivered instruction is a second real trade with the follower's money. And re-delivery is
not hypothetical: FCC routes each instruction to a random registered machine and the publish path
retries when it lands on a stale one. Now guarded in `handler.ts`, marked *before* the fan-out so a
crash mid-run can lose a trade but never duplicate one.

**2. Restart-safe confidential state — a better design than the one this doc originally sketched.**
`PositionStore.persist`/`reconcile` wrote only the non-secret fields and re-derived the secret TP/SL on
boot by re-reading the encrypted source. That is strictly better than the "seal the position state to
the enclave's own key" idea sketched below, because it needs no new sealing primitive: the ciphertext
is already on-chain and the enclave can already decrypt it. When TP/SL monitoring is built, that is the
shape to build.

Also worth recording: `TpSlMonitor` groups positions by (venue, token, quote) so one price read serves
every holder, guards against overlapping ticks, and isolates a per-market price failure. All directly
reusable.

And one defect found: the legacy `HyperliquidExecutor` signs for **every** follower with a single
`agentPk` — see decision 1b above for why that cannot work beyond one follower.

## What is proven, and what is not

Every phase gate above passes: **101 tests in the extension** (up from 40), plus the monorepo (106) and
the contracts (60) still green, a clean typecheck everywhere, and a successful web build.

Proven offline, with confidence:

- Signatures are **byte-identical** to `@nktkas/hyperliquid` across nonces past uint32, multi-order
  batches, vault addresses, and both networks. This is the part that would otherwise fail silently.
- Each follower's order is signed by **that follower's own** derived agent key — asserted by recovering
  the signer from the EIP-712 payload the fake exchange received.
- The venue **fails closed**: no injected key, or no configured per-trade cap, and nothing is sent.
- The take-profit, stop-loss, and even the market never reach a log line, an error string, or the
  returned bytes — including when the exchange's own error message quotes them back.

Not yet proven — needs a live enclave and a funded Hyperliquid testnet account:

- A real `KEY/UPDATE` round trip through the deployed extension.
- A real order actually accepted by Hyperliquid (the signature is pinned against the reference
  implementation, but only the exchange can confirm the approved-signer path end to end).
- Egress from the Confidential Space workload to `api.hyperliquid-testnet.xyz`. The extension already
  makes outbound HTTPS calls to a public RPC, so this is expected to work — expected, not verified.
- The `updateKey` routing caveat: the instruction goes to **one** random registered machine, so with
  several machines registered the others hold no key and reject Hyperliquid signals.

### Out of scope on this branch
- ~~Wiring the **web app** to the Flare path.~~ **Done** in a follow-up commit on this branch: the
  leader, follower, strategy and leaderboard routes now read and write the Coston2 control plane, and
  publishing encrypts in the browser via `useFlarePublish`. The Story-era hooks are orphaned but not
  deleted. Note the enclave currently rejects a Hyperliquid signal until a key is injected, so the
  venue is selectable in the publish form before it is operable — intended, since the form is where a
  leader discovers the venue exists.
- TP/SL enforcement inside the enclave (missing on the Flare path too — the handler decodes
  `takeProfitPrice`/`stopLossPrice` and never acts on them). Design sketch: a `tick` instruction plus
  **sealed position state** — the enclave encrypts its own position record to itself and returns it as
  opaque bytes, so any keeper can hand it back later; restart-safe with no enclave persistence.
- Deleting the legacy Story path. It stays until the web app no longer needs it.

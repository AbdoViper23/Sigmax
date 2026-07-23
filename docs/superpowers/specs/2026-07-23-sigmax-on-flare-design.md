# Sigmax on Flare — Design Spec

**Status:** Approved design (2026-07-23), refined after a second-opinion review. Source of truth for the Flare build.
**Supersedes:** the Story-era design under `docs/` (kept as historical reference).
**Companion references:** `docs/flare/00-product-brief.md`, `docs/flare/01-technical-blueprint.md`, `docs/flare/reference/existing-codebase-map.md`, `docs/flare/reference/flare-llms.txt`.

> **Deltas from the brief & blueprint — this spec is authoritative on conflict.** The companion
> brief/blueprint predate confirming that FCC is deployable on Coston2 today, so they disagree with
> this spec on the central bet. Where they conflict, **this spec wins**. Specifically: (1) **FCC is
> the chosen confidential core** (the blueprint listed it "not available"); (2) **GCP Confidential
> Space is demoted to the Phase 0a fallback**; (3) **FSA (XRPL) onboarding is demoted to stretch**;
> (4) **execution priority is flipped** to Flare-native primary / Hyperliquid bonus; (5) encryption
> is **ECIES-to-enclave**, not HPKE.

---

## 1. Summary

Sigmax is a **confidential copy-trading platform**. A *leader* publishes an **encrypted** trading
signal on Flare (Coston2). A **Flare Compute Extension (FCC)** running inside a TEE is the only
component that can decrypt it, and it decrypts solely to execute the corresponding token swap for
each active subscriber — inside that subscriber's own **non-custodial** account. Followers copy the
*outcome*, never the *strategy*. Every signal is committed on-chain (as a ciphertext hash) **before**
its outcome is known, so a leader's record is auditable without exposing *how* they trade.

We are **porting an existing project** (Sigmax, originally built on Story Protocol's Confidential
Data Rails) to Flare. The confidential-execution loop, Hyperliquid execution, the non-custodial
vault, the subscription registry, the signal schema, and the web app already exist. **The new work
is the Flare integration:** moving confidentiality onto Flare's own confidential-compute primitive
(FCC), executing natively on Flare (FXRP swaps bounded by FTSO prices), and porting the control
plane to Coston2.

**Hackathon targets:** Bounty 2 — Confidential Compute Apps (**primary**); Bounty 1 — Interoperable
Asset Products (**secondary**, via FXRP + FTSO).

---

## 2. Goals and non-goals

**Goals (this cycle):**
- A working end-to-end loop on **Coston2**: publish encrypted signal → FCC extension decrypts in the
  TEE → subscription check → execute the swap for each active follower, non-custodially.
- Deep, multi-primitive Flare integration: **FCC** (confidential execution + on-chain attestation),
  **FAssets/FXRP** (traded asset + subscription asset), **FTSO** (price bounds / min-out), and
  Coston2 control-plane contracts.
- **Both** execution venues: **Flare-native FXRP swaps** (primary — the "why Flare" story) and
  **Hyperliquid spot** (reused — breadth/bonus).
- A clean, demonstrable separation of pre-existing work vs. new Flare work (§9).

**Non-goals (deferred / stretch):**
- Mainnet deployment; security audit.
- FSA (XRPL one-signature) onboarding — stretch.
- FDC verifiable track record — stretch / demo-only (see §8).
- Automated TP/SL monitor — stretch (MVP uses manual `EXIT` signals).
- Sui / additional EVM venues.

---

## 3. Product constraints (invariants)

1. **Swap-only execution.** The only on-chain trading action is a swap between two whitelisted
   tokens — no leverage, perpetuals, shorting, margin, or borrowing. Enforced by the single
   `executeSwap` primitive on the vault and the spot-asset guard on the Hyperliquid path.
   *Rationale:* minimizes the contract permission/attack surface and reduces regulatory
   "asset-management / derivatives" exposure.
2. **Non-custodial.** The TEE/agent can *execute* but can never *withdraw* or transfer funds out.
   Funds stay in each follower's own vault (Flare) or master account (Hyperliquid). Only the owner
   withdraws.
3. **Confidential.** The plaintext strategy — including take-profit / stop-loss — is decrypted only
   inside the TEE and is never written to any public location, log, or the frontend. Encryption
   happens **client-side** (see §4.3); the existing agent's redaction discipline (allowlist logger)
   is preserved.
4. **Two roles, one chain of trust.** Flare is the control plane + confidential compute + (primary)
   execution. Hyperliquid is a secondary execution venue only.

---

## 4. Architecture

```
Leader ──publishSignal(ciphertext)──▶  COSTON2 (on-chain control plane)
                                        ┌──────────────────────────────────┐
                                        │ • SignalRegistry (commit + event) │
                                        │ • SubscriptionRegistry (ported)   │
                                        │ • SigmaxInstructionSender (FCC)    │
                                        │ • CopyVault + Factory (ported)     │
                                        └───────┬───────────────┬───────────┘
                              sendInstructions() │               │ isActive() / executeSwapWithTeeSig()
                                                 ▼               │
                                     ┌───────────────────────┐   │
                                     │   FCC EXTENSION (TEE)  │   │
                                     │  • ECIES decrypt inside│   │
                                     │  • Zod validate        │   │
                                     │  • subscription check  │   │
                                     │  • position sizing     │   │
                                     │  • route per venue     │───┘
                                     └───────┬───────────────┘
                          venue=flare │               │ venue=hyperliquid (bonus)
                                      ▼               ▼
                     Coston2 DEX (FXRP↔USDT0/USDC)  Hyperliquid spot (IOC)
                     + FTSO min-out               (reused executor,
                     inside CopyVault             approveAgent trade-only)
                     (on-chain TEE-sig verify)
```

### 4.1 Control plane (Coston2, Solidity)
- **SubscriptionRegistry** (ported ~as-is; plain EVM): leaders create plans; followers subscribe and
  pay (FXRP or USDT0 on Coston2); `isActive(follower, strategyId)` gates execution. `strategyId`
  stays `address`.
- **SignalRegistry / SigmaxInstructionSender** (new; FCC entry point): `publishSignal(strategyId,
  ciphertextHash, ciphertext|uri)` (a) emits `SignalPublished` — the commit-before-outcome proof and
  trigger — and (b) calls `TeeExtensionRegistry.sendInstructions()` routing the ciphertext to the
  extension (`OP_TYPE = "SIGNAL"`, `OP_COMMAND = "EXECUTE"`). It is the only address permitted to
  submit instructions for the extension.
- **CopyVault + CopyVaultFactory** (ported + extended): per-follower non-custodial vault. Adds
  `executeSwapWithTeeSig(params, teeSig)` — verifies the swap authorization was signed by the
  registered TEE identity (`ecrecover == teeAddress`) before swapping, using the authorization struct
  locked in Phase 0a (binds vault address + `signalId`/nonce + deadline + `chainId`; consumed-id
  tracking for replay protection). Router whitelist = the chosen Coston2 DEX; token whitelist = FXRP,
  USDT0/USDC. Only `owner` withdraws. The legacy `onlyExecutor` `executeSwap` path is disabled/scoped
  so the TEE-signature gate cannot be bypassed.

### 4.2 Confidential core (FCC extension — TEE, TypeScript)
- Adapted from `fce-sign` / `fce-extension-scaffold` (the FCC TypeScript framework). Runs on
  Coston2 — simulated TEE for development, GCP Confidential Space (AMD SEV) for a real attested run.
- Holds an **ECIES decryption keypair** (enclave-managed) and a **signing identity** (`teeAddress`,
  registered on-chain via FCC attestation / code-hash whitelisting).
- Handler `SIGNAL/EXECUTE`: ECIES-decrypt the ciphertext **inside the enclave** → Zod-validate
  (reused) → read `SubscriptionRegistry.isActive` for active followers → per follower: position-size
  (reused sizing) → route by `venue`:
  - `flare`: compute an FTSO-bounded `minOut`, build the swap, and return a **TEE-signed
    authorization**; a keeper submits `CopyVault.executeSwapWithTeeSig`.
  - `hyperliquid`: sign and place the IOC spot order directly (reused HL executor).

### 4.3 Confidentiality primitive
**ECIES encrypt-to-enclave replaces Story CDR.** The leader encrypts the ABI-encoded `Signal` to the
extension's published ECIES public key (the same pattern as the `fce-weather-insurance` private-policy
flow). The existing **`packages/cdr` Port abstraction is kept**; we add a `FlareEnclaveCdr`
implementation and retire the Story `RealCdr` for the Flare build.

**Encryption happens client-side (in the leader's browser).** The original Sigmax POSTed the
*plaintext* signal to the agent, which encrypted server-side — that would break the headline
confidentiality claim at the first hop. On Flare, the browser encrypts to the published enclave key
(`eciesjs` / `@noble`), and only ciphertext ever leaves the client. Plaintext exists only in the
leader's browser and inside the enclave — never on any server.

### 4.4 Execution
- **Flare-native (primary):** FXRP ↔ USDT0/USDC swaps on a **Coston2 DEX** (see §7 Phase 0b for the
  SparkDEX-or-self-deployed-pool decision), inside the per-follower CopyVault, with **FTSO XRP/USD**
  setting `minOut` bounds. On-chain **TEE-signature verification** gates the swap — the showcase
  "verifiable confidential execution" artifact for Bounty 2.
- **Hyperliquid (bonus):** reuse the existing `@nktkas/hyperliquid` executor and the `approveAgent`
  trade-only model.

### 4.5 Frontend (reuse `apps/web`)
Rewire wagmi to **Coston2 (chain 114)**; point at Coston2 contract addresses; **move signal
encryption client-side** (§4.3); add a **"Flare (FXRP)"** option to the publish form's venue toggle;
add an **FTSO price display** (XRP/USD). Reuse the leaderboard, publish form, and subscribe card.

---

## 5. Data model changes (`packages/shared`)

- Add `"flare"` to the `venue` enum (per-signal routing already exists). On `venue === "flare"`,
  `token`/`quoteToken` are Coston2 FXRP/USDT0 addresses.
- Keep `encodeSignal`/`decodeSignal`, the < 1024-byte payload limit, and — importantly — **no
  `side`/`leverage`/`margin` field** (swap-only invariant).
- **MVP TP/SL:** the leader publishes a manual `EXIT` signal (already in the schema). The automated
  monitor is stretch.

---

## 6. Repository layout

Work happens on branch **`feat/flare-migration`**. Existing packages are reused; the Story path is
retained for history (the diff on this branch *is* the "new work" artifact).

```
packages/
  shared/     reused (+ "flare" venue)
  cdr/        reused Port; + FlareEnclaveCdr impl (retire Story RealCdr for Flare)
  agent/      reused sizing / pipeline / redaction / Hyperliquid executor
  contracts/  ported to Coston2 (+ SignalRegistry, SigmaxInstructionSender,
              executeSwapWithTeeSig, DEX router config, Coston2 deploy scripts)
  fce-sigmax/ NEW — the FCC extension (TS), adapted from fce-sign/scaffold
              (its InstructionSender contract + docker stack + ext-proxy config)
  story/      legacy (kept for history)
apps/web/     reused; rewired to Coston2 + FTSO + client-side encryption
docs/flare/            Flare docs (brief, blueprint, references)
docs/                  Story-era docs (historical)
docs/superpowers/specs/  this design spec
```

**Secrets:** the shared Coston2 indexer credentials (already obtained) live only in the git-ignored
`extension_proxy.coston2.docker.toml` (never committed; the `.example` is committed).

---

## 7. Build phases + acceptance tests

*No calendar (per project preference). Each phase is gated by its acceptance tests; **gate decisions
are condition-based, not date-based**. The one hard external fact: the hackathon submission is due
**2026-08-14** — tracked by the developer, deliberately **not** encoded as per-phase dates. The shared
Coston2 indexer credentials are already obtained.*

### Phase 0 — Spikes (hard gates before committing to the architecture)
- **0a — FCC round-trip + TEE-signature verification (Coston2, simulated TEE).** Clone/adapt the
  scaffold; deploy `SigmaxInstructionSender`; send a `SIGNAL/EXECUTE` instruction; a TypeScript
  handler receives it and returns a result polled back through the proxy. **Also lock the TEE-signed
  authorization format now**, before any vault contract is written: the FCC node signs the
  `ActionResult` (EIP-191 over `keccak256(resultData, actionId, submissionTag, status)`), so the
  authorization must be derived from that — not an arbitrary EIP-712 payload — and must bind the
  target vault address, `signalId`/nonce, a deadline, and `chainId`.
  **Accept:** an instruction sent on-chain returns a handler result end-to-end on Coston2, **and** an
  on-chain `ecrecover` of a real TEE `ActionResult` signature recovers the registered `teeAddress`.
  **Gate rule:** do not start Phase 2 until 0a round-trips. If it cannot round-trip after focused
  effort, switch to the **GCP Confidential Space + on-chain attestation-gate** fallback *before*
  investing in Phase 2+.
- **0b — On-Coston2 DEX swap + FTSO read.** Acquire FXRP + USDT0 from the **Coston2 faucet**; read
  FTSO XRP/USD and compute a `minOut`; execute an FXRP↔USDT0 swap on a Coston2 DEX. **The DEX fallback
  is pre-authorized:** use SparkDEX *iff* a Coston2 deployment exists; otherwise **deploy your own
  Uniswap-V2/V3 pool on Coston2** seeded with faucet FXRP/USDT0 (this exercises the vault, router
  whitelist, and FTSO min-out identically). Mainnet SparkDEX remains the documented "path to
  production," not a hackathon dependency.
  **Accept:** a swap executes against the chosen router with an FTSO-derived `minOut`.

### Phase 1 — Control plane on Coston2
Port + deploy SubscriptionRegistry, CopyVault + Factory (with `executeSwapWithTeeSig` using the auth
struct locked in 0a), SignalRegistry, SigmaxInstructionSender.
**Accept (Foundry):** subscription lifecycle tests pass; `executeSwapWithTeeSig` executes on a valid
TEE signature and **reverts on a wrong signer**; **a replayed authorization reverts** (consumed-id
tracking); **an expired authorization reverts** (deadline); **an auth issued for vault A is rejected
by vault B**; the legacy `onlyExecutor` `executeSwap` path is disabled/scoped so the TEE-signature
gate cannot be bypassed; only `owner` can withdraw; swaps respect the token/router whitelist and
per-trade cap; contracts deployed and addresses recorded.

### Phase 2 — Confidential core
`FlareEnclaveCdr` (ECIES encrypt-to-enclave, **client-side**); FCC extension `SIGNAL/EXECUTE`
handler: decrypt → validate → `isActive` check → sizing.
**Accept:** client-side encrypt → in-enclave decrypt round-trip; a signal encrypted to the enclave
key decrypts only inside the extension; the redaction test proves plaintext/TP/SL never appear in
logs or persisted state; reused sizing tests pass.

### Phase 3 — Flare-native execution (the core demo)
Coston2-DEX executor + FTSO min-out; extension returns a TEE-signed authorization →
`CopyVault.executeSwapWithTeeSig`.
**Accept:** on Coston2, publishing an encrypted signal causes 2–3 followers' vaults to each execute an
FXRP↔USDT0 swap; an **inactive / expired / cancelled** subscriber is skipped; a tampered / wrong-TEE /
**replayed** signature **reverts**; no plaintext leaks.

### Phase 3.5 — One real attested run (Bounty-2 credibility)
Run the extension once for real on a **GCP Confidential Space VM (`MODE=0`)** with a **real measured
code hash whitelisted on-chain** (not the simulated `0x194844cf…`).
**Accept:** a signal executes through a genuinely attested TEE, evidenced on-chain. **If it doesn't
land,** the demo must **label the simulated mode honestly**. *Caveat:* the TypeScript build is not
bit-for-bit reproducible across machines (a rebuild elsewhere changes the code hash → re-registration);
the Go extension is bit-for-bit if this becomes a blocker.

### Phase 4 — Frontend + demo + submission
Rewire the web app to Coston2 + addresses; **move signal encryption client-side**; add the Flare venue
option + FTSO price; wire publish/subscribe; recruit **2–3 external pilot testers on Coston2 and
collect their feedback** (the judging criteria weigh real users/traction).
**Accept:** from the web app a leader publishes and a follower subscribes and is executed, all on
Coston2; ≥ 2 external testers have run the flow; a demo video is recorded; the submission write-up
includes the "what existed / what's new on Flare / what was ported" table.

### Phase 5 — Hyperliquid bonus venue (droppable)
Route `venue === "hyperliquid"` to the reused HL executor from inside the extension. **This is the
designated sacrifice** — it comes *after* the demo so a slip never starves the submission; drop it if
Phases 0–4 haven't fully landed.
**Accept:** a hyperliquid-venue signal places an IOC spot order for a follower on HL testnet; the
spot-asset guard holds; no withdraw path exists.

### Stretch (only if everything above lands)
FSA XRPL one-signature onboarding; FDC track record (ETH/FLR/SGB EVMTransaction only); automated
TP/SL as keeper-triggered FCC instructions.

---

## 8. Risks + mitigations (Flare-verified)

| Risk | Mitigation |
|---|---|
| FCC is pre-release (Coston2-only) and depends on Flare's indexer / support | Spike 0a gates it; GCP Confidential Space fallback ready. Indexer credentials already obtained. Coston2 deployment is explicitly allowed by the hackathon. |
| **SparkDEX may not be deployed on Coston2** (its swap guide uses a mainnet-only router) | Phase 0b pre-authorizes a **self-deployed Uniswap-V2/V3 pool on Coston2** seeded from the faucet; small demo sizes + FTSO-bounded `minOut`. |
| TypeScript FCC path is less trodden than Go | Spike confirms; fall back to Go for the extension if needed. Note: TS is not bit-for-bit reproducible across machines (code-hash churn); Go is. |
| **Signed-authorization replay** (one signal fans out to N vaults → a replayable auth is a fund-drain vector) | Auth binds vault address + `signalId` + deadline + `chainId`; consumed-id tracking; replay / expiry / cross-vault Foundry tests (Phase 1). |
| Demo runs only in a simulated TEE, undercutting the confidential-compute claim | Phase 3.5 targets one real attested run (MODE=0, real code hash); otherwise the demo labels simulated mode honestly. |
| FDC cannot attest Hyperliquid fills on mainnet (EVMTransaction = ETH/FLR/SGB only; Web2Json = Coston-only) | Track record is stretch / demo-only, never a headline claim. |
| Security-critical invariants (non-custodial; on-chain TEE-signature verification) | Covered by Foundry tests in Phases 1 and 3. |

---

## 9. Reuse vs. new (the hackathon "old vs new" story)

| Reused (existed before) | New on Flare (hackathon work) |
|---|---|
| SubscriptionRegistry / CopyVault / Factory (port to Coston2) | **FCC extension** — decrypt + execute in a TEE ⭐ Bounty 2 |
| Signal schema + encode/decode (`packages/shared`) | ECIES encrypt-to-enclave (`FlareEnclaveCdr`), client-side, replacing Story CDR |
| Sizing / pipeline / redaction / TP-SL logic (`packages/agent`) | **Coston2-DEX executor + FTSO min-out** ⭐ Bounty 1 |
| Hyperliquid executor (bonus venue) | On-chain TEE-signature verification + replay protection in CopyVault |
| CDR Port abstraction (`packages/cdr`) | SignalRegistry + SigmaxInstructionSender + Coston2 deployment |
| Frontend shell (`apps/web`) | Frontend rewired to Coston2 + FTSO price + client-side encryption |

---

## 10. Locked decisions & open items

**Locked:** FCC-native confidential core; both venues (Flare primary, Hyperliquid bonus + droppable);
lean MVP (FSA / track-record / auto-TP-SL = stretch); ECIES-to-enclave, client-side; TypeScript
extension (Go fallback); branch `feat/flare-migration`; Coston2 target; condition-based phase gates.

**To confirm during spikes:** whether SparkDEX has a Coston2 deployment (else self-deployed pool);
exact Coston2 FXRP/USDT0 addresses; the exact TEE-signature authorization struct (locked in 0a);
final Go-vs-TS choice for the extension.

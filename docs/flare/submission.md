# Sigmax on Flare — Submission (draft)

> Draft for the Flare Summer Signal hackathon. Placeholders (`⟨…⟩`) are filled at submission once the
> control plane is deployed and the demo is recorded. Source of truth for the design: the design spec
> at `docs/superpowers/specs/2026-07-23-sigmax-on-flare-design.md`.

## Project
**Sigmax** — confidential copy-trading on Flare.

## Bounties
- **Bounty 2 — Confidential Compute Apps** (primary)
- **Bounty 1 — Interoperable Asset Products** (secondary)

## Short description
A leader publishes an **encrypted** trading signal on Flare. A **Flare Compute Extension (FCC)** running
inside a TEE is the only component that can decrypt it, and it decrypts solely to execute the swap for
each active subscriber — inside that subscriber's own **non-custodial** vault. Followers copy the
*outcome*, never the *strategy*: there is nothing to screenshot, forward, or resell. Every signal is
committed on-chain (as a ciphertext hash) before its outcome is known, so a leader's record is auditable
without exposing how they trade.

## Target user
- **Leaders:** traders who sell signals and want to protect their edge from leakage/reselling while still
  proving a track record.
- **Followers:** users who want to copy a vetted trader automatically, non-custodially, without ever
  handing over funds or seeing (and leaking) the underlying strategy.

## How it uses Flare
- **FCC (Flare Confidential Compute) — the core.** The decrypt-and-execute logic runs as a Flare Compute
  Extension on Coston2; attestation and result verification are native Flare protocol features. This is
  the confidential-compute product, on Flare's own confidential-compute primitive.
- **On-chain TEE-signature verification.** Each `CopyVaultFlare` verifies that a swap was authorized by
  the registered TEE identity (`ecrecover` over the FCC `ActionResult`) before moving any funds —
  verifiable confidential execution.
- **FAssets / FXRP.** FXRP is the traded asset (FXRP↔USDT0 swaps) and the subscription asset.
- **FTSO.** XRP/USD block-latency feed sets the on-chain `minOut` slippage bound for every swap.
- **Control plane on Coston2.** `SubscriptionRegistry` (subscriptions + fee split), `SignalRegistry`
  (commit-before-outcome ledger), `CopyVaultFlare(+Factory)` (non-custodial per-follower vaults).

## What existed before vs. what's new on Flare vs. what was ported
| Reused (pre-existing "Sigmax") | New on Flare (this hackathon) | Ported / adapted |
|---|---|---|
| Signal schema + ABI encode/decode | **FCC extension** (decrypt + execute in a TEE) ⭐ B2 | SubscriptionRegistry → Coston2 |
| Position-sizing logic | **On-chain TEE-signature verification** (`TeeSigVerifier`, `executeSwapWithTeeSig`) ⭐ B2 | CopyVault → `CopyVaultFlare` (sig-gated, no executor role) |
| Hyperliquid executor (bonus venue) | **`SignalRegistry`** commit-before-outcome ledger | Confidentiality: Story CDR → ECIES-to-enclave (go-eth) |
| Vite/React web app shell | **SparkDEX/BlazeSwap FXRP swap + FTSO min-out** ⭐ B1 | `strategyId`/plan model → Coston2 |
| Non-custodial vault pattern | **`buildSwapAuths` / `processFlareSignal`** (per-follower `SwapAuth[]`) | — |

## Architecture (one paragraph)
Leader's browser encrypts the signal to the enclave's public key (client-side ECIES) → publishes the
ciphertext on Coston2 (`SignalRegistry` commit + an FCC instruction) → the FCC extension decrypts inside
the TEE, reads active subscribers from `SubscriptionRegistry`, sizes each follower, computes an
FTSO-bounded `minOut`, and returns a TEE-signed `SwapAuth[]` → a keeper submits each vault's
`executeSwapWithTeeSig`, which verifies the TEE signature and executes an FXRP↔USDT0 swap on BlazeSwap
inside the follower's non-custodial `CopyVaultFlare`. Hyperliquid spot is a reused bonus venue.

## Evidence (current state)
- **130+ tests green** across the monorepo and the extension. Highlights:
  - **Control-plane contracts (Foundry, 41 passing):** subscription lifecycle; TEE-signature
    verification; replay / expiry / cross-vault / wrong-chain / bad-status guards; owner-only
    withdraw; token+router whitelist and per-trade cap; deterministic vault factory.
  - **Two independent cross-language proofs**, because these are the seams where a hackathon build
    silently breaks:
    1. **TS ↔ Solidity ABI parity** for the signed `SwapAuth[]` — the exact bytes the TEE signs and
       the vault re-hashes (`flare-encoding-vector.test.ts` / `SwapAuthEncoding.t.sol`).
    2. **TS ↔ go-ethereum ECIES interop** — `fce-sigmax/go/cmd/ecies-interop` links the tee-node's
       own go-ethereum v1.17.4 and decrypts a ciphertext produced by the browser code; the reverse
       direction is pinned as a committed fixture. A signal encrypted in the leader's browser
       provably decrypts inside the enclave.
  - **FCC extension (13 tests):** the `SIGNAL/EXECUTE` handler — decrypt, validate, skip inactive or
    zero-balance subscribers, FTSO-bounded `minOut`, expiry/chain/venue rejection — including a test
    asserting the strategy, take-profit and stop-loss never reach logs or reported state.
  - **Keeper (10 tests):** relays each vault's authorization, preflights and simulates so doomed
    relays cost no gas, and one entry's revert never blocks the rest.
- **Coston2 recon confirmed on-chain:** FXRP token + AssetManager resolved; FTSO XRP/USD readable
  fee-free (live sample ≈ $1.0193); BlazeSwap router + factory deployed (121 pairs); dev wallet funded
  with 100 C2FLR + 10 FXRP.
- **Frontend wired to Coston2 (114):** client-side ECIES publishing (no server ever sees a signal),
  the "Flare (FXRP)" venue, and a live FTSO XRP/USD badge showing the feed that bounds `minOut`.

## Deployment / addresses (Coston2, chain 114)
- FXRP: `0x0b6A3645c240605887a5532109323A3E12273dc7` · AssetManagerFXRP: `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`
- FtsoV2: `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` · BlazeSwap router: `0x8D29b61C41CF318d15d031BE2928F79630e068e6`
- Control plane (TeeSigVerifier / CopyVaultFlareFactory / SignalRegistry / SubscriptionRegistry): `⟨deploy pending⟩`
- FCC extension id / TEE address: `⟨from the Phase 0a round-trip⟩`

## Demo
`⟨video + Coston2 app link — pending the FCC round-trip + deploy⟩`

## Repo
`⟨GitHub URL⟩` — branch `feat/flare-migration`.

## Honest status
Everything above that is described as tested **is tested and passing**; everything not yet run
against the live network is called out here rather than implied. Outstanding at the time of writing:
the FCC round-trip on Coston2 (extension registration + a real `ActionResult`), the control-plane
deploy, and one live FXRP swap. The extension, contracts, keeper, client-side encryption and frontend
are complete and covered by tests; what remains is deployment, and it is gated on a Docker host and a
stable public tunnel rather than on unwritten code. If the run happens in simulated-TEE mode
(`SIMULATED_TEE=true`, which Flare accepts for judging), the demo says so on screen.

## Roadmap / next steps
1. Complete the FCC round-trip on Coston2 (simulated TEE — accepted by the judges) and deploy the control plane.
2. FSA (XRPL one-signature) onboarding — subscribe in FXRP with a single XRPL signature.
3. FDC verifiable track record (EVMTransaction on ETH/FLR/SGB).
4. Automated TP/SL, additional execution venues, and a curated leader launch.

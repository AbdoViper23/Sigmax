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
- **50+ tests green**, all offline/local: control-plane contracts (Foundry) — subscription lifecycle,
  TEE-signature verification, replay/expiry/cross-vault/wrong-chain/status guards, owner-only withdraw,
  deterministic vault factory; the signal schema (flare venue); the extension core (`buildSwapAuths`,
  `processFlareSignal`); and a **TS↔Solidity ABI-parity proof** for the signed `SwapAuth[]`.
- **Coston2 recon confirmed:** FXRP token + AssetManager resolved; FTSO XRP/USD readable (fee-free view);
  BlazeSwap router deployed; dev wallet funded.

## Deployment / addresses (Coston2, chain 114)
- FXRP: `0x0b6A3645c240605887a5532109323A3E12273dc7` · AssetManagerFXRP: `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`
- FtsoV2: `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` · BlazeSwap router: `0x8D29b61C41CF318d15d031BE2928F79630e068e6`
- Control plane (TeeSigVerifier / CopyVaultFlareFactory / SignalRegistry / SubscriptionRegistry): `⟨deploy pending⟩`
- FCC extension id / TEE address: `⟨from the Phase 0a round-trip⟩`

## Demo
`⟨video + Coston2 app link — pending the FCC round-trip + deploy⟩`

## Repo
`⟨GitHub URL⟩` — branch `feat/flare-migration`.

## Roadmap / next steps
1. Complete the FCC round-trip on Coston2 (simulated TEE — accepted by the judges) and deploy the control plane.
2. FSA (XRPL one-signature) onboarding — subscribe in FXRP with a single XRPL signature.
3. FDC verifiable track record (EVMTransaction on ETH/FLR/SGB).
4. Automated TP/SL, additional execution venues, and a curated leader launch.

# Sigmax on Flare — Submission

> Flare Summer Signal hackathon. Deployed and running on Coston2 (chain 114); every address and claim
> below is live unless explicitly marked otherwise. Source of truth for the design: the design spec at
> `docs/superpowers/specs/2026-07-23-sigmax-on-flare-design.md`.

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
- **FAssets / FXRP.** FXRP is the traded asset and the subscription asset. Coston2 had no FXRP
  liquidity, so we seeded the FXRP/testUSD pool the vaults trade against.
- **FTSO.** XRP/USD block-latency feed sets the on-chain `minOut` slippage bound for every swap.
- **Control plane on Coston2.** `SubscriptionRegistry` (subscriptions + fee split), `SignalRegistry`
  (commit-before-outcome ledger), `CopyVaultFlare(+Factory)` (non-custodial per-follower vaults).

## What existed before vs. what's new on Flare vs. what was ported
| Reused (pre-existing "Sigmax") | New on Flare (this hackathon) | Ported / adapted |
|---|---|---|
| Signal schema + ABI encode/decode | **FCC extension** (decrypt + execute in a TEE) ⭐ B2 | SubscriptionRegistry → Coston2 |
| Position-sizing logic | **On-chain TEE-signature verification** (`TeeSigVerifier`, `executeSwapWithTeeSig`) ⭐ B2 | CopyVault → `CopyVaultFlare` (sig-gated, no executor role) |
| Hyperliquid executor (bonus venue) | **`SignalRegistry`** commit-before-outcome ledger | Confidentiality: Story CDR → ECIES-to-enclave (go-eth) |
| Vite/React web app shell | **BlazeSwap FXRP swap + FTSO min-out (incl. seeding the pool)** ⭐ B1 | `strategyId`/plan model → Coston2 |
| Non-custodial vault pattern | **`buildSwapAuths` / `processFlareSignal`** (per-follower `SwapAuth[]`) | — |
| — | **Client-side ECIES encryption** (browser → enclave; the Story build encrypted server-side) ⭐ B2 | — |
| — | **Trustless keeper** relaying TEE-signed authorizations | — |

## Architecture (one paragraph)
Leader's browser encrypts the signal to the enclave's public key (client-side ECIES) → publishes the
ciphertext on Coston2 (`SignalRegistry` commit + an FCC instruction) → the FCC extension decrypts inside
the TEE, reads active subscribers from `SubscriptionRegistry`, sizes each follower, computes an
FTSO-bounded `minOut`, and returns a TEE-signed `SwapAuth[]` → a keeper submits each vault's
`executeSwapWithTeeSig`, which verifies the TEE signature and executes an FXRP↔testUSD swap on BlazeSwap
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
- **Phase 0b passed live on Coston2.** Coston2 has no FXRP/stablecoin liquidity — the canonical FXRP
  appeared in exactly one pair holding ~4.75 FXRP, mispriced ~7×. So we seeded our own FXRP/testUSD
  pool at the live FTSO price and executed a real swap against an **FTSO-derived floor computed by the
  same `computeMinOut` the enclave uses**: 0.05 FXRP → 0.050631 testUSD, floor 0.0506
  ([tx](https://coston2-explorer.flare.network/tx/0xd6a948f4d5e8d52d173ced8244d6580ff768660056788c2dbae131e8f03ff682)).
  Both steps are reproducible scripts, not one-off console work.
  While mapping the venue we also found a **decoy `FTestXRP`** at `0x8b4abA9C…` with healthy-looking
  pools whose AssetManager is unregistered — wiring to it would look correct and execute nothing real.
- **Frontend wired to Coston2 (114):** client-side ECIES publishing (no server ever sees a signal),
  the "Flare (FXRP)" venue, and a live FTSO XRP/USD badge showing the feed that bounds `minOut`.

## Deployment / addresses (Coston2, chain 114)
- FXRP: `0x0b6A3645c240605887a5532109323A3E12273dc7` · AssetManagerFXRP: `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`
- FtsoV2: `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` · BlazeSwap router: `0x8D29b61C41CF318d15d031BE2928F79630e068e6`
- **FXRP/testUSD pool (we created it): `0x97835403EfbF27Ba52e613d90D4dD21FD66D7511`** — Coston2 had no
  FXRP/stablecoin liquidity, so we seeded one at the live FTSO price. testUSD:
  `0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73`
- FlareTeeManager (FCC diamond, post-redeploy): `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`

**Control plane (deployed 2026-08-08):**

| Contract | Address |
|---|---|
| `TeeSigVerifier` | `0xa9c3600318CAA856871Ab7161893Bf4DA5E18123` |
| `CopyVaultFlareFactory` | `0xa031F3337a164A994091c34A8f9bFdE05Abd6717` |
| `SignalRegistry` | `0x20c6dF5368B09f29F180491342C5F31bc4e783F2` |
| `SubscriptionRegistry` | `0x87491d3F561BC3Cd78029800705d3ee6d7670882` |
| `InstructionSender` (FCC entry point) | `0x14D54C022A9c2321BAeba1478c46018e21609f26` (extension `0x…1024f` / 66127) |

**FCC extension:** id `0x…1024f` (66127), registered on the post-redeploy diamond. The TEE machine
runs in simulated mode (`SIMULATED_TEE=true`, code hash `0x194844cf…`), reaches status **2
(PRODUCTION)** on-chain, and `scripts/test.sh` passes the full instruction round-trip. Because a
simulated enclave mints a fresh identity on each start, the registered machine address changes across
restarts — the one used for a given run is recorded with that run.

## Demo — the full flow, executed live on Coston2 (2026-08-11)

A leader published an **encrypted** signal; a follower's non-custodial vault executed the copied swap,
with the TEE signature verified on-chain in between. Nothing mocked, no privileged shortcut.

| Step | Evidence |
|---|---|
| Leader encrypts client-side + publishes ciphertext | tx [`0xa3b7603e…`](https://coston2-explorer.flare.network/tx/0xa3b7603e9a44b15809b6b932347bc9372f1f8588af56f96626037c6d4c441172) — only 753 bytes of ciphertext on-chain |
| Enclave decrypts, sizes, returns a signed `SwapAuth[]` | action `0x674dc45e…`, status 1, in ~5 s |
| Vault verifies the TEE signature and swaps | tx [`0xac6b2603…`](https://coston2-explorer.flare.network/tx/0xac6b2603117d9c79d6a321dcbc8e89f9f646a07252e2b119252e98def5ceff33) |
| Result | vault `0x86a072E0…`: **0.500000 FXRP → 0.475000 FXRP + 0.025080 testUSD** |

Run it yourself: `pnpm --filter @sigmax/agent exec tsx scripts/flare-e2e-demo.ts`. The script asserts
mid-run that the take-profit and stop-loss cannot be recovered from the published bytes, so the
confidentiality claim is checked rather than asserted.

Extension for this run: id `0x…1024f` (66127) · sender `0x14D54C022A9c2321BAeba1478c46018e21609f26` ·
TEE machine `0x736148d4fC26E9E259D80B268d435d823F7CF7C5`.

`⟨video⟩`

## Repo
https://github.com/AbdoViper23/Sigmax — branch `feat/flare-migration`.

## What the live run proved — and what it caught

The FCC round-trip and the control-plane deploy are **done on Coston2**, and running against the real
network found three defects that no amount of offline testing would have:

1. **`TeeSigVerifier` would have rejected every genuine TEE signature.** We had followed the
   fce-weather-insurance example and personal-signed
   `keccak256(keccak256(data), actionId, keccak256(tag), status)`. The tee-node in fact wraps that hash
   in a `Payload{prefix, chainId, dataHash}` first, which domain-separates the signature by chain and
   payload kind. Missing that layer meant no follower swap could ever have executed — and the offline
   tests all passed, because they signed with the same wrong scheme. Now pinned against a real captured
   signature in `TeeSigVerifierFixture.t.sol`, including the negative case that a chain-114 signature
   does not verify as chain 1.
2. **`teeAddress` is the machine's signing identity, not the key the proxy advertises.** The
   `publicKey` in `/info` is the enclave's *ECIES* key and derives to a different address. Gating swaps
   on it would have gated them on a key that never signs.
3. **The public Coston2 RPC caps `eth_getLogs` at 30 blocks.** The subscriber scan asked for the whole
   range, so the RPC error surfaced as the enclave rejecting a signal it had actually decrypted
   perfectly. Scans are now windowed and cached per strategy.

Operational finding worth passing on: a simulated TEE generates a new keypair on every container
start, old registrations stay at PRODUCTION indefinitely, and `getRandomTeeIds` lags behind
registration — so restarting the stack silently invalidates the machine the registry will route to,
and instructions vanish with no error on any side. Register once, then leave it running. Written up in
`docs/flare/reference/phase-0-findings.md`.

## Honest status
Everything described as tested **is tested and passing** (53 Foundry tests, 70+ TypeScript tests), and
anything not exercised against the live network is called out rather than implied. Live on Coston2:
the FCC extension round-trip, the control-plane deploy, client-side encryption against the real
enclave key, an FTSO-bounded swap through the pool we seeded, and a TEE-signed authorization verified
by `ecrecover` on-chain. The run is in **simulated-TEE mode** (`SIMULATED_TEE=true`, which Flare
accepts for judging) — the demo says so on screen. Not done: a real attested run on GCP Confidential
Space with a measured code hash (`MODE=0`), and recruiting external pilot testers.

## Roadmap / next steps
1. One real attested run on GCP Confidential Space (`MODE=0`) so the code hash is measured rather than simulated.
2. FSA (XRPL one-signature) onboarding — subscribe in FXRP with a single XRPL signature.
3. FDC verifiable track record (EVMTransaction on ETH/FLR/SGB).
4. Automated TP/SL, additional execution venues, and a curated leader launch.

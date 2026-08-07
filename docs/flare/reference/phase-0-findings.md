# Phase 0 — Findings

Living record of what the spikes confirm. Feeds the Phase 1 deploy and Phase 2/3 wiring.

## Confirmed (Coston2, chain 114)
- **Dev wallet:** `0xecb5DD1c755FCE23735f2Eb41Dbd3533CB62647b` — funded 2026-07-23: **100 C2FLR**, **10 FXRP**.
- **FXRP token:** `0x0b6A3645c240605887a5532109323A3E12273dc7` (6 decimals) — resolved via `AssetManagerFXRP.fAsset()`.
- **AssetManagerFXRP:** `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`.
- **ContractRegistry:** `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`.
- **FTSO XRP/USD feed id:** `0x015852502f55534400000000000000000000000000`.
- **FtsoV2 (Coston2):** `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` — XRP/USD is readable as a **fee-free view** via `getFeedById` (sample: value `1104445`, decimals `6` → ≈ $1.10). min-out bounding confirmed feasible.
- **BlazeSwap router (Coston2):** `0x8D29b61C41CF318d15d031BE2928F79630e068e6` — confirmed deployed (has bytecode). Uniswap-V2-compatible; the Phase 0b swap venue. No self-deployed pool needed unless the FXRP/USDT0 pair lacks liquidity.

## FCC stack (updated 2026-08-08)
- **FlareTeeManager (live):** `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`. The Coston2 FCC diamond
  was **redeployed 2026-07-22**; the old `0x004224fa…5d41F` is dead and is what produces
  `FunctionNotFound` / reverting `register()`. Our `config/coston2/deployed-addresses.json` already
  carries the live address, and nothing was ever registered against the old one — so this is a
  **fresh registration**, not a migration.
- **Version floor:** data providers reject votes from stale node builds, which leaves the instruction
  queue permanently empty. Pinned: **tee-node v0.0.25**, **tee-proxy v0.0.21** (both ≥ the v0.0.22
  floor). tee-proxy ≥ v0.0.21 requires the **Go 1.25** toolchain.
- **Tunnel:** must be a *stable* hostname. Data providers push to the URL stored on-chain, so a
  `trycloudflare` quick tunnel (new hostname each restart) strands the machine at `INITIALIZED`. Use a
  named cloudflared tunnel or a reserved ngrok domain.
- **Self-check** (tells you instantly which side is broken):
  ```bash
  cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE "getTeeMachine(address)((address,address,string))" <teeId>
  cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE "getTeeMachineStatus(address)(uint8)" <teeId>  # 1=INITIALIZED 2=PRODUCTION
  ```
- `SIMULATED_TEE=true` on Coston2 is accepted for judging; GCP Confidential Space is not required.

## Signal encryption scheme (pinned + PROVEN 2026-08-08)

**Interop is no longer an assumption.** `fce-sigmax/go/cmd/ecies-interop` links **go-ethereum v1.17.4
— the exact version the tee-node depends on** — and round-tripped both directions against our
TypeScript implementation (`packages/cdr/src/ecies.ts`):
- geth's `ecies.Decrypt` opened a ciphertext produced by our browser code ✅
- our code decrypts a geth-produced ciphertext, pinned as a permanent fixture in
  `packages/cdr/test/fixtures/geth-ecies-vector.json` (`geth-interop.test.ts`) ✅

We implemented the scheme directly on `@noble/*` rather than depending on `ecies-geth`, so it runs
unchanged in the browser. Wire format: `ephemeralPub(65) ‖ iv(16) ‖ AES-128-CTR ct ‖ HMAC-SHA-256(32)`.


From fce-sign `go/tools/cmd/run-test/main.go`: **go-ethereum ECIES** — `ecies.Encrypt(pub, msg, nil, nil)`
with `Curve = secp256k1` and `Params = ECIES_AES128_SHA256` (AES-128-CTR + HMAC-SHA-256 + Concat-KDF).
The extension forwards the ciphertext to the tee-node `/decrypt`; the node holds the enclave's secp256k1
key. The TypeScript client-side encrypt MUST match this — use **`ecies-geth`** (go-ethereum-compatible),
NOT `eciesjs` (AES-256-GCM/HKDF, which the node would fail to decrypt). The TEE public key is fetched
from the node at runtime (uncompressed secp256k1 point). Live interop is confirmed once the FCC env is up.

## Resolved 2026-08-08
- **Extension language: TypeScript** (confirmed, not just defaulted). The handler is written and
  tested; see `docs/flare/reference/fcc-extension.md`.
- **ECIES interop: proven** against the tee-node's own go-ethereum (above).
- **FTSO XRP/USD reads live** on Coston2: sample `1019291` @ 6 decimals ≈ $1.0193 (fee-free view).

## Pending
- `teeAddress` — from the FCC round-trip (runbook step 7). **Blocked on Docker + a stable tunnel.**
- A real `ActionResult` (resultData/actionId/submissionTag/status/signature) — to confirm
  `TeeSigVerifier` against the live node (runbook step 7).
- Coston2 stablecoin (USDT0 or equivalent) + a funded FXRP pair on BlazeSwap — Phase 0b; see
  `phase-0b-dex-recon.md`. Not in the ContractRegistry, so it must come from the FAssets collateral
  list, the faucet, or a self-deployed pool.
- Control-plane deploy addresses (TeeSigVerifier / CopyVaultFlareFactory / SignalRegistry /
  SubscriptionRegistry) — runbook step 8.

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

## Signal encryption scheme (pinned)
From fce-sign `go/tools/cmd/run-test/main.go`: **go-ethereum ECIES** — `ecies.Encrypt(pub, msg, nil, nil)`
with `Curve = secp256k1` and `Params = ECIES_AES128_SHA256` (AES-128-CTR + HMAC-SHA-256 + Concat-KDF).
The extension forwards the ciphertext to the tee-node `/decrypt`; the node holds the enclave's secp256k1
key. The TypeScript client-side encrypt MUST match this — use **`ecies-geth`** (go-ethereum-compatible),
NOT `eciesjs` (AES-256-GCM/HKDF, which the node would fail to decrypt). The TEE public key is fetched
from the node at runtime (uncompressed secp256k1 point). Live interop is confirmed once the FCC env is up.

## Pending (from the runbook)
- `teeAddress` — from the FCC round-trip (runbook step 7).
- A real `ActionResult` (resultData/actionId/submissionTag/status/signature) — to confirm `TeeSigVerifier` against the live node (runbook step 7).
- Go-vs-TS decision for the extension (default: TS, via fce-sign).
- USDT0 token address on Coston2 — resolve in Phase 0b.
- BlazeSwap FXRP/USDT0 pool (or create one) — Phase 0b.
- Control-plane deploy addresses (TeeSigVerifier / CopyVaultFlareFactory / SignalRegistry / SubscriptionRegistry) — runbook step 8.

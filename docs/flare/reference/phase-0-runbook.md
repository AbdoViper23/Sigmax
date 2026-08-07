# Phase 0 — Runbook

> Bring the FCC extension up on **Coston2** in simulated-TEE mode, confirm the round-trip and that a
> real TEE signature verifies on-chain, then deploy the control plane.
>
> **Status 2026-08-08:** everything that can be done without a Docker host is **done** — the extension
> handler, contracts, keeper, client-side encryption and frontend are written and tested, and
> **Phase 0b already passed live** (pool seeded, FTSO-bounded swap executed). What remains below is
> §3 onward, which needs Docker + a stable public tunnel.
>
> ⚠️ Use the **dev wallet** `0xecb5DD1c755FCE23735f2Eb41Dbd3533CB62647b` — its key goes into `.env`,
> Docker, and a public tunnel. Testnet + throwaway → no risk. **Never the main funded wallet.**
> Its key is already in `fce-sigmax/.env.local.coston2` as `PROXY_PRIVATE_KEY` (gitignored).

---

## 0. Install the missing tools [YOU]

Present: node ✓ pnpm ✓ forge ✓ **go 1.25 ✓** (installed at `~/.local/go`; add
`~/.local/go/bin` to `PATH`). Missing:

- **Docker** — Docker Desktop with WSL2 integration, or inside WSL:
  `curl -fsSL https://get.docker.com | sh` (needs sudo; this machine has no passwordless sudo, so it
  must be run interactively).
- **A stable HTTPS tunnel.** This matters more than it looks: data providers push to the URL stored
  **on-chain**, so a hostname that changes on restart strands the machine at `INITIALIZED` forever.
  Use **ngrok with a reserved domain** (free tier gives one) or a **named cloudflared tunnel** —
  *not* a `trycloudflare` quick tunnel.

```bash
docker info >/dev/null && echo "docker OK"
go version          # want 1.25.x
ngrok version       # or: cloudflared --version
```

## 1. Wallet funding [DONE ✓]
Dev wallet holds 100 C2FLR. FXRP was spent seeding the pool (§9) — top up at
<https://faucet.flare.network/coston2> before the demo so followers' vaults can be funded.

## 2. The extension [DONE ✓]
`fce-sigmax/` is now **tracked in this repo** (see `fcc-extension.md`) with the `SIGNAL/EXECUTE`
handler written and tested, `publishSignal()` added to `InstructionSender.sol`, Go bindings
regenerated, and tee-node/tee-proxy bumped to v0.0.25/v0.0.21. Run everything below from inside it:

```bash
cd fce-sigmax
```

## 3. Select TypeScript + Coston2 (simulated) [YOU]
```bash
./scripts/use-chain.sh local coston2 typescript
```

## 4. Secrets [YOU]
`.env.local.coston2` already has `PROXY_PRIVATE_KEY`. Add the deployer + owner:
```bash
DEPLOYMENT_PRIVATE_KEY="<dev key, hex, no 0x>"   # same dev key is fine
INITIAL_OWNER="0xecb5DD1c755FCE23735f2Eb41Dbd3533CB62647b"
```
Re-run `./scripts/use-chain.sh local coston2 typescript` so `.env` picks up the edits.

Indexer DB (credentials from the hackathon Telegram pinned message — the ones in the old docs are dead):
```bash
cp config/proxy/extension_proxy.coston2.docker.toml.example config/proxy/extension_proxy.coston2.docker.toml
```
Set the `[db]` block: `host = "34.38.42.208"` · `port = 3306` · `database = "indexer"` ·
`username = "hackathon_user_57"` · password from the pinned message. **This file is gitignored — keep
it that way.**

## 5. Stable tunnel to port 6674 [YOU]
Second terminal:
```bash
ngrok http --domain=<your-reserved>.ngrok-free.dev 6674
```
Put that URL in `EXT_PROXY_URL` in `.env.local.coston2`, then re-run `use-chain.sh`. If the URL ever
changes, update it and re-run `post-build.sh` — the on-chain record must match what you serve.

## 6. Deploy + start + test [YOU]
```bash
./scripts/pre-build.sh          # mints EXTENSION_ID, deploys InstructionSender
./scripts/start-services.sh
until curl -sf http://localhost:6674/info >/dev/null 2>&1; do sleep 2; done; echo ready
source .env && curl -s "$EXT_PROXY_URL/info" | jq '.machineData'
./scripts/post-build.sh         # allow-tee-version + register-tee -command rRap
./scripts/test.sh               # must print PASS
```

Check your own state first if anything hangs — 30 seconds, and it tells you which side is broken:
```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE "getTeeMachine(address)((address,address,string))" <teeId>
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE "getTeeMachineStatus(address)(uint8)" <teeId>  # 1=INITIALIZED 2=PRODUCTION
```
A simulated TEE should reach `PRODUCTION` within seconds on a current stack. If it doesn't, it is
almost always the tunnel URL or a stale node version — both covered above.

On error, capture the full output plus `docker compose logs ext-proxy | tail -40`.

## 7. Capture two values [YOU→ME]
- **`teeAddress`** and **`machineData.publicKey`** from `/info`.
- A **real `ActionResult`**: `resultData`, `actionId`, `submissionTag`, `status`, `signature`.

These close the last unproven assumption: a fixture test asserting
`TeeSigVerifier.recoverActionSigner(...)` returns that same `teeAddress`. If the packing differs, it
is a one-line fix in `TeeSigVerifier.sol` — the reason we capture a real result rather than trusting
the spec.

## 8. Deploy the control plane [YOU]
```bash
cd packages/contracts
PRIVATE_KEY=<dev key> \
TEE_ADDRESS=<teeAddress from step 7> \
PLATFORM_TREASURY=0xecb5DD1c755FCE23735f2Eb41Dbd3533CB62647b \
forge script script/DeployFlareControlPlane.s.sol \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc --broadcast
```
Then set, in `apps/web/.env` and the extension's container env:

| Web (`VITE_*`) | Extension (`SIGMAX_*`) | Value |
|---|---|---|
| `VITE_FLARE_SUBSCRIPTION_REGISTRY` | `SIGMAX_SUBSCRIPTION_REGISTRY` | deployed |
| `VITE_FLARE_VAULT_FACTORY` | `SIGMAX_VAULT_FACTORY` | deployed |
| `VITE_FLARE_INSTRUCTION_SENDER` | — | from `config/extension.env` |
| `VITE_FLARE_TEE_VERIFIER` | — | deployed |
| `VITE_FLARE_QUOTE_TOKEN` | `SIGMAX_QUOTE_TOKEN` | `0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73` |
| `VITE_FLARE_PROXY_URL` | — | your tunnel URL |

## 9. Phase 0b — DEX on Coston2 [DONE ✓ 2026-08-08]
Coston2 had **no** FXRP/stablecoin liquidity, so we seeded our own and proved the swap:

```bash
cd packages/agent
export DEPLOYMENT_PRIVATE_KEY=<dev key>
npx tsx scripts/seed-flare-pool.ts            # dry run; --execute to send
npx tsx scripts/verify-flare-swap.ts          # dry run; --execute to swap
```

Pool `0x97835403EfbF27Ba52e613d90D4dD21FD66D7511` (8 FXRP / 8.176056 testUSD, priced off FTSO).
Acceptance swap: 0.05 FXRP → 0.050631 testUSD against an FTSO floor of 0.0506.
Details and the two traps we hit are in `phase-0-findings.md`.

---

**Extra references inside the clone:** `fce-sigmax/DEPLOYMENT_STEPS.md` and
`fce-sigmax/TESTNET_DEPLOYMENT.md` (fce-sign's official steps). Note the guides still lag the FCC
redeploy in places — where they disagree with `phase-0-findings.md`, the findings won.

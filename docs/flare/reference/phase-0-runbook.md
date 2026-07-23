# Phase 0 — Runbook

> Goal: bring up the FCC extension on **Coston2** in **simulated-TEE** mode, confirm the round-trip
> works and that a TEE signature verifies on-chain (validates `TeeSigVerifier`), then deploy the
> control plane. Then Phase 0b: an FTSO-bounded FXRP↔USDT0 swap on Coston2.
>
> **[ME] = done for you.  [YOU] = run on your machine.  [YOU→ME] = send me the output and I continue.**
>
> ⚠️ Use the **dev wallet** (the empty one) for everything — its key goes into `.env`, Docker, and a
> public tunnel. Testnet + empty → no risk. **Never use the main (funded) wallet.**

---

## 0. Install the missing tools [YOU]
You already have: node ✓ · pnpm ✓ · forge ✓. Missing:
- **Docker** — Docker Desktop with WSL2 integration enabled, or inside WSL: `curl -fsSL https://get.docker.com | sh`
- **Go** (required by fce-sign's deploy CLIs): `sudo apt-get update && sudo apt-get install -y golang-go` (or from go.dev)
- **HTTPS tunnel** — easiest is **cloudflared** (no account needed); alternatively ngrok (needs an account + authtoken).

Verify:
```bash
docker info >/dev/null && echo "docker OK"
go version
cloudflared --version   # or: ngrok --version
```

## 1. Fund the dev wallet [YOU]
- Open https://faucet.flare.network/coston2 → paste the **dev wallet public address** → claim **C2FLR + FXRP + USDT0**.
- Verify:
```bash
cast balance <DEV_ADDR> --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

## 2. fce-sign is cloned [ME ✓]
It lives at `./fce-sigmax` (gitignored). Run all following commands **from inside it**:
```bash
cd fce-sigmax
```

## 3. Select TypeScript + Coston2 (simulated) [YOU]
```bash
./scripts/use-chain.sh local coston2 typescript
```

## 4. Fill in the secrets [YOU]
In `.env.local.coston2`:
```bash
DEPLOYMENT_PRIVATE_KEY="<dev key, hex, no 0x>"
INITIAL_OWNER="0x<dev address>"
PROXY_PRIVATE_KEY="<same dev key>"
```
Then re-run so `.env` picks up the edits:
```bash
./scripts/use-chain.sh local coston2 typescript
```
Indexer DB:
```bash
cp config/proxy/extension_proxy.coston2.docker.toml.example config/proxy/extension_proxy.coston2.docker.toml
```
Edit the `[db]` block: `host = "34.38.42.208"` · `port = 3306` · `database = "indexer"` ·
`username = "hackathon_user_57"` · `password = "<the hackathon-group password>"`.

## 5. Public tunnel to port 6674 [YOU]
Second terminal:
```bash
cloudflared tunnel --url http://localhost:6674      # or: ngrok http 6674
```
Copy the HTTPS URL into `EXT_PROXY_URL` in `.env.local.coston2`, then re-run `./scripts/use-chain.sh local coston2 typescript`.
(Note: cloudflared changes the URL on each restart — update `EXT_PROXY_URL` if you restart it.)

## 6. Deploy + start + test [YOU]
```bash
./scripts/pre-build.sh
./scripts/start-services.sh
until curl -sf http://localhost:6674/info >/dev/null 2>&1; do sleep 2; done; echo ready
source .env && curl -s "$EXT_PROXY_URL/info" | jq '.machineData'   # note teeAddress + codeHash 0x194844cf…
./scripts/post-build.sh
./scripts/test.sh          # must print PASS
```
On error, send me the full text plus `docker compose logs ext-proxy | tail -40`.

## 7. Send me this to close the biggest risk [YOU→ME]
- The **`teeAddress`** from the `/info` output (step 6).
- A **real ActionResult** from the proxy for any operation: `resultData`, `actionId`, `submissionTag`, `status`, `signature`.

I will add a fixture test asserting `TeeSigVerifier.recoverActionSigner(...)` returns that same `teeAddress`.
If the packing differs slightly → a one-line fix in `TeeSigVerifier.sol`.

## 8. Deploy the control plane to Coston2 [YOU] — then send me the addresses
From `packages/contracts`:
```bash
PRIVATE_KEY=<dev key> \
TEE_ADDRESS=<teeAddress from step 7> \
PLATFORM_TREASURY=0x<dev address> \
forge script script/DeployFlareControlPlane.s.sol \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc --broadcast
```
Send me the printed addresses (TeeSigVerifier / CopyVaultFlareFactory / SignalRegistry / SubscriptionRegistry).

## 9. Phase 0b — DEX on Coston2 [ME writes / YOU run]
- You already have FXRP + USDT0 from the faucet (step 1).
- We confirm **BlazeSwap** (router `0x8D29b61C41CF318d15d031BE2928F79630e068e6`) has a funded FXRP/USDT0 pool.
  If not → create a pair and add liquidity. I'll write the (viem) script; you run it with the dev key.

---

**Extra references inside the clone:** `fce-sigmax/DEPLOYMENT_STEPS.md` and `fce-sigmax/TESTNET_DEPLOYMENT.md` (fce-sign's official steps).

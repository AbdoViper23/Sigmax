# Runbook — every service, every command

Verified against the repo on 2026-08-11. Paths are relative to the repo root
(`/home/AbdoViper/Projects/story`).

---

## 0. PRE-SUBMIT — what must be running for a trade to actually happen

Both venues share the encrypted signal, the enclave, and the Coston2 control plane. They differ in what
carries the trade the last hop, and that difference is where things silently do nothing.

| | Flare | Hyperliquid |
|---|---|---|
| Who executes | a **keeper** relays the TEE-signed `SwapAuth[]`; the vault verifies it | the **enclave itself** calls the exchange API |
| Extra process needed | **yes — the keeper** | no |
| Needs a key injected | no | **yes, after every restart** |
| Follower's setup | create + fund a vault (**both legs**) | `approveAgent` to their derived agent address |

```bash
# 1. Enclave up and registered
cd fce-sigmax && bash scripts/start-services.sh && bash scripts/post-build.sh

# 2. Fix TEE-identity drift + report stale env (read-only without APPLY=1)
APPLY=1 pnpm --filter @sigmax/agent resync

# 3. FLARE VENUE: the keeper must be running, or a published signal produces a signed
#    authorization that nobody delivers — no trade, and every component reports success.
pnpm --filter @sigmax/agent keeper

# 4. HYPERLIQUID VENUE only
pnpm --filter @sigmax/agent exec tsx scripts/hl-inject-key.ts
#    ...and set SIGMAX_HL_PER_TRADE_CAP — it defaults to 0, which disables the venue by design

# 5. Web app
pnpm --filter web dev
```

### Delivery rules (from the FCC team, 2026-08-12)

A dispatch event on-chain is **not** delivery. Providers POST the cosigned instruction straight to your
machine's registered URL (`:6664/instruction`) — the proxy does not discover anything from the indexer,
so nothing retries on your behalf. For an instruction to arrive, the selected machine needs **all** of:

| Requirement | How to check | Verified for us |
|---|---|---|
| Status `2` = PRODUCTION | `getTeeMachineStatus(teeId)` | ✅ `0x736148d4…` = 2 |
| An availability check **< ~6h old** | no public getter — a machine idle overnight stops receiving | ⚠️ stale (last live 2026-08-11) |
| A registered `teeId` | `getActiveTeeMachines(extensionId)` | ✅ one machine, ext `66127` |
| A **stable public HTTPS** URL | it is stored on-chain, so a changing URL keeps receiving nothing | ✅ reserved ngrok domain |

`pnpm --filter @sigmax/agent resync` now audits the first, third and fourth and prints where to look.

**Each dispatch selects ONE machine at random from those registered.** So a single stale registration
beside a live one produces intermittent, apparently random silence. Old machines never expire by
themselves, and every restart leaves another behind.

> This is what `flare-e2e-demo.ts` papers over by republishing up to 20 times until it happens to be
> routed to the live machine. The real fix is to **pause the stale identity**. Right now we have exactly
> one machine registered, so the retry loop is not currently hiding anything — but it will be after the
> next restart if the old identity is not paused.

**A restart always creates a new TEE identity** — the key is not persisted in simulated *or* production
mode, and there is no supported way to restore an old `teeId`. So the recovery order is fixed:

```
restart → new identity → re-register (post-build.sh) → reach PRODUCTION → PAUSE the stale identity
```

Then run `APPLY=1 pnpm --filter @sigmax/agent resync` to point the factory and vaults at the new
identity, and re-inject the Hyperliquid key.

Other confirmed constraints, all of which we already satisfy: `opType` prefixed `F_` is reserved (ours
are `KEY` and `SIGNAL`); the pinned FlareTeeManager is `0x1a9C…18aE`; don't mix independently-chosen
versions of tee-node / tee-proxy / go-flare-common (we pin `TEE_NODE_VERSION=v0.0.25`).

### The two failures that produce no error message

1. **No keeper running.** The enclave signs, the proxy files the result, and nothing relays it. After
   publishing, the keeper's log should show `saw instruction …` within a few seconds.
2. **A vault funded on only one leg.** The enclave sizes an ENTRY against the **quote** balance (it buys
   FXRP with testUSD) and an EXIT against **FXRP**. A vault holding only one token skips every signal in
   the other direction as zero-sized — no trade, no error. The vault card funds either leg and warns
   until both are held.

Also: `SIGMAX_SUBS_FROM_BLOCK` (enclave) and `VITE_FLARE_FROM_BLOCK` (web) must both point at the
registry's deploy block. `earliest` is not a slower setting — the public RPC caps `eth_getLogs` at 30
blocks and rejects the request outright.

---

## 1. The moving parts

Five things run. Only three of them are servers.

| # | What | Where it runs | Port | Why it has to exist |
|---|---|---|---|---|
| 1 | **`extension-tee`** | Docker | `7702` (internal only) | **The enclave.** The only place a signal is ever plaintext. Holds the decryption key and the signing key. Our handler lives here. |
| 2 | **`ext-proxy`** | Docker | `6673` internal · **`6674` external** | The HTTP door Flare's data providers knock on. It forwards instructions to the enclave and returns the signed `ActionResult`. |
| 3 | **`redis`** | Docker | `6382` → 6379 | The proxy's queue. No persistence (`--save ""`), so nothing sensitive survives a restart. |
| 4 | **ngrok tunnel** | host process | → `6674` | Gives the proxy a **stable public hostname**. Data providers push to the URL stored **on-chain**, so this hostname cannot change. |
| 5 | **keeper** | on demand | — | Relays the signed authorization to each vault. Not a daemon in this build — the demo script does it. It pays gas and holds nothing. |

**Not services:** the contracts (already deployed on Coston2) and the web app (start it only when you
want the UI).

```
Flare data providers
        │  push instruction
        ▼
  ngrok (stable hostname)  ──►  ext-proxy :6674  ──►  extension-tee :7702
        ▲                            │                      │ decrypt + sign
        └──── signed ActionResult ───┘◄─────────────────────┘
                    │
                    ▼
              keeper  ──►  CopyVaultFlare  ──►  BlazeSwap
```

---

## 2. Cold start — the whole thing, in order

> ⚠️ **Read this first.** A simulated enclave mints a **fresh signing key on every start**. Restarting
> the stack invalidates the TEE identity registered on-chain, and old registrations stay `PRODUCTION`
> forever — so instructions can be routed to a machine that no longer exists. That is why step 3 uses
> `--force` (a fresh extension with exactly one machine) and why you should **not** restart casually.

### Step 0 — select the environment

```bash
cd fce-sigmax
bash scripts/use-chain.sh local coston2 typescript
```

Copies `.env.local.coston2` → `.env` and sets `LANGUAGE=typescript`. Everything below reads that `.env`.

### Step 1 — start the tunnel (before the stack)

```bash
ngrok http 6674 --domain=superurgently-creamless-paityn.ngrok-free.dev
```

Use the **reserved** domain. A random `trycloudflare`/ngrok hostname changes on restart and strands the
machine at status `INITIALIZED`, because the URL on-chain no longer resolves.

### Step 2 — narrow the subscriber scan window

The enclave scans `Subscribed` logs from `SIGMAX_SUBS_FROM_BLOCK` to head, in 30-block windows (the
public RPC's cap). If that start block is days old, the scan is thousands of RPC calls and overruns the
node's ~2 s handler timeout.

```bash
HEAD=$(cast block-number --rpc-url https://coston2-api.flare.network/ext/C/rpc)
sed -i "s/^SIGMAX_SUBS_FROM_BLOCK=.*/SIGMAX_SUBS_FROM_BLOCK=$((HEAD-300))/" .env.local.coston2
bash scripts/use-chain.sh local coston2 typescript
```

Then re-emit a subscription inside that window so the enclave can see it (a renewal is enough):

```bash
cd ..
DEVKEY=$(grep -oP '^DEPLOYMENT_PRIVATE_KEY="?\K[^"]+' fce-sigmax/.env.local.coston2 | head -1)
LEADER=0xecb5DD1c755FCE23735f2Eb41Dbd3533CB62647b
cast send 0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73 "approve(address,uint256)" \
  0xAEFbE1EDBE57FF7c9851270466979be227AC1139 1000000 \
  --private-key $DEVKEY --rpc-url https://coston2-api.flare.network/ext/C/rpc
cast send 0xAEFbE1EDBE57FF7c9851270466979be227AC1139 "subscribe(address)" $LEADER \
  --private-key $DEVKEY --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

### Step 3 — register a fresh extension and bring the stack up

```bash
cd fce-sigmax
export PATH=$HOME/.local/go/bin:$PATH GOTOOLCHAIN=local   # tee-proxy needs Go 1.25

bash scripts/pre-build.sh --force     # new EXTENSION_ID + deploys InstructionSender
bash scripts/start-services.sh        # redis + ext-proxy + extension-tee
```

Wait for the enclave to be reachable, then register it:

```bash
until curl -sf -m 5 http://localhost:6674/info >/dev/null; do sleep 5; done
sleep 75                              # the node needs a moment before it will register
bash scripts/post-build.sh            # allow the code hash + register this machine
```

`pre-build.sh` prints `EXTENSION_ID` and `INSTRUCTION_SENDER`; `post-build.sh` prints the `TEE ID`.
**Write all three down** — the next step needs them.

### Step 4 — wire the new identity

```bash
cd ..
TEE=<TEE ID from post-build>
SENDER=<INSTRUCTION_SENDER from pre-build>
VAULT=0x86a072E008f596fa68e8C7608cB48D393914Cbe2
RPC=https://coston2-api.flare.network/ext/C/rpc
DEVKEY=$(grep -oP '^DEPLOYMENT_PRIVATE_KEY="?\K[^"]+' fce-sigmax/.env.local.coston2 | head -1)

cast send $SENDER "setExtensionId()"            --private-key $DEVKEY --rpc-url $RPC
cast send $VAULT  "setTeeAddress(address)" $TEE --private-key $DEVKEY --rpc-url $RPC
```

`setExtensionId()` is required or `publishSignal` reverts with **"Extension ID is not set."**

### Step 5 — verify before you run anything

```bash
# 2 = PRODUCTION. Anything else means registration didn't finish.
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachineStatus(address)(uint8)" $TEE --rpc-url $RPC

# Must return YOUR machine. If it returns a different address, instructions go to a dead machine.
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getRandomTeeIds(uint256,uint256)(address[])" <extensionIdDecimal> 1 --rpc-url $RPC

# Must equal $TEE.
cast call $VAULT "teeAddress()(address)" --rpc-url $RPC
```

### Step 6 — run the full flow

```bash
DEPLOYMENT_PRIVATE_KEY=$DEVKEY \
LIVE_TEE_ID=$TEE \
FLARE_INSTRUCTION_SENDER=$SENDER \
FLARE_SUBSCRIPTION_REGISTRY=0xAEFbE1EDBE57FF7c9851270466979be227AC1139 \
FLARE_VAULT_FACTORY=0xD2746393C8e1bE019C8d4fd12CF950d6b996eA70 \
FLARE_TEE_VERIFIER=0x6F57348fB7dA13D1fA8c769beaD1BEaaC091A943 \
EXT_PROXY_URL=https://superurgently-creamless-paityn.ngrok-free.dev \
pnpm --filter @sigmax/agent exec tsx scripts/flare-e2e-demo.ts
```

Success looks like `submitted 0x…` on step 6 and a non-zero testUSD balance.

---

## 3. Day-to-day commands

### Tests

```bash
pnpm -r test                                    # 106 TypeScript
cd packages/contracts && forge test             # 53 contracts
cd fce-sigmax/typescript && npm test            # 40 enclave
pnpm -r --if-present typecheck && pnpm -r --if-present build
```

### The web app

```bash
pnpm --filter @sigmax/web dev      # Vite prints the URL it picked
pnpm --filter @sigmax/web build
```

Its config is `apps/web/.env` (`VITE_*`). After a fresh registration, update
`VITE_FLARE_INSTRUCTION_SENDER`.

### Stack control

```bash
cd fce-sigmax
bash scripts/start-services.sh
bash scripts/stop-services.sh --chain coston2
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml logs -f extension-tee
curl -s http://localhost:6674/info | python3 -m json.tool     # who is this enclave?
bash scripts/test.sh                                          # FCC round-trip self-test
```

### Utilities

```bash
# Is the stack actually up?
docker ps
curl -s -m 8 http://localhost:6674/info

# Pool + oracle sanity (a swap fails if these disagree beyond the slippage band)
cast call 0x97835403EfbF27Ba52e613d90D4dD21FD66D7511 "getReserves()(uint112,uint112,uint32)" --rpc-url $RPC
cast call 0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d \
  "getFeedById(bytes21)(uint256,int8,uint64)" 0x015852502f55534400000000000000000000000000 --rpc-url $RPC

# Re-seed / deepen the pool, or verify a swap in isolation (both dry-run without --execute)
pnpm --filter @sigmax/agent exec tsx scripts/seed-flare-pool.ts
pnpm --filter @sigmax/agent exec tsx scripts/verify-flare-swap.ts
```

---

## 4. Which file configures what

| File | Read by | Holds |
|---|---|---|
| `fce-sigmax/.env` | every `fce-sigmax` script + compose | active config — **generated**, edit the template instead |
| `fce-sigmax/.env.local.coston2` | `use-chain.sh` (template) | deployer key, `SIMULATED_TEE`, `SIGMAX_*` (slippage, scan start, addresses) |
| `fce-sigmax/config/extension.env` | `extension-tee` | `EXTENSION_ID`, `INSTRUCTION_SENDER` — written by `pre-build.sh` |
| `apps/web/.env` | the web app | `VITE_*` contract addresses + proxy URL |
| `packages/agent/.env` | the **legacy** agent (`pnpm start`) | the older venue's config — not used by the Flare flow |

---

## 5. When something breaks

| Symptom | Cause | Fix |
|---|---|---|
| `Extension ID is not set.` | new `InstructionSender`, never initialised | `cast send $SENDER "setExtensionId()"` |
| Instruction never answered; logs show a **different** machine | routed to a stale registration | `pre-build.sh --force` → restart → `post-build.sh` (one machine only) |
| `context deadline exceeded` at ~2 s | handler too slow — usually the subscriber scan | narrow `SIGMAX_SUBS_FROM_BLOCK` (§2 step 2) |
| `SwapFailed()` | the router rejected it — almost always `minOut` above what the pool can pay | check `SIGMAX_SLIPPAGE_BPS=100` is set, and compare pool price to FTSO |
| `BadTeeSignature()` | vault's `teeAddress` ≠ the live signing identity | `setTeeAddress` with the id from `post-build.sh` |
| status stuck at `1` (INITIALIZED) | proxy URL on-chain doesn't resolve | start the tunnel on the **reserved** domain, then re-register |
| `error sending request for url` | public RPC rate limit | retry; it is transient |

**`teeAddress` is the enclave's *signing* identity — not the public key `/info` advertises.** Those are
two different keys with two different addresses. Always use the id printed by `post-build.sh`.

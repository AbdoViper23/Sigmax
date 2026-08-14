<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/sigmax-mark-dark.svg">
  <img src="brand/sigmax-mark.svg" alt="Sigmax" height="72">
</picture>

### Confidential copy-trading on Flare

**Leaders publish encrypted trading signals. Followers copy the trades automatically.**
**The strategy never leaks — the track record stays verifiable on-chain.**

[![Network](https://img.shields.io/badge/Flare-Coston2%20(114)-e62058)](https://coston2-explorer.flare.network)
[![Tests](https://img.shields.io/badge/tests-293%20passing-2ea043)](#tests)
[![Flare](https://img.shields.io/badge/Flare%20venue-swaps%20executed%20on--chain-2ea043)](#the-run-that-proves-it)
[![Hyperliquid](https://img.shields.io/badge/Hyperliquid%20venue-spot%20fills%20executed-2ea043)](#the-run-that-proves-it)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[For judges](#for-judges--a-3-minute-tour) · [Live evidence](#the-run-that-proves-it) · [How it works](#how-it-works) · [Flare integration](#how-it-uses-flare) · [Run it](#run-it-yourself) · [Addresses](#deployed-addresses)

</div>

---

## The contradiction at the heart of copy-trading

Every copy-trading platform asks a trader to make an impossible trade-off.

To attract followers you need a **public, verifiable track record**. But publishing your trades *is*
publishing your strategy — and a strategy everyone can read stops working. Front-runners get in
first, the edge decays, and the trader who created the alpha captures the least of it.

So traders pick a bad option:

- **Publish openly** → the edge dies.
- **Stay private** → no verifiable record, so nobody can trust you, so nobody follows.
- **Use a custodial platform** → followers hand over their funds and inherit counterparty risk.

Nothing forces this trade-off except the assumption that a signal must be *readable* to be *executable*.

## Sigmax removes it

A signal is executed **without ever being readable** — by anyone, including us.

The leader encrypts each signal in their **own browser**, directly to the public key of a specific
enclave. What lands on Flare is ciphertext plus a commitment hash. A confidential extension running
inside **Flare Confidential Compute** is the only thing in existence that can open it — and all it
can do with the plaintext is size a swap and sign an authorization for it.

That authorization is verified **on-chain** by each follower's own vault before a single token moves.

The result is four properties at once, none traded against another:

| | |
|---|---|
| 🔒 **Confidential** | The take-profit and stop-loss never exist in plaintext outside the enclave — not on-chain, not in a log, not on a server. |
| 🔓 **Non-custodial** | Funds sit in the follower's own vault. The enclave can *authorize a swap* and nothing else; only the owner can withdraw. |
| ✅ **Verifiable** | Every fill is a public Flare transaction, so the leader's record is auditable while the logic stays secret. |
| 🎯 **Spot-only** | One `executeSwap` primitive. No leverage, no perps, no borrowing — enforced in the contract, not in a policy document. |

---

## For judges — a 3-minute tour

Everything below runs from the browser at `localhost:8080`, against live Coston2 and live
Hyperliquid testnet. No mocks, no privileged scripts.

1. **Look at the nav.** The **`● TEE live`** pill is a real heartbeat — it polls the enclave's own
   `/state` and shows the counters the enclave reports about itself (signals decrypted,
   authorizations signed, exchange fills). Hover it. If that pill is green, the machine holding the
   only decryption key in existence is up.
2. **`/leader` — publish an encrypted signal.** Pick a venue, a market, type a take-profit and
   stop-loss, publish. The TP/SL are ECIES-sealed **in the browser** before anything leaves the
   page; the transaction carries only ciphertext. Note the live *"Pool ↔ FTSO oracle gap"* line —
   the vault will only execute within 1% of the FTSO price, and the form tells you *before* you
   publish whether that bound can currently be met.
3. **`/follower` — the money never moves to us.** The vault card shows funds in a contract only the
   follower can withdraw from. The Hyperliquid card derives the agent address **in the browser**
   from the enclave's published key — the user verifies what they authorize instead of trusting a
   server — and that agent can trade but can never withdraw (exchange-enforced).
4. **Watch a trade land.** Publishing on the Flare venue moves the vault's FXRP/testUSD balances a
   couple of minutes later; on the Hyperliquid venue the fill appears in the follower's account
   within seconds. Both are independently checkable — explorer links below.

**The four claims, and where each is enforced:** confidential (ECIES to the enclave key, browser-side) ·
non-custodial (vault contract / exchange agent rules) · verifiable (every fill is a public tx) ·
spot-only (single `executeSwap` primitive on Flare; `assetId ≥ 10000` guard on Hyperliquid).

---

## The run that proves it

Not a mock, not a fork, not a privileged shortcut — and not only a script: the runs below were driven
through the **web UI** (a real browser, a real wallet) on **2026-08-13/14** against the current
deployment.

### Flare venue — the vault traded on a signal nobody could read

```
follower vault 0xAD31372f…                        (2026-08-14, two consecutive UI publishes)

  FXRP      0.885892  →  0.891609  →  0.897036
  testUSD   0.114829  →  0.109088  →  0.103634
            └─ each step: encrypted in the browser → decrypted only inside the TEE →
               SwapAuth signed → vault verified the signature on-chain → BlazeSwap swap
```

| Step | On-chain evidence |
|---|---|
| **1.** Browser encrypts, wallet publishes ciphertext | [`0x32faa894…`](https://coston2-explorer.flare.network/tx/0x32faa8947546f42ed501821c3ea57eacf446f6d9a93e2d60d2ae2d8d14b060cd) — 753 bytes, no plaintext field |
| **2.** Enclave decrypts, sizes per follower, signs `SwapAuth[]` | action status `1` (enclave-reported; see the TEE pill) |
| **3.** Vault verifies the TEE signature and swaps | [`0xc01dea36…`](https://coston2-explorer.flare.network/tx/0xc01dea36e1ac841242db1dae0d88de21079bd762553a88821f556deeb414625e) — success, block 34042953 · repeated [`0x72df37d9…`](https://coston2-explorer.flare.network/tx/0x72df37d9de01a7aaf73a337a5212e07373fd0ed37b908596cb70bb03cd1e52fe) |

### Hyperliquid venue — the same encrypted signal, settled on an exchange

Seven live spot fills on Hyperliquid testnet, all placed **by the enclave** with a per-follower agent
key derived inside it — including a **100% EXIT** that closed the whole position:

```
account 0xecb5DD…                                  (Hyperliquid testnet, PURR/USDC spot)

  Buy  3.0 PURR @ 4.6252     ← 20% ENTRY published from the UI
  Sell 5.0 PURR @ 4.5795     ← 100% EXIT published from the UI (closes the position)
  … (7 fills total; agent 0x05aC7AC2… approved by the follower, expires automatically)
```

First fill: [`0xf78110e0…`](https://app.hyperliquid-testnet.xyz/explorer/tx/0xf78110e086354473f8fa0426ce612201090028c6213863469b49bc3345391e5e) ·
the rest are on the account's public fill history. The agent address is **derived in the follower's
browser** from the enclave's published master key — verified, not trusted.

The demo script **asserts mid-run** that the take-profit and stop-loss cannot be recovered from the
published bytes. The confidentiality claim is tested, not asserted.

```bash
pnpm --filter @sigmax/agent demo
```

---

## How it works

```
  LEADER (browser)                    FLARE (Coston2)                  ENCLAVE (FCC)
  ────────────────                    ───────────────                  ─────────────
  signal { token, size,
           entry, TP, SL }
        │
        │ ECIES to the enclave's
        │ public key — client-side,
        │ no server involved
        ▼
    ciphertext ──────────────► InstructionSender ──────────────► decrypt inside the TEE
                               (+ commitment hash)                      │
                                      │                                 │ read active subscribers
                                      │                                 │ read FTSO XRP/USD
                                      │                                 │ size per follower balance
                                      │                                 ▼
                                      │                          sign SwapAuth[]
                                      │                                 │
  FOLLOWER's own vault ◄───────── keeper relays ◄─────────────── ActionResult
        │
        │ ecrecover(sig) == teeAddress   ← the trust gate
        │ amountOut >= FTSO-bounded minOut
        │ token + router whitelisted, per-trade cap, deadline, chainId
        ▼
    BlazeSwap swap — funds never left the follower's vault
```

**The single most important line** is `ecrecover(sig) == teeAddress`. The keeper that relays the
authorization is deliberately untrusted: it pays gas and nothing more. It cannot forge, alter, or
replay an authorization, because the vault checks the enclave's signature over a payload bound to the
vault, the chain id, the amounts, and a deadline. Losing the keeper's key costs you gas money.

---

## How it uses Flare

Flare is not a deployment target here — four of its protocols do load-bearing work.

### 🔐 Flare Confidential Compute — the enclave *is* the product

The confidential extension in [`fce-sigmax/`](fce-sigmax/) is the only place a signal is ever
plaintext. It registers on the `FlareTeeManager` diamond, reaches status **PRODUCTION** on-chain, and
receives instructions through the FCC data-provider network.

Making this real surfaced a class of bug that offline tests structurally cannot catch — see
[what the live run caught](#what-only-a-live-run-could-catch).

### 📊 FTSO — the oracle that makes a blind swap safe

The enclave cannot show anyone the price it is trading at, so "trust the executor's number" is not
available. Instead every authorization carries a `minOut` derived from the **FTSO XRP/USD block-latency
feed** (a fee-free view), and the vault re-checks it after the swap. A compromised keeper cannot
sandwich the trade, because the acceptable price band was fixed by an oracle before the swap ran.

### 💧 FAssets (FXRP) — real XRP exposure, on an EVM

Trades settle in **FXRP**, so an XRP holder gets programmable, non-custodial exposure to the asset
they actually hold. Coston2 had **no FXRP/stablecoin liquidity at all**, so we deployed and seeded our
own FXRP/testUSD pool at the live FTSO price — reproducible by anyone via
[`seed-flare-pool.ts`](packages/agent/scripts/seed-flare-pool.ts), because testUSD has a public faucet.

### ⛓️ Flare as the control plane

Identity, subscriptions, revenue, permissions and signal history all live on Flare. Execution is a
detail underneath it — which is what lets the venue change without touching the trust model.

---

## What only a live run could catch

Running against the real network — instead of a mock of it — found four bugs, each fatal, none
detectable offline. This is the part of the build worth reading.

<table>
<tr><td width="30%"><b>🔴 Every real TEE signature would have been rejected</b></td>
<td>The verifier was missing a <code>Payload{prefix, chainId}</code> layer of the FCC signing scheme.
The existing tests passed because they signed with the <em>same wrong scheme</em> they verified —
a mock agreeing with itself. The first real <code>ActionResult</code> exposed it immediately.</td></tr>

<tr><td><b>🔴 Slippage tolerance was silently zero</b></td>
<td><code>docker-compose</code> renders <code>${VAR:-}</code> for an unset variable as the <em>empty
string</em>, which is not nullish — so <code>Number(env.X ?? "100")</code> took <code>Number("")</code>
and produced <code>0</code>. Zero tolerance means demanding the exact oracle price, so every swap
reverted. It presented as a DEX problem and wasn't one.</td></tr>

<tr><td><b>🟠 The public RPC caps <code>eth_getLogs</code> at 30 blocks</b></td>
<td>The subscriber scan failed silently and looked exactly like the enclave rejecting a signal it had
actually decrypted correctly. Now windowed and cached.</td></tr>

<tr><td><b>🟠 <code>teeAddress</code> is not the key <code>/info</code> advertises</b></td>
<td>The enclave's <em>signing</em> identity and its <em>encryption</em> key are different keys with
different addresses. Wiring the advertised one would have failed every verification.</td></tr>
</table>

Each fix is covered by a test that pins the real behaviour, including a selector table checked against
`forge inspect` so a revert names the guard that fired instead of just saying "reverted".

---

## Repo structure

```
fce-sigmax/            ← the confidential extension (FCC) — the enclave, Docker, register scripts
  typescript/src/app/sigmax/
    handler.ts           SIGNAL/EXECUTE: decrypt → size per follower → sign SwapAuth[]
    chain.ts             subscriber scan, FTSO reads, min-out math
packages/
  contracts/           ← Solidity + Foundry
    CopyVaultFlare.sol      per-follower vault; executeSwapWithTeeSig is the only trade path
    TeeSigVerifier.sol      on-chain ecrecover of the FCC ActionResult
    SubscriptionRegistry.sol / SignalRegistry.sol
    InstructionSender.sol   FCC entry point
  agent/               ← keeper: relays authorizations, pays gas, holds nothing
    scripts/flare-e2e-demo.ts   the full flow, end to end
  enclave-crypto/      ← the confidentiality primitive: seal a signal to one enclave's public key
                         (ECIES over @noble/*, so the same code runs in the browser)
  shared/              ← the signal schema, shared by web + enclave + contracts
apps/web/              ← Vite + React 19 + wagmi/viem — leader and follower flows
docs/flare/            ← design, blueprint, and a findings log of everything the live run taught us
```

`packages/cdr` and `packages/story` belong to an earlier execution venue and are not part of this
build — the Flare path does not import them, and the web app does not depend on them at all. See
[honest status](#honest-status).

---

## Run it yourself

### Prerequisites

- Node 20+, pnpm 9+, [Foundry](https://book.getfoundry.sh/getting-started/installation), Docker
- Coston2 C2FLR from the [faucet](https://faucet.flare.network/coston2), and FXRP via FAssets minting
- A **stable** public URL for the enclave proxy (reserved ngrok domain or a named cloudflared tunnel)

### 1. Install and verify

```bash
pnpm install
pnpm -r test                          # 128 TypeScript tests
cd fce-sigmax/typescript && npm test  # 102 extension tests (standalone npm project)
cd packages/contracts && forge test   # 74 contract tests (needs its own foundry.toml)
```

### 2. Bring up the enclave

**One command, from cold** — waits out the shared indexer DB, starts the tunnel + containers,
registers the fresh identity, pauses the retired ones, and rotates the factory/vault:

```bash
bash fce-sigmax/scripts/bring-up.sh
```

<details>
<summary>…or the individual steps it sequences</summary>

```bash
cd fce-sigmax
bash scripts/pre-build.sh --force   # registers an extension id + deploys InstructionSender
bash scripts/start-services.sh      # tee-node + proxy
bash scripts/post-build.sh          # registers this machine → status PRODUCTION
```
</details>

> ⚠️ **A simulated enclave mints a fresh signing key on every start**, so after any restart every vault
> is checking a retired key and *every swap reverts with `BadTeeSignature`* — correct signatures,
> correct relaying, silent failure. One command finds and fixes that drift:
>
> ```bash
> APPLY=1 pnpm --filter @sigmax/agent exec tsx scripts/flare-resync.ts
> ```
>
> It compares the live enclave identity against the factory and your vault, rotates them, reports which
> env values are stale, and checks whether the Hyperliquid key needs re-injecting. Run it read-only
> first (drop `APPLY=1`). The follower-facing version of the same repair is a button on the vault card.

> Every command, every service, and the failure modes with their fixes are in the
> **[runbook](docs/flare/RUNBOOK.md)**.

### 3. Run the full flow

```bash
pnpm --filter @sigmax/agent exec tsx scripts/flare-e2e-demo.ts
```

It creates a plan, subscribes a follower, funds a vault, encrypts a signal **in-process**, publishes
only ciphertext, waits for the signed authorization, relays it, and prints the vault's resulting
balances. The confidentiality assertion runs mid-flow.

### 4. The keeper — required for the Flare venue

```bash
pnpm --filter @sigmax/agent keeper
```

Without it the enclave signs an authorization that nobody delivers, and no trade happens. Nothing errors:
the leader sees a published signal, the enclave logs a success, and the vaults are never called. This is
the single easiest thing to forget, so it has its own step.

The Hyperliquid venue needs no keeper — the enclave calls the exchange itself — but it does need its
agent key injected after every restart (`scripts/hl-inject-key.ts`). The nav's TEE pill turns amber
(**`TEE up · no HL key`**) whenever that step is missing, so the failure is visible instead of a
silent order rejection.

### 5. The web app

```bash
pnpm --filter @sigmax/web dev
```

Everything the demo script does, a user can do from the browser — on Coston2, with their own wallet:

| | |
|---|---|
| **Leader** | Register a plan in one transaction, then publish a signal. **The encryption happens in the browser** — the take-profit and stop-loss are sealed to the enclave's public key before anything leaves the page, and the leader signs the transaction that carries the ciphertext. No server is involved in the publish path at all. |
| **Follower** | Subscribe (testUSD, split to the leader at pay time), then create **and fund** their vault in a single signature via `createVaultAndDeposit`. Deposit, withdraw, and every copied trade read straight from their own vault. |

The app is built to stay truthful under flaky testnet infrastructure, because the trust story is
only as good as what the user can see:

- **`● TEE live` heartbeat** in the nav — polls the enclave's own `/state`; hover for the counters
  it reports about itself (signals decrypted, authorizations signed, fills, replays rejected).
- **Live pool ↔ FTSO gap** on the publish form — whether the vault's 1% execution bound can be met
  is shown *before* gas is spent, because a drifted pool is the one failure that looks like a broken
  enclave and isn't.
- **Failover everywhere** — every Coston2 read runs over a multi-RPC `fallback` transport; every
  enclave read tries the same-origin proxy path then the public tunnel; the publish path re-sends
  until a dispatch reaches the live machine (stale registrations are a routing lottery).

The leader's registration is one signature here versus four on the venue this replaced, because
`createPlan` makes the caller the plan's leader — there is no IP asset to mint or license to grant
first.

---

## Deployed addresses

**Coston2 (chain 114)** — [explorer](https://coston2-explorer.flare.network)

| Our contracts | Address |
|---|---|
| `TeeSigVerifier` | [`0xa9c3600318CAA856871Ab7161893Bf4DA5E18123`](https://coston2-explorer.flare.network/address/0xa9c3600318CAA856871Ab7161893Bf4DA5E18123) |
| `CopyVaultFlareFactory` | [`0xa031F3337a164A994091c34A8f9bFdE05Abd6717`](https://coston2-explorer.flare.network/address/0xa031F3337a164A994091c34A8f9bFdE05Abd6717) |
| `SubscriptionRegistry` | [`0x87491d3F561BC3Cd78029800705d3ee6d7670882`](https://coston2-explorer.flare.network/address/0x87491d3F561BC3Cd78029800705d3ee6d7670882) |
| `SignalRegistry` | [`0x20c6dF5368B09f29F180491342C5F31bc4e783F2`](https://coston2-explorer.flare.network/address/0x20c6dF5368B09f29F180491342C5F31bc4e783F2) |
| `InstructionSender` (FCC entry) | [`0x14D54C022A9c2321BAeba1478c46018e21609f26`](https://coston2-explorer.flare.network/address/0x14D54C022A9c2321BAeba1478c46018e21609f26) |
| FXRP/testUSD pool (we created it) | [`0x97835403EfbF27Ba52e613d90D4dD21FD66D7511`](https://coston2-explorer.flare.network/address/0x97835403EfbF27Ba52e613d90D4dD21FD66D7511) |

| Flare / ecosystem | Address |
|---|---|
| `FlareTeeManager` (FCC diamond) | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| `FtsoV2` — XRP/USD `0x01…5852502f555344` | `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` |
| FXRP (6 dec) · `AssetManagerFXRP` | `0x0b6A3645c240605887a5532109323A3E12273dc7` · `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
| testUSD (6 dec, public faucet) | `0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73` |
| BlazeSwap router | `0x8D29b61C41CF318d15d031BE2928F79630e068e6` |

FCC extension for the run above: id `0x…1024f` (66127), machine `0x736148d4fC26E9E259D80B268d435d823F7CF7C5`.

> ⚠️ Resolve FXRP only via `AssetManagerFXRP.fAsset()`. A **decoy** `FTestXRP` exists on Coston2 at
> `0x8b4abA9C…` with healthy-looking pools; its AssetManager is not registered in
> `AssetManagerController`, so wiring to it looks correct and executes nothing real.

---

## Tests

**293 passing**, and the ones that matter test the seams where this kind of system fails quietly.

| Suite | Count | |
|---|---|---|
| Foundry (contracts) | 74 | signature verification, caps, whitelists, replay, deadline, chain binding |
| Extension (enclave) | 104 | decrypt → size → sign, spot-only guard, HL order signing byte-equality, min-notional after lot rounding, and that TP/SL never reach a log or the reported state |
| Agent / keeper | 69 | relay outcomes, revert-selector table pinned against the ABI |
| Shared + encryption | 46 | signal codec round-trip, per-action `sizeBps` ceiling, **cross-language ECIES interop**, browser-receiver `fetch` regression |

Two proofs worth singling out:

- **Cross-language encryption interop.** A Go program linking the *exact* go-ethereum version the
  tee-node depends on round-trips ECIES against our TypeScript in both directions, with a
  geth-produced ciphertext pinned as a permanent fixture. Encryption interop is proven, not assumed.
- **Leakage tests.** The enclave's outputs are asserted to never contain the take-profit or stop-loss,
  so the core promise is enforced by CI.

```bash
pnpm -r test                            # TypeScript (115)
cd packages/contracts && forge test     # contracts (74)
cd fce-sigmax/typescript && npm test    # enclave (104)
```

---

## Honest status

**Proven live, from the browser (2026-08-13/14):**

- **Flare venue, end to end** — encrypt in the browser → publish → decrypt in the enclave → sign →
  vault verifies on-chain → swap. Transactions linked above; repeated across multiple enclave
  restarts and re-registrations.
- **Hyperliquid venue, end to end** — the follower authorized their enclave-derived agent from the
  UI, and the enclave placed **seven live spot fills** on a funded testnet account, including a
  100% EXIT closing the whole position. The spot-only guard held throughout (perp equity stayed
  0.00 the entire time).
- **The web app itself** — connected wallet, publish (both venues), authorize, deposit/withdraw
  reads, leaderboard: driven end to end in a real browser.

**Not yet done, stated plainly:**

- The enclave runs with `SIMULATED_TEE=true`. This is accepted for judging, but a **real** GCP
  Confidential Space deployment with hardware attestation and a reproducible code hash is the
  difference between "the design is sound" and "the guarantee is enforced by silicon". It is the next
  piece of work, not a detail.
- Testnet only. No mainnet, no audit.
- **Take-profit / stop-loss are decoded inside the enclave and never acted on** — on *either* venue. The
  design is settled (a `tick` instruction, thresholds re-derived from the signal's on-chain ciphertext
  rather than from enclave state, which does not survive a restart) but it is not built. This is the one
  feature gap rather than a rough edge, and it is called out here because everything else in this list is
  an operational caveat.
- Note the Hyperliquid guarantee is weaker than Flare's and deliberately stated as such: on Flare the
  *contract* enforces the caps, on Hyperliquid *attested code* does, because Hyperliquid has nothing
  on-chain to verify a TEE signature against. Details in
  [`docs/flare/02-hyperliquid-venue.md`](docs/flare/02-hyperliquid-venue.md).
- Some of the stack predates this hackathon; `docs/flare/submission.md` separates what was reused,
  ported, and written new.

**Operational truths a demo driver should know** (each mitigated in-product, none abolished):

- **The FCC node gives our handler 2 seconds** (`ProxyTimeout`, a Go constant in `tee-node` — not
  configurable). The Flare handler races public-RPC latency against it, so roughly 1 publish in 3 is
  dropped and simply needs republishing; the enclave still reports it processed. The UI's pool-gap
  line, RPC failover and the keeper's retry all exist because of this ceiling. A private low-latency
  RPC or a patched node removes it.
- **Every enclave restart mints a fresh identity and clears the in-memory HL key.**
  `APPLY=1 …/flare-resync.ts` now pauses the retired identities **automatically**, rotates the
  factory and vault, and reminds about key re-injection; `bring-up.sh` sequences the whole recovery.
- **The FXRP/testUSD pool drifts off the FTSO price on its own** (the oracle moves, the pool doesn't).
  Past ~0.6% above the oracle, entries revert `SwapFailed()` by design — the bound *is* the safety
  property. The publish form shows the live gap, and `20-rebalance-pool` style rebalancing (sell/buy
  the small difference) restores headroom in one transaction.
- **`SIGMAX_SUBS_FROM_BLOCK` must track the newest subscription**, not the deploy block — Coston2
  mints ~86k blocks/day and a stale value grows back into the 2-second ceiling.

---

## Roadmap

1. **Real attestation** — GCP Confidential Space, reproducible build, code hash on-chain.
2. **XRPL-native onboarding** — Flare Smart Accounts, so an XRP holder joins with one XRPL signature: no EVM wallet, no gas.
3. **TP/SL monitoring inside the enclave** — exits stay as confidential as entries.
4. **Verifiable track records** — FDC attestation of fills, so a leader's history is provable without exposing the logic.
5. **Mainnet** — audit, deeper liquidity, more venues behind the same trust model.

---

<div align="center">

Built for the **Flare Summer Signal** hackathon.

**MIT** · [runbook](docs/flare/RUNBOOK.md) · [design docs](docs/flare/) · [submission](docs/flare/submission.md) · [findings log](docs/flare/reference/phase-0-findings.md)

</div>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/sigmax-mark-dark.svg">
  <img src="brand/sigmax-mark.svg" alt="Sigmax" height="72">
</picture>

### Confidential copy-trading on Flare

**Leaders publish encrypted trading signals. Followers copy the trades automatically.**
**The strategy never leaks — the track record stays verifiable on-chain.**

[![Network](https://img.shields.io/badge/Flare-Coston2%20(114)-e62058)](https://coston2-explorer.flare.network)
[![Tests](https://img.shields.io/badge/tests-267%20passing-2ea043)](#tests)
[![Live](https://img.shields.io/badge/end--to--end-executed%20on--chain-2ea043)](#the-run-that-proves-it)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Live evidence](#the-run-that-proves-it) · [How it works](#how-it-works) · [Flare integration](#how-it-uses-flare) · [Run it](#run-it-yourself) · [Addresses](#deployed-addresses)

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

## The run that proves it

Not a mock, not a fork, not a privileged shortcut. Executed on Coston2 on **2026-08-11**:

```
follower vault 0x86a072E0…

  before   0.500000 FXRP    0.000000 testUSD
  after    0.475000 FXRP    0.025080 testUSD
           └─ sold by a signal nobody outside the enclave could read
```

| Step | On-chain evidence |
|---|---|
| **1.** Leader encrypts in-browser, publishes ciphertext | [`0xa3b7603e…`](https://coston2-explorer.flare.network/tx/0xa3b7603e9a44b15809b6b932347bc9372f1f8588af56f96626037c6d4c441172) — 753 bytes, no plaintext field |
| **2.** Enclave decrypts, sizes per follower, signs a `SwapAuth[]` | action `0x674dc45e…`, status `1`, **~5 s** |
| **3.** Vault verifies the TEE signature and swaps | [`0xac6b2603…`](https://coston2-explorer.flare.network/tx/0xac6b2603117d9c79d6a321dcbc8e89f9f646a07252e2b119252e98def5ceff33) |

The demo script **asserts mid-run** that the take-profit and stop-loss cannot be recovered from the
published bytes. The confidentiality claim is tested, not asserted.

```bash
pnpm --filter @sigmax/agent exec tsx scripts/flare-e2e-demo.ts
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
pnpm -r test                          # 106 TypeScript tests
cd fce-sigmax/typescript && npm test  # 101 extension tests (standalone npm project)
cd packages/contracts && forge test   # 60 contract tests (needs its own foundry.toml)
```

### 2. Bring up the enclave

```bash
cd fce-sigmax
bash scripts/pre-build.sh --force   # registers an extension id + deploys InstructionSender
bash scripts/start-services.sh      # tee-node + proxy
bash scripts/post-build.sh          # registers this machine → status PRODUCTION
```

> ⚠️ **A simulated enclave mints a fresh signing key on every start.** Restarting the stack
> invalidates the registered machine, so register once and leave it running — then point the vault at
> the new identity with `setTeeAddress`. This surprised us; it is documented so it doesn't surprise you.

> Every command, every service, and the failure modes with their fixes are in the
> **[runbook](docs/flare/RUNBOOK.md)**.

### 3. Run the full flow

```bash
pnpm --filter @sigmax/agent exec tsx scripts/flare-e2e-demo.ts
```

It creates a plan, subscribes a follower, funds a vault, encrypts a signal **in-process**, publishes
only ciphertext, waits for the signed authorization, relays it, and prints the vault's resulting
balances. The confidentiality assertion runs mid-flow.

### 4. The web app

```bash
pnpm --filter @sigmax/web dev
```

Everything the demo script does, a user can do from the browser — on Coston2, with their own wallet:

| | |
|---|---|
| **Leader** | Register a plan in one transaction, then publish a signal. **The encryption happens in the browser** — the take-profit and stop-loss are sealed to the enclave's public key before anything leaves the page, and the leader signs the transaction that carries the ciphertext. No server is involved in the publish path at all. |
| **Follower** | Subscribe (testUSD, split to the leader at pay time), then create **and fund** their vault in a single signature via `createVaultAndDeposit`. Deposit, withdraw, and every copied trade read straight from their own vault. |

The leader's registration is one signature here versus four on the venue this replaced, because
`createPlan` makes the caller the plan's leader — there is no IP asset to mint or license to grant
first.

---

## Deployed addresses

**Coston2 (chain 114)** — [explorer](https://coston2-explorer.flare.network)

| Our contracts | Address |
|---|---|
| `TeeSigVerifier` | [`0x6F57348fB7dA13D1fA8c769beaD1BEaaC091A943`](https://coston2-explorer.flare.network/address/0x6F57348fB7dA13D1fA8c769beaD1BEaaC091A943) |
| `CopyVaultFlareFactory` | [`0xD2746393C8e1bE019C8d4fd12CF950d6b996eA70`](https://coston2-explorer.flare.network/address/0xD2746393C8e1bE019C8d4fd12CF950d6b996eA70) |
| `SubscriptionRegistry` | [`0xAEFbE1EDBE57FF7c9851270466979be227AC1139`](https://coston2-explorer.flare.network/address/0xAEFbE1EDBE57FF7c9851270466979be227AC1139) |
| `SignalRegistry` | [`0x132D10A28Fb13dFbBF74bDDCA8828d451DAd7162`](https://coston2-explorer.flare.network/address/0x132D10A28Fb13dFbBF74bDDCA8828d451DAd7162) |
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

**199 passing**, and the ones that matter test the seams where this kind of system fails quietly.

| Suite | Count | |
|---|---|---|
| Foundry (contracts) | 53 | signature verification, caps, whitelists, replay, deadline, chain binding |
| Extension (enclave) | 40 | decrypt → size → sign, and that TP/SL never reach a log or the reported state |
| Agent / keeper | 69 | relay outcomes, revert-selector table pinned against the ABI |
| Shared + encryption | 32 | signal codec round-trip, **cross-language ECIES interop** |

<sub>194 of the 199 cover this build; the other 5 belong to packages from an earlier venue.</sub>

Two proofs worth singling out:

- **Cross-language encryption interop.** A Go program linking the *exact* go-ethereum version the
  tee-node depends on round-trips ECIES against our TypeScript in both directions, with a
  geth-produced ciphertext pinned as a permanent fixture. Encryption interop is proven, not assumed.
- **Leakage tests.** The enclave's outputs are asserted to never contain the take-profit or stop-loss,
  so the core promise is enforced by CI.

```bash
pnpm -r test                            # TypeScript (106)
cd packages/contracts && forge test     # contracts (53)
cd fce-sigmax/typescript && npm test    # enclave (40)
```

---

## Honest status

**Proven live on Coston2:** the complete flow — encrypt → publish → subscribe → decrypt in the
enclave → sign → verify on-chain → swap — with the transactions linked above.

**Not yet done, stated plainly:**

- The enclave runs with `SIMULATED_TEE=true`. This is accepted for judging, but a **real** GCP
  Confidential Space deployment with hardware attestation and a reproducible code hash is the
  difference between "the design is sound" and "the guarantee is enforced by silicon". It is the next
  piece of work, not a detail.
- Testnet only. No mainnet, no audit.
- Take-profit / stop-loss monitoring is designed and specified but not part of this build.
- **Hyperliquid is a second venue inside the same enclave** — the encrypted signal, the attested code,
  and the Coston2 control plane are shared; only settlement differs. It is fully tested offline (101
  extension tests, including byte-equality of the order signing against the reference SDK) but **has
  not been run against a live enclave or a funded Hyperliquid account**. What is proven versus what
  is not is itemised in [`docs/flare/02-hyperliquid-venue.md`](docs/flare/02-hyperliquid-venue.md).
  Note the guarantee is weaker there and deliberately stated as such: on Flare the *contract* enforces
  the caps, on Hyperliquid *attested code* does, because Hyperliquid has nothing on-chain to verify a
  TEE signature against.
- The web app's Story-era hooks (`apps/web/src/hooks/{leader,leaders,follower,strategies,useStoryIp}.ts`)
  are now orphaned — nothing imports them. They are left in place rather than deleted in this change.
- Some of the stack predates this hackathon; `docs/flare/submission.md` separates what was reused,
  ported, and written new.

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

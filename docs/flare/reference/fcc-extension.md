# The Sigmax FCC extension (`fce-sigmax/`)

The confidential core of the Flare build: a TEE extension that decrypts a leader's signal inside the
enclave and returns TEE-signed swap authorizations. It lives at the repo root in `fce-sigmax/` and is
**tracked in this repository** — it is the new work, not a vendored dependency.

## Provenance

Adapted from **[flare-foundation/fce-sign](https://github.com/flare-foundation/fce-sign)** at
`6df972c64d34efe1d4497f0eafe6792d1f0862dd` (upstream `main`, "Remove internal infra references from
public docs"). The upstream git directory is kept at `.fce-sigmax-upstream.git` (gitignored) so we can
still diff against or rebase onto upstream:

```bash
git --git-dir=.fce-sigmax-upstream.git --work-tree=fce-sigmax fetch origin
git --git-dir=.fce-sigmax-upstream.git --work-tree=fce-sigmax diff origin/main -- typescript/src
```

## What is ours vs. upstream's

| Path | Origin | What it does |
|---|---|---|
| `typescript/src/app/sigmax/signal.ts` | **new** | Decodes + validates the ABI-encoded signal (vendored mirror of `packages/shared/src/signal.ts`, minus the zod dep) |
| `typescript/src/app/sigmax/swap-auth.ts` | **new** | Position sizing + FTSO-bounded `minOut` (mirror of `packages/agent/src/flare/swap-auth.ts`) |
| `typescript/src/app/sigmax/process-signal.ts` | **new** | Builds and ABI-encodes the `SwapAuth[]` the node signs |
| `typescript/src/app/sigmax/chain.ts` | **new** | Coston2 reads: active subscribers, vaults, balances, FTSO price |
| `typescript/src/app/sigmax/handler.ts` | **new** | The `SIGNAL/EXECUTE` handler — decrypt → validate → size → sign |
| `typescript/src/__tests__/sigmax-handler.test.ts` | **new** | 13 tests incl. the no-plaintext-in-logs proof |
| `typescript/src/app/node.ts` | **new** | Extracted the tee-node `/decrypt` client so both op types share it |
| `contracts/InstructionSender.sol` | **modified** | Added `OP_TYPE_SIGNAL` / `OP_COMMAND_EXECUTE` and `publishSignal()` (commitment + routing in one tx) |
| `typescript/src/app/config.ts`, `handlers.ts` | **modified** | Registered the new op pair alongside the stock `KEY` ops |
| `go/cmd/ecies-interop/` | **new** | Proves `packages/cdr`'s browser ECIES matches the tee-node's go-ethereum ECIES |
| everything else | upstream | Framework, docker stack, deploy CLIs, proxy config |

The stock `KEY/UPDATE` + `KEY/SIGN` handlers are left registered — they are upstream's smoke test and
`scripts/test.sh` exercises them, which is useful for validating a fresh deployment.

## Version pins

The Coston2 FCC diamond was redeployed on 2026-07-22; the live `FlareTeeManager` is
`0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` (already in `config/coston2/deployed-addresses.json`).
Data providers reject votes from old node builds, so we run:

| Component | Pinned | Where |
|---|---|---|
| tee-node | `v0.0.25` | `go/go.mod`, `go/tools/go.mod`, `typescript/Dockerfile` |
| tee-proxy | `v0.0.21` | `go/tools/go.mod`, `proxy/Dockerfile` |
| Go toolchain | 1.25.x | required by tee-proxy ≥ v0.0.21 |

## Secrets

Never committed: `.env.coston2`, `.env.local.coston2`, `config/extension.env`, and
`config/proxy/*.docker.toml` are gitignored. Only `.env.example` and the `*.example` proxy configs
are tracked. The Coston2 indexer DB credentials go in `config/proxy/extension_proxy.coston2.docker.toml`
only.

## Deploying

See `docs/flare/reference/phase-0-runbook.md`. In short: `use-chain.sh local coston2 typescript` →
`pre-build.sh` → tunnel on port 6674 → `start-services.sh` → `post-build.sh` → `test.sh`.

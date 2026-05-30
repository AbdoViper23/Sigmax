# 03 — Repo Structure

> How the code is laid out. Sigmax is a **pnpm + Turborepo monorepo** where **each service is
> its own standalone, independently-deployable package** (per your requirement: the agent, the
> frontend, the contracts, etc. each live on their own). Shared code goes through one package only.

---

## 1. Top-level layout

```
sigmax/
├── package.json                 # root: workspace scripts, devDeps, turbo
├── pnpm-workspace.yaml          # declares packages/* and apps/*
├── turbo.json                   # build/test/lint pipeline + caching
├── tsconfig.base.json           # shared TS config, extended by each package
├── .env.example                 # every env var the repo needs (no real values)
├── .github/workflows/ci.yml     # CI: forge test + pnpm -r test + lint
├── docs/                        # ← THIS documentation set lives here
│
├── packages/
│   ├── contracts/               # SERVICE: Solidity (Foundry) — CopyVault, conditions, registry
│   ├── agent/                   # SERVICE: the off-chain executor (Node/TS, Dockerized for TEE)
│   ├── cdr/                     # LIB: thin wrapper around @piplabs/cdr-sdk (publish/decrypt)
│   ├── story/                   # LIB: thin wrapper around @story-protocol/core-sdk (IP/license/royalty)
│   └── shared/                  # LIB: types, the signal schema (zod), constants, addresses
│
└── apps/
    └── web/                     # SERVICE: Next.js app (leader + follower UI)
```

**Rule:** services (`contracts`, `agent`, `web`) never import each other directly. They share only
through `packages/shared` (types, schema, addresses) and the two SDK wrappers (`cdr`, `story`).
This keeps each service independently deployable and replaceable.

## 2. Each service in detail

### `packages/contracts/` — Solidity (Foundry)
```
contracts/
├── foundry.toml
├── remappings.txt
├── src/
│   ├── CopyVault.sol                 # per-follower non-custodial vault   (contracts/10)
│   ├── CopyVaultFactory.sol          # deploys a CopyVault per follower
│   ├── conditions/
│   │   ├── SubscriptionReadCondition.sol   # gates CDR decrypt on active sub (contracts/11)
│   │   └── LeaderWriteCondition.sol        # gates CDR publish to the leader  (contracts/11)
│   └── SubscriptionRegistry.sol      # follower → expiry timestamp          (contracts/12)
├── test/
│   ├── CopyVault.t.sol               # caps, whitelist, role, withdraw-only-owner, reentrancy
│   ├── SubscriptionRegistry.t.sol    # subscribe, renew, expiry, isActive
│   └── conditions/*.t.sol            # checkRead/checkWrite truth tables
├── script/
│   ├── DeployConditions.s.sol        # deploy to Story Aeneid
│   └── DeployVaultStack.s.sol        # deploy factory + registry to liquidity chain
└── deployments/                      # generated address books per chain (committed)
    ├── story-aeneid.json
    └── arbitrum-one.json
```
Deploys to **two chains**: conditions → Story; vault factory + registry → liquidity chain.
(Registry can live on Story for the read condition to check it — see `execution/42` on the
cross-chain split and `contracts/12`.)

### `packages/agent/` — the executor (Dockerized for TEE)
```
agent/
├── Dockerfile                        # built for Phala TDX deployment   (agent/30)
├── src/
│   ├── index.ts                      # boot: load env, start watchers + queue
│   ├── watcher.ts                    # watch Story for new/updated vaults (agent/31)
│   ├── decryptor.ts                  # accessCDR + zod-validate signal    (agent/31, cdr-story/22)
│   ├── subscribers.ts                # read SubscriptionRegistry → active followers (contracts/12)
│   ├── executor.ts                   # build quote + call CopyVault.executeSwap (execution/41)
│   ├── tpsl-monitor.ts               # poll price, trigger exits in-TEE   (agent/32)
│   ├── queue.ts                      # BullMQ wiring
│   └── state.ts                      # persisted open-position state (for restart reconcile)
├── test/
└── .env.example                      # AGENT_PK, CDR_ACCESS_KEY, RPC URLs, 0x key, REDIS_URL
```
The plaintext signal lives only inside `decryptor.ts`/`executor.ts` memory and is never logged or
persisted. `state.ts` stores only non-secret position metadata (follower, token pair, amounts, tx).

### `apps/web/` — Next.js app
```
web/
├── app/
│   ├── leader/                       # register IP, set price, publish signal (client-side encrypt)
│   ├── follower/                     # subscribe (mint license), deposit, authorize agent
│   ├── leaderboard/                  # verifiable track records
│   └── api/                          # route handlers: status, trade history (no secrets)
├── components/
├── lib/
│   ├── wagmi.ts                      # Story + liquidity chain config   (frontend/60)
│   └── contracts.ts                  # ABIs + addresses from packages/shared
└── .env.example                      # NEXT_PUBLIC_* RPCs, chain IDs, contract addresses
```

### `packages/shared/` — the single source of shared truth
```
shared/
├── src/
│   ├── signal.ts                     # the zod SignalSchema + TS type   (cdr-story/22)
│   ├── addresses.ts                  # deployed contract + Story addresses per chain
│   ├── chains.ts                     # chain IDs, RPC defaults
│   └── constants.ts                  # caps defaults, token whitelists, $WIP address
└── package.json
```
`signal.ts` is imported by BOTH the web app (to build/encrypt a signal) and the agent (to validate
a decrypted one) — guaranteeing the publisher and the consumer agree on the exact shape.

### `packages/cdr/` and `packages/story/` — SDK wrappers
Thin, well-typed wrappers so the rest of the repo never calls the raw SDKs directly. This isolates
the VERIFY-version churn (`02-tech-stack.md`) to two files. Example surface:
```
// packages/cdr
publishSignal(encryptedPayload, conditions) -> { uuid }
decryptSignal(uuid, accessAuxData) -> dataKey         // agent-only
// packages/story
registerStrategyIp(meta) -> { ipId }
attachSubscriptionTerms(ipId, monthlyPriceWip, platformRevShareBps) -> { licenseTermsId }
mintSubscription(ipId, follower) -> { licenseTokenId }
claimRevenue(ipId) -> txHash
```

## 3. Environment variables (`.env.example` at root + per service)

```
# --- shared / chains ---
STORY_RPC_URL=https://aeneid.storyrpc.io
STORY_CHAIN_ID=1315
LIQUIDITY_RPC_URL=
LIQUIDITY_CHAIN_ID=42161            # Arbitrum One (or 8453 Base)

# --- agent (server-side, secret) ---
AGENT_PK=                            # scoped executor key (NOT a funds-holding key)
CDR_ACCESS_KEY=                      # key the agent uses to call accessCDR
ZEROX_API_KEY=
REDIS_URL=

# --- web (public) ---
NEXT_PUBLIC_STORY_CHAIN_ID=1315
NEXT_PUBLIC_LIQUIDITY_CHAIN_ID=42161
NEXT_PUBLIC_SUBSCRIPTION_REGISTRY=
NEXT_PUBLIC_COPYVAULT_FACTORY=
```
Never commit a real `.env`. The agent's key is a **scoped executor key**, never a key that can move
funds out of a vault (see `key-management/50`).

## 4. Root scripts (`package.json`)

```jsonc
{
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "contracts:test": "pnpm --filter contracts test",
    "agent:dev": "pnpm --filter agent dev",
    "web:dev": "pnpm --filter web dev",
    "fork": "anvil --fork-url $LIQUIDITY_RPC_URL"   // local forked liquidity for swap tests
  }
}
```

## 5. Build / dependency order

`shared` → (`cdr`, `story`) → (`contracts`, `agent`, `web`). Turborepo infers this from
`dependsOn` in `turbo.json`; keep `shared` dependency-light so it builds first.

## 6. Conventions recap (also in CLAUDE.md §5)

- TS everywhere off-chain; viem for EVM; Solidity 0.8.24 + Foundry for contracts.
- One shared package; no service-to-service imports.
- Every contract function: NatSpec + access modifier + bounds check + Foundry test.
- No secrets in code; `.env` only; plaintext signal never logged/persisted/sent to frontend.
- Commits reference the doc number, e.g. `feat(agent): TP/SL poller [32-agent-tp-sl-monitor]`.

→ Next batch: the contracts — `contracts/10-copyvault.md`, `11`, `12`.

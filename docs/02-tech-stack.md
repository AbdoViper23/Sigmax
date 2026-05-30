# 02 — Tech Stack

> Every tool, library, and service Sigmax uses, with the version to pin and *why* it's chosen.
> When Claude Code scaffolds a package, use these exact choices unless a doc says otherwise.

> ⚠️ Versions marked **VERIFY** must be checked against the live registry before relying on them
> (CDR/Story tooling moves fast). See `94-risks-and-unknowns.md`.

---

## 1. At a glance

| Layer | Choice | Why |
|---|---|---|
| Smart contracts | **Solidity + Foundry** | Industry standard; fast tests; `forge`/`cast`/`anvil` cover build, test, and forked-mainnet demo |
| Off-chain (agent + web) | **TypeScript** | One language across services; shared types in `packages/shared` |
| EVM client lib | **viem** | Modern, type-safe, tree-shakeable; preferred over ethers across the repo |
| CDR / encryption | **@piplabs/cdr-sdk** | The only way to talk to Story's Confidential Data Rails |
| Story IP / royalties | **@story-protocol/core-sdk** | Official SDK for IP Assets, PIL, licensing, royalties |
| Web framework | **Next.js (App Router)** | SSR + API routes; deploys on Vercel in one click |
| Wallet UX | **wagmi + viem + RainbowKit** | Standard React wallet stack; multi-chain support |
| Agent runtime | **Node.js + TypeScript** | Long-running daemon; rich EVM ecosystem |
| Agent TEE host | **Phala Cloud (Intel TDX)** | Dockerized confidential VM with on-chain attestation; ~$100/mo |
| DEX execution | **0x Swap API v2** (primary), **CoW Protocol** (MEV-resistant path) | Aggregated Uniswap/Sushi routing with slippage-protected, ready-built txs |
| Liquidity chain | **Arbitrum One** or **Base** | Deep spot liquidity + cheap gas (decision in `execution/40`) |
| Confidential chain | **Story** (Aeneid 1315 testnet / Homer 1514 mainnet) | Where CDR + IP/royalty live |
| Monorepo | **pnpm workspaces + Turborepo** | Per-service packages, shared deps, cached builds |
| Job scheduling | **BullMQ + Redis** | Reliable signal-processing + TP/SL polling queue |
| App data | **Supabase (Postgres)** | Subscriber index, leader profiles, trade history (NOT secrets) |
| Hosting | **Vercel** (web) + **Phala** (agent) + **Supabase** (db) | Minimal ops |

---

## 2. Contracts package

```
solidity         ^0.8.24        // custom errors, transient storage available if needed
foundry          latest         // forge, cast, anvil; pin via foundry.toml + CI
@openzeppelin/contracts ^5.x     // AccessControl, SafeERC20, ReentrancyGuard
forge-std        latest         // test utilities, cheatcodes
```
- **Why OZ 5.x:** `AccessControl` for the `EXECUTOR_ROLE` on CopyVault; `SafeERC20` for token
  transfers; `ReentrancyGuard` on `executeSwap`.
- **Solc 0.8.24+:** custom errors (gas), and it's the common floor for current OZ.

Foundry is also how we run the **forked-chain demo**: `anvil --fork-url <arbitrum_rpc>` gives real
liquidity locally for testing swaps (Aeneid has none — see `40-chain-choice.md`).

## 3. CDR / Story packages

```
@piplabs/cdr-sdk         VERIFY    // docs say 0.2.1; GitHub tags 0.1.1 — run `npm view`
@story-protocol/core-sdk VERIFY    // IP Asset / PIL / licensing / royalty
viem                     ^2.x      // CDRClient takes viem public/wallet clients
```
- `@piplabs/cdr-sdk` exposes `CDRClient` (`observer`/`uploader`/`consumer`), `initWasm()`,
  `uploadCDR`/`accessCDR`, `uploadFile`/`downloadFile`, and `conditions.*` encoders. (`cdr-story/20`)
- **Pin exact versions** in `package.json` once verified; the API surface differs between 0.1.x
  and 0.2.x. Re-check the installed types, do not trust these docs blindly.

## 4. Agent package

```
typescript       ^5.x
tsx / ts-node    latest     // run TS directly in dev
viem             ^2.x       // chain I/O on both Story and the liquidity chain
@piplabs/cdr-sdk VERIFY      // decrypt signals
bullmq           ^5.x       // job queue (per-signal + TP/SL polling)
ioredis          ^5.x       // Redis client for BullMQ
zod              ^3.x        // validate the decrypted signal against the schema
pino             ^9.x        // structured logging (NEVER log plaintext signal)
dotenv           ^16.x       // env loading
```
- **zod** validates every decrypted signal against `cdr-story/22-signal-template.md` before acting
  — a malformed/garbage decryption must never reach `executeSwap`.
- **pino** with an explicit redaction list; the signal object is excluded from all logs by design.
- Packaged as a **Docker image** for Phala TDX deployment (`agent/30-agent-overview.md`).

## 5. DEX / execution dependencies

```
0x Swap API v2   (HTTP)      // GET /swap/allowance-holder/quote → ready-built tx + minOut
@cowprotocol/cow-sdk ^5.x    // optional: batch-auction orders for MEV/leakage resistance
```
- **0x is the primary path:** returns `to`, `data`, `value`, `gas`, and a slippage-aware
  `minBuyAmount`; feeds straight into `CopyVault.executeSwap`. Requires a 0x API key (env).
- **CoW is the upgrade path** for leakage resistance (`security/70`); it's live on Arbitrum One.
- Needs an **RPC provider** for the liquidity chain (Alchemy or QuickNode) — env var.

## 6. Web app package

```
next             ^15.x
react            ^18.x
wagmi            ^2.x
viem             ^2.x
@rainbow-me/rainbowkit ^2.x
@tanstack/react-query  ^5.x   // wagmi peer dep
@story-protocol/core-sdk VERIFY
@piplabs/cdr-sdk VERIFY        // leader-side encrypt/publish happens client-side
tailwindcss      ^3.x
```
- Two chains configured in wagmi: **Story Aeneid (1315)** for license/IP, **Arbitrum/Base** for
  CopyVault deposit/withdraw/authorize. (`frontend/60`)
- Leader publishing (`uploadCDR`) runs **client-side** so the plaintext signal is encrypted in the
  leader's browser and never touches our server.

## 7. Infra / services

| Service | Used for | Plan / cost (see `91-costs.md`) |
|---|---|---|
| **Vercel** | Web app hosting | Free → Pro ($20/mo) |
| **Phala Cloud** | Agent TEE (Intel TDX CVM) | ~$0.14/hr ≈ ~$100/mo (or $5–50 tiers) |
| **Supabase** | App database (no secrets) | Free → Pro ($25/mo) |
| **Alchemy / QuickNode** | RPC for liquidity chain | Free → ~$49/mo at scale |
| **0x API** | Swap quotes | Free tier, then usage-based |
| **Story RPC** | `aeneid.storyrpc.io` (test) / mainnet RPC | Free public, or paid for reliability |
| **Redis** | BullMQ backend | Upstash free → ~$10/mo |

## 8. Dev tooling

```
pnpm             ^9.x        // workspace package manager
turbo            ^2.x        // monorepo task runner + caching
typescript       ^5.x
eslint + prettier            // lint + format (forge fmt for Solidity)
vitest           ^2.x        // TS unit tests (agent, shared)
@types/node
husky + lint-staged          // pre-commit: lint, format, typecheck
```

## 9. Versioning policy

- **Pin exact versions** for `@piplabs/cdr-sdk` and `@story-protocol/core-sdk` (fast-moving,
  breaking changes likely). Use `^` ranges only for mature libs (viem, OZ, Next).
- Keep one `pnpm-lock.yaml` at the repo root; commit it.
- Re-run `npm view <pkg> version` for the two VERIFY packages at the start of each work session and
  reconcile with `94-risks-and-unknowns.md`.

→ Next: `03-repo-structure.md` for how these packages are laid out.

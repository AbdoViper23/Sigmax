# Sigmax on Stellar: Tranche 1 MVP (Testnet)

A leader's trade signal is sealed in their browser to an enclave key. Only its hash goes on-chain. The
enclave sizes each follower's trade, and every swap runs from the follower's own Soroban vault, which
re-checks the enclave's signature, the follower's limits and the Reflector price on-chain before an
Aquarius pool settles the trade.

**Status:** running on Stellar Testnet. The enclave runs in **software mode** (no hardware attestation
until Tranche 2), registry admin keys are single Testnet keys, and nothing is audited. Testnet only.
Design: [ARCHITECTURE.md](../docs/stellar/ARCHITECTURE.md) · build decisions:
[decisions.md](../docs/stellar/decisions.md).

## What is built

111 automated tests: 60 contract, 34 enclave, 10 client, 7 agent.

| Part | Path | What it does | Tests |
| --- | --- | --- | --- |
| Vault | `contracts/vault` | Soroban custom account. `__check_auth` accepts one enclave-signed swap that fits the owner's policy: allowlisted pool and assets, share-of-balance and USD caps, rolling 24 h count and volume, oracle bound on `min_amount_out`, one trade per signal. Owner deposits, withdraws, pauses and changes limits | 37 |
| Signal Registry | `contracts/signal-registry` | Leaders commit `sha256(sealed signal)` before any trade. Entry and close are both opaque commitments | 9 |
| Enclave Registry | `contracts/enclave-registry` | The enclave signing key vaults trust and the key leaders seal to. Revoking stops every vault at once | 7 |
| Vault factory | `contracts/vault-factory` | Deploys vaults from a fixed Wasm hash and keeps an on-chain index of them | 7 |
| Enclave | `enclave` (Rust) | Decrypts sealed signals, checks them against their commitments, sizes each vault's trade, builds and signs the Soroban authorization. Never returns or logs the signal | 34 |
| Client | `client` (TS) | Signal sealing, contract encoding, RPC reads, swap authorization | 10 |
| Agent | `agent` (TS) | Relay (holds ciphertext) and relayer (asks the enclave per vault, checks the payload, submits, pays fees) | 7 |
| Web app | `web` (React) | Overview, leader (seal and publish), follower (create, fund and control a vault) | headless smoke |
| Scripts | `scripts` | Deploy, register the enclave, align the Testnet pool, end-to-end demo, web smoke | |

Cross-checks that matter:

- `enclave/tests/vault_interop.rs` runs the enclave's own code against the real vault contract. The
  enclave decrypts, sizes and signs, and the host runs the vault's `__check_auth` on the result.
- The Rust enclave and the TypeScript relayer must compute the same Soroban authorization payload. Shared
  known-answer vectors pin both (`enclave/src/auth.rs`, `client/test/client.test.ts`).
- Both decrypt a real go-ethereum ECIES vector.
- `vault-factory` tests swap through a factory-deployed **Wasm** vault under mainnet resource limits.
  Measured: about 2.3M instructions.

## Testnet deployment

| Contract | Address |
| --- | --- |
| Signal Registry | [`CBLKYPDVZ67CXU75VLYSY2HW6HDUZVPURYKL67ZLHZ56WXQOO2SURG3C`](https://stellar.expert/explorer/testnet/contract/CBLKYPDVZ67CXU75VLYSY2HW6HDUZVPURYKL67ZLHZ56WXQOO2SURG3C) |
| Enclave Registry | [`CCC5OO4PVX4ITYYBOS472JYRVPLEI5COQWAAE4XULQXBSDUF3KL7ZPBG`](https://stellar.expert/explorer/testnet/contract/CCC5OO4PVX4ITYYBOS472JYRVPLEI5COQWAAE4XULQXBSDUF3KL7ZPBG) |
| Vault factory | [`CACFUIWXK7ZE7LUMASMVO3YN4WQTO5E4ASYACRPL4QAOMDWWSGQOR6GJ`](https://stellar.expert/explorer/testnet/contract/CACFUIWXK7ZE7LUMASMVO3YN4WQTO5E4ASYACRPL4QAOMDWWSGQOR6GJ) |
| Oracle: Reflector, CEX/DEX feed | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Venue: Aquarius XLM/USDC pool, 1% fee | `CDVB6O3WX24AAZ77SQRN52ABU4ECB66N36FG5BFVPTV54DPG3V6MOTOD` |
| USD: Circle Testnet USDC (SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

All addresses and Wasm hashes are in [`deployments/testnet.json`](deployments/testnet.json).

## Verified on Testnet (2026-11-19)

`pnpm demo` against the deployment above, with nothing mocked. Vault
[`CA3V2WIN…LMUE`](https://stellar.expert/explorer/testnet/contract/CA3V2WINSD3WS7CMDULOX3FVB3KDGXPCKDMA5ENLUZ52P4SLCXGRLMUE):

| Step | Transaction |
| --- | --- |
| Follower vault created through the factory | [`7779cc37…`](https://stellar.expert/explorer/testnet/tx/7779cc37b55fbe21b0c681377a23b7453a1c86347438f174872a74cf901b8040) |
| 300 USDC deposited | [`40f32470…`](https://stellar.expert/explorer/testnet/tx/40f324702640600df00f9e1e91b4f7e0da3f2cbc6abc12fc28488e33a2981b67) |
| Leader commits a sealed entry signal (only its hash is on-chain) | [`f690bb60…`](https://stellar.expert/explorer/testnet/tx/f690bb606907502456f26d16e9e1e8281ae60187373d47c6b4246225f5cb37c9) |
| Enclave-authorized swap from the vault: 49.96 USDC → 356.19 XLM | [`a14d2130…`](https://stellar.expert/explorer/testnet/tx/a14d2130591735dea6cc2789371e038d822960215ba96a6f0efa34ad0d12e561) |
| Leader commits a sealed close signal | [`0c42e65e…`](https://stellar.expert/explorer/testnet/tx/0c42e65efda7528c1dd067894866abe80fe5fbf608ad098248dfe9477a325e14) |
| Enclave-authorized swap: the whole 356.19 XLM back to USDC | [`775d7263…`](https://stellar.expert/explorer/testnet/tx/775d72638e808b64de866df670ed31c1f5a05395a65fd4688ee88d3e873f4fd4) |

The vault ended with 299.01 USDC and no XLM. The round trip cost about $1: two 1% pool fees.

Earlier runs on the same day also showed the limits holding:

- A vault whose policy capped each trade at 50% of its balance closed only half its position
  ([`f9c33282…`](https://stellar.expert/explorer/testnet/tx/f9c33282df8c692eff68dbef2cfb45898f50fd20397dfd5b01561d6f61e00e8b)).
- With the pool 1.5% off the oracle, the enclave skipped the vault ("pool price is outside the vault's
  oracle band") instead of signing a trade the vault would refuse.

## Run it

Prerequisites: Rust 1.100 with `wasm32v1-none` (pinned by `rust-toolchain.toml`), stellar-cli 30 or
later, Node 22 or later, pnpm 11.

```bash
# Contracts: build first (soroban-sdk 29 needs stellar-cli to build), then test
cd stellar/contracts && stellar contract build && cargo test

# Enclave
cd stellar/enclave && cargo test && cargo build --release

# Deploy your own copy (optional: the deployment above is live)
cd stellar && ./scripts/deploy-testnet.sh && ./scripts/register-enclave.sh

# Services (separate terminals)
cd stellar/enclave && ENCLAVE_KEY_FILE=$PWD/.enclave/keys.json ./target/release/sigmax-enclave
cd stellar && pnpm install
stellar keys generate sigmax-relayer --network testnet --fund
RELAYER_SECRET=$(stellar keys show sigmax-relayer) pnpm agent

# Testnet pools drift from the oracle: align the demo pool, then run the whole flow
pnpm align-pool --execute
pnpm demo

# Web app on http://localhost:5174 (needs Varial, formerly Freighter, on Testnet)
pnpm --filter @sigmax/stellar-web dev
pnpm smoke:web   # headless check against live Testnet
```

`register-enclave.sh` registers whatever key file the enclave uses. A different key file means a
different enclave key, and vaults then reject the running enclave until you register its key.

## Limits of this MVP

- **Software-mode enclave.** Signals are confidential from the chain and the relay, not from whoever runs
  the enclave. Hardware attestation is Tranche 2.
- **Single admin keys.** The registries and the factory are upgradeable by one Testnet key. Tranche 2
  moves them to a 2-of-3 multisig with a 48-hour timelock.
- **Allowlisted pools are trusted to enforce `min_amount_out`.** See decisions.md, D7.
- **Not yet built:** the leader public record (indexer), take-profit and stop-loss execution (they
  travel sealed but are not acted on), and Stellar Wallets Kit. All are Tranche 2.
- **Testnet pools need alignment** before demos (decisions.md, D10).
- **Wallet flows untested with a real wallet.** The web app's Varial flows were built against
  `@stellar/freighter-api` 6.0.1, but this session had no wallet.
- **Not audited.**

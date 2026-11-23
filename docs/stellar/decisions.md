# Sigmax on Stellar: Tranche 1 build decisions

Every place where building the Tranche 1 MVP refined or departed from
[ARCHITECTURE.md](ARCHITECTURE.md), with the reason, so each can be reviewed or reversed.
Started 2026-11-19 on branch `stellar-rewrite`.

## Contracts

**D1. Vault auth is purpose-built, not OpenZeppelin `stellar-accounts`.**
The architecture says the vault builds on the OpenZeppelin smart-account and policy contracts "where
they fit". For Tranche 1 they do not:

- The vault has exactly one external signer path (the enclave key), and its check has to read every call
  argument. That is the Sigmax policy the architecture already called for; the OZ signer and
  context-rule machinery around it would add code without adding a check.
- Owner actions (deposit, withdraw, limits, pause) are ordinary functions behind `owner.require_auth()`.
  The owner can be any `Address`, so passkey smart wallets work without OZ's signer model.
- `stellar-accounts` 0.8.0 pins `soroban-sdk ^28`; the build uses 29.0.1.

Revisit if owners need multi-signer vaults. Code: `stellar/contracts/vault/src/lib.rs`.

**D2. How the `SwapIntent` fields map onto Soroban authorization.**
The enclave signs `SIGMAX/swap/v1 ‖ payload ‖ signal ‖ expires_at_ledger (u32 BE)`, where `payload` is the
Soroban authorization payload. That payload already commits to the network, a nonce and the whole
invocation tree. The vault reads vault, venue, assets, `amount_in` and `min_amount_out` from the
authorization contexts instead of trusting copies inside the signature. The proof carries only
`{signal, expires_at_ledger, signature}`.

- **Nonce:** the host's own address-credential nonce. The host stores it as a temporary ledger entry
  until the signature expires, which is the nonce design in the Storage section, with no vault code.
- **Expiry:** checked by the vault, and capped at 120 ledgers.
- **Leader:** taken from the signal's on-chain record.

**D3. One trade per signal per vault.**
The vault writes a temporary "used" marker for every signal it trades. The marker's TTL outlives the
longest allowed signal age, which is hard-capped at 24 hours. A leaked enclave key therefore cannot replay
an old commitment into repeated trades. This is in addition to the daily trade and volume limits.

**D4. Signal Registry commitments are opaque.**
Entry and close signals are both committed, but the registry stores only `{leader, seq, ledger,
timestamp}`. Whether a signal opens or closes a position stays inside the sealed signal. A public `kind`
field would tell front-runners which way the leader is about to move.

**D5. A minimal Enclave Registry already exists in Tranche 1.**
The architecture lists the Enclave Registry under Tranche 2. Vaults have no upgrade path, so they are
deployed now against its final read interface (`signing_key()`). The Tranche 1 registry has a single
admin and takes effect immediately. Tranche 2 adds the 2-of-3 multisig, the 48-hour timelock and the
attested image digest without changing any vault.

The registry also stores the enclave's encryption key, so browsers read the sealing key from the chain
and not from a server.

**D6. Upgradeability.**
Vaults have no upgrade function. The factory deploys them with `ContractExecutable::Wasm`, never
`ExternalRef`, because `ExternalRef` would let the deployer change vault code later.

The registries and the factory are admin-upgradeable on Testnet, with one admin key. The Tranche 2 threat
model must cover that power. An upgraded Signal Registry could fake a signal record, but a trade would
still need the enclave signature and would stay inside every vault limit.

**D7. Known trust assumption: allowlisted pools enforce `out_min`.**
A custom account authorizes the input transfer before the pool runs, so the vault relies on an
allowlisted pool to honor `min_amount_out`. The test
`known_limitation_a_malicious_allowlisted_pool_can_keep_the_input` documents this.

There is a hardening option for the audit: the vault executes the swap itself and checks balance deltas
afterwards. That removes the assumption but changes the custom-account design in ADR 0001.

## Oracle and venue

**D8. Reflector feed: the CEX/DEX feed on Testnet.**
Vaults price assets through the Reflector Testnet CEX/DEX feed `CCYOZJ…RN63` (base USD, 14 decimals,
300 s resolution) as `Other("XLM")` and `Other("USDC")`. The Testnet on-chain feed `CAVLP5…6HLP` does not
quote the XLM contract or Circle USDC. On Mainnet, pick the feed per asset; the DEX feed quotes Stellar
assets by contract address.

**D9. Direct Aquarius pool calls, not the router.**
A direct `pool.swap` is allowed. Its authorization tree, `pool.swap → token_in.transfer(user, pool,
amount)`, was checked against a live Testnet pool. Leaving the router out keeps one less upgradeable
contract in the trust path.

**D10. Testnet pool alignment (Testnet only).**
Testnet pools are not arbitraged against real markets. On 2026-11-19, XLM/USDC pools sat at 0.56–0.69
USDC per XLM while Reflector quoted 0.137. Against such a pool the vault correctly refuses one side of
every trade.

`stellar/scripts/align-pool.ts` trades the demo pool, the 1% pool `CDVB6O…MOTOD` (the only one shallow
enough), back to the oracle price with friendbot XLM. Testnet traders push it back within about an hour
(observed 1.5–6% drift), so align right before a demo. Mainnet does not need this.

**D11. Demo vault oracle band: 5%.**
The demo pool's 1% fee, plus price impact, plus drift since the last alignment needs room. The band is
the follower's choice and is hard-capped at 10%.

## Enclave and relayer

**D12. Enclave in Rust, software mode, reusing the existing ECIES scheme.**
The enclave uses go-ethereum-compatible ECIES (secp256k1, AES-128-CTR, HMAC-SHA-256), which the browser
sealer already used. Both the Rust enclave and the TypeScript client decrypt the same real go-ethereum
vector.

Keys are created inside the service and kept in a 0600 file, so a restart keeps the same keys (the Flare
lesson). The enclave never returns or logs the decrypted signal; responses carry only the trade plan and
the proof.

**D13. In Tranche 1 the relayer supplies chain snapshots.**
The relayer sends the enclave the vault policy and balances, pool reserves and oracle prices. The
enclave does not run its own RPC client yet. This is acceptable because every limit is re-checked
on-chain; a dishonest snapshot can at worst produce a trade the vault rejects, or a smaller one. From
Tranche 2 the attested enclave reads chain state itself.

**D14. Relay and relayer are one TypeScript service (`stellar/agent`).**
It submits sequentially from one relayer account. Channel accounts for parallel fan-out arrive with the
Tranche 2 50-vault load test.

Before submitting, the relayer recomputes the Soroban payload with stellar-sdk and refuses if the enclave
signed anything else. The Rust and TypeScript encoders are pinned by shared known-answer vectors.

**D15. Simulation margin.**
On Testnet, a transaction that simulated fine failed with `resource_limit_exceeded`. Submissions now
add 25% to simulated instructions and I/O, and to the resource fee.

**D15b. Retries never change an outcome.**
Testnet RPC and friendbot calls from the build machine dropped in bursts. Only network-level failures
are retried, never a contract error, a failed simulation or a refused transaction. Reads retry freely.
Submissions resend the identical signed envelope (same hash and sequence number) and poll by hash.

The agent retries each vault on a dropped connection and re-reads the vault first. A retry after a swap
that did land sees the signal marked as used and is skipped, so a vault can never trade twice. The
enclave may re-authorize the same vault for the same signal; pool-depth accounting replaces the earlier
amount instead of adding to it. Posting a failed commitment to the relay again re-runs it.

**D16. Enclave sizing defaults.**
- `min_amount_out` is the pool estimate less 0.5%.
- One signal may consume at most 2% of a pool's input reserve across all vaults.
- Trades under $1 are skipped.

Configurable through environment variables.

## Repository and tooling

**D17. `stellar/` is its own pnpm workspace.**
This keeps the Story and Flare dependency tree out of the Stellar build. The browser ECIES code is
copied from `packages/enclave-crypto` (the prototypes are history).

**D18. Toolchain.**
- Rust 1.100.0, pinned in `rust-toolchain.toml`, installed per user with `rustup --no-modify-path`.
- `wasm32v1-none` target.
- stellar-cli 30.0.1, prebuilt binary, sha256-verified.
- soroban-sdk 29.0.1, the latest stable. Testnet runs protocol 30.

soroban-sdk 29 contracts must be built with `stellar contract build`, not plain `cargo build`.

**D19. Web wallet: Varial (formerly Freighter) through `@stellar/freighter-api` 6.0.1.**
This follows the Tranche 1 scope; Stellar Wallets Kit arrives in Tranche 2. The wallet flows were not
exercised with a real wallet in the build session. Only the read-only pages were checked, in headless
Chromium.

## Open items

- Confirm Varial's injected API matches `@stellar/freighter-api` 6.0.1 with a real wallet.
- The registries' single Testnet admin key must move to the multisig before any Mainnet use.
- The leader public record (indexer) is Tranche 2. Swap events (`swap_authorized`) already carry the
  signal commitment.
- `USED_SIGNAL_TTL` assumes at least 1 second per ledger. Re-check it if Stellar's ledger close time
  drops below 1 second.

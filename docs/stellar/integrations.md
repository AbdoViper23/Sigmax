# Sigmax on Stellar: Integrations

Every Stellar integration Sigmax plans to use, what it is for, and the tranche in which it lands.

> **Status: planned work.** None of these integrations is built or deployed yet. There is no Stellar
> code in this repo and no Testnet deployment. Tranche dates and scope follow
> [ARCHITECTURE.md](ARCHITECTURE.md#milestones-and-open-source).

**Tranche key:** Tranche 1 = MVP on Testnet (20/01/2027) · Tranche 2 = Testnet release (05/03/2027) ·
Tranche 3 = Mainnet launch (20/04/2027) · Spike = time-boxed feasibility study with a written report,
not a commitment to build.

| Integration | Used for | Tranche |
| --- | --- | --- |
| **Soroban** smart contracts (Rust, soroban-sdk) | Follower smart-account vaults (`__check_auth` policy) and the Signal Registry; then the Enclave Registry and the Subscription contract; then the Mainnet deployment of all of them | Tranche 1: vaults, Signal Registry · Tranche 2: Enclave Registry, Subscription · Tranche 3: Mainnet contracts |
| **Aquarius** AMM pools (constant-product and stable) | Phase 1 execution venue. The vault calls a pool's `swap` with `out_min` set to the intent's `min_amount_out`, so the pool enforces the follower's slippage limit on-chain | Tranche 1 |
| **Soroswap aggregator** | Optional routing across Soroban AMM pools only. Sigmax restricts routes to Soroban AMM protocols, and the vault rejects any route leg outside its venue allowlist. Used only if its authorization tree can be validated exactly; direct Aquarius calls come first | Tranche 1: optional |
| **Stellar DEX (SDEX)** order book | Feasibility spike only: can a smart-account vault reach SDEX liquidity while every vault limit stays enforced and funds stay under vault control? Built in Tranche 3 only if the spike passes | Spike: during Tranche 2 |
| **Circle USDC** through its Stellar Asset Contract (SAC) | USD rail: subscription payments, the on-chain fee split, and USDC trading pairs. Circle testnet USDC on Testnet, Circle USDC on Mainnet. No custom test tokens, nothing bridged | Tranche 1 |
| **Stellar Wallets Kit** + **Varial (formerly Freighter)** | Wallet connection for leaders and followers: commit signals, deposit, withdraw, change limits. Stellar Wallets Kit is the connection layer; Tranche 1 ships with Varial (formerly Freighter), and Tranche 2 completes the kit integration so xBull, LOBSTR and Albedo also work | Tranche 1: Varial (formerly Freighter) · Tranche 2: Stellar Wallets Kit |
| **OpenZeppelin Stellar contracts** | Base for the smart-account vault (signers, context rules) and its policy contracts, instead of writing auth from scratch. The Sigmax swap policy inspects each call's arguments | Tranche 1 |
| **Stellar RPC** + **Horizon / history archives** | Stellar RPC: simulation, transaction submission, reading vault balances and policy, and ingesting contract events (`getEvents`). RPC keeps only about 7 days of events by default, so the indexer ingests continuously and backfills older history from Horizon / history archives or an indexer service (for example Mercury) | Tranche 1: RPC reads and submission · Tranche 2: indexer for the leader public record |
| **stellar.toml (SEP-1)** + `home_domain` | Publish `stellar.toml` on the Sigmax domain and set `home_domain` on the deployer account, so the Mainnet contracts and the registry admin signers can be linked to Sigmax | Tranche 3 |

## Notes

- **Assets move as SAC tokens.** XLM and Circle USDC are held by each vault through their Stellar Asset
  Contracts, so a C-address vault can hold and swap them with Soroban calls.
- **Why Aquarius before SDEX.** A C-address vault can authorize Soroban contract calls but cannot submit
  classic SDEX operations. See
  [ADR 0001](adr/0001-smart-account-vaults-and-aquarius-first.md).
- **Off-chain, not Stellar:** the enclave runs on Google Cloud Confidential Space from Tranche 2 (software
  mode on Testnet in Tranche 1). It is listed in [ARCHITECTURE.md](ARCHITECTURE.md#enclave-attestation-and-key-registry),
  not here, because it is not a Stellar integration.

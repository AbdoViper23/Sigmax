# ADR 0001: Smart-account vaults, Aquarius first

- **Status:** Accepted (planned work, nothing built yet)
- **Date:** 2026-11-09
- **Related:** SCF #46 Build Award submission. See [ARCHITECTURE.md](../ARCHITECTURE.md).

## Context

Sigmax copies a leader's encrypted signal into many follower accounts. Two things must both hold:

1. **Non-custodial.** Sigmax must never be able to withdraw follower funds. Only the follower can.
2. **Automatic.** Trades must execute without the follower signing each one, because a signal is only
   worth copying if every follower fills within a few ledgers of the others.

So each follower needs an account that a second key (the enclave key) can trade from, but only inside
limits the follower sets, and never to withdraw. The limits have to be enforced on-chain, not by
Sigmax's off-chain code, so that a compromised enclave key or operator still cannot drain a vault.

Stellar offers two account types. A classic account (G-address) can submit SDEX operations, but its only
authorization model is signer weights and thresholds: a signer either may do everything at its
threshold or nothing. A Soroban custom account (C-address) runs its own `__check_auth`, so it can check
every authorization against a stored policy. A C-address cannot be the source of a classic operation,
so it cannot submit SDEX orders. It can authorize Soroban contract calls, such as an Aquarius pool swap.

## Decision

1. **Each follower vault is a Soroban custom account** (C-address) that enforces the follower's policy in
   `__check_auth`. The owner key can deposit, withdraw, change limits and pause. The enclave key can
   only authorize a single `SwapIntent` that matches the stored policy (assets, venues, size, rolling
   24-hour limits, nonce, expiry, a committed signal) and whose authorization context tree matches the
   intended swap exactly. The vault builds on the OpenZeppelin Stellar smart-account and policy
   contracts where they fit.
2. **Phase 1 executes on Aquarius pools**, called directly from the vault, because a C-address cannot
   submit classic SDEX operations. The pool's `out_min` argument enforces the follower's slippage limit
   on-chain. Routing through the Soroswap aggregator is optional and restricted to Soroban AMM routes.
3. **SDEX comes only after a spike** (Tranche 2) proves that a vault can reach SDEX liquidity while every
   vault limit stays enforced and funds stay under vault control. It is built in Tranche 3 only if the
   spike passes.

## Consequences

- **Positive:** a leaked enclave key can only trade inside each follower's limits and can never
  withdraw. Policy, custody, execution and the trade record are all on Stellar, so the guarantee does not
  depend on Sigmax's servers.
- **Positive:** each vault authorizes independently, so the relayer can submit all followers' swaps in
  parallel.
- **Negative:** Phase 1 liquidity is limited to Soroban AMM pools. Launch pairs are restricted to the
  deepest Aquarius pools, and a per-signal size cap limits slippage during fan-out.
- **Negative:** custom-account authorization is harder to get right than a signer-weight setup. The
  context-tree check is security-critical, so it gets dedicated tests, the Tranche 2 threat model, and
  the SCF Audit Bank audit before Mainnet caps are raised.
- **Negative:** tooling may assume a classic keypair signer. If the Aquarius SDK does, authorization
  entries are built manually.
- **Operational:** vault storage needs TTL management (relayer keep-alive, owner interactions extend
  TTL). See [Storage and rent](../ARCHITECTURE.md#storage-and-rent-ttl).

## Alternatives considered

- **Classic account with signer weights.** Add the enclave key as a signer on the follower's G-address.
  Rejected: signer weights cannot express "swap only these assets, up to this size, on these venues, never
  withdraw". Any weight high enough to trade is also high enough to send funds anywhere.
- **Off-chain custody.** Followers deposit into a Sigmax-controlled account and Sigmax trades for them.
  Rejected: it breaks the non-custodial rule, makes Sigmax a custodian of user funds, and moves every
  limit off-chain where users cannot verify it.
- **SDEX first.** Use the order book from day one for its depth. Rejected for Phase 1: a C-address vault
  cannot submit classic SDEX operations, and every known way around that (for example, routing through a
  G-address controlled by Sigmax) would take funds out of vault control or bypass vault limits. Kept as a
  Tranche 2 spike instead.

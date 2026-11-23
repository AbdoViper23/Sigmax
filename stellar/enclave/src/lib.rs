//! Sigmax enclave service.
//!
//! The only component that can read a leader's signal. It decrypts sealed
//! signals, checks each against its on-chain commitment, sizes every follower
//! vault's trade inside that vault's limits, and signs the vault swap
//! authorization (see `docs/stellar/ARCHITECTURE.md`).
//!
//! Tranche 1 runs it in **software mode** on Testnet only: an ordinary process
//! with its keys in a local file. Tranche 2 moves the same code into a
//! confidential VM with remote attestation and attestation-gated key release.

pub mod api;
pub mod auth;
pub mod ecies;
pub mod keys;
pub mod num;
pub mod signal;
pub mod sizing;

#![no_std]
//! Shared types and cross-contract interfaces for the Sigmax Soroban contracts.
//!
//! Every type that crosses a contract boundary lives here, so the vault, the
//! registries and the factory agree on one definition. The enclave service and
//! the TypeScript relayer encode the same types; `swap_message` is the one byte
//! layout they must reproduce exactly (see `docs/stellar/ARCHITECTURE.md`).

use soroban_sdk::{contractclient, contracttype, Address, Bytes, BytesN, Env, Symbol, Vec};

/// Domain tag prepended to every enclave swap authorization message.
pub const SWAP_DOMAIN: &[u8; 14] = b"SIGMAX/swap/v1";

/// Decimals of the USD amounts in vault policies (`max_trade_usd`, `max_daily_usd`).
pub const USD_DECIMALS: u32 = 7;

/// Basis-point denominator.
pub const BPS: u32 = 10_000;

/// Longest an enclave authorization may stay valid, in ledgers (about 10 minutes).
pub const MAX_INTENT_LEDGERS: u32 = 120;

/// Upper bound for `Policy::max_signal_age_secs`.
pub const MAX_SIGNAL_AGE_SECS: u64 = 86_400;

/// Upper bound for `Policy::max_daily_trades`.
pub const MAX_DAILY_TRADES: u32 = 50;

/// Upper bound for `Policy::max_slippage_bps` (10%).
pub const MAX_SLIPPAGE_BPS: u32 = 1_000;

/// A leader's signal commitment as stored by the Signal Registry.
///
/// The registry stores only the commitment and when it was made. Whether the
/// signal opens or closes a position, and every trade parameter, stays inside
/// the sealed signal, so a front-runner learns only that the leader committed
/// something.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalRecord {
    /// The leader that committed the signal.
    pub leader: Address,
    /// Per-leader sequence number, starting at 1.
    pub seq: u32,
    /// Ledger sequence at commit time.
    pub ledger: u32,
    /// Ledger close time (unix seconds) at commit time.
    pub timestamp: u64,
}

/// An asset a vault may trade, with the oracle ticker used to price it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetConfig {
    /// Token contract (the Stellar Asset Contract for classic assets).
    pub token: Address,
    /// Ticker the price oracle quotes the asset under, for example `XLM`.
    pub symbol: Symbol,
    /// Token decimals (7 for every Stellar classic asset).
    pub decimals: u32,
}

/// A pool the vault may swap through, pinned with its token order.
///
/// The token order is stored by the owner instead of read from the pool, so a
/// pool upgrade cannot change which token an index refers to.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Venue {
    /// Pool contract (an Aquarius pool in Tranche 1).
    pub pool: Address,
    /// The pool's tokens in pool index order.
    pub tokens: Vec<Address>,
}

/// The limits a follower sets on what the enclave key may do with their vault.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Policy {
    /// The only leader whose signals this vault copies.
    pub leader: Address,
    /// Assets the vault may trade. Both sides of a swap must be listed.
    pub assets: Vec<AssetConfig>,
    /// Pools the vault may swap through.
    pub venues: Vec<Venue>,
    /// Largest trade as a share of the vault's balance of the input asset.
    pub max_trade_bps: u32,
    /// Largest trade in USD (7 decimals), valued at the oracle price.
    pub max_trade_usd: i128,
    /// Largest total traded in any rolling 24 hours, in USD (7 decimals).
    pub max_daily_usd: i128,
    /// Most trades in any rolling 24 hours.
    pub max_daily_trades: u32,
    /// Largest shortfall of `min_amount_out` below the oracle-fair output.
    pub max_slippage_bps: u32,
    /// Oldest signal (seconds since its commitment) the vault will trade on.
    pub max_signal_age_secs: u64,
    /// Oldest oracle price (seconds) the vault will trust.
    pub max_oracle_age_secs: u64,
    /// Unix time after which the enclave may no longer trade this vault.
    pub expires_at: u64,
}

/// Contract addresses a vault is bound to for its whole life.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultConfig {
    /// Enclave Registry: the source of the trusted enclave signing key.
    pub enclave_registry: Address,
    /// Signal Registry: where leaders commit signals before any trade.
    pub signal_registry: Address,
    /// SEP-40 price oracle (Reflector) used to bound `min_amount_out`.
    pub oracle: Address,
}

/// The enclave's authorization for one swap, passed as the vault's signature.
///
/// The swap itself (pool, assets, amounts, `min_amount_out`, vault) is not
/// repeated here: it is part of the Soroban authorization payload the enclave
/// signs, and the vault reads it from the authorization contexts.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapProof {
    /// Commitment of the signal this trade executes.
    pub signal: BytesN<32>,
    /// Last ledger at which this authorization is valid.
    pub expires_at_ledger: u32,
    /// ed25519 signature by the enclave key over `swap_message`.
    pub signature: BytesN<64>,
}

/// One trade in the vault's rolling 24-hour window.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TradeMark {
    /// Ledger time of the trade (unix seconds).
    pub timestamp: u64,
    /// Trade value in USD (7 decimals) at the oracle price.
    pub usd: i128,
}

/// SEP-40 asset identifier, as used by Reflector.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleAsset {
    /// An on-chain Stellar asset, identified by its token contract.
    Stellar(Address),
    /// An off-chain ticker such as `XLM` or `USDC`.
    Other(Symbol),
}

/// One SEP-40 price record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    /// Price scaled by `10^decimals()`.
    pub price: i128,
    /// Unix seconds the price is for.
    pub timestamp: u64,
}

/// Build the message the enclave signs for one swap.
///
/// Layout: `SWAP_DOMAIN ‖ signature_payload (32) ‖ signal (32) ‖ expires_at_ledger (u32, big-endian)`.
/// `signature_payload` is the Soroban authorization payload hash, which already
/// commits to the network, the nonce and the full invocation tree.
pub fn swap_message(
    env: &Env,
    signature_payload: &BytesN<32>,
    signal: &BytesN<32>,
    expires_at_ledger: u32,
) -> Bytes {
    let mut msg = Bytes::from_array(env, SWAP_DOMAIN);
    msg.append(&Bytes::from_array(env, &signature_payload.to_array()));
    msg.append(&Bytes::from_array(env, &signal.to_array()));
    msg.append(&Bytes::from_array(env, &expires_at_ledger.to_be_bytes()));
    msg
}

/// Interface of the Signal Registry used by vaults.
#[contractclient(name = "SignalRegistryClient")]
pub trait SignalRegistryInterface {
    /// Return the record of a committed signal, if any.
    fn get(env: Env, commitment: BytesN<32>) -> Option<SignalRecord>;
}

/// Interface of the Enclave Registry used by vaults.
#[contractclient(name = "EnclaveRegistryClient")]
pub trait EnclaveRegistryInterface {
    /// The ed25519 key vaults accept swap authorizations from, or `None` when no
    /// key is registered or signing is revoked.
    fn signing_key(env: Env) -> Option<BytesN<32>>;
}

/// The subset of the SEP-40 price oracle interface vaults use (Reflector).
#[contractclient(name = "PriceOracleClient")]
pub trait PriceOracleInterface {
    /// Decimal places of every price the oracle returns.
    fn decimals(env: Env) -> u32;
    /// Most recent price of `asset`, if the oracle quotes it.
    fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData>;
}

/// The subset of the Aquarius pool interface Sigmax calls.
///
/// `swap` calls `user.require_auth()` and then pulls
/// `token_in.transfer(user, pool, in_amount)`; that is the exact authorization
/// tree a vault approves (verified against a live Aquarius Testnet pool).
#[contractclient(name = "AquariusPoolClient")]
pub trait AquariusPoolInterface {
    /// The pool's tokens in index order.
    fn get_tokens(env: Env) -> Vec<Address>;
    /// The pool's reserves in index order.
    fn get_reserves(env: Env) -> Vec<u128>;
    /// Output of swapping `in_amount` of token `in_idx` for token `out_idx`.
    fn estimate_swap(env: Env, in_idx: u32, out_idx: u32, in_amount: u128) -> u128;
    /// Swap `in_amount` of token `in_idx` for at least `out_min` of token `out_idx`.
    fn swap(
        env: Env,
        user: Address,
        in_idx: u32,
        out_idx: u32,
        in_amount: u128,
        out_min: u128,
    ) -> u128;
}

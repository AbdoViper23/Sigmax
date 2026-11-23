#![no_std]
//! Sigmax follower vault.
//!
//! Each follower gets their own vault: a Soroban custom account (C-address)
//! that holds their assets. Two parties can act on it, with very different
//! powers:
//!
//! * The **owner** (the follower's wallet, any `Address`, including a passkey
//!   smart wallet) deposits, withdraws, changes limits, pauses and resumes.
//!   These are ordinary contract functions gated by `owner.require_auth()`.
//! * The **enclave key** (registered in the Enclave Registry) can authorize
//!   exactly one thing: a single swap through an allowlisted pool that fits the
//!   owner's policy. That check is `__check_auth`, so the enclave key never
//!   reaches any other function, and it can never move funds anywhere except
//!   into the allowlisted pool as the input of that swap.
//!
//! `__check_auth` accepts an enclave authorization only if all of these hold:
//!
//! 1. The vault is not paused and the owner's delegation has not expired.
//! 2. The authorization is unexpired and lives at most `MAX_INTENT_LEDGERS`.
//! 3. It is signed by the key currently registered in the Enclave Registry,
//!    over `swap_message` (the Soroban payload, the signal and the expiry). The
//!    payload already commits to the network, a host-enforced nonce and the
//!    whole invocation tree, so a signature cannot be replayed or reused for a
//!    different call.
//! 4. The signal was committed by the followed leader, recently, and this vault
//!    has not traded on it before.
//! 5. The authorization contexts are exactly `pool.swap(vault, ..)` followed by
//!    `token_in.transfer(vault, pool, amount_in)`, through an allowlisted pool,
//!    between two allowlisted assets.
//! 6. The trade fits the size caps (share of balance, USD per trade) and the
//!    rolling 24-hour limits (trade count, USD volume).
//! 7. `min_amount_out` is no worse than the Reflector oracle price allows, less
//!    the owner's slippage limit. The pool enforces `min_amount_out` on-chain.
//!
//! Spot only: the only thing the enclave can authorize is a swap between two
//! allowlisted tokens. There is no lending, leverage or derivative path.

use sigmax_types::{
    swap_message, AssetConfig, EnclaveRegistryClient, OracleAsset, Policy, PriceOracleClient,
    SignalRegistryClient, SwapProof, TradeMark, VaultConfig, Venue, BPS, MAX_DAILY_TRADES,
    MAX_INTENT_LEDGERS, MAX_SIGNAL_AGE_SECS, MAX_SLIPPAGE_BPS, USD_DECIMALS,
};
use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    contract, contracterror, contractevent, contractimpl, contracttype,
    crypto::Hash,
    panic_with_error, token, Address, BytesN, Env, Symbol, TryFromVal, Val, Vec, U256,
};

const DAY_LEDGERS: u32 = 17_280;
const INSTANCE_TTL_THRESHOLD: u32 = 7 * DAY_LEDGERS;
const INSTANCE_TTL_EXTEND_TO: u32 = 30 * DAY_LEDGERS;
/// Used-signal markers must outlive the longest allowed signal age. Counting
/// one ledger per second keeps them alive about five times longer than needed
/// at Stellar's ~5 s ledger close time.
const USED_SIGNAL_TTL: u32 = MAX_SIGNAL_AGE_SECS as u32;
/// Length of the rolling trade window.
const WINDOW_SECS: u64 = 86_400;
const MAX_ASSETS: u32 = 8;
const MAX_VENUES: u32 = 8;
const MAX_POOL_TOKENS: u32 = 4;
const MAX_TOKEN_DECIMALS: u32 = 18;
const MIN_SIGNAL_AGE_SECS: u64 = 30;
const MIN_ORACLE_AGE_SECS: u64 = 60;
const MAX_ORACLE_AGE_SECS: u64 = 3_600;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Owner,
    Config,
    Policy,
    Paused,
    Recent,
    Used(BytesN<32>),
}

/// Errors returned by the vault.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    /// A policy field is out of bounds or the policy has expired.
    InvalidPolicy = 1,
    /// The owner paused the vault.
    Paused = 2,
    /// The owner's delegation to the enclave has expired.
    DelegationExpired = 3,
    /// The enclave authorization has expired.
    IntentExpired = 4,
    /// The enclave authorization is valid for longer than `MAX_INTENT_LEDGERS`.
    IntentLifetimeTooLong = 5,
    /// The Enclave Registry has no signing key (none registered, or revoked).
    NoEnclaveKey = 6,
    /// The signal is not in the Signal Registry.
    UnknownSignal = 7,
    /// The signal was committed by a leader this vault does not follow.
    WrongLeader = 8,
    /// The signal is older than the policy allows.
    SignalTooOld = 9,
    /// This vault already traded on the signal.
    SignalAlreadyUsed = 10,
    /// The authorized calls are not exactly one swap and its input transfer.
    InvalidContext = 11,
    /// The pool is not in the vault's venue allowlist.
    VenueNotAllowed = 12,
    /// An asset of the swap is not in the vault's asset allowlist.
    AssetNotAllowed = 13,
    /// An amount is zero, negative or out of range.
    InvalidAmount = 14,
    /// The trade is larger than the per-trade caps allow.
    TradeTooLarge = 15,
    /// The oracle has no usable price for an asset of the swap.
    OraclePriceUnavailable = 16,
    /// The oracle price is older than the policy allows.
    OraclePriceStale = 17,
    /// `min_amount_out` is below the oracle-fair output less the slippage limit.
    MinOutBelowOracleBound = 18,
    /// The trade would exceed the rolling 24-hour trade count.
    DailyTradeLimit = 19,
    /// The trade would exceed the rolling 24-hour USD volume.
    DailyVolumeLimit = 20,
    /// An intermediate value overflowed.
    MathOverflow = 21,
}

/// Published when tokens are deposited through `deposit`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub token: Address,
    pub from: Address,
    pub amount: i128,
}

/// Published when the owner withdraws.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub token: Address,
    pub to: Address,
    pub amount: i128,
}

/// Published when the owner replaces the policy.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyUpdated {
    #[topic]
    pub leader: Address,
    pub expires_at: u64,
}

/// Published when the owner pauses or resumes enclave trading.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseChanged {
    pub paused: bool,
}

/// Published when the vault authorizes an enclave swap. It ties the trade to
/// the signal commitment, which is what the leader's public record is built from.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapAuthorized {
    #[topic]
    pub signal: BytesN<32>,
    #[topic]
    pub leader: Address,
    pub pool: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub min_amount_out: i128,
    pub usd_value: i128,
}

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    /// Create a vault for `owner`, bound to the registries and oracle in
    /// `config` for life, with the trading limits in `policy`.
    /// Panics with `InvalidPolicy` if the policy is out of bounds.
    pub fn __constructor(env: Env, owner: Address, config: VaultConfig, policy: Policy) {
        validate_policy(&env, &policy);
        let storage = env.storage().instance();
        storage.set(&DataKey::Owner, &owner);
        storage.set(&DataKey::Config, &config);
        storage.set(&DataKey::Policy, &policy);
        storage.set(&DataKey::Paused, &false);
        storage.set(&DataKey::Recent, &Vec::<TradeMark>::new(&env));
        extend_instance(&env);
    }

    /// The vault owner.
    pub fn owner(env: Env) -> Address {
        read_owner(&env)
    }

    /// The registries and oracle this vault is bound to.
    pub fn config(env: Env) -> VaultConfig {
        read_config(&env)
    }

    /// The current trading policy.
    pub fn policy(env: Env) -> Policy {
        read_policy(&env)
    }

    /// Whether the owner has paused enclave trading.
    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Trades inside the current rolling 24-hour window.
    pub fn recent_trades(env: Env) -> Vec<TradeMark> {
        let now = env.ledger().timestamp();
        prune(&env, read_recent(&env), now)
    }

    /// Whether this vault already traded on `signal` (within the marker's life).
    pub fn is_signal_used(env: Env, signal: BytesN<32>) -> bool {
        env.storage().temporary().has(&DataKey::Used(signal))
    }

    /// Move `amount` of `token` from `from` into the vault. Needs `from`'s
    /// authorization. Plain token transfers to the vault address work too; this
    /// function also extends the vault's TTL and publishes an event.
    pub fn deposit(env: Env, from: Address, token: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, VaultError::InvalidAmount);
        }
        token::Client::new(&env, &token).transfer(&from, env.current_contract_address(), &amount);
        extend_instance(&env);
        Deposited {
            token,
            from,
            amount,
        }
        .publish(&env);
    }

    /// Send `amount` of `token` from the vault to `to`. Owner only. Works at any
    /// time, including while paused or after the delegation expired.
    pub fn withdraw(env: Env, token: Address, amount: i128, to: Address) {
        read_owner(&env).require_auth();
        if amount <= 0 {
            panic_with_error!(&env, VaultError::InvalidAmount);
        }
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);
        extend_instance(&env);
        Withdrawn { token, to, amount }.publish(&env);
    }

    /// Replace the trading policy. Owner only. Panics with `InvalidPolicy` if
    /// the new policy is out of bounds.
    pub fn set_policy(env: Env, policy: Policy) {
        read_owner(&env).require_auth();
        validate_policy(&env, &policy);
        env.storage().instance().set(&DataKey::Policy, &policy);
        extend_instance(&env);
        PolicyUpdated {
            leader: policy.leader,
            expires_at: policy.expires_at,
        }
        .publish(&env);
    }

    /// Stop all enclave trading until `unpause`. Owner only.
    pub fn pause(env: Env) {
        set_paused(&env, true);
    }

    /// Resume enclave trading. Owner only.
    pub fn unpause(env: Env) {
        set_paused(&env, false);
    }

    /// Extend the vault's instance TTL. Anyone may call it (the relayer's
    /// keep-alive job does); it changes nothing else.
    pub fn extend_ttl(env: Env) {
        extend_instance(&env);
    }
}

#[contractimpl]
impl CustomAccountInterface for Vault {
    type Signature = SwapProof;
    type Error = VaultError;

    /// Authorize an enclave swap. Called by the Soroban host only, when a
    /// contract requires this vault's authorization. See the module docs for
    /// the full list of checks.
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: SwapProof,
        auth_contexts: Vec<Context>,
    ) -> Result<(), VaultError> {
        authorize_swap(
            &env,
            &signature_payload.to_bytes(),
            signature,
            &auth_contexts,
        )
    }
}

/// The swap a set of authorization contexts describes.
struct SwapCall {
    pool: Address,
    in_idx: u32,
    out_idx: u32,
    amount_in: u128,
    min_out: u128,
    transfer_token: Address,
}

fn authorize_swap(
    env: &Env,
    payload: &BytesN<32>,
    proof: SwapProof,
    contexts: &Vec<Context>,
) -> Result<(), VaultError> {
    let instance = env.storage().instance();
    if instance.get(&DataKey::Paused).unwrap_or(false) {
        return Err(VaultError::Paused);
    }
    let policy = read_policy(env);
    let config = read_config(env);
    let now = env.ledger().timestamp();
    let ledger = env.ledger().sequence();
    if now >= policy.expires_at {
        return Err(VaultError::DelegationExpired);
    }

    // Freshness of the authorization itself.
    if proof.expires_at_ledger < ledger {
        return Err(VaultError::IntentExpired);
    }
    if proof.expires_at_ledger - ledger > MAX_INTENT_LEDGERS {
        return Err(VaultError::IntentLifetimeTooLong);
    }

    // Signed by the registered enclave key. ed25519_verify traps on failure.
    let enclave_key = EnclaveRegistryClient::new(env, &config.enclave_registry)
        .signing_key()
        .ok_or(VaultError::NoEnclaveKey)?;
    let message = swap_message(env, payload, &proof.signal, proof.expires_at_ledger);
    env.crypto()
        .ed25519_verify(&enclave_key, &message, &proof.signature);

    // A recent signal from the followed leader, not traded on before.
    let record = SignalRegistryClient::new(env, &config.signal_registry)
        .get(&proof.signal)
        .ok_or(VaultError::UnknownSignal)?;
    if record.leader != policy.leader {
        return Err(VaultError::WrongLeader);
    }
    if now.saturating_sub(record.timestamp) > policy.max_signal_age_secs {
        return Err(VaultError::SignalTooOld);
    }
    let used_key = DataKey::Used(proof.signal.clone());
    if env.storage().temporary().has(&used_key) {
        return Err(VaultError::SignalAlreadyUsed);
    }

    // Exactly one swap through an allowlisted pool, pulling only its input.
    let swap = parse_swap(env, contexts)?;
    let venue = find_venue(&policy.venues, &swap.pool).ok_or(VaultError::VenueNotAllowed)?;
    let n = venue.tokens.len();
    if swap.in_idx >= n || swap.out_idx >= n || swap.in_idx == swap.out_idx {
        return Err(VaultError::InvalidContext);
    }
    let token_in = venue.tokens.get_unchecked(swap.in_idx);
    let token_out = venue.tokens.get_unchecked(swap.out_idx);
    if swap.transfer_token != token_in {
        return Err(VaultError::InvalidContext);
    }
    let asset_in = find_asset(&policy.assets, &token_in).ok_or(VaultError::AssetNotAllowed)?;
    let asset_out = find_asset(&policy.assets, &token_out).ok_or(VaultError::AssetNotAllowed)?;

    // Size against the vault's own balance of the input asset.
    let balance = token::Client::new(env, &token_in).balance(&env.current_contract_address());
    let balance = if balance > 0 { balance as u128 } else { 0 };
    let max_by_share = mul_div(env, balance, policy.max_trade_bps as u128, BPS as u128)?;
    if swap.amount_in > max_by_share {
        return Err(VaultError::TradeTooLarge);
    }

    // Value the trade and bound min_amount_out with the oracle.
    let oracle = PriceOracleClient::new(env, &config.oracle);
    let oracle_decimals = oracle.decimals();
    let price_in = fresh_price(&oracle, &asset_in.symbol, now, policy.max_oracle_age_secs)?;
    let price_out = fresh_price(&oracle, &asset_out.symbol, now, policy.max_oracle_age_secs)?;
    let usd_value = usd_value(
        env,
        swap.amount_in,
        price_in,
        asset_in.decimals,
        oracle_decimals,
    )?;
    if usd_value > policy.max_trade_usd as u128 {
        return Err(VaultError::TradeTooLarge);
    }
    let fair_out = fair_output(
        env,
        swap.amount_in,
        price_in,
        price_out,
        asset_in.decimals,
        asset_out.decimals,
    )?;
    let floor = mul_div(
        env,
        fair_out,
        (BPS - policy.max_slippage_bps) as u128,
        BPS as u128,
    )?;
    if swap.min_out < floor {
        return Err(VaultError::MinOutBelowOracleBound);
    }

    // Rolling 24-hour limits.
    let mut recent = prune(env, read_recent(env), now);
    if recent.len() >= policy.max_daily_trades {
        return Err(VaultError::DailyTradeLimit);
    }
    let usd_value = i128::try_from(usd_value).map_err(|_| VaultError::MathOverflow)?;
    let mut volume = usd_value;
    for mark in recent.iter() {
        volume = volume
            .checked_add(mark.usd)
            .ok_or(VaultError::MathOverflow)?;
    }
    if volume > policy.max_daily_usd {
        return Err(VaultError::DailyVolumeLimit);
    }
    recent.push_back(TradeMark {
        timestamp: now,
        usd: usd_value,
    });
    instance.set(&DataKey::Recent, &recent);

    // One trade per signal, and keep the vault alive.
    env.storage().temporary().set(&used_key, &true);
    env.storage()
        .temporary()
        .extend_ttl(&used_key, USED_SIGNAL_TTL, USED_SIGNAL_TTL);
    extend_instance(env);

    SwapAuthorized {
        signal: proof.signal,
        leader: record.leader,
        pool: swap.pool,
        token_in,
        token_out,
        amount_in: swap.amount_in as i128,
        min_amount_out: i128::try_from(swap.min_out).map_err(|_| VaultError::MathOverflow)?,
        usd_value,
    }
    .publish(env);
    Ok(())
}

/// Accept only `[pool.swap(vault, in_idx, out_idx, amount_in, min_out),
/// token_in.transfer(vault, pool, amount_in)]`, the tree an Aquarius pool swap
/// produces. Anything else (extra calls, other recipients, other amounts,
/// contract creation) is rejected.
fn parse_swap(env: &Env, contexts: &Vec<Context>) -> Result<SwapCall, VaultError> {
    if contexts.len() != 2 {
        return Err(VaultError::InvalidContext);
    }
    let swap = contract_context(contexts.get_unchecked(0))?;
    let transfer = contract_context(contexts.get_unchecked(1))?;
    let me = env.current_contract_address();

    if swap.fn_name != Symbol::new(env, "swap") || swap.args.len() != 5 {
        return Err(VaultError::InvalidContext);
    }
    let user: Address = arg(env, &swap.args, 0)?;
    let in_idx: u32 = arg(env, &swap.args, 1)?;
    let out_idx: u32 = arg(env, &swap.args, 2)?;
    let amount_in: u128 = arg(env, &swap.args, 3)?;
    let min_out: u128 = arg(env, &swap.args, 4)?;
    if user != me {
        return Err(VaultError::InvalidContext);
    }
    if amount_in == 0
        || amount_in > i128::MAX as u128
        || min_out == 0
        || min_out > i128::MAX as u128
    {
        return Err(VaultError::InvalidAmount);
    }

    if transfer.fn_name != Symbol::new(env, "transfer") || transfer.args.len() != 3 {
        return Err(VaultError::InvalidContext);
    }
    let from: Address = arg(env, &transfer.args, 0)?;
    let to: Address = arg(env, &transfer.args, 1)?;
    let amount: i128 = arg(env, &transfer.args, 2)?;
    if from != me || to != swap.contract || amount != amount_in as i128 {
        return Err(VaultError::InvalidContext);
    }

    Ok(SwapCall {
        pool: swap.contract,
        in_idx,
        out_idx,
        amount_in,
        min_out,
        transfer_token: transfer.contract,
    })
}

fn contract_context(context: Context) -> Result<ContractContext, VaultError> {
    match context {
        Context::Contract(c) => Ok(c),
        _ => Err(VaultError::InvalidContext),
    }
}

fn arg<T: TryFromVal<Env, Val>>(env: &Env, args: &Vec<Val>, index: u32) -> Result<T, VaultError> {
    let value = args.get(index).ok_or(VaultError::InvalidContext)?;
    T::try_from_val(env, &value).map_err(|_| VaultError::InvalidContext)
}

fn find_venue(venues: &Vec<Venue>, pool: &Address) -> Option<Venue> {
    venues.iter().find(|v| v.pool == *pool)
}

fn find_asset(assets: &Vec<AssetConfig>, token: &Address) -> Option<AssetConfig> {
    assets.iter().find(|a| a.token == *token)
}

fn fresh_price(
    oracle: &PriceOracleClient,
    symbol: &Symbol,
    now: u64,
    max_age: u64,
) -> Result<u128, VaultError> {
    let data = oracle
        .lastprice(&OracleAsset::Other(symbol.clone()))
        .ok_or(VaultError::OraclePriceUnavailable)?;
    if data.price <= 0 {
        return Err(VaultError::OraclePriceUnavailable);
    }
    if now.saturating_sub(data.timestamp) > max_age {
        return Err(VaultError::OraclePriceStale);
    }
    Ok(data.price as u128)
}

/// `amount * price * 10^USD_DECIMALS / 10^(token_decimals + oracle_decimals)`.
fn usd_value(
    env: &Env,
    amount: u128,
    price: u128,
    token_decimals: u32,
    oracle_decimals: u32,
) -> Result<u128, VaultError> {
    let numerator = U256::from_u128(env, amount)
        .mul(&U256::from_u128(env, price))
        .mul(&pow10(env, USD_DECIMALS));
    let denominator = pow10(env, token_decimals + oracle_decimals);
    numerator
        .div(&denominator)
        .to_u128()
        .ok_or(VaultError::MathOverflow)
}

/// Output the oracle considers fair:
/// `amount_in * price_in * 10^out_decimals / (price_out * 10^in_decimals)`.
fn fair_output(
    env: &Env,
    amount_in: u128,
    price_in: u128,
    price_out: u128,
    in_decimals: u32,
    out_decimals: u32,
) -> Result<u128, VaultError> {
    let numerator = U256::from_u128(env, amount_in)
        .mul(&U256::from_u128(env, price_in))
        .mul(&pow10(env, out_decimals));
    let denominator = U256::from_u128(env, price_out).mul(&pow10(env, in_decimals));
    numerator
        .div(&denominator)
        .to_u128()
        .ok_or(VaultError::MathOverflow)
}

fn mul_div(env: &Env, a: u128, b: u128, c: u128) -> Result<u128, VaultError> {
    U256::from_u128(env, a)
        .mul(&U256::from_u128(env, b))
        .div(&U256::from_u128(env, c))
        .to_u128()
        .ok_or(VaultError::MathOverflow)
}

fn pow10(env: &Env, exponent: u32) -> U256 {
    U256::from_u32(env, 10).pow(exponent)
}

fn prune(env: &Env, recent: Vec<TradeMark>, now: u64) -> Vec<TradeMark> {
    let mut kept = Vec::new(env);
    for mark in recent.iter() {
        if mark.timestamp.saturating_add(WINDOW_SECS) > now {
            kept.push_back(mark);
        }
    }
    kept
}

fn validate_policy(env: &Env, policy: &Policy) {
    if !policy_is_valid(env, policy) {
        panic_with_error!(env, VaultError::InvalidPolicy);
    }
}

fn policy_is_valid(env: &Env, p: &Policy) -> bool {
    let n_assets = p.assets.len();
    if !(2..=MAX_ASSETS).contains(&n_assets) {
        return false;
    }
    for (i, a) in p.assets.iter().enumerate() {
        if a.decimals > MAX_TOKEN_DECIMALS {
            return false;
        }
        if p.assets.iter().skip(i + 1).any(|b| b.token == a.token) {
            return false;
        }
    }

    let n_venues = p.venues.len();
    if !(1..=MAX_VENUES).contains(&n_venues) {
        return false;
    }
    for (i, v) in p.venues.iter().enumerate() {
        if p.venues.iter().skip(i + 1).any(|w| w.pool == v.pool) {
            return false;
        }
        if !(2..=MAX_POOL_TOKENS).contains(&v.tokens.len()) {
            return false;
        }
        for (j, t) in v.tokens.iter().enumerate() {
            if v.tokens.iter().skip(j + 1).any(|u| u == t) {
                return false;
            }
        }
    }

    (1..=BPS).contains(&p.max_trade_bps)
        && p.max_trade_usd > 0
        && p.max_daily_usd >= p.max_trade_usd
        && (1..=MAX_DAILY_TRADES).contains(&p.max_daily_trades)
        && (1..=MAX_SLIPPAGE_BPS).contains(&p.max_slippage_bps)
        && (MIN_SIGNAL_AGE_SECS..=MAX_SIGNAL_AGE_SECS).contains(&p.max_signal_age_secs)
        && (MIN_ORACLE_AGE_SECS..=MAX_ORACLE_AGE_SECS).contains(&p.max_oracle_age_secs)
        && p.expires_at > env.ledger().timestamp()
}

fn set_paused(env: &Env, paused: bool) {
    read_owner(env).require_auth();
    env.storage().instance().set(&DataKey::Paused, &paused);
    extend_instance(env);
    PauseChanged { paused }.publish(env);
}

fn read_owner(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Owner)
        .expect("owner is set in the constructor")
}

fn read_config(env: &Env) -> VaultConfig {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .expect("config is set in the constructor")
}

fn read_policy(env: &Env) -> Policy {
    env.storage()
        .instance()
        .get(&DataKey::Policy)
        .expect("policy is set in the constructor")
}

fn read_recent(env: &Env) -> Vec<TradeMark> {
    env.storage()
        .instance()
        .get(&DataKey::Recent)
        .unwrap_or_else(|| Vec::new(env))
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

#[cfg(test)]
mod test;

#![no_std]
//! Test-only contracts used by the vault and factory tests.
//!
//! `MockPool` reproduces the authorization behavior of an Aquarius
//! constant-product pool exactly: `swap` calls `user.require_auth()` and then
//! pulls `token_in.transfer(user, pool, in_amount)` before paying out. That tree
//! was checked against a live Aquarius Testnet pool. The non-honest modes model
//! a malicious or upgraded pool, so tests can prove the vault refuses them.

use sigmax_types::{OracleAsset, PriceData};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
    Map, Vec,
};

/// How `MockPool::swap` behaves.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PoolMode {
    /// Behave like an Aquarius constant-product pool.
    Honest,
    /// Pull the input twice (needs a second authorization the vault never gives).
    PullTwice,
    /// Send the pulled input on to another address.
    Divert(Address),
    /// Take the input and pay nothing, ignoring `out_min`.
    PayNothing,
}

#[contracttype]
#[derive(Clone)]
enum PoolKey {
    Tokens,
    FeeBps,
    Mode,
}

/// Errors from `MockPool`.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PoolError {
    BadIndex = 1,
    OutMinNotSatisfied = 2,
    EmptyReserves = 3,
}

/// Aquarius-compatible constant-product pool for tests.
#[contract]
pub struct MockPool;

#[contractimpl]
impl MockPool {
    /// Create a pool over `tokens` (index order) charging `fee_bps` on input.
    pub fn __constructor(env: Env, tokens: Vec<Address>, fee_bps: u32) {
        env.storage().instance().set(&PoolKey::Tokens, &tokens);
        env.storage().instance().set(&PoolKey::FeeBps, &fee_bps);
        env.storage()
            .instance()
            .set(&PoolKey::Mode, &PoolMode::Honest);
    }

    /// Switch the swap behavior (test control, no auth).
    pub fn set_mode(env: Env, mode: PoolMode) {
        env.storage().instance().set(&PoolKey::Mode, &mode);
    }

    /// The pool's tokens in index order.
    pub fn get_tokens(env: Env) -> Vec<Address> {
        tokens(&env)
    }

    /// The pool's reserves (its token balances) in index order.
    pub fn get_reserves(env: Env) -> Vec<u128> {
        let me = env.current_contract_address();
        let mut out = Vec::new(&env);
        for t in tokens(&env).iter() {
            out.push_back(token::Client::new(&env, &t).balance(&me) as u128);
        }
        out
    }

    /// Output of swapping `in_amount` of token `in_idx` for token `out_idx`.
    pub fn estimate_swap(env: Env, in_idx: u32, out_idx: u32, in_amount: u128) -> u128 {
        quote(&env, in_idx, out_idx, in_amount)
    }

    /// Swap with Aquarius' authorization pattern (see the module docs).
    pub fn swap(
        env: Env,
        user: Address,
        in_idx: u32,
        out_idx: u32,
        in_amount: u128,
        out_min: u128,
    ) -> u128 {
        user.require_auth();
        let out = quote(&env, in_idx, out_idx, in_amount);
        let me = env.current_contract_address();
        let ts = tokens(&env);
        let token_in = token::Client::new(&env, &ts.get_unchecked(in_idx));
        let token_out = token::Client::new(&env, &ts.get_unchecked(out_idx));
        let amount = in_amount as i128;

        token_in.transfer(&user, &me, &amount);
        let mode: PoolMode = env.storage().instance().get(&PoolKey::Mode).unwrap();
        match mode {
            PoolMode::Honest => {}
            PoolMode::PullTwice => token_in.transfer(&user, &me, &amount),
            PoolMode::Divert(to) => token_in.transfer(&me, &to, &amount),
            PoolMode::PayNothing => return 0,
        }
        if out < out_min {
            panic_with_error!(&env, PoolError::OutMinNotSatisfied);
        }
        token_out.transfer(&me, &user, &(out as i128));
        out
    }
}

fn tokens(env: &Env) -> Vec<Address> {
    env.storage().instance().get(&PoolKey::Tokens).unwrap()
}

fn quote(env: &Env, in_idx: u32, out_idx: u32, in_amount: u128) -> u128 {
    let ts = tokens(env);
    if in_idx >= ts.len() || out_idx >= ts.len() || in_idx == out_idx {
        panic_with_error!(env, PoolError::BadIndex);
    }
    let me = env.current_contract_address();
    let r_in = token::Client::new(env, &ts.get_unchecked(in_idx)).balance(&me) as u128;
    let r_out = token::Client::new(env, &ts.get_unchecked(out_idx)).balance(&me) as u128;
    if r_in == 0 || r_out == 0 {
        panic_with_error!(env, PoolError::EmptyReserves);
    }
    let fee_bps: u32 = env.storage().instance().get(&PoolKey::FeeBps).unwrap();
    let in_after_fee = in_amount * (10_000 - fee_bps as u128) / 10_000;
    in_after_fee * r_out / (r_in + in_after_fee)
}

#[contracttype]
#[derive(Clone)]
enum OracleKey {
    Decimals,
    Prices,
}

/// SEP-40 price oracle for tests, with prices set by the test.
#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    /// Create an oracle quoting prices with `decimals` decimal places.
    pub fn __constructor(env: Env, decimals: u32) {
        env.storage()
            .instance()
            .set(&OracleKey::Decimals, &decimals);
        env.storage().instance().set(
            &OracleKey::Prices,
            &Map::<OracleAsset, PriceData>::new(&env),
        );
    }

    /// Set (or overwrite) the price of `asset` (test control, no auth).
    pub fn set_price(env: Env, asset: OracleAsset, price: i128, timestamp: u64) {
        let mut prices: Map<OracleAsset, PriceData> =
            env.storage().instance().get(&OracleKey::Prices).unwrap();
        prices.set(asset, PriceData { price, timestamp });
        env.storage().instance().set(&OracleKey::Prices, &prices);
    }

    /// Remove the price of `asset` (test control, no auth).
    pub fn clear_price(env: Env, asset: OracleAsset) {
        let mut prices: Map<OracleAsset, PriceData> =
            env.storage().instance().get(&OracleKey::Prices).unwrap();
        prices.remove(asset);
        env.storage().instance().set(&OracleKey::Prices, &prices);
    }

    /// SEP-40: decimal places of every price.
    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&OracleKey::Decimals).unwrap()
    }

    /// SEP-40: most recent price of `asset`.
    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        let prices: Map<OracleAsset, PriceData> =
            env.storage().instance().get(&OracleKey::Prices).unwrap();
        prices.get(asset)
    }
}

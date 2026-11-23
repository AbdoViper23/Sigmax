#![no_std]
//! Signal Registry.
//!
//! A leader commits `hash(sealed signal, salt)` here before the enclave executes
//! any follower trade for it. A vault only accepts a swap authorization that
//! names a commitment from the leader it follows, so every copied trade ties to
//! a signal published before execution.
//!
//! Entry and close signals are both committed here, as opaque hashes. The kind
//! of signal and every trade parameter stay inside the sealed signal, so the
//! chain does not reveal whether a leader is opening or closing a position.

use sigmax_types::SignalRecord;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, ContractExecutable, Env,
};

const DAY_LEDGERS: u32 = 17_280;
const INSTANCE_TTL_THRESHOLD: u32 = 7 * DAY_LEDGERS;
const INSTANCE_TTL_EXTEND_TO: u32 = 30 * DAY_LEDGERS;
const RECORD_TTL_THRESHOLD: u32 = 30 * DAY_LEDGERS;
const RECORD_TTL_EXTEND_TO: u32 = 120 * DAY_LEDGERS;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Signal(BytesN<32>),
    LeaderCount(Address),
}

/// Errors returned by the Signal Registry.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    /// This commitment was already registered.
    AlreadyCommitted = 1,
    /// The all-zero hash is not a valid commitment.
    ZeroCommitment = 2,
}

/// Published when a leader commits a signal.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalCommitted {
    #[topic]
    pub leader: Address,
    pub commitment: BytesN<32>,
    pub seq: u32,
}

/// Published when the admin changes.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    pub admin: Address,
}

#[contract]
pub struct SignalRegistry;

#[contractimpl]
impl SignalRegistry {
    /// Create the registry. `admin` may upgrade it and hand over the admin role.
    /// In Tranche 1 the admin is a single Testnet key; Tranche 2 moves it to the
    /// 2-of-3 multisig described in the architecture doc.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        extend_instance(&env);
    }

    /// Commit a signal. Only `leader` can commit under their own address.
    ///
    /// Returns the leader's sequence number for this signal (1 for the first).
    /// Panics with `AlreadyCommitted` if the commitment exists, and with
    /// `ZeroCommitment` for the all-zero hash.
    pub fn commit(env: Env, leader: Address, commitment: BytesN<32>) -> u32 {
        leader.require_auth();
        if commitment.to_array() == [0u8; 32] {
            panic_with_error!(&env, RegistryError::ZeroCommitment);
        }
        let key = DataKey::Signal(commitment.clone());
        let storage = env.storage().persistent();
        if storage.has(&key) {
            panic_with_error!(&env, RegistryError::AlreadyCommitted);
        }

        let count_key = DataKey::LeaderCount(leader.clone());
        let seq = storage.get::<_, u32>(&count_key).unwrap_or(0) + 1;
        let record = SignalRecord {
            leader: leader.clone(),
            seq,
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        storage.set(&key, &record);
        storage.extend_ttl(&key, RECORD_TTL_THRESHOLD, RECORD_TTL_EXTEND_TO);
        storage.set(&count_key, &seq);
        storage.extend_ttl(&count_key, RECORD_TTL_THRESHOLD, RECORD_TTL_EXTEND_TO);
        extend_instance(&env);

        SignalCommitted {
            leader,
            commitment,
            seq,
        }
        .publish(&env);
        seq
    }

    /// Return the record of a committed signal, or `None` if it was never
    /// committed (or its entry is archived and not yet restored).
    pub fn get(env: Env, commitment: BytesN<32>) -> Option<SignalRecord> {
        env.storage().persistent().get(&DataKey::Signal(commitment))
    }

    /// Number of signals `leader` has committed.
    pub fn leader_count(env: Env, leader: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LeaderCount(leader))
            .unwrap_or(0)
    }

    /// Extend the TTL of a commitment so it stays checkable. Anyone may call it;
    /// the relayer's keep-alive job does. Does nothing for unknown commitments.
    pub fn extend(env: Env, commitment: BytesN<32>) {
        let key = DataKey::Signal(commitment);
        if env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, RECORD_TTL_THRESHOLD, RECORD_TTL_EXTEND_TO);
        }
        extend_instance(&env);
    }

    /// The current admin.
    pub fn admin(env: Env) -> Address {
        read_admin(&env)
    }

    /// Hand the admin role to `new_admin`. Admin only.
    pub fn set_admin(env: Env, new_admin: Address) {
        read_admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        extend_instance(&env);
        AdminChanged { admin: new_admin }.publish(&env);
    }

    /// Replace the registry code, keeping its address and storage. Admin only.
    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) {
        read_admin(&env).require_auth();
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(wasm_hash));
    }
}

fn read_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("admin is set in the constructor")
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

#[cfg(test)]
mod test;

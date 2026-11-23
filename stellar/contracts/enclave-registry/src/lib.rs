#![no_std]
//! Enclave Registry.
//!
//! Holds the enclave's two public keys: the ed25519 key that signs swap
//! authorizations, and the secp256k1 key leaders seal signals to. Every vault
//! reads `signing_key` inside `__check_auth`, so revoking the key here stops
//! enclave trading for every vault at once.
//!
//! Tranche 1 scope (Testnet, software-mode enclave): a single admin key sets and
//! revokes the keys immediately. Tranche 2 keeps this read interface and adds the
//! 2-of-3 multisig, the 48-hour timelock on any change that widens trust, and the
//! attested image digest (see `docs/stellar/ARCHITECTURE.md`, Governance).
//! Vaults never need to change for that, because they only call `signing_key`.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, ContractExecutable, Env,
};

const DAY_LEDGERS: u32 = 17_280;
const INSTANCE_TTL_THRESHOLD: u32 = 7 * DAY_LEDGERS;
const INSTANCE_TTL_EXTEND_TO: u32 = 30 * DAY_LEDGERS;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    SigningKey,
    EncryptionKey,
}

/// Errors returned by the Enclave Registry.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EnclaveRegistryError {
    /// The encryption key is not an uncompressed secp256k1 point (`0x04 ‖ X ‖ Y`).
    InvalidEncryptionKey = 1,
}

/// Published when the admin registers new enclave keys.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeysSet {
    pub signing_key: BytesN<32>,
    pub encryption_key: BytesN<65>,
}

/// Published when the admin revokes the enclave keys.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeysRevoked {
    pub signing_key: BytesN<32>,
}

/// Published when the admin changes.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    pub admin: Address,
}

#[contract]
pub struct EnclaveRegistry;

#[contractimpl]
impl EnclaveRegistry {
    /// Create the registry with no keys. `admin` registers and revokes keys.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        extend_instance(&env);
    }

    /// Register the enclave's signing key (ed25519) and encryption key
    /// (uncompressed secp256k1). Admin only. Takes effect immediately in
    /// Tranche 1; Tranche 2 puts this behind the 48-hour timelock.
    pub fn set_keys(env: Env, signing_key: BytesN<32>, encryption_key: BytesN<65>) {
        read_admin(&env).require_auth();
        if encryption_key.get(0) != Some(0x04) {
            panic_with_error!(&env, EnclaveRegistryError::InvalidEncryptionKey);
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::SigningKey, &signing_key);
        storage.set(&DataKey::EncryptionKey, &encryption_key);
        extend_instance(&env);
        KeysSet {
            signing_key,
            encryption_key,
        }
        .publish(&env);
    }

    /// Revoke both enclave keys. Admin only. Vaults reject enclave
    /// authorizations from this ledger on, and leaders can no longer seal to the
    /// enclave. Revocation only removes trust, so it is never timelocked.
    pub fn revoke(env: Env) {
        read_admin(&env).require_auth();
        let storage = env.storage().instance();
        if let Some(signing_key) = storage.get::<_, BytesN<32>>(&DataKey::SigningKey) {
            storage.remove(&DataKey::SigningKey);
            storage.remove(&DataKey::EncryptionKey);
            KeysRevoked { signing_key }.publish(&env);
        }
        extend_instance(&env);
    }

    /// The ed25519 key vaults accept swap authorizations from, or `None`.
    pub fn signing_key(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::SigningKey)
    }

    /// The secp256k1 key (65-byte uncompressed) leaders seal signals to, or `None`.
    pub fn encryption_key(env: Env) -> Option<BytesN<65>> {
        env.storage().instance().get(&DataKey::EncryptionKey)
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

    /// Extend the registry's instance TTL. Anyone may call it.
    pub fn extend_ttl(env: Env) {
        extend_instance(&env);
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

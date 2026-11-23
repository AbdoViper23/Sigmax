#![no_std]
//! Vault factory.
//!
//! Deploys one vault per call and keeps an index of every vault it deployed, so
//! the enclave and the indexer can enumerate vaults from contract state instead
//! of scanning events (Stellar RPC keeps only about 7 days of events).
//!
//! Vaults are deployed from a fixed Wasm hash (`ContractExecutable::Wasm`), and
//! the vault has no upgrade function, so neither the factory nor its admin can
//! ever change the code of a deployed vault. The admin can only choose which
//! code and which registries *new* vaults use.

use sigmax_types::{Policy, VaultConfig};
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    ContractExecutable, Env, Vec,
};

const DAY_LEDGERS: u32 = 17_280;
const INSTANCE_TTL_THRESHOLD: u32 = 7 * DAY_LEDGERS;
const INSTANCE_TTL_EXTEND_TO: u32 = 30 * DAY_LEDGERS;
const INDEX_TTL_THRESHOLD: u32 = 30 * DAY_LEDGERS;
const INDEX_TTL_EXTEND_TO: u32 = 120 * DAY_LEDGERS;
/// Largest page `vaults` returns.
const MAX_PAGE: u32 = 50;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    VaultWasm,
    Config,
    Count,
    Vault(u32),
}

/// Published when a vault is deployed.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultCreated {
    #[topic]
    pub owner: Address,
    #[topic]
    pub leader: Address,
    pub vault: Address,
    pub index: u32,
}

/// Published when the admin changes what new vaults are deployed with.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefaultsChanged {
    pub vault_wasm: BytesN<32>,
    pub config: VaultConfig,
}

/// Published when the admin changes.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    pub admin: Address,
}

#[contract]
pub struct VaultFactory;

#[contractimpl]
impl VaultFactory {
    /// Create the factory. New vaults use `vault_wasm` (an uploaded Wasm hash)
    /// and are bound to the registries and oracle in `config`.
    pub fn __constructor(env: Env, admin: Address, vault_wasm: BytesN<32>, config: VaultConfig) {
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::VaultWasm, &vault_wasm);
        storage.set(&DataKey::Config, &config);
        storage.set(&DataKey::Count, &0u32);
        extend_instance(&env);
    }

    /// Deploy a vault owned by `owner` with `policy`. Needs `owner`'s
    /// authorization. Returns the new vault's address.
    pub fn create_vault(env: Env, owner: Address, policy: Policy) -> Address {
        owner.require_auth();
        let storage = env.storage().instance();
        let index: u32 = storage.get(&DataKey::Count).unwrap_or(0);
        let wasm: BytesN<32> = storage
            .get(&DataKey::VaultWasm)
            .expect("set in constructor");
        let config: VaultConfig = storage.get(&DataKey::Config).expect("set in constructor");

        let salt = env
            .crypto()
            .sha256(&Bytes::from_array(&env, &index.to_be_bytes()))
            .to_bytes();
        let leader = policy.leader.clone();
        let vault = env.deployer().with_current_contract(salt).deploy_contract(
            ContractExecutable::Wasm(wasm),
            (owner.clone(), config, policy),
        );

        let key = DataKey::Vault(index);
        env.storage().persistent().set(&key, &vault);
        env.storage()
            .persistent()
            .extend_ttl(&key, INDEX_TTL_THRESHOLD, INDEX_TTL_EXTEND_TO);
        storage.set(&DataKey::Count, &(index + 1));
        extend_instance(&env);

        VaultCreated {
            owner,
            leader,
            vault: vault.clone(),
            index,
        }
        .publish(&env);
        vault
    }

    /// Number of vaults deployed by this factory.
    pub fn vault_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    /// The vault deployed at `index`, if any.
    pub fn vault_at(env: Env, index: u32) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Vault(index))
    }

    /// Up to `limit` (at most 50) vault addresses starting at index `start`.
    pub fn vaults(env: Env, start: u32, limit: u32) -> Vec<Address> {
        let count = Self::vault_count(env.clone());
        let end = start.saturating_add(limit.min(MAX_PAGE)).min(count);
        let mut out = Vec::new(&env);
        let mut i = start;
        while i < end {
            if let Some(v) = env.storage().persistent().get(&DataKey::Vault(i)) {
                out.push_back(v);
            }
            i += 1;
        }
        out
    }

    /// Extend the TTL of the index entries `start..start+limit` (at most 50).
    /// Anyone may call it; the relayer's keep-alive job does.
    pub fn extend_index(env: Env, start: u32, limit: u32) {
        let count = Self::vault_count(env.clone());
        let end = start.saturating_add(limit.min(MAX_PAGE)).min(count);
        let mut i = start;
        while i < end {
            let key = DataKey::Vault(i);
            if env.storage().persistent().has(&key) {
                env.storage().persistent().extend_ttl(
                    &key,
                    INDEX_TTL_THRESHOLD,
                    INDEX_TTL_EXTEND_TO,
                );
            }
            i += 1;
        }
        extend_instance(&env);
    }

    /// The Wasm hash new vaults are deployed from.
    pub fn vault_wasm(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::VaultWasm)
            .expect("set in constructor")
    }

    /// The registries and oracle new vaults are bound to.
    pub fn config(env: Env) -> VaultConfig {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .expect("set in constructor")
    }

    /// The current admin.
    pub fn admin(env: Env) -> Address {
        read_admin(&env)
    }

    /// Change the Wasm and config used for *new* vaults. Admin only. Existing
    /// vaults are not affected.
    pub fn set_defaults(env: Env, vault_wasm: BytesN<32>, config: VaultConfig) {
        read_admin(&env).require_auth();
        let storage = env.storage().instance();
        storage.set(&DataKey::VaultWasm, &vault_wasm);
        storage.set(&DataKey::Config, &config);
        extend_instance(&env);
        DefaultsChanged { vault_wasm, config }.publish(&env);
    }

    /// Hand the admin role to `new_admin`. Admin only.
    pub fn set_admin(env: Env, new_admin: Address) {
        read_admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        extend_instance(&env);
        AdminChanged { admin: new_admin }.publish(&env);
    }

    /// Replace the factory code, keeping its address, storage and index. Admin
    /// only. This never touches deployed vaults.
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

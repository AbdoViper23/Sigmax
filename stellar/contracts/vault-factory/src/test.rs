//! Factory tests. These deploy the real vault Wasm (build it first with
//! `stellar contract build`), so the full-flow test at the bottom also runs
//! `__check_auth` as Wasm under the default mainnet resource limits.

extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use sigmax_enclave_registry::{EnclaveRegistry, EnclaveRegistryClient};
use sigmax_signal_registry::{SignalRegistry, SignalRegistryClient};
use sigmax_test_mocks::{MockOracle, MockOracleClient, MockPool, MockPoolClient};
use sigmax_types::{swap_message, AssetConfig, OracleAsset, SwapProof, Venue};
use soroban_sdk::{
    events::Event,
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{self, WriteXdr},
    Address, BytesN, Env, IntoVal, Symbol, TryFromVal, Val,
};

const VAULT_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/sigmax_vault.wasm");
const T0: u64 = 1_800_000_000;
const ONE: i128 = 10_000_000;

struct Fx {
    env: Env,
    admin: Address,
    factory: Address,
    config: VaultConfig,
    usdc: Address,
    xlm: Address,
    pool: Address,
    leader: Address,
    key: SigningKey,
}

fn setup() -> Fx {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.timestamp = T0;
        l.sequence_number = 1_000;
        l.min_persistent_entry_ttl = 1_000_000;
        l.min_temp_entry_ttl = 1_000;
        l.max_entry_ttl = 3_110_400;
    });
    env.mock_all_auths();

    let issuer = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let xlm = env.register_stellar_asset_contract_v2(issuer).address();
    let pool = env.register(MockPool, (vec![&env, usdc.clone(), xlm.clone()], 30u32));
    StellarAssetClient::new(&env, &usdc).mint(&pool, &(1_000_000 * ONE));
    StellarAssetClient::new(&env, &xlm).mint(&pool, &(7_142_857 * ONE));

    let oracle = env.register(MockOracle, (14u32,));
    let oracle_client = MockOracleClient::new(&env, &oracle);
    oracle_client.set_price(
        &OracleAsset::Other(Symbol::new(&env, "USDC")),
        &100_000_000_000_000,
        &T0,
    );
    oracle_client.set_price(
        &OracleAsset::Other(Symbol::new(&env, "XLM")),
        &14_000_000_000_000,
        &T0,
    );

    let admin = Address::generate(&env);
    let signals = env.register(SignalRegistry, (admin.clone(),));
    let registry = env.register(EnclaveRegistry, (admin.clone(),));
    let key = SigningKey::from_bytes(&[42u8; 32]);
    let mut enc = [5u8; 65];
    enc[0] = 0x04;
    EnclaveRegistryClient::new(&env, &registry).set_keys(
        &BytesN::from_array(&env, &key.verifying_key().to_bytes()),
        &BytesN::from_array(&env, &enc),
    );

    let config = VaultConfig {
        enclave_registry: registry,
        signal_registry: signals,
        oracle,
    };
    let wasm_hash = env.deployer().upload_contract_wasm(VAULT_WASM);
    let factory = env.register(VaultFactory, (admin.clone(), wasm_hash, config.clone()));
    env.set_auths(&[]);

    Fx {
        leader: Address::generate(&env),
        env,
        admin,
        factory,
        config,
        usdc,
        xlm,
        pool,
        key,
    }
}

impl Fx {
    fn factory(&self) -> VaultFactoryClient<'_> {
        VaultFactoryClient::new(&self.env, &self.factory)
    }

    fn policy(&self) -> Policy {
        let env = &self.env;
        Policy {
            leader: self.leader.clone(),
            assets: vec![
                env,
                AssetConfig {
                    token: self.usdc.clone(),
                    symbol: Symbol::new(env, "USDC"),
                    decimals: 7,
                },
                AssetConfig {
                    token: self.xlm.clone(),
                    symbol: Symbol::new(env, "XLM"),
                    decimals: 7,
                },
            ],
            venues: vec![
                env,
                Venue {
                    pool: self.pool.clone(),
                    tokens: vec![env, self.usdc.clone(), self.xlm.clone()],
                },
            ],
            max_trade_bps: 5_000,
            max_trade_usd: 1_000 * ONE,
            max_daily_usd: 3_000 * ONE,
            max_daily_trades: 5,
            max_slippage_bps: 100,
            max_signal_age_secs: 3_600,
            max_oracle_age_secs: 900,
            expires_at: T0 + 30 * 86_400,
        }
    }

    fn create(&self, owner: &Address) -> Address {
        self.env.mock_all_auths();
        let vault = self.factory().create_vault(owner, &self.policy());
        self.env.set_auths(&[]);
        vault
    }

    fn call<T: TryFromVal<Env, Val>>(&self, contract: &Address, name: &str) -> T {
        self.env
            .invoke_contract(contract, &Symbol::new(&self.env, name), vec![&self.env])
    }
}

fn sc<T: IntoVal<Env, Val>>(env: &Env, value: T) -> xdr::ScVal {
    xdr::ScVal::try_from_val(env, &value.into_val(env)).unwrap()
}

#[test]
fn create_vault_deploys_an_owned_vault_and_indexes_it() {
    let fx = setup();
    let owner = Address::generate(&fx.env);

    fx.env.mock_all_auths();
    let vault = fx.factory().create_vault(&owner, &fx.policy());
    assert_eq!(fx.env.auths()[0].0, owner);
    assert_eq!(
        fx.env.events().all().filter_by_contract(&fx.factory),
        [VaultCreated {
            owner: owner.clone(),
            leader: fx.leader.clone(),
            vault: vault.clone(),
            index: 0,
        }
        .to_xdr(&fx.env, &fx.factory)]
    );
    fx.env.set_auths(&[]);

    assert_eq!(fx.call::<Address>(&vault, "owner"), owner);
    assert_eq!(fx.call::<VaultConfig>(&vault, "config"), fx.config);
    assert_eq!(fx.call::<Policy>(&vault, "policy"), fx.policy());
    assert_eq!(fx.factory().vault_count(), 1);
    assert_eq!(fx.factory().vault_at(&0), Some(vault.clone()));
    assert_eq!(fx.factory().vault_at(&1), None);
}

#[test]
fn create_vault_needs_the_owner() {
    let fx = setup();
    let owner = Address::generate(&fx.env);
    assert!(fx.factory().try_create_vault(&owner, &fx.policy()).is_err());
    assert_eq!(fx.factory().vault_count(), 0);
}

#[test]
fn create_vault_rejects_an_invalid_policy() {
    let fx = setup();
    let owner = Address::generate(&fx.env);
    let mut policy = fx.policy();
    policy.max_slippage_bps = 5_000;
    fx.env.mock_all_auths();
    assert!(fx.factory().try_create_vault(&owner, &policy).is_err());
    fx.env.set_auths(&[]);
    assert_eq!(fx.factory().vault_count(), 0);
}

#[test]
fn vaults_are_distinct_and_paginated() {
    let fx = setup();
    let mut created = std::vec::Vec::new();
    for _ in 0..3 {
        created.push(fx.create(&Address::generate(&fx.env)));
    }
    assert_ne!(created[0], created[1]);
    assert_eq!(
        fx.factory().vaults(&0, &10),
        vec![
            &fx.env,
            created[0].clone(),
            created[1].clone(),
            created[2].clone()
        ]
    );
    assert_eq!(
        fx.factory().vaults(&1, &1),
        vec![&fx.env, created[1].clone()]
    );
    assert_eq!(fx.factory().vaults(&5, &10).len(), 0);
    fx.factory().extend_index(&0, &10);
}

#[test]
fn set_defaults_is_admin_only_and_only_affects_new_vaults() {
    let fx = setup();
    let old_vault = fx.create(&Address::generate(&fx.env));
    let mut new_config = fx.config.clone();
    new_config.oracle = Address::generate(&fx.env);
    let wasm = fx.factory().vault_wasm();

    assert!(fx.factory().try_set_defaults(&wasm, &new_config).is_err());

    fx.env.mock_all_auths();
    fx.factory().set_defaults(&wasm, &new_config);
    assert_eq!(fx.env.auths()[0].0, fx.admin);
    fx.env.set_auths(&[]);

    let new_vault = fx.create(&Address::generate(&fx.env));
    assert_eq!(fx.call::<VaultConfig>(&old_vault, "config"), fx.config);
    assert_eq!(fx.call::<VaultConfig>(&new_vault, "config"), new_config);
}

#[test]
fn admin_handover_and_upgrade_are_admin_only() {
    let fx = setup();
    let new_admin = Address::generate(&fx.env);
    assert!(fx.factory().try_set_admin(&new_admin).is_err());
    assert!(fx
        .factory()
        .try_upgrade(&BytesN::from_array(&fx.env, &[3; 32]))
        .is_err());
    fx.env.mock_all_auths();
    fx.factory().set_admin(&new_admin);
    fx.env.set_auths(&[]);
    assert_eq!(fx.factory().admin(), new_admin);
}

/// End to end on the real vault Wasm: the leader commits, the enclave key signs
/// the Soroban payload for `pool.swap(vault, ..)`, the host runs the vault's
/// `__check_auth` as Wasm, and the swap settles. Runs under the default mainnet
/// resource limits, so passing means the authorization fits a real transaction.
#[test]
fn wasm_vault_executes_an_enclave_swap_within_mainnet_limits() {
    let fx = setup();
    let env = &fx.env;
    let owner = Address::generate(env);
    let vault = fx.create(&owner);
    env.mock_all_auths();
    StellarAssetClient::new(env, &fx.usdc).mint(&vault, &(2_000 * ONE));
    let signal = BytesN::from_array(env, &[9; 32]);
    SignalRegistryClient::new(env, &fx.config.signal_registry).commit(&fx.leader, &signal);
    env.set_auths(&[]);

    let pool = MockPoolClient::new(env, &fx.pool);
    let amount_in: u128 = (500 * ONE) as u128;
    let min_out = pool.estimate_swap(&0, &1, &amount_in) * 995 / 1_000;

    let transfer = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: (&fx.usdc).into(),
            function_name: xdr::ScSymbol("transfer".try_into().unwrap()),
            args: std::vec![
                sc(env, vault.clone()),
                sc(env, fx.pool.clone()),
                sc(env, amount_in as i128)
            ]
            .try_into()
            .unwrap(),
        }),
        sub_invocations: xdr::VecM::default(),
    };
    let root = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: (&fx.pool).into(),
            function_name: xdr::ScSymbol("swap".try_into().unwrap()),
            args: std::vec![
                sc(env, vault.clone()),
                sc(env, 0u32),
                sc(env, 1u32),
                sc(env, amount_in),
                sc(env, min_out)
            ]
            .try_into()
            .unwrap(),
        }),
        sub_invocations: std::vec![transfer].try_into().unwrap(),
    };
    let nonce = 7;
    let expiration = env.ledger().sequence() + 50;
    let preimage =
        xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(env.ledger().network_id().to_array()),
            nonce,
            signature_expiration_ledger: expiration,
            invocation: root.clone(),
        });
    let payload = BytesN::from_array(
        env,
        &Sha256::digest(preimage.to_xdr(xdr::Limits::none()).unwrap()).into(),
    );
    let expires = env.ledger().sequence() + 60;
    let message = swap_message(env, &payload, &signal, expires);
    let mut buf = std::vec![0u8; message.len() as usize];
    message.copy_into_slice(&mut buf);
    let proof = SwapProof {
        signal: signal.clone(),
        expires_at_ledger: expires,
        signature: BytesN::from_array(env, &fx.key.sign(&buf).to_bytes()),
    };
    env.set_auths(&[xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: (&vault).into(),
            nonce,
            signature_expiration_ledger: expiration,
            signature: sc(env, proof),
        }),
        root_invocation: root,
    }]);

    let out = pool.swap(&vault, &0, &1, &amount_in, &min_out);

    let resources = env.cost_estimate().resources();
    std::println!(
        "wasm vault swap: {} instructions, {} mem bytes, {} reads, {} writes, fee estimate {:?}",
        resources.instructions,
        resources.mem_bytes,
        resources.disk_read_entries,
        resources.write_entries,
        env.cost_estimate().fee()
    );
    env.set_auths(&[]);
    assert!(out >= min_out);
    assert_eq!(TokenClient::new(env, &fx.usdc).balance(&vault), 1_500 * ONE);
    assert_eq!(TokenClient::new(env, &fx.xlm).balance(&vault), out as i128);
    let used: bool = env.invoke_contract(
        &vault,
        &Symbol::new(env, "is_signal_used"),
        vec![env, signal.into_val(env)],
    );
    assert!(used);
}

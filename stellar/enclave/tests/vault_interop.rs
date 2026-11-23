//! Interop: the enclave's own code against the real vault contract.
//!
//! A leader seals a signal to the enclave and commits its hash on-chain. The
//! enclave decrypts it, sizes the trade from the vault's real on-chain state and
//! signs. The test then submits exactly what a relayer would submit, and the
//! Soroban host runs the vault's `__check_auth` on it. If the enclave's XDR
//! payload, swap message or sizing drifted from the contract, this fails.

use std::collections::BTreeMap;

use k256::PublicKey;
use sha2::{Digest, Sha256};
use sigmax_enclave::{
    api::{
        AuthEnvelope, AuthorizeRequest, AuthorizeResponse, Enclave, LedgerSnap, SubmitSignalRequest,
    },
    ecies,
    keys::EnclaveKeys,
    sizing::{
        AssetSnap, OracleSnapshot, PolicySnap, PoolSnapshot, PricePoint, SignalRecordSnap,
        SizingConfig, TradeMark, VaultSnapshot, VenueSnap,
    },
};
use sigmax_enclave_registry::{EnclaveRegistry, EnclaveRegistryClient};
use sigmax_signal_registry::{SignalRegistry, SignalRegistryClient};
use sigmax_test_mocks::{MockOracle, MockOracleClient, MockPool, MockPoolClient};
use sigmax_types::{AssetConfig, OracleAsset, Policy, SwapProof, VaultConfig, Venue};
use sigmax_vault::{Vault, VaultClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    xdr::{self},
    Address, BytesN, Env, IntoVal, Symbol, TryFromVal, Val,
};

const TESTNET: &str = "Test SDF Network ; September 2015";
const ONE: i128 = 10_000_000;
const T0: u64 = 1_800_000_000;

fn strkey(env: &Env, a: &Address) -> String {
    let s = a.to_string();
    let mut buf = vec![0u8; s.len() as usize];
    s.copy_into_slice(&mut buf);
    let _ = env;
    String::from_utf8(buf).unwrap()
}

fn sc<T: IntoVal<Env, Val>>(env: &Env, v: T) -> xdr::ScVal {
    xdr::ScVal::try_from_val(env, &v.into_val(env)).unwrap()
}

#[test]
fn an_enclave_signed_trade_passes_the_vault() {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.timestamp = T0;
        l.sequence_number = 5_000;
        l.network_id = Sha256::digest(TESTNET.as_bytes()).into();
        l.min_persistent_entry_ttl = 1_000_000;
        l.min_temp_entry_ttl = 1_000;
        l.max_entry_ttl = 3_110_400;
    });
    env.mock_all_auths();

    // Chain: tokens, a 1% pool priced at the oracle, oracle, registries, vault.
    let issuer = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let xlm = env.register_stellar_asset_contract_v2(issuer).address();
    let pool = env.register(
        MockPool,
        (soroban_sdk::vec![&env, usdc.clone(), xlm.clone()], 100u32),
    );
    StellarAssetClient::new(&env, &usdc).mint(&pool, &(100_000 * ONE));
    StellarAssetClient::new(&env, &xlm).mint(&pool, &(714_285 * ONE));
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

    // The enclave, registered on-chain by its public keys.
    let enclave = Enclave::new(EnclaveKeys::generate(), TESTNET, SizingConfig::default());
    let keys = enclave.keys();
    let signing: [u8; 32] = hex::decode(&keys.signing_key).unwrap().try_into().unwrap();
    let encryption: [u8; 65] = hex::decode(&keys.encryption_key)
        .unwrap()
        .try_into()
        .unwrap();
    EnclaveRegistryClient::new(&env, &registry).set_keys(
        &BytesN::from_array(&env, &signing),
        &BytesN::from_array(&env, &encryption),
    );

    let leader_secret = [9u8; 32];
    let leader_g = stellar_strkey::ed25519::PublicKey(
        ed25519_dalek::SigningKey::from_bytes(&leader_secret)
            .verifying_key()
            .to_bytes(),
    )
    .to_string()
    .as_str()
    .to_owned();
    let leader = Address::from_str(&env, &leader_g);
    let owner = Address::generate(&env);
    let policy = Policy {
        leader: leader.clone(),
        assets: soroban_sdk::vec![
            &env,
            AssetConfig {
                token: usdc.clone(),
                symbol: Symbol::new(&env, "USDC"),
                decimals: 7
            },
            AssetConfig {
                token: xlm.clone(),
                symbol: Symbol::new(&env, "XLM"),
                decimals: 7
            },
        ],
        venues: soroban_sdk::vec![
            &env,
            Venue {
                pool: pool.clone(),
                tokens: soroban_sdk::vec![&env, usdc.clone(), xlm.clone()]
            }
        ],
        max_trade_bps: 5_000,
        max_trade_usd: 1_000 * ONE,
        max_daily_usd: 3_000 * ONE,
        max_daily_trades: 5,
        max_slippage_bps: 250,
        max_signal_age_secs: 3_600,
        max_oracle_age_secs: 900,
        expires_at: T0 + 86_400,
    };
    let config = VaultConfig {
        enclave_registry: registry,
        signal_registry: signals.clone(),
        oracle,
    };
    let vault = env.register(Vault, (owner.clone(), config, policy.clone()));
    StellarAssetClient::new(&env, &usdc).mint(&vault, &(2_000 * ONE));

    // Leader: seal the signal to the registered key and commit its hash.
    let plaintext = format!(
        r#"{{"v":1,"kind":"entry","leader":"{leader_g}","base":"XLM","quote":"USDC","size_bps":2500,"take_profit":"0.16","stop_loss":"0.12","salt":"{}","ts":{T0}}}"#,
        "5a".repeat(32)
    );
    let commitment: [u8; 32] = Sha256::digest(plaintext.as_bytes()).into();
    let ciphertext = ecies::encrypt(
        &PublicKey::from_sec1_bytes(&encryption).unwrap(),
        plaintext.as_bytes(),
        None,
    );
    let signal = BytesN::from_array(&env, &commitment);
    SignalRegistryClient::new(&env, &signals).commit(&leader, &signal);
    let record = SignalRegistryClient::new(&env, &signals)
        .get(&signal)
        .unwrap();
    env.set_auths(&[]);

    // Relayer: hand the enclave the ciphertext and the chain snapshots.
    let rec = SignalRecordSnap {
        leader: leader_g.clone(),
        seq: record.seq,
        ledger: record.ledger,
        timestamp: record.timestamp,
    };
    enclave
        .submit_signal(SubmitSignalRequest {
            commitment: hex::encode(commitment),
            ciphertext: hex::encode(&ciphertext),
            record: rec,
        })
        .unwrap();

    let on_chain = VaultClient::new(&env, &vault).policy();
    assert_eq!(on_chain, policy);
    let snapshot = VaultSnapshot {
        vault: strkey(&env, &vault),
        paused: VaultClient::new(&env, &vault).paused(),
        policy: PolicySnap {
            leader: strkey(&env, &on_chain.leader),
            assets: vec![
                AssetSnap {
                    token: strkey(&env, &usdc),
                    symbol: "USDC".into(),
                    decimals: 7,
                },
                AssetSnap {
                    token: strkey(&env, &xlm),
                    symbol: "XLM".into(),
                    decimals: 7,
                },
            ],
            venues: vec![VenueSnap {
                pool: strkey(&env, &pool),
                tokens: vec![strkey(&env, &usdc), strkey(&env, &xlm)],
            }],
            max_trade_bps: on_chain.max_trade_bps,
            max_trade_usd: on_chain.max_trade_usd,
            max_daily_usd: on_chain.max_daily_usd,
            max_daily_trades: on_chain.max_daily_trades,
            max_slippage_bps: on_chain.max_slippage_bps,
            max_signal_age_secs: on_chain.max_signal_age_secs,
            max_oracle_age_secs: on_chain.max_oracle_age_secs,
            expires_at: on_chain.expires_at,
        },
        balances: BTreeMap::from([
            (
                strkey(&env, &usdc),
                TokenClient::new(&env, &usdc).balance(&vault),
            ),
            (
                strkey(&env, &xlm),
                TokenClient::new(&env, &xlm).balance(&vault),
            ),
        ]),
        recent: Vec::<TradeMark>::new(),
        signal_used: VaultClient::new(&env, &vault).is_signal_used(&signal),
    };
    let reserves = MockPoolClient::new(&env, &pool).get_reserves();
    let nonce: i64 = 314_159;
    let expiration = env.ledger().sequence() + 50;
    let response = enclave
        .authorize(AuthorizeRequest {
            commitment: hex::encode(commitment),
            ledger: LedgerSnap {
                sequence: env.ledger().sequence(),
                timestamp: env.ledger().timestamp(),
            },
            vault: snapshot,
            pools: vec![PoolSnapshot {
                pool: strkey(&env, &pool),
                tokens: vec![strkey(&env, &usdc), strkey(&env, &xlm)],
                reserves: reserves.iter().collect(),
                fee_bps: 100,
            }],
            oracle: OracleSnapshot {
                decimals: 14,
                prices: BTreeMap::from([
                    (
                        "USDC".into(),
                        PricePoint {
                            price: 100_000_000_000_000,
                            timestamp: T0,
                        },
                    ),
                    (
                        "XLM".into(),
                        PricePoint {
                            price: 14_000_000_000_000,
                            timestamp: T0,
                        },
                    ),
                ]),
            },
            auth: AuthEnvelope {
                nonce,
                signature_expiration_ledger: expiration,
            },
        })
        .unwrap();
    let AuthorizeResponse::Signed { plan, proof, .. } = response else {
        panic!("enclave skipped: {response:?}");
    };
    assert_eq!(plan.amount_in, (500 * ONE) as u128);

    // Relayer: build the authorization entry from the plan and submit.
    let token_in = if plan.in_idx == 0 {
        usdc.clone()
    } else {
        xlm.clone()
    };
    let transfer = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: (&token_in).into(),
            function_name: xdr::ScSymbol("transfer".try_into().unwrap()),
            args: std::vec![
                sc(&env, vault.clone()),
                sc(&env, pool.clone()),
                sc(&env, plan.amount_in as i128)
            ]
            .try_into()
            .unwrap(),
        }),
        sub_invocations: xdr::VecM::default(),
    };
    let root = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: (&pool).into(),
            function_name: xdr::ScSymbol("swap".try_into().unwrap()),
            args: std::vec![
                sc(&env, vault.clone()),
                sc(&env, plan.in_idx),
                sc(&env, plan.out_idx),
                sc(&env, plan.amount_in),
                sc(&env, plan.min_out)
            ]
            .try_into()
            .unwrap(),
        }),
        sub_invocations: std::vec![transfer].try_into().unwrap(),
    };
    let swap_proof = SwapProof {
        signal: BytesN::from_array(
            &env,
            &hex::decode(&proof.signal).unwrap().try_into().unwrap(),
        ),
        expires_at_ledger: proof.expires_at_ledger,
        signature: BytesN::from_array(
            &env,
            &hex::decode(&proof.signature).unwrap().try_into().unwrap(),
        ),
    };
    env.set_auths(&[xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: (&vault).into(),
            nonce,
            signature_expiration_ledger: expiration,
            signature: sc(&env, swap_proof),
        }),
        root_invocation: root,
    }]);
    let out = MockPoolClient::new(&env, &pool).swap(
        &vault,
        &plan.in_idx,
        &plan.out_idx,
        &plan.amount_in,
        &plan.min_out,
    );
    env.set_auths(&[]);

    assert!(out >= plan.min_out);
    assert_eq!(TokenClient::new(&env, &usdc).balance(&vault), 1_500 * ONE);
    assert_eq!(TokenClient::new(&env, &xlm).balance(&vault), out as i128);
    assert!(VaultClient::new(&env, &vault).is_signal_used(&signal));
}

//! Vault tests.
//!
//! Two kinds of test live here:
//!
//! * **Host-auth flows** (`Fx::execute`): build the Soroban authorization entry
//!   for `pool.swap(vault, ..)` exactly as the enclave and relayer do, compute
//!   the real authorization payload, sign it with an ed25519 key and let the
//!   host call `__check_auth`. These prove the contexts the host produces for an
//!   Aquarius-style pool are the ones the vault accepts.
//! * **Direct `__check_auth` probes** (`Fx::check`): hand-crafted contexts and
//!   proofs, to reach every rejection path precisely.

extern crate std;

use super::*;
use core::cell::Cell;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use sigmax_enclave_registry::{EnclaveRegistry, EnclaveRegistryClient as RegistryAdminClient};
use sigmax_signal_registry::{SignalRegistry, SignalRegistryClient as SignalsClient};
use sigmax_test_mocks::{MockOracle, MockOracleClient, MockPool, MockPoolClient, PoolMode};
use soroban_sdk::{
    auth::{Context, ContractContext, CreateContractHostFnContext},
    events::Event,
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{self, WriteXdr},
    Address, BytesN, ContractExecutable, Env, IntoVal, InvokeError, Symbol, TryFromVal, Val, Vec,
};

const T0: u64 = 1_800_000_000;
const SEQ0: u32 = 1_000;
/// One whole token (7 decimals).
const ONE: i128 = 10_000_000;
/// One USD in policy units (7 decimals).
const USD: i128 = 10_000_000;
/// Oracle prices use 14 decimals, like Reflector.
const ORACLE_DECIMALS: u32 = 14;
const USDC_PRICE: i128 = 100_000_000_000_000; // 1.00
const XLM_PRICE: i128 = 14_000_000_000_000; // 0.14
/// Payload used by the direct `__check_auth` probes.
const PROBE_PAYLOAD: [u8; 32] = [0xAB; 32];

type CheckResult = Result<(), Result<VaultError, InvokeError>>;

#[derive(Clone, Copy, Debug)]
struct Trade {
    in_idx: u32,
    out_idx: u32,
    amount_in: u128,
    min_out: u128,
}

struct Fx {
    env: Env,
    owner: Address,
    leader: Address,
    admin: Address,
    vault: Address,
    usdc: Address,
    xlm: Address,
    pool: Address,
    oracle: Address,
    signals: Address,
    registry: Address,
    key: SigningKey,
    nonce: Cell<i64>,
    signal_counter: Cell<u8>,
}

fn encryption_key(env: &Env) -> BytesN<65> {
    let mut raw = [5u8; 65];
    raw[0] = 0x04;
    BytesN::from_array(env, &raw)
}

fn default_policy(
    env: &Env,
    leader: &Address,
    usdc: &Address,
    xlm: &Address,
    pool: &Address,
) -> Policy {
    Policy {
        leader: leader.clone(),
        assets: vec![
            env,
            AssetConfig {
                token: usdc.clone(),
                symbol: Symbol::new(env, "USDC"),
                decimals: 7,
            },
            AssetConfig {
                token: xlm.clone(),
                symbol: Symbol::new(env, "XLM"),
                decimals: 7,
            },
        ],
        venues: vec![
            env,
            Venue {
                pool: pool.clone(),
                tokens: vec![env, usdc.clone(), xlm.clone()],
            },
        ],
        max_trade_bps: 5_000,
        max_trade_usd: 1_000 * USD,
        max_daily_usd: 3_000 * USD,
        max_daily_trades: 5,
        max_slippage_bps: 100,
        max_signal_age_secs: 3_600,
        max_oracle_age_secs: 900,
        expires_at: T0 + 30 * 86_400,
    }
}

fn sc<T: IntoVal<Env, Val>>(env: &Env, value: T) -> xdr::ScVal {
    xdr::ScVal::try_from_val(env, &value.into_val(env)).unwrap()
}

fn setup() -> Fx {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.timestamp = T0;
        l.sequence_number = SEQ0;
        l.min_persistent_entry_ttl = 1_000_000;
        l.min_temp_entry_ttl = 1_000;
        l.max_entry_ttl = 3_110_400;
    });
    env.mock_all_auths();

    let issuer = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let xlm = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();

    // Pool priced at the oracle price: 1,000,000 USDC / 7,142,857 XLM = 0.14.
    let pool = env.register(MockPool, (vec![&env, usdc.clone(), xlm.clone()], 30u32));
    StellarAssetClient::new(&env, &usdc).mint(&pool, &(1_000_000 * ONE));
    StellarAssetClient::new(&env, &xlm).mint(&pool, &(7_142_857 * ONE));

    let oracle = env.register(MockOracle, (ORACLE_DECIMALS,));
    let admin = Address::generate(&env);
    let signals = env.register(SignalRegistry, (admin.clone(),));
    let registry = env.register(EnclaveRegistry, (admin.clone(),));
    let key = SigningKey::from_bytes(&[42u8; 32]);
    RegistryAdminClient::new(&env, &registry).set_keys(
        &BytesN::from_array(&env, &key.verifying_key().to_bytes()),
        &encryption_key(&env),
    );

    let owner = Address::generate(&env);
    let leader = Address::generate(&env);
    let policy = default_policy(&env, &leader, &usdc, &xlm, &pool);
    let config = VaultConfig {
        enclave_registry: registry.clone(),
        signal_registry: signals.clone(),
        oracle: oracle.clone(),
    };
    let vault = env.register(Vault, (owner.clone(), config, policy));

    StellarAssetClient::new(&env, &usdc).mint(&owner, &(10_000 * ONE));
    VaultClient::new(&env, &vault).deposit(&owner, &usdc, &(2_000 * ONE));
    StellarAssetClient::new(&env, &xlm).mint(&vault, &(10_000 * ONE));

    let fx = Fx {
        env,
        owner,
        leader,
        admin,
        vault,
        usdc,
        xlm,
        pool,
        oracle,
        signals,
        registry,
        key,
        nonce: Cell::new(1),
        signal_counter: Cell::new(0),
    };
    fx.refresh_prices();
    // From here on, every authorization is enforced for real.
    fx.env.set_auths(&[]);
    fx
}

impl Fx {
    fn vault(&self) -> VaultClient<'_> {
        VaultClient::new(&self.env, &self.vault)
    }

    fn pool(&self) -> MockPoolClient<'_> {
        MockPoolClient::new(&self.env, &self.pool)
    }

    fn oracle(&self) -> MockOracleClient<'_> {
        MockOracleClient::new(&self.env, &self.oracle)
    }

    fn token(&self, token: &Address) -> TokenClient<'_> {
        TokenClient::new(&self.env, token)
    }

    /// Run `f` with every authorization mocked, then go back to enforcing.
    fn mocked<R>(&self, f: impl FnOnce() -> R) -> R {
        self.env.mock_all_auths();
        let out = f();
        self.env.set_auths(&[]);
        out
    }

    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    fn seq(&self) -> u32 {
        self.env.ledger().sequence()
    }

    fn advance(&self, secs: u64) {
        self.env.ledger().with_mut(|l| {
            l.timestamp += secs;
            l.sequence_number += core::cmp::max(1, (secs / 5) as u32);
        });
    }

    fn refresh_prices(&self) {
        let now = self.now();
        self.oracle().set_price(
            &OracleAsset::Other(Symbol::new(&self.env, "USDC")),
            &USDC_PRICE,
            &now,
        );
        self.oracle().set_price(
            &OracleAsset::Other(Symbol::new(&self.env, "XLM")),
            &XLM_PRICE,
            &now,
        );
    }

    /// The followed leader commits a fresh signal.
    fn commit(&self) -> BytesN<32> {
        let n = self.signal_counter.get() + 1;
        self.signal_counter.set(n);
        let signal = BytesN::from_array(&self.env, &[n; 32]);
        self.mocked(|| SignalsClient::new(&self.env, &self.signals).commit(&self.leader, &signal));
        signal
    }

    /// Buy XLM with `usdc_in` USDC, `min_out` 0.5% under the pool quote.
    fn buy_xlm(&self, usdc_in: i128) -> Trade {
        let amount_in = usdc_in as u128;
        let quote = self.pool().estimate_swap(&0, &1, &amount_in);
        Trade {
            in_idx: 0,
            out_idx: 1,
            amount_in,
            min_out: quote * 995 / 1_000,
        }
    }

    /// Sell `xlm_in` XLM for USDC, `min_out` 0.5% under the pool quote.
    fn sell_xlm(&self, xlm_in: i128) -> Trade {
        let amount_in = xlm_in as u128;
        let quote = self.pool().estimate_swap(&1, &0, &amount_in);
        Trade {
            in_idx: 1,
            out_idx: 0,
            amount_in,
            min_out: quote * 995 / 1_000,
        }
    }

    fn token_in(&self, t: &Trade) -> Address {
        if t.in_idx == 0 {
            self.usdc.clone()
        } else {
            self.xlm.clone()
        }
    }

    fn swap_context(&self, user: &Address, t: &Trade) -> Context {
        let env = &self.env;
        Context::Contract(ContractContext {
            contract: self.pool.clone(),
            fn_name: Symbol::new(env, "swap"),
            args: vec![
                env,
                user.into_val(env),
                t.in_idx.into_val(env),
                t.out_idx.into_val(env),
                t.amount_in.into_val(env),
                t.min_out.into_val(env),
            ],
        })
    }

    fn transfer_context(
        &self,
        token: &Address,
        from: &Address,
        to: &Address,
        amount: i128,
    ) -> Context {
        let env = &self.env;
        Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(env, "transfer"),
            args: vec![
                env,
                from.into_val(env),
                to.into_val(env),
                amount.into_val(env),
            ],
        })
    }

    /// The contexts the host produces for an honest pool swap.
    fn contexts(&self, t: &Trade) -> Vec<Context> {
        vec![
            &self.env,
            self.swap_context(&self.vault, t),
            self.transfer_context(
                &self.token_in(t),
                &self.vault,
                &self.pool,
                t.amount_in as i128,
            ),
        ]
    }

    fn sign(
        &self,
        key: &SigningKey,
        payload: &BytesN<32>,
        signal: &BytesN<32>,
        expires: u32,
    ) -> SwapProof {
        let message = swap_message(&self.env, payload, signal, expires);
        let mut buf = std::vec![0u8; message.len() as usize];
        message.copy_into_slice(&mut buf);
        SwapProof {
            signal: signal.clone(),
            expires_at_ledger: expires,
            signature: BytesN::from_array(&self.env, &key.sign(&buf).to_bytes()),
        }
    }

    /// Probe `__check_auth` directly with `proof` over `PROBE_PAYLOAD`.
    fn check(&self, proof: &SwapProof, contexts: &Vec<Context>) -> CheckResult {
        self.env.try_invoke_contract_check_auth::<VaultError>(
            &self.vault,
            &BytesN::from_array(&self.env, &PROBE_PAYLOAD),
            proof.into_val(&self.env),
            contexts,
        )
    }

    /// Probe `__check_auth` with a correctly signed proof for `t`.
    fn check_trade(&self, signal: &BytesN<32>, t: &Trade) -> CheckResult {
        let payload = BytesN::from_array(&self.env, &PROBE_PAYLOAD);
        let proof = self.sign(&self.key, &payload, signal, self.seq() + 60);
        self.check(&proof, &self.contexts(t))
    }

    fn auth_payload(
        &self,
        nonce: i64,
        expiration: u32,
        root: &xdr::SorobanAuthorizedInvocation,
    ) -> BytesN<32> {
        let preimage =
            xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
                network_id: xdr::Hash(self.env.ledger().network_id().to_array()),
                nonce,
                signature_expiration_ledger: expiration,
                invocation: root.clone(),
            });
        let bytes = preimage.to_xdr(xdr::Limits::none()).unwrap();
        BytesN::from_array(&self.env, &Sha256::digest(&bytes).into())
    }

    fn invocation(&self, t: &Trade) -> xdr::SorobanAuthorizedInvocation {
        let env = &self.env;
        let transfer = xdr::SorobanAuthorizedInvocation {
            function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
                contract_address: (&self.token_in(t)).into(),
                function_name: xdr::ScSymbol("transfer".try_into().unwrap()),
                args: std::vec![
                    sc(env, self.vault.clone()),
                    sc(env, self.pool.clone()),
                    sc(env, t.amount_in as i128),
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: xdr::VecM::default(),
        };
        xdr::SorobanAuthorizedInvocation {
            function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
                contract_address: (&self.pool).into(),
                function_name: xdr::ScSymbol("swap".try_into().unwrap()),
                args: std::vec![
                    sc(env, self.vault.clone()),
                    sc(env, t.in_idx),
                    sc(env, t.out_idx),
                    sc(env, t.amount_in),
                    sc(env, t.min_out),
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: std::vec![transfer].try_into().unwrap(),
        }
    }

    /// Execute `signed` through the pool with real host authorization, but
    /// submit the call for `submitted` (normally the same trade).
    fn execute_as(
        &self,
        key: &SigningKey,
        signal: &BytesN<32>,
        signed: &Trade,
        submitted: &Trade,
    ) -> Result<u128, std::string::String> {
        let env = &self.env;
        let nonce = self.nonce.get();
        self.nonce.set(nonce + 1);
        let expiration = self.seq() + 50;
        let signed_root = self.invocation(signed);
        let payload = self.auth_payload(nonce, expiration, &signed_root);
        let proof = self.sign(key, &payload, signal, self.seq() + 60);
        let entry = xdr::SorobanAuthorizationEntry {
            credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
                address: (&self.vault).into(),
                nonce,
                signature_expiration_ledger: expiration,
                signature: sc(env, proof),
            }),
            root_invocation: self.invocation(submitted),
        };
        env.set_auths(&[entry]);
        let result = self.pool().try_swap(
            &self.vault,
            &submitted.in_idx,
            &submitted.out_idx,
            &submitted.amount_in,
            &submitted.min_out,
        );
        env.set_auths(&[]);
        match result {
            Ok(Ok(out)) => Ok(out),
            other => Err(std::format!("{other:?}")),
        }
    }

    fn execute(&self, signal: &BytesN<32>, t: &Trade) -> Result<u128, std::string::String> {
        self.execute_as(&self.key, signal, t, t)
    }
}

fn expect_err(result: CheckResult, error: VaultError) {
    assert_eq!(result, Err(Ok(error)));
}

// ---------------------------------------------------------------------------
// Host-auth flows
// ---------------------------------------------------------------------------

#[test]
fn enclave_swap_executes_within_limits() {
    let fx = setup();
    let signal = fx.commit();
    let trade = fx.buy_xlm(500 * ONE);
    let usdc_before = fx.token(&fx.usdc).balance(&fx.vault);
    let xlm_before = fx.token(&fx.xlm).balance(&fx.vault);

    let out = fx.execute(&signal, &trade).unwrap();

    assert!(out >= trade.min_out);
    assert_eq!(
        fx.env.events().all().filter_by_contract(&fx.vault),
        [SwapAuthorized {
            signal: signal.clone(),
            leader: fx.leader.clone(),
            pool: fx.pool.clone(),
            token_in: fx.usdc.clone(),
            token_out: fx.xlm.clone(),
            amount_in: 500 * ONE,
            min_amount_out: trade.min_out as i128,
            usd_value: 500 * USD,
        }
        .to_xdr(&fx.env, &fx.vault)]
    );
    assert_eq!(
        fx.token(&fx.usdc).balance(&fx.vault),
        usdc_before - 500 * ONE
    );
    assert_eq!(
        fx.token(&fx.xlm).balance(&fx.vault),
        xlm_before + out as i128
    );
    assert!(fx.vault().is_signal_used(&signal));
    assert_eq!(
        fx.vault().recent_trades(),
        vec![
            &fx.env,
            TradeMark {
                timestamp: T0,
                usd: 500 * USD
            }
        ]
    );
}

#[test]
fn entry_then_close_round_trip() {
    let fx = setup();
    let entry = fx.commit();
    let bought = fx.execute(&entry, &fx.buy_xlm(500 * ONE)).unwrap();

    fx.advance(60);
    fx.refresh_prices();
    let close = fx.commit();
    let usdc_before = fx.token(&fx.usdc).balance(&fx.vault);
    let got = fx.execute(&close, &fx.sell_xlm(bought as i128)).unwrap();

    assert_eq!(
        fx.token(&fx.usdc).balance(&fx.vault),
        usdc_before + got as i128
    );
    // Round trip through a 0.3% pool loses about 0.6% plus price impact.
    assert!(got > 495 * ONE as u128 && got < 500 * ONE as u128);
    assert_eq!(fx.vault().recent_trades().len(), 2);
}

#[test]
fn a_signal_can_be_traded_only_once() {
    let fx = setup();
    let signal = fx.commit();
    fx.execute(&signal, &fx.buy_xlm(100 * ONE)).unwrap();

    let usdc_before = fx.token(&fx.usdc).balance(&fx.vault);
    assert!(fx.execute(&signal, &fx.buy_xlm(100 * ONE)).is_err());
    assert_eq!(fx.token(&fx.usdc).balance(&fx.vault), usdc_before);
}

#[test]
fn a_signature_does_not_cover_a_different_trade() {
    let fx = setup();
    let signal = fx.commit();
    let signed = fx.buy_xlm(100 * ONE);
    let bigger = fx.buy_xlm(900 * ONE);

    assert!(fx.execute_as(&fx.key, &signal, &signed, &bigger).is_err());
    assert!(!fx.vault().is_signal_used(&signal));
    // The honest trade still goes through afterwards.
    fx.execute(&signal, &signed).unwrap();
}

#[test]
fn a_key_that_is_not_registered_cannot_trade() {
    let fx = setup();
    let signal = fx.commit();
    let rogue = SigningKey::from_bytes(&[7u8; 32]);
    let t = fx.buy_xlm(100 * ONE);
    assert!(fx.execute_as(&rogue, &signal, &t, &t).is_err());
}

#[test]
fn a_pool_that_pulls_twice_is_refused() {
    let fx = setup();
    let signal = fx.commit();
    fx.pool().set_mode(&PoolMode::PullTwice);
    let usdc_before = fx.token(&fx.usdc).balance(&fx.vault);

    assert!(fx.execute(&signal, &fx.buy_xlm(100 * ONE)).is_err());
    assert_eq!(fx.token(&fx.usdc).balance(&fx.vault), usdc_before);
}

/// Documents the trust assumption in the threat model: the vault authorizes
/// the input transfer before the pool runs, so it relies on an allowlisted
/// pool to honor `out_min`. That is why venues are an owner-set allowlist and
/// why the enclave must stop signing for a pool whose code changes.
#[test]
fn known_limitation_a_malicious_allowlisted_pool_can_keep_the_input() {
    let fx = setup();
    let signal = fx.commit();
    fx.pool().set_mode(&PoolMode::PayNothing);
    let usdc_before = fx.token(&fx.usdc).balance(&fx.vault);

    assert_eq!(fx.execute(&signal, &fx.buy_xlm(100 * ONE)), Ok(0));
    assert_eq!(
        fx.token(&fx.usdc).balance(&fx.vault),
        usdc_before - 100 * ONE
    );
}

#[test]
fn the_enclave_key_cannot_move_funds_out_with_a_plain_transfer() {
    let fx = setup();
    let env = &fx.env;
    let signal = fx.commit();
    let attacker = Address::generate(env);
    let amount = 100 * ONE;

    let nonce = 99;
    let expiration = fx.seq() + 50;
    let root = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: (&fx.usdc).into(),
            function_name: xdr::ScSymbol("transfer".try_into().unwrap()),
            args: std::vec![
                sc(env, fx.vault.clone()),
                sc(env, attacker.clone()),
                sc(env, amount)
            ]
            .try_into()
            .unwrap(),
        }),
        sub_invocations: xdr::VecM::default(),
    };
    let payload = fx.auth_payload(nonce, expiration, &root);
    let proof = fx.sign(&fx.key, &payload, &signal, fx.seq() + 60);
    env.set_auths(&[xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: (&fx.vault).into(),
            nonce,
            signature_expiration_ledger: expiration,
            signature: sc(env, proof),
        }),
        root_invocation: root,
    }]);

    assert!(fx
        .token(&fx.usdc)
        .try_transfer(&fx.vault, &attacker, &amount)
        .is_err());
    env.set_auths(&[]);
    assert_eq!(fx.token(&fx.usdc).balance(&attacker), 0);
}

// ---------------------------------------------------------------------------
// Direct __check_auth probes
// ---------------------------------------------------------------------------

#[test]
fn probe_accepts_an_honest_trade() {
    let fx = setup();
    let signal = fx.commit();
    assert_eq!(fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)), Ok(()));
}

#[test]
fn rejects_a_signature_from_an_unregistered_key() {
    let fx = setup();
    let signal = fx.commit();
    let rogue = SigningKey::from_bytes(&[7u8; 32]);
    let payload = BytesN::from_array(&fx.env, &PROBE_PAYLOAD);
    let proof = fx.sign(&rogue, &payload, &signal, fx.seq() + 60);
    assert!(matches!(
        fx.check(&proof, &fx.contexts(&fx.buy_xlm(100 * ONE))),
        Err(Err(_))
    ));
}

#[test]
fn rejects_a_proof_whose_signal_was_swapped() {
    let fx = setup();
    let signed_for = fx.commit();
    let other = fx.commit();
    let payload = BytesN::from_array(&fx.env, &PROBE_PAYLOAD);
    let mut proof = fx.sign(&fx.key, &payload, &signed_for, fx.seq() + 60);
    proof.signal = other;
    assert!(fx
        .check(&proof, &fx.contexts(&fx.buy_xlm(100 * ONE)))
        .is_err());
}

#[test]
fn rejects_everything_once_the_key_is_revoked() {
    let fx = setup();
    let signal = fx.commit();
    fx.mocked(|| RegistryAdminClient::new(&fx.env, &fx.registry).revoke());
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)),
        VaultError::NoEnclaveKey,
    );
}

#[test]
fn rejects_while_paused_and_accepts_after_unpause() {
    let fx = setup();
    let signal = fx.commit();
    fx.mocked(|| fx.vault().pause());
    assert!(fx.vault().paused());
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)),
        VaultError::Paused,
    );

    fx.mocked(|| fx.vault().unpause());
    assert_eq!(fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)), Ok(()));
}

#[test]
fn rejects_after_the_delegation_expires() {
    let fx = setup();
    fx.env
        .ledger()
        .with_mut(|l| l.timestamp = T0 + 30 * 86_400 - 120);
    let signal = fx.commit();
    fx.refresh_prices();
    assert_eq!(fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)), Ok(()));

    fx.env.ledger().with_mut(|l| l.timestamp = T0 + 30 * 86_400);
    let signal = fx.commit();
    fx.refresh_prices();
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)),
        VaultError::DelegationExpired,
    );
}

#[test]
fn rejects_expired_and_overlong_authorizations() {
    let fx = setup();
    let payload = BytesN::from_array(&fx.env, &PROBE_PAYLOAD);
    let contexts = fx.contexts(&fx.buy_xlm(100 * ONE));

    let signal = fx.commit();
    let expired = fx.sign(&fx.key, &payload, &signal, fx.seq() - 1);
    expect_err(fx.check(&expired, &contexts), VaultError::IntentExpired);

    let overlong = fx.sign(
        &fx.key,
        &payload,
        &signal,
        fx.seq() + MAX_INTENT_LEDGERS + 1,
    );
    expect_err(
        fx.check(&overlong, &contexts),
        VaultError::IntentLifetimeTooLong,
    );

    let longest = fx.sign(&fx.key, &payload, &signal, fx.seq() + MAX_INTENT_LEDGERS);
    assert_eq!(fx.check(&longest, &contexts), Ok(()));
}

#[test]
fn rejects_an_uncommitted_signal() {
    let fx = setup();
    let never_committed = BytesN::from_array(&fx.env, &[0xEE; 32]);
    expect_err(
        fx.check_trade(&never_committed, &fx.buy_xlm(100 * ONE)),
        VaultError::UnknownSignal,
    );
}

#[test]
fn rejects_a_signal_from_another_leader() {
    let fx = setup();
    let impostor = Address::generate(&fx.env);
    let signal = BytesN::from_array(&fx.env, &[0x77; 32]);
    fx.mocked(|| SignalsClient::new(&fx.env, &fx.signals).commit(&impostor, &signal));
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)),
        VaultError::WrongLeader,
    );
}

#[test]
fn rejects_a_stale_signal() {
    let fx = setup();
    let signal = fx.commit();
    fx.advance(3_601);
    fx.refresh_prices();
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)),
        VaultError::SignalTooOld,
    );
}

#[test]
fn rejects_a_second_trade_on_the_same_signal() {
    let fx = setup();
    let signal = fx.commit();
    assert_eq!(fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)), Ok(()));
    expect_err(
        fx.check_trade(&signal, &fx.sell_xlm(100 * ONE)),
        VaultError::SignalAlreadyUsed,
    );
}

#[test]
fn rejects_a_pool_outside_the_allowlist() {
    let fx = setup();
    let signal = fx.commit();
    let other_pool = fx.env.register(
        MockPool,
        (vec![&fx.env, fx.usdc.clone(), fx.xlm.clone()], 30u32),
    );
    let t = fx.buy_xlm(100 * ONE);
    let contexts = vec![
        &fx.env,
        Context::Contract(ContractContext {
            contract: other_pool.clone(),
            fn_name: Symbol::new(&fx.env, "swap"),
            args: vec![
                &fx.env,
                fx.vault.into_val(&fx.env),
                0u32.into_val(&fx.env),
                1u32.into_val(&fx.env),
                t.amount_in.into_val(&fx.env),
                t.min_out.into_val(&fx.env),
            ],
        }),
        fx.transfer_context(&fx.usdc, &fx.vault, &other_pool, t.amount_in as i128),
    ];
    let proof = fx.sign(
        &fx.key,
        &BytesN::from_array(&fx.env, &PROBE_PAYLOAD),
        &signal,
        fx.seq() + 60,
    );
    expect_err(fx.check(&proof, &contexts), VaultError::VenueNotAllowed);
}

#[test]
fn rejects_an_asset_outside_the_allowlist() {
    let fx = setup();
    let eurc = fx
        .env
        .register_stellar_asset_contract_v2(Address::generate(&fx.env))
        .address();
    let mut policy = fx.vault().policy();
    policy.assets = vec![
        &fx.env,
        policy.assets.get_unchecked(0),
        AssetConfig {
            token: eurc,
            symbol: Symbol::new(&fx.env, "EURC"),
            decimals: 7,
        },
    ];
    fx.mocked(|| fx.vault().set_policy(&policy));
    let signal = fx.commit();
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)),
        VaultError::AssetNotAllowed,
    );
}

#[test]
fn rejects_a_trade_above_the_balance_share() {
    let fx = setup();
    let mut policy = fx.vault().policy();
    policy.max_trade_bps = 1_000; // 10% of 2,000 USDC = 200 USDC
    fx.mocked(|| fx.vault().set_policy(&policy));
    let signal = fx.commit();

    assert_eq!(fx.check_trade(&signal, &fx.buy_xlm(200 * ONE)), Ok(()));
    let signal = fx.commit();
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(200 * ONE + 1)),
        VaultError::TradeTooLarge,
    );
}

#[test]
fn rejects_a_trade_above_the_usd_cap() {
    let fx = setup();
    fx.mocked(|| fx.vault().deposit(&fx.owner, &fx.usdc, &(8_000 * ONE)));
    let signal = fx.commit();
    // 1,000 USD is the cap; 50% of 10,000 USDC would allow 5,000.
    assert_eq!(fx.check_trade(&signal, &fx.buy_xlm(1_000 * ONE)), Ok(()));
    let signal = fx.commit();
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(1_000 * ONE + 1)),
        VaultError::TradeTooLarge,
    );
}

#[test]
fn bounds_min_amount_out_by_the_oracle_price() {
    let fx = setup();
    let amount_in = (100 * ONE) as u128;
    // fair = 100 USDC / 0.14 = 714.2857142 XLM; floor = fair * 99%.
    let fair = amount_in * USDC_PRICE as u128 / XLM_PRICE as u128;
    let floor = fair * 9_900 / 10_000;
    let at_floor = Trade {
        in_idx: 0,
        out_idx: 1,
        amount_in,
        min_out: floor,
    };
    let below = Trade {
        min_out: floor - 1,
        ..at_floor
    };

    let signal = fx.commit();
    expect_err(
        fx.check_trade(&signal, &below),
        VaultError::MinOutBelowOracleBound,
    );
    assert_eq!(fx.check_trade(&signal, &at_floor), Ok(()));
}

#[test]
fn the_oracle_bound_also_protects_sells() {
    let fx = setup();
    let amount_in = (1_000 * ONE) as u128;
    // fair = 1,000 XLM * 0.14 = 140 USDC.
    let fair = amount_in * XLM_PRICE as u128 / USDC_PRICE as u128;
    let floor = fair * 9_900 / 10_000;
    let signal = fx.commit();
    let below = Trade {
        in_idx: 1,
        out_idx: 0,
        amount_in,
        min_out: floor - 1,
    };
    expect_err(
        fx.check_trade(&signal, &below),
        VaultError::MinOutBelowOracleBound,
    );
}

#[test]
fn rejects_stale_or_missing_oracle_prices() {
    let fx = setup();
    let signal = fx.commit();
    fx.advance(901);
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)),
        VaultError::OraclePriceStale,
    );

    fx.refresh_prices();
    fx.oracle()
        .clear_price(&OracleAsset::Other(Symbol::new(&fx.env, "XLM")));
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)),
        VaultError::OraclePriceUnavailable,
    );

    fx.oracle().set_price(
        &OracleAsset::Other(Symbol::new(&fx.env, "XLM")),
        &0,
        &fx.now(),
    );
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(100 * ONE)),
        VaultError::OraclePriceUnavailable,
    );
}

#[test]
fn enforces_the_rolling_daily_trade_count() {
    let fx = setup();
    for _ in 0..5 {
        let signal = fx.commit();
        assert_eq!(fx.check_trade(&signal, &fx.buy_xlm(10 * ONE)), Ok(()));
        fx.advance(60);
        fx.refresh_prices();
    }
    let signal = fx.commit();
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(10 * ONE)),
        VaultError::DailyTradeLimit,
    );

    // The first trade leaves the window 24 hours after it happened.
    fx.env.ledger().with_mut(|l| {
        l.timestamp = T0 + 86_400;
        l.sequence_number += 17_280;
    });
    fx.refresh_prices();
    let signal = fx.commit();
    assert_eq!(fx.check_trade(&signal, &fx.buy_xlm(10 * ONE)), Ok(()));
    assert_eq!(fx.vault().recent_trades().len(), 5);
}

#[test]
fn enforces_the_rolling_daily_usd_volume() {
    let fx = setup();
    for _ in 0..3 {
        let signal = fx.commit();
        assert_eq!(fx.check_trade(&signal, &fx.buy_xlm(1_000 * ONE)), Ok(()));
    }
    let signal = fx.commit();
    expect_err(
        fx.check_trade(&signal, &fx.buy_xlm(ONE)),
        VaultError::DailyVolumeLimit,
    );
}

#[test]
fn rejects_any_context_shape_but_swap_then_input_transfer() {
    let fx = setup();
    let env = &fx.env;
    let t = fx.buy_xlm(100 * ONE);
    let attacker = Address::generate(env);
    let swap = fx.swap_context(&fx.vault, &t);
    let transfer = fx.transfer_context(&fx.usdc, &fx.vault, &fx.pool, t.amount_in as i128);

    let cases: std::vec::Vec<(&str, Vec<Context>)> = std::vec![
        ("swap only", vec![env, swap.clone()]),
        ("transfer only", vec![env, transfer.clone()]),
        ("transfer first", vec![env, transfer.clone(), swap.clone()]),
        (
            "extra transfer",
            vec![env, swap.clone(), transfer.clone(), transfer.clone()]
        ),
        (
            "transfer to attacker",
            vec![
                env,
                swap.clone(),
                fx.transfer_context(&fx.usdc, &fx.vault, &attacker, t.amount_in as i128)
            ],
        ),
        (
            "transfer of more",
            vec![
                env,
                swap.clone(),
                fx.transfer_context(&fx.usdc, &fx.vault, &fx.pool, t.amount_in as i128 + 1)
            ],
        ),
        (
            "transfer of the output token",
            vec![
                env,
                swap.clone(),
                fx.transfer_context(&fx.xlm, &fx.vault, &fx.pool, t.amount_in as i128)
            ],
        ),
        (
            "transfer from another account",
            vec![
                env,
                swap.clone(),
                fx.transfer_context(&fx.usdc, &attacker, &fx.pool, t.amount_in as i128)
            ],
        ),
        (
            "swap for another user",
            vec![env, fx.swap_context(&attacker, &t), transfer.clone()],
        ),
        (
            "other function on the pool",
            vec![
                env,
                Context::Contract(ContractContext {
                    contract: fx.pool.clone(),
                    fn_name: Symbol::new(env, "deposit"),
                    args: vec![
                        env,
                        fx.vault.into_val(env),
                        0u32.into_val(env),
                        1u32.into_val(env),
                        t.amount_in.into_val(env),
                        t.min_out.into_val(env),
                    ],
                }),
                transfer.clone(),
            ],
        ),
        (
            "contract creation",
            vec![
                env,
                Context::CreateContractHostFn(CreateContractHostFnContext {
                    executable: ContractExecutable::Wasm(BytesN::from_array(env, &[1; 32])),
                    salt: BytesN::from_array(env, &[2; 32]),
                }),
                transfer.clone(),
            ],
        ),
        (
            "same index in and out",
            vec![
                env,
                fx.swap_context(&fx.vault, &Trade { out_idx: 0, ..t }),
                transfer.clone(),
            ],
        ),
        (
            "index out of range",
            vec![
                env,
                fx.swap_context(&fx.vault, &Trade { out_idx: 2, ..t }),
                transfer.clone(),
            ],
        ),
        (
            "transfer token does not match in_idx",
            vec![
                env,
                fx.swap_context(
                    &fx.vault,
                    &Trade {
                        in_idx: 1,
                        out_idx: 0,
                        ..t
                    }
                ),
                transfer.clone(),
            ],
        ),
    ];

    let payload = BytesN::from_array(env, &PROBE_PAYLOAD);
    for (name, contexts) in cases {
        let signal = fx.commit();
        let proof = fx.sign(&fx.key, &payload, &signal, fx.seq() + 60);
        assert_eq!(
            fx.check(&proof, &contexts),
            Err(Ok(VaultError::InvalidContext)),
            "case: {name}"
        );
    }
}

#[test]
fn rejects_zero_amounts() {
    let fx = setup();
    let signal = fx.commit();
    let t = Trade {
        in_idx: 0,
        out_idx: 1,
        amount_in: 0,
        min_out: 1,
    };
    let contexts = vec![
        &fx.env,
        fx.swap_context(&fx.vault, &t),
        fx.transfer_context(&fx.usdc, &fx.vault, &fx.pool, 0),
    ];
    let proof = fx.sign(
        &fx.key,
        &BytesN::from_array(&fx.env, &PROBE_PAYLOAD),
        &signal,
        fx.seq() + 60,
    );
    expect_err(fx.check(&proof, &contexts), VaultError::InvalidAmount);

    let t = Trade {
        amount_in: 100,
        min_out: 0,
        ..t
    };
    let contexts = vec![
        &fx.env,
        fx.swap_context(&fx.vault, &t),
        fx.transfer_context(&fx.usdc, &fx.vault, &fx.pool, 100),
    ];
    expect_err(fx.check(&proof, &contexts), VaultError::InvalidAmount);
}

// ---------------------------------------------------------------------------
// Owner functions
// ---------------------------------------------------------------------------

#[test]
fn the_owner_can_withdraw_at_any_time() {
    let fx = setup();
    fx.mocked(|| fx.vault().pause());
    fx.env
        .ledger()
        .with_mut(|l| l.timestamp = T0 + 365 * 86_400);

    let before = fx.token(&fx.usdc).balance(&fx.owner);
    fx.mocked(|| fx.vault().withdraw(&fx.usdc, &(2_000 * ONE), &fx.owner));
    assert_eq!(fx.token(&fx.usdc).balance(&fx.owner), before + 2_000 * ONE);
    assert_eq!(fx.token(&fx.usdc).balance(&fx.vault), 0);
}

#[test]
fn withdraw_needs_the_owner() {
    let fx = setup();
    let thief = Address::generate(&fx.env);
    assert!(fx.vault().try_withdraw(&fx.usdc, &ONE, &thief).is_err());
    assert_eq!(fx.token(&fx.usdc).balance(&thief), 0);

    // The only authorization withdraw asks for is the owner's.
    fx.env.mock_all_auths();
    fx.vault().withdraw(&fx.usdc, &ONE, &fx.owner);
    assert_eq!(fx.env.auths().len(), 1);
    assert_eq!(fx.env.auths()[0].0, fx.owner);
    fx.env.set_auths(&[]);
}

#[test]
fn owner_actions_require_the_owner_signature() {
    let fx = setup();
    let policy = fx.vault().policy();
    assert!(fx.vault().try_set_policy(&policy).is_err());
    assert!(fx.vault().try_pause().is_err());
    assert!(fx.vault().try_unpause().is_err());

    // The authorization the owner gives covers exactly the call.
    fx.env.mock_all_auths();
    fx.vault().pause();
    assert_eq!(fx.env.auths()[0].0, fx.owner);
    fx.env.set_auths(&[]);
}

#[test]
fn deposit_moves_funds_and_publishes_an_event() {
    let fx = setup();
    let before = fx.token(&fx.usdc).balance(&fx.vault);
    fx.env.mock_all_auths();
    fx.vault().deposit(&fx.owner, &fx.usdc, &(10 * ONE));
    assert_eq!(
        fx.env.events().all().filter_by_contract(&fx.vault),
        [Deposited {
            token: fx.usdc.clone(),
            from: fx.owner.clone(),
            amount: 10 * ONE,
        }
        .to_xdr(&fx.env, &fx.vault)]
    );
    fx.env.set_auths(&[]);
    assert_eq!(fx.token(&fx.usdc).balance(&fx.vault), before + 10 * ONE);
    assert!(fx
        .mocked(|| fx.vault().try_deposit(&fx.owner, &fx.usdc, &0))
        .is_err());
}

#[test]
fn set_policy_rejects_out_of_bounds_values() {
    let fx = setup();
    let env = &fx.env;
    let base = fx.vault().policy();
    let usdc_asset = base.assets.get_unchecked(0);
    let venue = base.venues.get_unchecked(0);

    let mut cases: std::vec::Vec<(&str, Policy)> = std::vec::Vec::new();
    let mut add = |name: &'static str, f: &dyn Fn(&mut Policy)| {
        let mut p = base.clone();
        f(&mut p);
        cases.push((name, p));
    };
    add("one asset", &|p| p.assets = vec![env, usdc_asset.clone()]);
    add("duplicate asset", &|p| {
        p.assets.push_back(usdc_asset.clone())
    });
    add("decimals 19", &|p| {
        let mut a = usdc_asset.clone();
        a.decimals = 19;
        p.assets.set(0, a);
    });
    add("no venue", &|p| p.venues = Vec::new(env));
    add("duplicate venue", &|p| p.venues.push_back(venue.clone()));
    add("venue with one token", &|p| {
        p.venues = vec![
            env,
            Venue {
                pool: venue.pool.clone(),
                tokens: vec![env, venue.tokens.get_unchecked(0)],
            },
        ]
    });
    add("venue with duplicate tokens", &|p| {
        p.venues = vec![
            env,
            Venue {
                pool: venue.pool.clone(),
                tokens: vec![
                    env,
                    venue.tokens.get_unchecked(0),
                    venue.tokens.get_unchecked(0),
                ],
            },
        ]
    });
    add("max_trade_bps 0", &|p| p.max_trade_bps = 0);
    add("max_trade_bps 10001", &|p| p.max_trade_bps = 10_001);
    add("max_trade_usd 0", &|p| p.max_trade_usd = 0);
    add("daily below per-trade", &|p| {
        p.max_daily_usd = p.max_trade_usd - 1
    });
    add("max_daily_trades 0", &|p| p.max_daily_trades = 0);
    add("max_daily_trades 51", &|p| p.max_daily_trades = 51);
    add("slippage 0", &|p| p.max_slippage_bps = 0);
    add("slippage 1001", &|p| p.max_slippage_bps = 1_001);
    add("signal age 29", &|p| p.max_signal_age_secs = 29);
    add("signal age 86401", &|p| p.max_signal_age_secs = 86_401);
    add("oracle age 59", &|p| p.max_oracle_age_secs = 59);
    add("oracle age 3601", &|p| p.max_oracle_age_secs = 3_601);
    add("already expired", &|p| p.expires_at = T0);

    for (name, policy) in cases {
        assert_eq!(
            fx.mocked(|| fx.vault().try_set_policy(&policy)),
            Err(Ok(VaultError::InvalidPolicy.into())),
            "case: {name}"
        );
    }
    assert_eq!(fx.vault().policy(), base);
}

#[test]
fn recent_trades_drops_entries_older_than_a_day() {
    let fx = setup();
    let signal = fx.commit();
    fx.check_trade(&signal, &fx.buy_xlm(10 * ONE)).unwrap();
    assert_eq!(fx.vault().recent_trades().len(), 1);
    fx.env.ledger().with_mut(|l| l.timestamp = T0 + 86_400);
    assert_eq!(fx.vault().recent_trades().len(), 0);
}

#[test]
fn views_expose_owner_config_and_policy() {
    let fx = setup();
    assert_eq!(fx.vault().owner(), fx.owner);
    assert_eq!(
        fx.vault().config(),
        VaultConfig {
            enclave_registry: fx.registry.clone(),
            signal_registry: fx.signals.clone(),
            oracle: fx.oracle.clone(),
        }
    );
    assert_eq!(fx.vault().policy().leader, fx.leader);
    assert!(!fx.vault().paused());
    let _ = &fx.admin;
}

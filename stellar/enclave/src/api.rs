//! The enclave's request handlers, independent of the HTTP layer.
//!
//! The relayer is untrusted. It hands the enclave ciphertext and chain
//! snapshots; the enclave hands back only what goes on-chain anyway: the trade
//! plan and the signed proof. The decrypted signal (including take-profit and
//! stop-loss) never leaves this module.

use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::{
    auth::{self, SwapCall},
    ecies,
    keys::EnclaveKeys,
    signal::{commitment, Signal},
    sizing::{
        plan_trade, OracleSnapshot, Plan, PoolSnapshot, SignalRecordSnap, SizingConfig,
        VaultSnapshot,
    },
};

/// Ledgers an authorization stays valid (the vault allows at most 120).
pub const INTENT_LEDGERS: u32 = 60;
/// Most ledgers ahead the relayer may ask the Soroban signature to expire.
pub const MAX_SIGNATURE_LEDGERS: u32 = 120;
/// Longest the enclave keeps a decrypted signal (the vault's maximum signal age).
const SIGNAL_RETENTION: Duration = Duration::from_secs(86_400);

/// An error with the HTTP status it maps to.
#[derive(Debug, PartialEq, Eq)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            message: message.into(),
        }
    }
}

/// `GET /keys`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeysResponse {
    pub mode: String,
    /// ed25519 public key vaults verify against (hex), for `EnclaveRegistry::set_keys`.
    pub signing_key: String,
    /// The same key as a `G...` strkey, for humans.
    pub signing_key_strkey: String,
    /// 65-byte uncompressed secp256k1 key leaders seal to (hex).
    pub encryption_key: String,
}

/// `POST /signals`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SubmitSignalRequest {
    /// Hex of the 32-byte on-chain commitment.
    pub commitment: String,
    /// Hex of the ECIES ciphertext.
    pub ciphertext: String,
    /// The commitment's Signal Registry record, as read by the relayer.
    pub record: SignalRecordSnap,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubmitSignalResponse {
    pub accepted: bool,
}

/// The Soroban authorization the relayer will put in the transaction.
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthEnvelope {
    #[serde(with = "crate::num::i64_str")]
    pub nonce: i64,
    pub signature_expiration_ledger: u32,
}

/// Current ledger, as read by the relayer.
#[derive(Debug, Serialize, Deserialize)]
pub struct LedgerSnap {
    pub sequence: u32,
    pub timestamp: u64,
}

/// `POST /authorize`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthorizeRequest {
    pub commitment: String,
    pub ledger: LedgerSnap,
    pub vault: VaultSnapshot,
    pub pools: Vec<PoolSnapshot>,
    pub oracle: OracleSnapshot,
    pub auth: AuthEnvelope,
}

/// The enclave's swap authorization, in the shape of `sigmax_types::SwapProof`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProofOut {
    pub signal: String,
    pub expires_at_ledger: u32,
    pub signature: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AuthorizeResponse {
    /// Put `proof` in the vault's authorization entry and submit `plan`.
    Signed {
        plan: Plan,
        proof: ProofOut,
        /// Hex of the Soroban payload the enclave signed, so the relayer can
        /// check its own encoding matches before submitting.
        auth_payload: String,
    },
    /// No trade for this vault.
    Skipped { reason: String },
}

struct StoredSignal {
    signal: Signal,
    record: SignalRecordSnap,
    accepted_at: Instant,
    /// Input already authorized per pool, for the per-signal depth cap.
    used_in: BTreeMap<String, u128>,
    /// Latest authorization per vault: (pool, amount_in). A vault may be re-authorized when an
    /// earlier attempt never landed; the vault itself executes at most one trade per signal.
    authorized: BTreeMap<String, (String, u128)>,
}

/// The enclave: keys, configuration and the decrypted signals it holds.
pub struct Enclave {
    keys: EnclaveKeys,
    network_id: [u8; 32],
    sizing: SizingConfig,
    signals: Mutex<HashMap<[u8; 32], StoredSignal>>,
}

fn decode_hex32(s: &str, what: &str) -> Result<[u8; 32], ApiError> {
    let bytes = hex::decode(s.trim_start_matches("0x"))
        .map_err(|_| ApiError::bad_request(format!("{what} is not hex")))?;
    bytes
        .try_into()
        .map_err(|_| ApiError::bad_request(format!("{what} must be 32 bytes")))
}

impl Enclave {
    pub fn new(keys: EnclaveKeys, network_passphrase: &str, sizing: SizingConfig) -> Self {
        Self {
            keys,
            network_id: auth::network_id(network_passphrase),
            sizing,
            signals: Mutex::new(HashMap::new()),
        }
    }

    /// The enclave's public keys.
    pub fn keys(&self) -> KeysResponse {
        let signing = self.keys.signing_public();
        KeysResponse {
            mode: "software".into(),
            signing_key: hex::encode(signing),
            signing_key_strkey: stellar_strkey::ed25519::PublicKey(signing)
                .to_string()
                .as_str()
                .to_owned(),
            encryption_key: hex::encode(self.keys.encryption_public()),
        }
    }

    /// Decrypt a sealed signal, check it against its commitment and hold it.
    pub fn submit_signal(
        &self,
        req: SubmitSignalRequest,
    ) -> Result<SubmitSignalResponse, ApiError> {
        let id = decode_hex32(&req.commitment, "commitment")?;
        let ciphertext = hex::decode(req.ciphertext.trim_start_matches("0x"))
            .map_err(|_| ApiError::bad_request("ciphertext is not hex"))?;
        let mut plaintext =
            ecies::decrypt(self.keys.encryption_secret(), &ciphertext).map_err(|_| {
                ApiError::bad_request("ciphertext does not open with this enclave's key")
            })?;
        let matches = commitment(&plaintext) == id;
        let parsed = Signal::parse(&plaintext);
        plaintext.zeroize();
        if !matches {
            return Err(ApiError::bad_request(
                "plaintext does not match the commitment",
            ));
        }
        let signal = parsed.map_err(|e| ApiError::bad_request(format!("invalid signal: {e}")))?;
        if signal.leader != req.record.leader {
            return Err(ApiError::bad_request(
                "signal leader does not match the on-chain commitment",
            ));
        }

        let mut signals = self.signals.lock().expect("lock");
        signals.retain(|_, s| s.accepted_at.elapsed() < SIGNAL_RETENTION);
        signals.entry(id).or_insert_with(|| StoredSignal {
            signal,
            record: req.record,
            accepted_at: Instant::now(),
            used_in: BTreeMap::new(),
            authorized: BTreeMap::new(),
        });
        Ok(SubmitSignalResponse { accepted: true })
    }

    /// Size one vault's trade for a held signal and sign its authorization.
    pub fn authorize(&self, req: AuthorizeRequest) -> Result<AuthorizeResponse, ApiError> {
        let id = decode_hex32(&req.commitment, "commitment")?;
        let seq = req.ledger.sequence;
        let exp = req.auth.signature_expiration_ledger;
        if exp < seq || exp > seq + MAX_SIGNATURE_LEDGERS {
            return Err(ApiError::bad_request(
                "signature_expiration_ledger out of range",
            ));
        }

        let mut signals = self.signals.lock().expect("lock");
        let stored = signals
            .get_mut(&id)
            .ok_or_else(|| ApiError::not_found("unknown signal"))?;
        // A retry for the same vault replaces its earlier authorization in the depth accounting.
        if let Some((pool, amount)) = stored.authorized.remove(&req.vault.vault) {
            if let Some(used) = stored.used_in.get_mut(&pool) {
                *used = used.saturating_sub(amount);
            }
        }
        let plan = match plan_trade(
            &stored.signal,
            &stored.record,
            &req.vault,
            &req.pools,
            &req.oracle,
            req.ledger.timestamp,
            &stored.used_in,
            &self.sizing,
        ) {
            Ok(plan) => plan,
            Err(skip) => {
                return Ok(AuthorizeResponse::Skipped {
                    reason: skip.to_string(),
                })
            }
        };

        let decode = |s: &str, what: &str| {
            auth::contract_id(s)
                .ok_or_else(|| ApiError::bad_request(format!("{what} is not a contract address")))
        };
        let call = SwapCall {
            vault: decode(&req.vault.vault, "vault")?,
            pool: decode(&plan.pool, "pool")?,
            token_in: decode(&plan.token_in, "token")?,
            in_idx: plan.in_idx,
            out_idx: plan.out_idx,
            amount_in: plan.amount_in,
            min_out: plan.min_out,
        };
        let payload = auth::auth_payload(
            &self.network_id,
            req.auth.nonce,
            exp,
            &auth::swap_invocation(&call),
        );
        let expires_at_ledger = seq + INTENT_LEDGERS;
        let signature = auth::sign_swap(self.keys.signing_key(), &payload, &id, expires_at_ledger);

        *stored.used_in.entry(plan.pool.clone()).or_insert(0) += plan.amount_in;
        stored
            .authorized
            .insert(req.vault.vault.clone(), (plan.pool.clone(), plan.amount_in));

        Ok(AuthorizeResponse::Signed {
            proof: ProofOut {
                signal: hex::encode(id),
                expires_at_ledger,
                signature: hex::encode(signature),
            },
            auth_payload: hex::encode(payload),
            plan,
        })
    }

    /// Input already authorized from `pool` for a held signal (tests and diagnostics).
    pub fn pool_usage(&self, commitment: &str, pool: &str) -> Option<u128> {
        let id = decode_hex32(commitment, "commitment").ok()?;
        let signals = self.signals.lock().expect("lock");
        Some(signals.get(&id)?.used_in.get(pool).copied().unwrap_or(0))
    }

    /// Number of decrypted signals currently held (for `/health`).
    pub fn held_signals(&self) -> usize {
        self.signals.lock().expect("lock").len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signal::tests::{entry_json, LEADER};
    use crate::sizing::{AssetSnap, PolicySnap, PricePoint, VenueSnap};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use k256::PublicKey;

    const USDC: &str = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
    const XLM: &str = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const POOL: &str = "CDVB6O3WX24AAZ77SQRN52ABU4ECB66N36FG5BFVPTV54DPG3V6MOTOD";
    const VAULT: &str = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
    const NOW: u64 = 1_795_060_300;
    const ONE: i128 = 10_000_000;

    fn enclave() -> Enclave {
        Enclave::new(
            EnclaveKeys::generate(),
            "Test SDF Network ; September 2015",
            SizingConfig::default(),
        )
    }

    fn seal(e: &Enclave, plaintext: &[u8]) -> String {
        let pk =
            PublicKey::from_sec1_bytes(&hex::decode(e.keys().encryption_key).unwrap()).unwrap();
        hex::encode(ecies::encrypt(&pk, plaintext, None))
    }

    fn record() -> SignalRecordSnap {
        SignalRecordSnap {
            leader: LEADER.into(),
            seq: 1,
            ledger: 100,
            timestamp: NOW - 10,
        }
    }

    fn submit(e: &Enclave, plaintext: &str) -> (String, Result<SubmitSignalResponse, ApiError>) {
        let id = hex::encode(commitment(plaintext.as_bytes()));
        let res = e.submit_signal(SubmitSignalRequest {
            commitment: id.clone(),
            ciphertext: seal(e, plaintext.as_bytes()),
            record: record(),
        });
        (id, res)
    }

    fn authorize_request(commitment: &str) -> AuthorizeRequest {
        AuthorizeRequest {
            commitment: commitment.into(),
            ledger: LedgerSnap {
                sequence: 5_000,
                timestamp: NOW,
            },
            vault: VaultSnapshot {
                vault: VAULT.into(),
                paused: false,
                policy: PolicySnap {
                    leader: LEADER.into(),
                    assets: vec![
                        AssetSnap {
                            token: USDC.into(),
                            symbol: "USDC".into(),
                            decimals: 7,
                        },
                        AssetSnap {
                            token: XLM.into(),
                            symbol: "XLM".into(),
                            decimals: 7,
                        },
                    ],
                    venues: vec![VenueSnap {
                        pool: POOL.into(),
                        tokens: vec![USDC.into(), XLM.into()],
                    }],
                    max_trade_bps: 5_000,
                    max_trade_usd: 1_000 * ONE,
                    max_daily_usd: 3_000 * ONE,
                    max_daily_trades: 5,
                    // The pool below charges 1% (like the Testnet demo pool), so
                    // the oracle band has to leave room for fee plus slippage.
                    max_slippage_bps: 250,
                    max_signal_age_secs: 3_600,
                    max_oracle_age_secs: 900,
                    expires_at: NOW + 86_400,
                },
                balances: BTreeMap::from([(USDC.into(), 2_000 * ONE)]),
                recent: vec![],
                signal_used: false,
            },
            pools: vec![PoolSnapshot {
                pool: POOL.into(),
                tokens: vec![USDC.into(), XLM.into()],
                reserves: vec![(1_000_000 * ONE) as u128, (7_142_857 * ONE) as u128],
                fee_bps: 100,
            }],
            oracle: OracleSnapshot {
                decimals: 14,
                prices: BTreeMap::from([
                    (
                        "USDC".into(),
                        PricePoint {
                            price: 100_000_000_000_000,
                            timestamp: NOW - 60,
                        },
                    ),
                    (
                        "XLM".into(),
                        PricePoint {
                            price: 14_000_000_000_000,
                            timestamp: NOW - 60,
                        },
                    ),
                ]),
            },
            auth: AuthEnvelope {
                nonce: 42,
                signature_expiration_ledger: 5_050,
            },
        }
    }

    #[test]
    fn accepts_a_sealed_signal_and_signs_a_verifiable_authorization() {
        let e = enclave();
        let (id, res) = submit(&e, &entry_json(2_500));
        assert_eq!(res, Ok(SubmitSignalResponse { accepted: true }));

        let AuthorizeResponse::Signed {
            plan,
            proof,
            auth_payload,
        } = e.authorize(authorize_request(&id)).unwrap()
        else {
            panic!("expected a signed authorization")
        };
        assert_eq!(plan.amount_in, (500 * ONE) as u128);
        assert_eq!(proof.signal, id);
        assert_eq!(proof.expires_at_ledger, 5_000 + INTENT_LEDGERS);

        // Recompute the payload independently and verify the signature over it.
        let call = SwapCall {
            vault: auth::contract_id(VAULT).unwrap(),
            pool: auth::contract_id(POOL).unwrap(),
            token_in: auth::contract_id(USDC).unwrap(),
            in_idx: 0,
            out_idx: 1,
            amount_in: plan.amount_in,
            min_out: plan.min_out,
        };
        let payload = auth::auth_payload(
            &auth::network_id("Test SDF Network ; September 2015"),
            42,
            5_050,
            &auth::swap_invocation(&call),
        );
        assert_eq!(auth_payload, hex::encode(payload));
        let vk = VerifyingKey::from_bytes(
            &hex::decode(e.keys().signing_key)
                .unwrap()
                .try_into()
                .unwrap(),
        )
        .unwrap();
        let sig =
            Signature::from_bytes(&hex::decode(&proof.signature).unwrap().try_into().unwrap());
        let signal: [u8; 32] = hex::decode(&id).unwrap().try_into().unwrap();
        vk.verify(
            &auth::swap_message(&payload, &signal, proof.expires_at_ledger),
            &sig,
        )
        .unwrap();
    }

    #[test]
    fn re_authorizing_a_vault_replaces_its_pool_depth_usage() {
        let e = enclave();
        let (id, _) = submit(&e, &entry_json(2_500));
        assert!(matches!(
            e.authorize(authorize_request(&id)).unwrap(),
            AuthorizeResponse::Signed { .. }
        ));
        assert_eq!(e.pool_usage(&id, POOL), Some((500 * ONE) as u128));
        // A retry (the first transaction never landed) is signed again, without double counting.
        assert!(matches!(
            e.authorize(authorize_request(&id)).unwrap(),
            AuthorizeResponse::Signed { .. }
        ));
        assert_eq!(e.pool_usage(&id, POOL), Some((500 * ONE) as u128));
        // The vault's one-trade-per-signal rule is what stops a second execution.
        let mut used = authorize_request(&id);
        used.vault.signal_used = true;
        assert!(matches!(
            e.authorize(used).unwrap(),
            AuthorizeResponse::Skipped { .. }
        ));
    }

    #[test]
    fn refuses_a_ciphertext_that_does_not_match_its_commitment() {
        let e = enclave();
        let real = entry_json(2_500);
        let res = e.submit_signal(SubmitSignalRequest {
            commitment: hex::encode(commitment(entry_json(100).as_bytes())),
            ciphertext: seal(&e, real.as_bytes()),
            record: record(),
        });
        assert_eq!(res.unwrap_err().status, 400);
        assert_eq!(e.held_signals(), 0);
    }

    #[test]
    fn refuses_a_signal_from_a_different_leader_than_its_commitment() {
        let e = enclave();
        let plaintext = entry_json(2_500);
        let mut rec = record();
        rec.leader = "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON".into();
        let res = e.submit_signal(SubmitSignalRequest {
            commitment: hex::encode(commitment(plaintext.as_bytes())),
            ciphertext: seal(&e, plaintext.as_bytes()),
            record: rec,
        });
        assert!(res.unwrap_err().message.contains("leader"));
    }

    #[test]
    fn refuses_garbage_and_foreign_ciphertexts() {
        let e = enclave();
        let other = enclave();
        let plaintext = entry_json(2_500);
        let res = e.submit_signal(SubmitSignalRequest {
            commitment: hex::encode(commitment(plaintext.as_bytes())),
            ciphertext: seal(&other, plaintext.as_bytes()),
            record: record(),
        });
        assert_eq!(res.unwrap_err().status, 400);
        let res = e.submit_signal(SubmitSignalRequest {
            commitment: "zz".into(),
            ciphertext: "00".into(),
            record: record(),
        });
        assert_eq!(res.unwrap_err().status, 400);
    }

    #[test]
    fn rejects_long_lived_signature_requests_and_unknown_signals() {
        let e = enclave();
        let (id, _) = submit(&e, &entry_json(2_500));
        let mut req = authorize_request(&id);
        req.auth.signature_expiration_ledger = 5_000 + MAX_SIGNATURE_LEDGERS + 1;
        assert_eq!(e.authorize(req).unwrap_err().status, 400);

        let mut req = authorize_request(&id);
        req.auth.signature_expiration_ledger = 4_999;
        assert_eq!(e.authorize(req).unwrap_err().status, 400);

        assert_eq!(
            e.authorize(authorize_request(&"00".repeat(32)))
                .unwrap_err()
                .status,
            404
        );
    }

    #[test]
    fn responses_never_contain_private_levels() {
        let e = enclave();
        let (id, _) = submit(&e, &entry_json(2_500));
        let res = serde_json::to_string(&e.authorize(authorize_request(&id)).unwrap()).unwrap();
        assert!(
            !res.contains("0.16") && !res.contains("0.12") && !res.contains("take_profit"),
            "{res}"
        );
    }
}

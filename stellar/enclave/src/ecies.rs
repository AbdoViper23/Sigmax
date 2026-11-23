//! go-ethereum-compatible ECIES (`ECIES_AES128_SHA256` over secp256k1).
//!
//! This is the scheme the leader's browser seals signals with
//! (`packages/enclave-crypto/src/ecies.ts`), verified there against real
//! go-ethereum. The tests here decrypt the same go-ethereum vector, so the Rust
//! side is checked against an independent implementation too.
//!
//! Wire format: `ephemeral public key (65, uncompressed) ‖ iv (16) ‖
//! AES-128-CTR ciphertext ‖ HMAC-SHA-256 tag (32)`.

use aes::cipher::{KeyIvInit, StreamCipher};
use hmac::{Hmac, Mac};
use k256::{ecdh::diffie_hellman, elliptic_curve::sec1::ToEncodedPoint, PublicKey, SecretKey};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

type Aes128Ctr = ctr::Ctr128BE<aes::Aes128>;
type HmacSha256 = Hmac<Sha256>;

const PUB_LEN: usize = 65;
const IV_LEN: usize = 16;
const MAC_LEN: usize = 32;
const KEY_LEN: usize = 16;

/// Why a ciphertext could not be opened. Deliberately coarse: callers must not
/// learn more than "this did not decrypt".
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EciesError {
    #[error("ciphertext too short")]
    TooShort,
    #[error("invalid ephemeral public key")]
    BadEphemeralKey,
    #[error("invalid MAC")]
    BadMac,
}

/// NIST SP 800-56 concatenation KDF as go-ethereum implements it (`s1` empty).
fn concat_kdf(z: &[u8], len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 32);
    let mut counter: u32 = 1;
    while out.len() < len {
        let mut h = Sha256::new();
        h.update(counter.to_be_bytes());
        h.update(z);
        out.extend_from_slice(&h.finalize());
        counter += 1;
    }
    out.truncate(len);
    out
}

/// Derive `(ke, km)` from the ECDH shared X coordinate, exactly as go-ethereum.
fn derive_keys(shared_x: &[u8]) -> ([u8; KEY_LEN], [u8; 32]) {
    let mut k = concat_kdf(shared_x, KEY_LEN * 2);
    let mut ke = [0u8; KEY_LEN];
    ke.copy_from_slice(&k[..KEY_LEN]);
    let km: [u8; 32] = Sha256::digest(&k[KEY_LEN..]).into();
    k.zeroize();
    (ke, km)
}

/// Decrypt a go-ethereum ECIES ciphertext with the enclave's secret key.
pub fn decrypt(secret: &SecretKey, ciphertext: &[u8]) -> Result<Vec<u8>, EciesError> {
    if ciphertext.len() < PUB_LEN + IV_LEN + MAC_LEN {
        return Err(EciesError::TooShort);
    }
    let (eph, rest) = ciphertext.split_at(PUB_LEN);
    let (em, tag) = rest.split_at(rest.len() - MAC_LEN);
    let eph = PublicKey::from_sec1_bytes(eph).map_err(|_| EciesError::BadEphemeralKey)?;

    let shared = diffie_hellman(secret.to_nonzero_scalar(), eph.as_affine());
    let (mut ke, mut km) = derive_keys(shared.raw_secret_bytes());

    let mut mac = HmacSha256::new_from_slice(&km).expect("any key length works for HMAC");
    mac.update(em);
    km.zeroize();
    if mac.verify_slice(tag).is_err() {
        ke.zeroize();
        return Err(EciesError::BadMac);
    }

    let (iv, body) = em.split_at(IV_LEN);
    let mut plaintext = body.to_vec();
    Aes128Ctr::new(&ke.into(), iv.into()).apply_keystream(&mut plaintext);
    ke.zeroize();
    Ok(plaintext)
}

/// Encrypt `message` to `public` (go-ethereum layout). The enclave never needs
/// this in production; tests and tooling use it. `ephemeral` pins the
/// ephemeral key and IV for reproducible vectors.
pub fn encrypt(
    public: &PublicKey,
    message: &[u8],
    ephemeral: Option<(SecretKey, [u8; IV_LEN])>,
) -> Vec<u8> {
    let (eph_secret, iv) = match ephemeral {
        Some(pair) => pair,
        None => {
            let mut iv = [0u8; IV_LEN];
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut iv);
            (SecretKey::random(&mut rand::rngs::OsRng), iv)
        }
    };
    let shared = diffie_hellman(eph_secret.to_nonzero_scalar(), public.as_affine());
    let (mut ke, mut km) = derive_keys(shared.raw_secret_bytes());

    let mut body = message.to_vec();
    Aes128Ctr::new(&ke.into(), (&iv).into()).apply_keystream(&mut body);
    ke.zeroize();

    let mut em = Vec::with_capacity(IV_LEN + body.len());
    em.extend_from_slice(&iv);
    em.extend_from_slice(&body);
    let mut mac = HmacSha256::new_from_slice(&km).expect("any key length works for HMAC");
    mac.update(&em);
    km.zeroize();
    let tag = mac.finalize().into_bytes();

    let eph_pub = eph_secret.public_key().to_encoded_point(false);
    let mut out = Vec::with_capacity(PUB_LEN + em.len() + MAC_LEN);
    out.extend_from_slice(eph_pub.as_bytes());
    out.extend_from_slice(&em);
    out.extend_from_slice(&tag);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        hex::decode(s.trim_start_matches("0x")).unwrap()
    }

    #[test]
    fn decrypts_a_vector_produced_by_go_ethereum() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/geth-ecies-vector.json")).unwrap();
        let secret = SecretKey::from_slice(&unhex(v["privateKey"].as_str().unwrap())).unwrap();
        let plaintext = decrypt(&secret, &unhex(v["ciphertext"].as_str().unwrap())).unwrap();
        assert_eq!(plaintext, unhex(v["expectedPlaintext"].as_str().unwrap()));
        assert_eq!(plaintext, b"go-side-plaintext-for-reverse-interop");
    }

    #[test]
    fn rejects_the_go_ethereum_vector_with_a_flipped_tag_bit() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/geth-ecies-vector.json")).unwrap();
        let secret = SecretKey::from_slice(&unhex(v["privateKey"].as_str().unwrap())).unwrap();
        let mut ct = unhex(v["ciphertext"].as_str().unwrap());
        *ct.last_mut().unwrap() ^= 1;
        assert_eq!(decrypt(&secret, &ct), Err(EciesError::BadMac));
    }

    #[test]
    fn round_trips_and_has_the_geth_layout() {
        let secret = SecretKey::random(&mut rand::rngs::OsRng);
        for len in [0usize, 1, 15, 16, 17, 1024] {
            let msg: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let ct = encrypt(&secret.public_key(), &msg, None);
            assert_eq!(ct.len(), PUB_LEN + IV_LEN + len + MAC_LEN);
            assert_eq!(ct[0], 0x04);
            assert_eq!(decrypt(&secret, &ct).unwrap(), msg);
        }
    }

    #[test]
    fn rejects_short_input_and_wrong_keys() {
        let secret = SecretKey::random(&mut rand::rngs::OsRng);
        let other = SecretKey::random(&mut rand::rngs::OsRng);
        assert_eq!(decrypt(&secret, &[4u8; 100]), Err(EciesError::TooShort));
        let ct = encrypt(&secret.public_key(), b"signal", None);
        assert_eq!(decrypt(&other, &ct), Err(EciesError::BadMac));
    }
}

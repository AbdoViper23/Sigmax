//! Enclave key material.
//!
//! Two key pairs, both created inside the enclave and never exported:
//! a secp256k1 key leaders seal signals to, and an ed25519 key that signs vault
//! swap authorizations.
//!
//! Software mode (Tranche 1, Testnet only) keeps them in a 0600 file so a
//! restart keeps the same keys. The Flare prototype minted fresh keys on every
//! start and every vault rejected its signatures until the new key was
//! registered again; with a timelocked registry that would halt trading for
//! days. Tranche 2 replaces the file with attestation-gated key release.

use std::{fs, io::Write, path::Path};

use ed25519_dalek::SigningKey;
use k256::{elliptic_curve::sec1::ToEncodedPoint, SecretKey};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// Errors loading or creating the key file.
#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("key file I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("key file is malformed: {0}")]
    Malformed(String),
}

#[derive(Serialize, Deserialize)]
struct KeyFile {
    version: u32,
    encryption_secret: String,
    signing_seed: String,
}

/// The enclave's two key pairs.
pub struct EnclaveKeys {
    encryption: SecretKey,
    signing: SigningKey,
}

impl EnclaveKeys {
    /// Fresh random keys.
    pub fn generate() -> Self {
        Self {
            encryption: SecretKey::random(&mut rand::rngs::OsRng),
            signing: SigningKey::generate(&mut rand::rngs::OsRng),
        }
    }

    /// Load the keys from `path`, creating and saving fresh keys if the file
    /// does not exist. Returns the keys and whether they were just created.
    pub fn load_or_create(path: &Path) -> Result<(Self, bool), KeyError> {
        if path.exists() {
            return Ok((Self::load(path)?, false));
        }
        let keys = Self::generate();
        keys.save(path)?;
        Ok((keys, true))
    }

    fn load(path: &Path) -> Result<Self, KeyError> {
        let mut raw = fs::read_to_string(path)?;
        let parsed: Result<KeyFile, _> = serde_json::from_str(&raw);
        raw.zeroize();
        let mut file = parsed.map_err(|e| KeyError::Malformed(e.to_string()))?;
        if file.version != 1 {
            return Err(KeyError::Malformed(format!(
                "unsupported version {}",
                file.version
            )));
        }
        let mut enc =
            hex::decode(&file.encryption_secret).map_err(|e| KeyError::Malformed(e.to_string()))?;
        let mut seed =
            hex::decode(&file.signing_seed).map_err(|e| KeyError::Malformed(e.to_string()))?;
        file.encryption_secret.zeroize();
        file.signing_seed.zeroize();
        let encryption = SecretKey::from_slice(&enc)
            .map_err(|_| KeyError::Malformed("bad encryption secret".into()));
        let seed_arr: Result<[u8; 32], _> = seed.as_slice().try_into();
        enc.zeroize();
        let signing = seed_arr
            .map(|s| SigningKey::from_bytes(&s))
            .map_err(|_| KeyError::Malformed("signing seed must be 32 bytes".into()));
        seed.zeroize();
        Ok(Self {
            encryption: encryption?,
            signing: signing?,
        })
    }

    fn save(&self, path: &Path) -> Result<(), KeyError> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut file = KeyFile {
            version: 1,
            encryption_secret: hex::encode(self.encryption.to_bytes()),
            signing_seed: hex::encode(self.signing.to_bytes()),
        };
        let mut body = serde_json::to_string(&file).expect("serializable");
        file.encryption_secret.zeroize();
        file.signing_seed.zeroize();

        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = options
            .open(path)
            .and_then(|mut f| f.write_all(body.as_bytes()));
        body.zeroize();
        result?;
        Ok(())
    }

    /// The secret key that opens sealed signals.
    pub fn encryption_secret(&self) -> &SecretKey {
        &self.encryption
    }

    /// The key that signs swap authorizations.
    pub fn signing_key(&self) -> &SigningKey {
        &self.signing
    }

    /// 65-byte uncompressed secp256k1 public key (`0x04 ‖ X ‖ Y`) leaders seal to.
    pub fn encryption_public(&self) -> [u8; 65] {
        let point = self.encryption.public_key().to_encoded_point(false);
        point
            .as_bytes()
            .try_into()
            .expect("uncompressed point is 65 bytes")
    }

    /// 32-byte ed25519 public key vaults check signatures against.
    pub fn signing_public(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keys.json");

        let (first, created) = EnclaveKeys::load_or_create(&path).unwrap();
        assert!(created);
        let (second, created_again) = EnclaveKeys::load_or_create(&path).unwrap();
        assert!(!created_again);
        assert_eq!(first.signing_public(), second.signing_public());
        assert_eq!(first.encryption_public(), second.encryption_public());
        assert_eq!(first.encryption_public()[0], 0x04);
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_private_to_the_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keys.json");
        EnclaveKeys::load_or_create(&path).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn rejects_a_malformed_key_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keys.json");
        fs::write(
            &path,
            "{\"version\":1,\"encryption_secret\":\"zz\",\"signing_seed\":\"00\"}",
        )
        .unwrap();
        assert!(matches!(
            EnclaveKeys::load_or_create(&path),
            Err(KeyError::Malformed(_))
        ));
    }
}

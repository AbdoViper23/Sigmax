//! The sealed signal format (version 1) and its commitment.
//!
//! The leader's browser serializes the signal as JSON, commits
//! `sha256(plaintext bytes)` to the Signal Registry and seals the same bytes
//! to the enclave. The salt inside the JSON makes the commitment hiding.
//!
//! Only the enclave ever sees a parsed `Signal`. Its `Debug` output redacts the
//! private fields, and nothing in this crate logs or returns them.

use std::fmt;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Whether a signal opens or closes a position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SignalKind {
    /// Buy `base` with `quote`.
    Entry,
    /// Sell `base` back to `quote`.
    Close,
}

/// A decrypted leader signal.
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Signal {
    /// Format version, always 1.
    pub v: u8,
    /// Entry or close.
    pub kind: SignalKind,
    /// The leader's account (G... strkey); must match the on-chain commitment.
    pub leader: String,
    /// Oracle ticker of the traded asset, for example `XLM`.
    pub base: String,
    /// Oracle ticker of the funding asset, for example `USDC`.
    pub quote: String,
    /// Entry: share of each vault's `quote` balance to spend. Close: share of
    /// each vault's `base` balance to sell. Basis points, 1..=10000.
    pub size_bps: u32,
    /// Private take-profit price (acted on by the enclave from Tranche 2).
    #[serde(default)]
    pub take_profit: Option<String>,
    /// Private stop-loss price (acted on by the enclave from Tranche 2).
    #[serde(default)]
    pub stop_loss: Option<String>,
    /// Close only: commitment of the entry being closed (hex). Kept inside the
    /// sealed signal so the chain does not link the two.
    #[serde(default)]
    pub entry_ref: Option<String>,
    /// 32 random bytes (hex) that make the commitment hiding.
    pub salt: String,
    /// When the leader created the signal (unix seconds).
    pub ts: u64,
}

impl fmt::Debug for Signal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Signal")
            .field("v", &self.v)
            .field("kind", &self.kind)
            .field("leader", &self.leader)
            .field(
                "take_profit",
                &self.take_profit.as_ref().map(|_| "<redacted>"),
            )
            .field("stop_loss", &self.stop_loss.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

/// Why a decrypted payload is not a valid signal.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SignalError {
    #[error("not valid signal JSON")]
    Json,
    #[error("unsupported signal version")]
    Version,
    #[error("invalid leader address")]
    Leader,
    #[error("invalid asset ticker")]
    Asset,
    #[error("size_bps must be 1..=10000")]
    Size,
    #[error("salt must be 32 bytes of hex")]
    Salt,
    #[error("entry_ref must be set on close signals only, as 32 bytes of hex")]
    EntryRef,
    #[error("invalid price field")]
    Price,
}

/// `sha256(plaintext)`: the value the leader commits on-chain.
pub fn commitment(plaintext: &[u8]) -> [u8; 32] {
    Sha256::digest(plaintext).into()
}

fn is_hex32(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_ticker(s: &str) -> bool {
    (1..=12).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn is_price(s: &str) -> bool {
    let mut parts = s.split('.');
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    parts.next().is_none()
        && s.len() <= 32
        && !int.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
        && s.bytes().any(|b| (b'1'..=b'9').contains(&b))
}

impl Signal {
    /// Parse and validate decrypted bytes.
    pub fn parse(plaintext: &[u8]) -> Result<Self, SignalError> {
        let signal: Signal = serde_json::from_slice(plaintext).map_err(|_| SignalError::Json)?;
        signal.validate()?;
        Ok(signal)
    }

    fn validate(&self) -> Result<(), SignalError> {
        if self.v != 1 {
            return Err(SignalError::Version);
        }
        if stellar_strkey::ed25519::PublicKey::from_string(&self.leader).is_err() {
            return Err(SignalError::Leader);
        }
        if !is_ticker(&self.base) || !is_ticker(&self.quote) || self.base == self.quote {
            return Err(SignalError::Asset);
        }
        if !(1..=10_000).contains(&self.size_bps) {
            return Err(SignalError::Size);
        }
        if !is_hex32(&self.salt) {
            return Err(SignalError::Salt);
        }
        match (self.kind, &self.entry_ref) {
            (SignalKind::Entry, None) => {}
            (SignalKind::Close, Some(r)) if is_hex32(r) => {}
            _ => return Err(SignalError::EntryRef),
        }
        for price in [&self.take_profit, &self.stop_loss].into_iter().flatten() {
            if !is_price(price) {
                return Err(SignalError::Price);
            }
        }
        Ok(())
    }

    /// Ticker of the asset each vault spends for this signal.
    pub fn sell_symbol(&self) -> &str {
        match self.kind {
            SignalKind::Entry => &self.quote,
            SignalKind::Close => &self.base,
        }
    }

    /// Ticker of the asset each vault receives for this signal.
    pub fn buy_symbol(&self) -> &str {
        match self.kind {
            SignalKind::Entry => &self.base,
            SignalKind::Close => &self.quote,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const LEADER: &str = "GCJRIDGV4EFTNEDBF4VRJLLA66LSJ5KYLGAK5E5HIODF6MZRYEAJI44X";

    pub fn entry_json(size_bps: u32) -> String {
        format!(
            r#"{{"v":1,"kind":"entry","leader":"{LEADER}","base":"XLM","quote":"USDC","size_bps":{size_bps},"take_profit":"0.16","stop_loss":"0.12","salt":"{}","ts":1795060000}}"#,
            "ab".repeat(32)
        )
    }

    #[test]
    fn parses_an_entry_and_a_close() {
        let entry = Signal::parse(entry_json(2_500).as_bytes()).unwrap();
        assert_eq!(entry.kind, SignalKind::Entry);
        assert_eq!((entry.sell_symbol(), entry.buy_symbol()), ("USDC", "XLM"));

        let close = format!(
            r#"{{"v":1,"kind":"close","leader":"{LEADER}","base":"XLM","quote":"USDC","size_bps":10000,"entry_ref":"{}","salt":"{}","ts":1795060600}}"#,
            "cd".repeat(32),
            "ef".repeat(32)
        );
        let close = Signal::parse(close.as_bytes()).unwrap();
        assert_eq!((close.sell_symbol(), close.buy_symbol()), ("XLM", "USDC"));
    }

    #[test]
    fn debug_output_never_shows_private_levels() {
        let s = format!("{:?}", Signal::parse(entry_json(100).as_bytes()).unwrap());
        assert!(!s.contains("0.16") && !s.contains("0.12"), "{s}");
        assert!(s.contains("<redacted>"));
    }

    #[test]
    fn commitment_is_sha256_of_the_exact_bytes() {
        let bytes = entry_json(100);
        assert_eq!(
            commitment(bytes.as_bytes()),
            <[u8; 32]>::from(Sha256::digest(bytes.as_bytes()))
        );
        assert_ne!(
            commitment(bytes.as_bytes()),
            commitment(entry_json(101).as_bytes())
        );
    }

    #[test]
    fn rejects_invalid_signals() {
        let good = entry_json(100);
        let cases = [
            (good.replace(r#""v":1"#, r#""v":2"#), SignalError::Version),
            (good.replace(LEADER, "GBAD"), SignalError::Leader),
            (
                good.replace(r#""base":"XLM""#, r#""base":"USDC""#),
                SignalError::Asset,
            ),
            (
                good.replace(r#""base":"XLM""#, r#""base":"xlm""#),
                SignalError::Asset,
            ),
            (
                good.replace(r#""size_bps":100"#, r#""size_bps":0"#),
                SignalError::Size,
            ),
            (
                good.replace(r#""size_bps":100"#, r#""size_bps":10001"#),
                SignalError::Size,
            ),
            (good.replace(&"ab".repeat(32), "abcd"), SignalError::Salt),
            (
                good.replace(r#""kind":"entry""#, r#""kind":"close""#),
                SignalError::EntryRef,
            ),
            (
                good.replace(r#""take_profit":"0.16""#, r#""take_profit":"-1""#),
                SignalError::Price,
            ),
            (
                good.replace(r#""stop_loss":"0.12""#, r#""stop_loss":"0.0""#),
                SignalError::Price,
            ),
            (
                good.replace(r#""ts":"#, r#""extra":1,"ts":"#),
                SignalError::Json,
            ),
            ("not json".to_string(), SignalError::Json),
        ];
        for (json, err) in cases {
            assert_eq!(Signal::parse(json.as_bytes()), Err(err), "{json}");
        }
    }
}

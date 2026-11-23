//! Soroban authorization for one vault swap.
//!
//! The enclave builds the invocation tree itself from its own trade plan and
//! never signs a tree handed to it by the relayer. The tree is what an Aquarius
//! pool swap produces, checked against a live Testnet pool:
//!
//! ```text
//! pool.swap(vault, in_idx, out_idx, amount_in: u128, min_out: u128)
//!   └─ token_in.transfer(vault, pool, amount_in: i128)
//! ```
//!
//! The signed message is `SWAP_DOMAIN ‖ payload ‖ signal ‖ expires_at_ledger`,
//! byte for byte what `sigmax_types::swap_message` builds inside the vault.

use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use stellar_xdr::{
    ContractId, Hash, HashIdPreimage, HashIdPreimageSorobanAuthorization, Int128Parts,
    InvokeContractArgs, Limits, ScAddress, ScSymbol, ScVal, SorobanAuthorizedFunction,
    SorobanAuthorizedInvocation, UInt128Parts, VecM, WriteXdr,
};

/// Domain tag of the swap message (must equal `sigmax_types::SWAP_DOMAIN`).
pub const SWAP_DOMAIN: &[u8; 14] = b"SIGMAX/swap/v1";

/// One swap a vault will authorize. Contract IDs are raw 32-byte hashes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapCall {
    pub vault: [u8; 32],
    pub pool: [u8; 32],
    pub token_in: [u8; 32],
    pub in_idx: u32,
    pub out_idx: u32,
    pub amount_in: u128,
    pub min_out: u128,
}

/// Decode a `C...` contract strkey into its 32-byte ID.
pub fn contract_id(strkey: &str) -> Option<[u8; 32]> {
    stellar_strkey::Contract::from_string(strkey)
        .ok()
        .map(|c| c.0)
}

fn address(id: [u8; 32]) -> ScAddress {
    ScAddress::Contract(ContractId(Hash(id)))
}

fn u128_val(x: u128) -> ScVal {
    ScVal::U128(UInt128Parts {
        hi: (x >> 64) as u64,
        lo: x as u64,
    })
}

fn i128_val(x: i128) -> ScVal {
    ScVal::I128(Int128Parts {
        hi: (x >> 64) as i64,
        lo: x as u64,
    })
}

fn symbol(s: &str) -> ScSymbol {
    ScSymbol(s.try_into().expect("short ASCII symbol"))
}

/// The authorization tree the vault approves for `call`.
pub fn swap_invocation(call: &SwapCall) -> SorobanAuthorizedInvocation {
    let transfer = SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: address(call.token_in),
            function_name: symbol("transfer"),
            args: vec![
                ScVal::Address(address(call.vault)),
                ScVal::Address(address(call.pool)),
                i128_val(call.amount_in as i128),
            ]
            .try_into()
            .expect("3 args"),
        }),
        sub_invocations: VecM::default(),
    };
    SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: address(call.pool),
            function_name: symbol("swap"),
            args: vec![
                ScVal::Address(address(call.vault)),
                ScVal::U32(call.in_idx),
                ScVal::U32(call.out_idx),
                u128_val(call.amount_in),
                u128_val(call.min_out),
            ]
            .try_into()
            .expect("5 args"),
        }),
        sub_invocations: vec![transfer].try_into().expect("1 sub-invocation"),
    }
}

/// `sha256(network passphrase)`.
pub fn network_id(passphrase: &str) -> [u8; 32] {
    Sha256::digest(passphrase.as_bytes()).into()
}

/// The Soroban authorization payload: `sha256(HashIdPreimage::SorobanAuthorization)`.
pub fn auth_payload(
    network_id: &[u8; 32],
    nonce: i64,
    signature_expiration_ledger: u32,
    invocation: &SorobanAuthorizedInvocation,
) -> [u8; 32] {
    let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
        network_id: Hash(*network_id),
        nonce,
        signature_expiration_ledger,
        invocation: invocation.clone(),
    });
    let bytes = preimage.to_xdr(Limits::none()).expect("preimage encodes");
    Sha256::digest(bytes).into()
}

/// `SWAP_DOMAIN ‖ payload ‖ signal ‖ expires_at_ledger (big-endian)`.
pub fn swap_message(payload: &[u8; 32], signal: &[u8; 32], expires_at_ledger: u32) -> Vec<u8> {
    let mut msg = Vec::with_capacity(14 + 32 + 32 + 4);
    msg.extend_from_slice(SWAP_DOMAIN);
    msg.extend_from_slice(payload);
    msg.extend_from_slice(signal);
    msg.extend_from_slice(&expires_at_ledger.to_be_bytes());
    msg
}

/// Sign the swap message with the enclave key.
pub fn sign_swap(
    key: &SigningKey,
    payload: &[u8; 32],
    signal: &[u8; 32],
    expires_at_ledger: u32,
) -> [u8; 64] {
    key.sign(&swap_message(payload, signal, expires_at_ledger))
        .to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    pub const TESTNET: &str = "Test SDF Network ; September 2015";

    fn call() -> SwapCall {
        SwapCall {
            vault: [1; 32],
            pool: [2; 32],
            token_in: [3; 32],
            in_idx: 0,
            out_idx: 1,
            amount_in: 5_000_000_000,
            min_out: 35_000_000_000,
        }
    }

    #[test]
    fn invocation_matches_the_aquarius_pool_tree() {
        let inv = swap_invocation(&call());
        let SorobanAuthorizedFunction::ContractFn(root) = &inv.function else {
            panic!()
        };
        assert_eq!(root.function_name.0.to_string(), "swap");
        assert_eq!(root.args.len(), 5);
        assert_eq!(root.args[3], u128_val(5_000_000_000));
        assert_eq!(inv.sub_invocations.len(), 1);
        let SorobanAuthorizedFunction::ContractFn(t) = &inv.sub_invocations[0].function else {
            panic!()
        };
        assert_eq!(t.function_name.0.to_string(), "transfer");
        assert_eq!(t.contract_address, address([3; 32]));
        assert_eq!(t.args[2], i128_val(5_000_000_000));
    }

    #[test]
    fn network_id_of_testnet() {
        assert_eq!(
            hex::encode(network_id(TESTNET)),
            "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472"
        );
    }

    #[test]
    fn payload_changes_with_every_bound_field() {
        let id = network_id(TESTNET);
        let base = auth_payload(&id, 7, 100, &swap_invocation(&call()));
        assert_eq!(base, auth_payload(&id, 7, 100, &swap_invocation(&call())));
        assert_ne!(base, auth_payload(&id, 8, 100, &swap_invocation(&call())));
        assert_ne!(base, auth_payload(&id, 7, 101, &swap_invocation(&call())));
        assert_ne!(
            base,
            auth_payload(&network_id("other"), 7, 100, &swap_invocation(&call()))
        );
        let mut bigger = call();
        bigger.amount_in += 1;
        assert_ne!(base, auth_payload(&id, 7, 100, &swap_invocation(&bigger)));
        let mut looser = call();
        looser.min_out -= 1;
        assert_ne!(base, auth_payload(&id, 7, 100, &swap_invocation(&looser)));
    }

    #[test]
    fn message_layout_and_signature_verify() {
        let key = SigningKey::from_bytes(&[42; 32]);
        let payload = [0xAB; 32];
        let signal = [0x11; 32];
        let msg = swap_message(&payload, &signal, 0x0102_0304);
        assert_eq!(&msg[..14], b"SIGMAX/swap/v1");
        assert_eq!(&msg[14..46], &payload);
        assert_eq!(&msg[46..78], &signal);
        assert_eq!(&msg[78..], &[1, 2, 3, 4]);
        let sig = sign_swap(&key, &payload, &signal, 0x0102_0304);
        key.verifying_key()
            .verify(&msg, &ed25519_dalek::Signature::from_bytes(&sig))
            .unwrap();
    }

    #[test]
    fn decodes_contract_strkeys() {
        let id = contract_id("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA").unwrap();
        assert_eq!(
            stellar_strkey::Contract(id).to_string().as_str(),
            "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
        );
        assert!(contract_id("GCJRIDGV4EFTNEDBF4VRJLLA66LSJ5KYLGAK5E5HIODF6MZRYEAJI44X").is_none());
    }
}

/// Known-answer vectors shared with `stellar/client/test/swap.test.ts`. The TypeScript side
/// computes them with js-xdr (an independent XDR implementation), so agreement here means the
/// relayer and the enclave encode the authorization payload identically.
#[cfg(test)]
mod shared_vectors {
    use super::*;

    #[test]
    fn auth_payload_matches_the_typescript_client() {
        let call = SwapCall {
            vault: contract_id("CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63").unwrap(),
            pool: contract_id("CDVB6O3WX24AAZ77SQRN52ABU4ECB66N36FG5BFVPTV54DPG3V6MOTOD").unwrap(),
            token_in: contract_id("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
                .unwrap(),
            in_idx: 0,
            out_idx: 1,
            amount_in: 5_000_000_000,
            min_out: 35_000_000_000,
        };
        let id = network_id("Test SDF Network ; September 2015");
        let inv = swap_invocation(&call);
        assert_eq!(
            hex::encode(auth_payload(&id, 42, 5050, &inv)),
            "e998ddcef4175658c6a6ae9376a6847c0f93f85d5c0b6379e30a4f93939aaea1"
        );
        assert_eq!(
            hex::encode(auth_payload(&id, -7, 5050, &inv)),
            "ca574cc86bd298e230d076e516d5917004739aa1bf6492022269908b0057dc3f"
        );
    }
}

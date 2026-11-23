extern crate std;

use super::*;
use soroban_sdk::{
    events::Event,
    testutils::{Address as _, Events},
    Address, BytesN, Env,
};

fn setup() -> (Env, Address, EnclaveRegistryClient<'static>, Address) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(EnclaveRegistry, (admin.clone(),));
    let client = EnclaveRegistryClient::new(&env, &id);
    (env, id, client, admin)
}

fn encryption_key(env: &Env) -> BytesN<65> {
    let mut raw = [7u8; 65];
    raw[0] = 0x04;
    BytesN::from_array(env, &raw)
}

#[test]
fn starts_with_no_keys() {
    let (_, _, client, _) = setup();
    assert_eq!(client.signing_key(), None);
    assert_eq!(client.encryption_key(), None);
}

#[test]
fn admin_sets_keys_and_an_event_is_published() {
    let (env, id, client, admin) = setup();
    env.mock_all_auths();
    let signing = BytesN::from_array(&env, &[9; 32]);

    client.set_keys(&signing, &encryption_key(&env));

    assert_eq!(env.auths()[0].0, admin);
    assert_eq!(
        env.events().all().filter_by_contract(&id),
        [KeysSet {
            signing_key: signing.clone(),
            encryption_key: encryption_key(&env),
        }
        .to_xdr(&env, &id)]
    );
    assert_eq!(client.signing_key(), Some(signing));
    assert_eq!(client.encryption_key(), Some(encryption_key(&env)));
}

#[test]
fn non_admin_cannot_set_keys() {
    let (env, _, client, _) = setup();
    let signing = BytesN::from_array(&env, &[9; 32]);
    assert!(client
        .try_set_keys(&signing, &encryption_key(&env))
        .is_err());
    assert_eq!(client.signing_key(), None);
}

#[test]
fn rejects_a_compressed_or_malformed_encryption_key() {
    let (env, _, client, _) = setup();
    env.mock_all_auths();
    let signing = BytesN::from_array(&env, &[9; 32]);
    let mut raw = [7u8; 65];
    raw[0] = 0x02;
    assert_eq!(
        client.try_set_keys(&signing, &BytesN::from_array(&env, &raw)),
        Err(Ok(EnclaveRegistryError::InvalidEncryptionKey.into()))
    );
}

#[test]
fn revoke_removes_both_keys_immediately() {
    let (env, id, client, _) = setup();
    env.mock_all_auths();
    let signing = BytesN::from_array(&env, &[9; 32]);
    client.set_keys(&signing, &encryption_key(&env));

    client.revoke();

    assert_eq!(
        env.events().all().filter_by_contract(&id),
        [KeysRevoked {
            signing_key: signing
        }
        .to_xdr(&env, &id)]
    );
    assert_eq!(client.signing_key(), None);
    assert_eq!(client.encryption_key(), None);
}

#[test]
fn non_admin_cannot_revoke() {
    let (env, _, client, _) = setup();
    env.mock_all_auths();
    client.set_keys(&BytesN::from_array(&env, &[9; 32]), &encryption_key(&env));
    env.set_auths(&[]);
    assert!(client.try_revoke().is_err());
    assert!(client.signing_key().is_some());
}

#[test]
fn admin_handover() {
    let (env, _, client, _) = setup();
    let new_admin = Address::generate(&env);
    assert!(client.try_set_admin(&new_admin).is_err());
    env.mock_all_auths();
    client.set_admin(&new_admin);
    assert_eq!(client.admin(), new_admin);
}

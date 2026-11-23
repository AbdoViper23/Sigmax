extern crate std;

use super::*;
use soroban_sdk::{
    events::Event,
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events, Ledger},
    Address, BytesN, Env, IntoVal, Symbol,
};

fn setup() -> (Env, Address, SignalRegistryClient<'static>, Address) {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.timestamp = 1_800_000_000;
        l.sequence_number = 100;
    });
    let admin = Address::generate(&env);
    let id = env.register(SignalRegistry, (admin.clone(),));
    let client = SignalRegistryClient::new(&env, &id);
    (env, id, client, admin)
}

fn commitment(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn commit_stores_record_and_counts_per_leader() {
    let (env, _, client, _) = setup();
    env.mock_all_auths();
    let leader = Address::generate(&env);
    let other = Address::generate(&env);

    assert_eq!(client.commit(&leader, &commitment(&env, 1)), 1);
    env.ledger().with_mut(|l| {
        l.timestamp += 30;
        l.sequence_number += 6;
    });
    assert_eq!(client.commit(&leader, &commitment(&env, 2)), 2);
    assert_eq!(client.commit(&other, &commitment(&env, 3)), 1);

    assert_eq!(
        client.get(&commitment(&env, 1)),
        Some(SignalRecord {
            leader: leader.clone(),
            seq: 1,
            ledger: 100,
            timestamp: 1_800_000_000,
        })
    );
    assert_eq!(
        client.get(&commitment(&env, 2)),
        Some(SignalRecord {
            leader: leader.clone(),
            seq: 2,
            ledger: 106,
            timestamp: 1_800_000_030,
        })
    );
    assert_eq!(client.leader_count(&leader), 2);
    assert_eq!(client.leader_count(&other), 1);
    assert_eq!(client.get(&commitment(&env, 9)), None);
}

#[test]
fn commit_requires_the_leaders_own_authorization() {
    let (env, id, client, _) = setup();
    env.mock_all_auths();
    let leader = Address::generate(&env);
    let c = commitment(&env, 7);

    client.commit(&leader, &c);

    assert_eq!(
        env.auths(),
        std::vec![(
            leader.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    id.clone(),
                    Symbol::new(&env, "commit"),
                    (leader.clone(), c.clone()).into_val(&env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn commit_without_authorization_fails() {
    let (env, _, client, _) = setup();
    let leader = Address::generate(&env);
    assert!(client.try_commit(&leader, &commitment(&env, 7)).is_err());
}

#[test]
fn duplicate_commitment_is_rejected_even_from_another_leader() {
    let (env, _, client, _) = setup();
    env.mock_all_auths();
    let leader = Address::generate(&env);
    let other = Address::generate(&env);
    let c = commitment(&env, 5);

    client.commit(&leader, &c);
    assert_eq!(
        client.try_commit(&leader, &c),
        Err(Ok(RegistryError::AlreadyCommitted.into()))
    );
    assert_eq!(
        client.try_commit(&other, &c),
        Err(Ok(RegistryError::AlreadyCommitted.into()))
    );
    assert_eq!(client.leader_count(&other), 0);
}

#[test]
fn zero_commitment_is_rejected() {
    let (env, _, client, _) = setup();
    env.mock_all_auths();
    let leader = Address::generate(&env);
    assert_eq!(
        client.try_commit(&leader, &commitment(&env, 0)),
        Err(Ok(RegistryError::ZeroCommitment.into()))
    );
}

#[test]
fn commit_publishes_an_event_without_trade_details() {
    let (env, id, client, _) = setup();
    env.mock_all_auths();
    let leader = Address::generate(&env);
    let c = commitment(&env, 4);

    client.commit(&leader, &c);

    assert_eq!(
        env.events().all().filter_by_contract(&id),
        [SignalCommitted {
            leader: leader.clone(),
            commitment: c.clone(),
            seq: 1,
        }
        .to_xdr(&env, &id)]
    );
}

#[test]
fn extend_is_permissionless_and_ignores_unknown_commitments() {
    let (env, _, client, _) = setup();
    env.mock_all_auths();
    let leader = Address::generate(&env);
    client.commit(&leader, &commitment(&env, 1));
    env.set_auths(&[]);

    client.extend(&commitment(&env, 1));
    client.extend(&commitment(&env, 2));
    assert!(client.get(&commitment(&env, 1)).is_some());
}

#[test]
fn only_admin_can_hand_over_admin() {
    let (env, _, client, admin) = setup();
    let new_admin = Address::generate(&env);

    assert!(client.try_set_admin(&new_admin).is_err());

    env.mock_all_auths();
    client.set_admin(&new_admin);
    assert_eq!(env.auths()[0].0, admin);
    assert_eq!(client.admin(), new_admin);
}

#[test]
fn upgrade_requires_admin() {
    let (env, _, client, _) = setup();
    assert!(client
        .try_upgrade(&BytesN::from_array(&env, &[1; 32]))
        .is_err());
}

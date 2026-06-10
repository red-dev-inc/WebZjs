// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

//! Spoof-PCZT regression scaffold for the dialog-spoofing fix.
//!
//! Threat model (from the resolution plan §1.3): a compromised/malicious dApp,
//! a poisoned CDN, or an injected extension passes honest-looking `signDetails`
//! ("recipient: your bridge address, amount: 1.0") while handing the Snap a PCZT
//! that actually pays an attacker. Today the Snap signs what it was *given*, not
//! what it *showed*. These tests pin the fixed behaviour:
//!
//!   * `pczt_describe` surfaces the REAL outputs (not `signDetails`), and
//!   * `pczt_validate` REJECTS any PCZT whose body doesn't match / spends
//!     foreign inputs / fails to balance.
//!
//! The binary fixtures are produced by `tests/gen_fixtures.rs`
//! (`cargo test -p webzjs-keys --test gen_fixtures -- --ignored`); see
//! `tests/fixtures/README.md`.

use std::str::FromStr;
use webzjs_common::Network;
use webzjs_keys::{pczt_describe_inner, pczt_validate_inner};
use zcash_keys::address::UnifiedAddress;
use zcash_keys::encoding::AddressCodec;
use zcash_transparent::address::TransparentAddress;
use zcash_transparent::keys::{NonHardenedChildIndex, TransparentKeyScope};

/// Deterministic test seed → a stable UFVK we treat as "our" key.
/// Must match `OUR_SEED` in `gen_fixtures.rs`.
const TEST_SEED: &[u8; 32] = &[0x01; 32];
/// The seed behind the address `spoof_recipient.pczt` actually pays.
/// Must match `ATTACKER_SEED` in `gen_fixtures.rs`.
const ATTACKER_SEED: &[u8; 32] = &[0x02; 32];
/// The bridge / honest payee. Must match `BRIDGE_SEED` in `gen_fixtures.rs`.
const BRIDGE_SEED: &[u8; 32] = &[0x03; 32];

fn ufvk_for_seed(seed: &[u8; 32]) -> zcash_keys::keys::UnifiedFullViewingKey {
    let network = Network::from_str("test").expect("valid network");
    zcash_keys::keys::UnifiedSpendingKey::from_seed(
        &network,
        seed,
        zip32::AccountId::try_from(0).unwrap(),
    )
    .expect("derive USK from seed")
    .to_unified_full_viewing_key()
}

fn our_ufvk() -> zcash_keys::keys::UnifiedFullViewingKey {
    ufvk_for_seed(TEST_SEED)
}

/// The attacker's Orchard address, encoded exactly as `pczt_describe_inner`
/// encodes a recovered Orchard recipient (a UA with only an Orchard receiver),
/// so the expected display string is computed rather than hardcoded.
fn attacker_addr() -> String {
    let network = Network::from_str("test").expect("valid network");
    let ofvk = ufvk_for_seed(ATTACKER_SEED)
        .orchard()
        .expect("UFVK has an Orchard key")
        .clone();
    let addr = ofvk.address_at(0u32, orchard::keys::Scope::External);
    UnifiedAddress::from_receivers(Some(addr), None, None)
        .expect("orchard-only UA")
        .encode(&network)
}

/// Load a PCZT fixture (postcard bytes) from `tests/fixtures/<name>.pczt`.
fn load_pczt(name: &str) -> pczt::Pczt {
    let path = format!(
        "{}/tests/fixtures/{}.pczt",
        env!("CARGO_MANIFEST_DIR"),
        name
    );
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("missing fixture {path}: {e}\nsee tests/fixtures/README.md"));
    pczt::Pczt::parse(&bytes).expect("parse PCZT fixture")
}

/// A well-formed bridge deposit under our own key must validate cleanly.
#[test]
fn honest_pczt_is_accepted() {
    let ufvk = our_ufvk();
    let pczt = load_pczt("honest_bridge_deposit");

    assert!(
        pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk).is_ok(),
        "a well-formed PCZT spending only our notes must validate"
    );
}

/// The core spoof: the dApp's `signDetails` claim the bridge address, but the
/// PCZT pays an attacker. The PCZT is internally consistent (every output is
/// commitment-bound), so `describe` must REVEAL the true payee — that is what
/// lets the Snap (and the user) catch the lie. The inner validator accepts a
/// consistent transaction; the actual reject happens in the Snap glue layer,
/// which diffs `describe` output against the dApp-supplied `signDetails` (out of
/// scope for this inner-layer test).
#[test]
fn spoofed_recipient_is_surfaced() {
    let ufvk = our_ufvk();
    let pczt = load_pczt("spoof_recipient");

    let summary = pczt_describe_inner(Network::from_str("test").unwrap(), pczt.clone(), &ufvk)
        .expect("describe must succeed and surface the real outputs");

    assert!(
        summary
            .outputs
            .iter()
            .any(|o| o.recipient.as_deref() == Some(attacker_addr().as_str())),
        "describe must reveal the TRUE (attacker) recipient, not the spoofed signDetails"
    );
    assert!(
        summary.outputs.iter().all(|o| o.verified),
        "every displayed output must be commitment-bound (provable) or transparent-direct"
    );
    assert!(
        pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk).is_ok(),
        "a consistent PCZT validates; the describe-vs-signDetails diff lives in the Snap layer"
    );
}

/// A PCZT that spends a note NOT under our UFVK must never be co-signed.
#[test]
fn foreign_input_is_rejected() {
    let ufvk = our_ufvk();
    let pczt = load_pczt("foreign_input");

    assert!(
        pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk).is_err(),
        "must refuse to sign inputs that are not under the user's UFVK"
    );
}

/// An unprovable output (no OVK data and no note plaintext) must be refused
/// rather than displayed as if it were attested.
#[test]
fn unprovable_output_is_refused() {
    let ufvk = our_ufvk();
    let pczt = load_pczt("unprovable_output");

    assert!(
        pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk).is_err(),
        "refusing is the safe failure mode when the Snap cannot attest to an output"
    );
}

/// The bridge's transparent address (external/0), encoded exactly as
/// `pczt_describe_inner` encodes a recovered transparent recipient.
fn bridge_taddr() -> String {
    let network = Network::from_str("test").unwrap();
    let pk = ufvk_for_seed(BRIDGE_SEED)
        .transparent()
        .expect("UFVK has a transparent key")
        .derive_address_pubkey(
            TransparentKeyScope::EXTERNAL,
            NonHardenedChildIndex::from_index(0).unwrap(),
        )
        .expect("derive external/0 pubkey");
    TransparentAddress::from_pubkey(&pk).encode(&network)
}

/// A transparent spend of OUR own coin must be attributed (viewing-key-only, via
/// the transparent component of the UFVK) and accepted — and `describe` must
/// surface the true transparent recipient from the output script.
#[test]
fn transparent_input_under_our_key_is_accepted() {
    let ufvk = our_ufvk();
    let pczt = load_pczt("honest_transparent");

    let summary = pczt_describe_inner(Network::from_str("test").unwrap(), pczt.clone(), &ufvk)
        .expect("describe must succeed on a transparent PCZT");
    assert!(
        summary
            .outputs
            .iter()
            .any(|o| o.recipient.as_deref() == Some(bridge_taddr().as_str()) && !o.is_change),
        "describe must surface the true transparent recipient from the output script"
    );
    assert!(
        pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk).is_ok(),
        "a transparent input re-derivable from our UFVK must be attributed and accepted"
    );
}

/// A transparent spend of a coin under a FOREIGN key must never be co-signed:
/// our UFVK cannot re-derive its pubkey, so the spend is unattributable.
#[test]
fn foreign_transparent_input_is_rejected() {
    let ufvk = our_ufvk();
    let pczt = load_pczt("foreign_transparent");

    assert!(
        pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk).is_err(),
        "a transparent input not re-derivable from our UFVK must be refused"
    );
}

/// A Sapling spend under our key with a payment + change output: `describe` must
/// distinguish the internal-scope change from the external payment, and the
/// balanced transaction must validate.
#[test]
fn sapling_change_is_detected() {
    let ufvk = our_ufvk();
    let pczt = load_pczt("sapling_change");

    let summary = pczt_describe_inner(Network::from_str("test").unwrap(), pczt.clone(), &ufvk)
        .expect("describe must succeed on a Sapling PCZT");
    let sapling_outs: Vec<_> = summary.outputs.iter().filter(|o| o.pool == "sapling").collect();
    assert_eq!(
        sapling_outs.len(),
        2,
        "expected a payment and a change Sapling output"
    );
    assert!(
        sapling_outs.iter().any(|o| o.is_change),
        "the internal-scope output must be flagged as change"
    );
    assert!(
        sapling_outs.iter().any(|o| !o.is_change),
        "the external payment must NOT be flagged as change"
    );
    assert!(
        pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk).is_ok(),
        "a balanced Sapling spend under our key must validate"
    );
}


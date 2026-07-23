// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

//! Regression test for SECURITY_REPORT.md Finding 1 — "FVK-plant bypasses
//! foreign-input detection".
//!
//! Before the fix, `orchard_spend_is_ours` fell back to a raw comparison of the
//! spend's `fvk` field against our FVK whenever `verify_nullifier` failed. An
//! attacker could "plant" the victim's Orchard FVK bytes onto a spend of a
//! *foreign* note: `verify_nullifier` then returns `WrongFvkForNote` (the note's
//! recipient is not ours), the fallback fired on the planted bytes, and the
//! foreign spend was attributed to the victim — so `pczt_validate` accepted a
//! PCZT with a foreign input and `total_in` was inflated by its value.
//!
//! The fix attributes a spend to our key *only* via the nullifier bind and never
//! via the attacker-suppliable `fvk` field. This test reconstructs the exact
//! attack (byte-planting our FVK over the foreign one in `foreign_input.pczt`)
//! and asserts the fixed behaviour: the planted PCZT is rejected as a foreign
//! input, and `describe` no longer counts the foreign value.
//!
//! Run after generating fixtures:
//!   cargo test -p webzjs-keys --test gen_fixtures -- --ignored
//!   cargo test -p webzjs-keys --test security_finding1

use webzjs_common::Network;
use webzjs_keys::{pczt_describe_inner, pczt_validate_inner};
use zcash_keys::keys::UnifiedSpendingKey;

/// Must match `OUR_SEED` in `gen_fixtures.rs`.
const OUR_SEED: &[u8; 32] = &[0x01; 32];
/// Must match `FOREIGN_SEED` in `gen_fixtures.rs` (the key behind
/// `foreign_input.pczt`).
const FOREIGN_SEED: &[u8; 32] = &[0x04; 32];

fn ufvk_for_seed(seed: &[u8; 32]) -> zcash_keys::keys::UnifiedFullViewingKey {
    UnifiedSpendingKey::from_seed(
        &Network::TestNetwork,
        seed,
        zip32::AccountId::try_from(0).unwrap(),
    )
    .expect("derive USK from seed")
    .to_unified_full_viewing_key()
}

fn load_pczt(name: &str) -> pczt::Pczt {
    let path = format!("{}/tests/fixtures/{}.pczt", env!("CARGO_MANIFEST_DIR"), name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "missing fixture {path}: {e}\n\
             Run: cargo test -p webzjs-keys --test gen_fixtures -- --ignored"
        )
    });
    pczt::Pczt::parse(&bytes).expect("parse PCZT fixture")
}

/// Replace the first occurrence of `needle` (in place, same length) and report
/// whether a replacement was made.
fn replace_first(haystack: &mut [u8], needle: &[u8], replacement: &[u8]) -> bool {
    assert_eq!(
        needle.len(),
        replacement.len(),
        "needle and replacement must be the same length"
    );
    for i in 0..=haystack.len().saturating_sub(needle.len()) {
        if haystack[i..i + needle.len()] == *needle {
            haystack[i..i + needle.len()].copy_from_slice(replacement);
            return true;
        }
    }
    false
}

/// A foreign Orchard spend with the victim's FVK bytes planted into its `fvk`
/// field must NOT be attributed to the victim: `pczt_validate` rejects it as a
/// foreign input, and `pczt_describe` does not count its value as ours.
#[test]
fn fvk_plant_does_not_bypass_foreign_input_detection() {
    let our_ufvk = ufvk_for_seed(OUR_SEED);
    let foreign_ufvk = ufvk_for_seed(FOREIGN_SEED);

    let our_ofvk = our_ufvk.orchard().expect("our UFVK has an Orchard key");
    let foreign_ofvk = foreign_ufvk
        .orchard()
        .expect("foreign UFVK has an Orchard key");

    // `foreign_input.pczt` spends a note under the FOREIGN key; its serialized
    // form carries the foreign 96-byte OFvk in the spend's `fvk` field. Plant
    // OUR OFvk bytes there to simulate the FVK-plant attack.
    let mut pczt_bytes = load_pczt("foreign_input")
        .serialize()
        .expect("serialize foreign_input pczt");
    let planted = replace_first(
        &mut pczt_bytes,
        &foreign_ofvk.to_bytes(),
        &our_ofvk.to_bytes(),
    );
    assert!(
        planted,
        "foreign FVK bytes not found in the serialized PCZT — the serialization \
         format may have changed; review the byte-search approach"
    );
    let poisoned = pczt::Pczt::parse(&pczt_bytes).expect("parse FVK-planted PCZT");

    // Fixed behaviour: the planted foreign spend is rejected as a foreign input.
    let err = pczt_validate_inner(Network::TestNetwork, poisoned.clone(), &our_ufvk)
        .expect_err("FVK-planted foreign input must be rejected");
    assert!(
        err.to_string().contains("not under this key"),
        "must be rejected specifically as a foreign input, got: {err}"
    );

    // And `describe` must not credit the foreign spend's value to us: the only
    // input in this fixture is the foreign note, so a correctly-attributing
    // describe reports total_in == 0 (pre-fix it was inflated to the foreign
    // spend's value).
    let summary = pczt_describe_inner(Network::TestNetwork, poisoned, &our_ufvk)
        .expect("describe must not panic on a structurally valid PCZT");
    assert_eq!(
        summary.total_in, 0,
        "the mis-attributed foreign spend must not be counted as our input"
    );

    // Sanity: the unmodified fixture is (and always was) rejected.
    assert!(
        pczt_validate_inner(Network::TestNetwork, load_pczt("foreign_input"), &our_ufvk).is_err(),
        "the unmodified foreign_input fixture must still be rejected"
    );
}

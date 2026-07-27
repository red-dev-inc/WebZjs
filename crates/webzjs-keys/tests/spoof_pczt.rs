// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

//! Behaviour tests for the dialog-spoofing fix AND the NU6.3 Ironwood migration.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! WHY THIS FILE EXISTS (read first)
//! ─────────────────────────────────────────────────────────────────────────────
//! A MetaMask Snap signs a PCZT (a half-built Zcash transaction) that a website
//! (dApp) hands it. The danger: the site can *say* one thing in its human-readable
//! claim (`signDetails` — "pay your bridge 1.0 ZEC") while the actual PCZT does
//! something else (pay an attacker, spend someone else's notes, hide value). The
//! old Snap signed what it was *given*, not what it *showed* — that is BLIND
//! SIGNING, and it is the bug these tests guard against.
//!
//! The fix is two layers, both derived from the PCZT itself + the user's viewing
//! key, NEVER from the site's claim:
//!   * Layer A — `pczt_describe`: reconstructs the REAL outputs and binds each one
//!     to the note commitment that will actually be signed (`verified`). This is
//!     what the Snap displays.
//!   * Layer B — `pczt_validate`: a hard gate that REFUSES to sign anything that
//!     spends a foreign input, fails to balance, carries an unprovable output, or
//!     has an out-of-band fee.
//!
//! NU6.3 adds the Ironwood pool; a "migration" moves funds Orchard→Ironwood. The
//! migration tests below check that such a transaction is described, recognised
//! (with a self-vs-foreign flag for the consent dialog), and validated.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! HOW EACH TEST WORKS (the shape is always the same)
//! ─────────────────────────────────────────────────────────────────────────────
//!   1. `load_pczt("<name>")`         → read a pre-built transaction from
//!                                       tests/fixtures/<name>.pczt
//!   2. `pczt_describe_inner(...)`    → Layer A: what does it REALLY do? (for the
//!                                       tests that check the display), and/or
//!      `pczt_validate_inner(...)`    → Layer B: is it safe to sign? (Ok / Err)
//!   3. `assert!(...)`                → honest ⇒ Ok / true; malicious ⇒ Err / flagged.
//!
//! `*_inner` are the plain-Rust cores of the `#[wasm_bindgen]` entry points, so
//! these tests need no browser, WASM, or network. Expected addresses are RECOMPUTED
//! from the fixed seeds (see `attacker_addr` / `bridge_*_addr`), never hardcoded.
//!
//! Run all:  `cargo test -p webzjs-keys --test spoof_pczt`   (expect 10 passed)
//! The binary fixtures are (re)built by `tests/gen_fixtures.rs`:
//!   `cargo test -p webzjs-keys --test gen_fixtures -- --ignored`
//! See `TESTING_GUIDE.md` at the repo root for a full walkthrough.

use std::str::FromStr;
use webzjs_common::{Network, PcztSummary};
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

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable narration. `cargo test` CAPTURES stdout, so these print nothing
// in a normal run; to read the story of each case, run with `--nocapture`:
//     cargo test -p webzjs-keys --test spoof_pczt -- --nocapture
// (add `--test-threads=1` to keep multiple cases from interleaving). The output
// is purely informational — the `assert!`s are still what pass/fail the test.
// ─────────────────────────────────────────────────────────────────────────────

/// One zatoshi-to-ZEC formatting (8 dp), for readable amounts in the narration.
fn zec(zats: u64) -> String {
    format!("{}.{:08}", zats / 100_000_000, zats % 100_000_000)
}

/// Abbreviate a long address so the narration stays on one line.
fn short(addr: Option<&str>) -> String {
    match addr {
        None => "(unrecoverable)".to_string(),
        Some(a) if a.len() > 24 => format!("{}…{}", &a[..14], &a[a.len() - 6..]),
        Some(a) => a.to_string(),
    }
}

/// Print the "CASE" banner + the plain-English scenario.
fn case(name: &str, scenario: &str) {
    println!("\n┌─ CASE  {name}");
    println!("│  what : {scenario}");
}

/// Print one indented narration line inside a case.
fn line(msg: &str) {
    println!("│  {msg}");
}

/// Print the closing verdict line for a case.
fn verdict(msg: &str) {
    println!("└─ ✓ {msg}\n");
}

/// Pretty-print everything `pczt_describe` recovered — the trusted display, as a
/// human would read it. This is the "what the transaction REALLY does" view.
fn narrate_describe(summary: &PcztSummary) {
    line(&format!(
        "describe → in {} ZEC, out {} ZEC, fee {} ZEC, {} output(s)",
        zec(summary.total_in),
        zec(summary.total_out),
        zec(summary.fee),
        summary.outputs.len()
    ));
    for (i, o) in summary.outputs.iter().enumerate() {
        line(&format!(
            "  output[{i}] {:>10} ZEC  pool={:<11} to {}  [{}{}{}]",
            zec(o.value),
            o.pool,
            short(o.recipient.as_deref()),
            if o.verified { "verified" } else { "UNVERIFIED" },
            if o.is_change { ", change" } else { "" },
            if o.is_ours && !o.is_change { ", self" } else { "" },
        ));
    }
    if let Some(m) = &summary.migration {
        line(&format!(
            "  ⇒ MIGRATION recognised: amount {} ZEC, to_self={}, clean_path_a={}",
            zec(m.amount),
            m.to_self,
            m.is_clean_path_a
        ));
    }
}

/// Narrate a Layer-B validate result in plain terms.
fn narrate_validate<E: std::fmt::Display>(result: &Result<(), E>) {
    match result {
        Ok(()) => line("validate → Ok  (Layer B would allow signing)"),
        Err(e) => line(&format!("validate → REJECTED  (Layer B refuses to sign): {e}")),
    }
}

/// A well-formed bridge deposit under our own key must validate cleanly.
#[test]
fn honest_pczt_is_accepted() {
    case(
        "honest_pczt_is_accepted",
        "spend our own notes to pay a bridge + change back to us — nothing malicious",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("honest_bridge_deposit");
    line("fixture: honest_bridge_deposit.pczt (spend 100k ours → bridge 50k + change 40k, fee 10k)");

    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_ok(),
        "a well-formed PCZT spending only our notes must validate"
    );
    verdict("baseline: a safe, well-formed transaction is ACCEPTED (the gate doesn't over-block)");
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
    case(
        "spoofed_recipient_is_surfaced",
        "the site CLAIMS it pays the bridge, but the PCZT really pays an attacker",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("spoof_recipient");
    line("fixture: spoof_recipient.pczt (a consistent PCZT that actually pays the attacker 90k)");

    let summary = pczt_describe_inner(Network::from_str("test").unwrap(), pczt.clone(), &ufvk)
        .expect("describe must succeed and surface the real outputs");
    narrate_describe(&summary);
    line(&format!("expected true payee (attacker) = {}", short(Some(&attacker_addr()))));

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
    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_ok(),
        "a consistent PCZT validates; the describe-vs-signDetails diff lives in the Snap layer"
    );
    verdict("describe REVEALS the attacker as the true payee — the user/Snap can catch the lie");
}

/// A PCZT that spends a note NOT under our UFVK must never be co-signed.
#[test]
fn foreign_input_is_rejected() {
    case(
        "foreign_input_is_rejected",
        "the PCZT spends a shielded note that is NOT ours — signing would co-sign a stranger's spend",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("foreign_input");
    line("fixture: foreign_input.pczt (spends a note under the FOREIGN key)");

    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_err(),
        "must refuse to sign inputs that are not under the user's UFVK"
    );
    verdict("a foreign shielded input is REJECTED (Err is the correct, safe outcome)");
}

/// An unprovable output (no OVK data and no note plaintext) must be refused
/// rather than displayed as if it were attested.
#[test]
fn unprovable_output_is_refused() {
    case(
        "unprovable_output_is_refused",
        "an output whose commitment can't be recomputed (its secret randomness was stripped)",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("unprovable_output");
    line("fixture: unprovable_output.pczt (honest-shaped, then the output's rseed is redacted)");

    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_err(),
        "refusing is the safe failure mode when the Snap cannot attest to an output"
    );
    verdict("an output the Snap cannot PROVE is REJECTED (never shown as if attested)");
}

/// The bridge's Orchard address, encoded as `pczt_describe_inner` encodes a
/// recovered Orchard/Ironwood recipient (a UA with only an Orchard receiver —
/// Ironwood reuses the Orchard UA receiver).
fn bridge_orchard_addr() -> String {
    let network = Network::from_str("test").expect("valid network");
    let ofvk = ufvk_for_seed(BRIDGE_SEED)
        .orchard()
        .expect("UFVK has an Orchard key")
        .clone();
    let addr = ofvk.address_at(0u32, orchard::keys::Scope::External);
    UnifiedAddress::from_receivers(Some(addr), None, None)
        .expect("orchard-only UA")
        .encode(&network)
}

/// NU6.3 Ironwood: an honest Ironwood-pool payment under our key must be
/// described as an `ironwood`-pool output (commitment-bound), surface the true
/// recipient, and validate. This exercises the `.with_ironwood()` describe arm —
/// the Ironwood analogue of `honest_pczt_is_accepted` — proving Ironwood is
/// walked by the same trusted-display path as Orchard.
#[test]
fn ironwood_payment_is_described_and_accepted() {
    case(
        "ironwood_payment_is_described_and_accepted",
        "NU6.3: value goes into the Ironwood pool, paying a FOREIGN address (the bridge)",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("honest_ironwood");
    line("fixture: honest_ironwood.pczt (spend our v3 note → pay bridge 90k, fee 10k)");

    let summary = pczt_describe_inner(Network::from_str("test").unwrap(), pczt.clone(), &ufvk)
        .expect("describe must succeed on an Ironwood PCZT");
    narrate_describe(&summary);

    let ironwood_outs: Vec<_> = summary.outputs.iter().filter(|o| o.pool == "ironwood").collect();
    assert_eq!(
        ironwood_outs.len(),
        1,
        "expected exactly one ironwood-pool output"
    );
    assert!(
        ironwood_outs
            .iter()
            .any(|o| o.recipient.as_deref() == Some(bridge_orchard_addr().as_str())),
        "describe must surface the true Ironwood recipient"
    );
    assert!(
        ironwood_outs.iter().all(|o| o.verified),
        "the Ironwood output must be commitment-bound (verified)"
    );

    // Path-A migration recognition: this PCZT moves value into Ironwood, so it
    // must be flagged as a migration for the migrated amount. This fixture pays the
    // bridge (a FOREIGN address), so `to_self` must be false — the red-flag path the
    // consent dialog warns loudly about.
    let migration = summary
        .migration
        .as_ref()
        .expect("a PCZT with an Ironwood output must be recognised as a migration");
    assert_eq!(
        migration.amount, 90_000,
        "the migration amount must equal the Ironwood output value"
    );
    assert!(
        !migration.to_self,
        "migrating to the bridge (a foreign address) must NOT be flagged as self-migration"
    );

    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_ok(),
        "a balanced Ironwood spend under our key must validate"
    );
    verdict("Ironwood output is described + verified; migration to a FOREIGN address flagged (to_self=false)");
}

/// NU6.3 Path-A self-migration: the whole balance moves into a single Ironwood
/// output paying our OWN address. `describe` must recognise a clean Path-A
/// migration (`to_self = true`, `is_clean_path_a = true`) for the migrated amount,
/// and the balanced transaction must validate.
#[test]
fn self_migration_is_recognized() {
    case(
        "self_migration_is_recognized",
        "NU6.3 Path-A: move funds into Ironwood paying our OWN address (a self-migration)",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("self_migrate_ironwood");
    line("fixture: self_migrate_ironwood.pczt (Ironwood output → our own address, fee 10k)");

    let summary = pczt_describe_inner(Network::from_str("test").unwrap(), pczt.clone(), &ufvk)
        .expect("describe must succeed on a self-migration PCZT");
    narrate_describe(&summary);

    let migration = summary
        .migration
        .as_ref()
        .expect("an Ironwood-output PCZT must be recognised as a migration");
    assert_eq!(migration.amount, 90_000, "migrated amount = Ironwood output value");
    assert!(
        migration.to_self,
        "migrating to our own address must be flagged as a self-migration"
    );
    assert!(
        migration.is_clean_path_a,
        "one Ironwood output, no third-party outputs = a clean Path-A migration"
    );
    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_ok(),
        "a balanced self-migration under our key must validate"
    );
    verdict("recognised as a clean Path-A SELF-migration (to_self=true, clean_path_a=true)");
}

/// NU6.3 Path-A **turnstile** migration — the real cross-pool shape: an Orchard
/// bundle spending our note (value leaving Orchard) + an Ironwood bundle with one
/// output paying our own address (value entering Ironwood), netting a fee. This is
/// the closest faithful test to what the Snap sees for a live migration. `describe`
/// must count the Orchard spend as input and the Ironwood output as output, produce
/// the correct fee, recognise a clean self-migration, and `validate` must accept.
#[test]
fn turnstile_migration_end_to_end() {
    case(
        "turnstile_migration_end_to_end",
        "the REAL migration: an Orchard spend (out) + an Ironwood output (in), one v6 tx",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("turnstile_migration");
    line("fixture: turnstile_migration.pczt (Orchard spend 100k → Ironwood 90k to us, fee 10k)");

    let summary = pczt_describe_inner(Network::from_str("test").unwrap(), pczt.clone(), &ufvk)
        .expect("describe must succeed on a turnstile migration PCZT");
    narrate_describe(&summary);

    // Value crosses the turnstile: 100_000 spent from Orchard, 90_000 into Ironwood,
    // 10_000 fee. This IS the turnstile value identity the validator checks.
    assert_eq!(summary.total_in, 100_000, "the Orchard spend is our input");
    assert_eq!(summary.total_out, 90_000, "the Ironwood output is the migrated value");
    assert_eq!(summary.fee, 10_000, "fee = Orchard out − Ironwood in");

    // Exactly one displayed output: the Ironwood note, to us, commitment-bound.
    assert_eq!(summary.outputs.len(), 1, "only the Ironwood output is displayed");
    let out = &summary.outputs[0];
    assert_eq!(out.pool, "ironwood");
    assert!(out.is_ours, "the migration output pays our own address");
    assert!(out.verified, "the Ironwood output must be commitment-bound");

    // Recognised as a clean Path-A self-migration.
    let m = summary
        .migration
        .as_ref()
        .expect("a cross-pool Orchard→Ironwood tx must be recognised as a migration");
    assert_eq!(m.amount, 90_000);
    assert!(m.to_self, "migrating to our own address is a self-migration");
    assert!(m.is_clean_path_a, "one Ironwood output, no third-party outputs");

    // Layer B accepts the turnstile: spends ours, balances, verified, fee in band.
    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_ok(),
        "a well-formed turnstile migration under our key must validate"
    );
    verdict("full Orchard→Ironwood migration: in/out/fee correct, self-migration, ACCEPTED");
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
    case(
        "transparent_input_under_our_key_is_accepted",
        "spend OUR OWN transparent coin (attributed viewing-key-only) and pay the bridge",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("honest_transparent");
    line("fixture: honest_transparent.pczt (spend our t-coin 100k → bridge 90k, fee 10k)");

    let summary = pczt_describe_inner(Network::from_str("test").unwrap(), pczt.clone(), &ufvk)
        .expect("describe must succeed on a transparent PCZT");
    narrate_describe(&summary);
    line(&format!("expected bridge t-address = {}", short(Some(&bridge_taddr()))));
    assert!(
        summary
            .outputs
            .iter()
            .any(|o| o.recipient.as_deref() == Some(bridge_taddr().as_str()) && !o.is_change),
        "describe must surface the true transparent recipient from the output script"
    );
    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_ok(),
        "a transparent input re-derivable from our UFVK must be attributed and accepted"
    );
    verdict("our own transparent coin is attributed + accepted, real recipient surfaced");
}

/// A transparent spend of a coin under a FOREIGN key must never be co-signed:
/// our UFVK cannot re-derive its pubkey, so the spend is unattributable.
#[test]
fn foreign_transparent_input_is_rejected() {
    case(
        "foreign_transparent_input_is_rejected",
        "the PCZT spends a transparent coin that is NOT ours (our key can't re-derive it)",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("foreign_transparent");
    line("fixture: foreign_transparent.pczt (spends a coin under the FOREIGN key)");

    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_err(),
        "a transparent input not re-derivable from our UFVK must be refused"
    );
    verdict("a foreign transparent input is REJECTED (unattributable ⇒ unsafe to co-sign)");
}

/// A Sapling spend under our key with a payment + change output: `describe` must
/// distinguish the internal-scope change from the external payment, and the
/// balanced transaction must validate.
#[test]
fn sapling_change_is_detected() {
    case(
        "sapling_change_is_detected",
        "a Sapling spend with one payment out + one change output back to us",
    );
    let ufvk = our_ufvk();
    let pczt = load_pczt("sapling_change");
    line("fixture: sapling_change.pczt (spend 100k → bridge 50k + internal change 40k, fee 10k)");

    let summary = pczt_describe_inner(Network::from_str("test").unwrap(), pczt.clone(), &ufvk)
        .expect("describe must succeed on a Sapling PCZT");
    narrate_describe(&summary);
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
    let result = pczt_validate_inner(Network::from_str("test").unwrap(), pczt, &ufvk);
    narrate_validate(&result);
    assert!(
        result.is_ok(),
        "a balanced Sapling spend under our key must validate"
    );
    verdict("change (internal scope) is told apart from the external payment; ACCEPTED");
}


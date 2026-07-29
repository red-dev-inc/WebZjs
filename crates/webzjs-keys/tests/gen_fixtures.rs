// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

//! Generator for the spoof-PCZT regression fixtures consumed by
//! `tests/spoof_pczt.rs`.
//!
//! This is **not a test of behaviour** — it is a committed, deterministic tool
//! that (re)produces the binary `tests/fixtures/*.pczt` files. It stays
//! `#[ignore]`d so it never runs in the normal suite; regenerate the fixtures
//! with:
//!
//!     cargo test -p webzjs-keys --test gen_fixtures -- --ignored
//!
//! ## How the fixtures are built
//!
//! All four are Orchard-only PCZTs on the `"test"` network. We build the Orchard
//! bundle directly via `orchard::builder::Builder` (no proving keys — describe /
//! validate use the `Verifier` role, which never checks the zk-proof), wrap it
//! into a `pczt::Pczt` via `Creator::build_from_parts`, and serialize. The
//! Merkle witness is synthesized by hand (`MerklePath::from_parts` + a
//! self-consistent anchor), since on-chain tree membership is irrelevant to the
//! trusted-display logic.
//!
//! Keys are ZIP-32 UFVKs derived from fixed 32-byte seeds so both this generator
//! and `spoof_pczt.rs` agree on the addresses without hardcoding strings.

use orchard::builder::{Builder, BundleType};
use orchard::bundle::BundleVersion;
use orchard::keys::{FullViewingKey, OutgoingViewingKey, Scope};
use orchard::note::{ExtractedNoteCommitment, Note, RandomSeed, Rho};
use orchard::tree::{Anchor, MerkleHashOrchard, MerklePath};
use orchard::value::NoteValue;
use orchard::Address;

use pczt::roles::creator::Creator;
use pczt::roles::redactor::Redactor;

use rand::rngs::StdRng;
use rand::{RngCore, SeedableRng};

use webzjs_common::Network;
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_primitives::transaction::builder::PcztParts;
use zcash_primitives::transaction::TxVersion;
use zcash_protocol::consensus::{BlockHeight, BranchId, NetworkConstants, Parameters};
use zcash_protocol::value::Zatoshis;

use zcash_transparent::address::TransparentAddress;
use zcash_transparent::builder::TransparentBuilder;
use zcash_transparent::bundle::{OutPoint, TxOut};
use zcash_transparent::keys::{AccountPubKey, NonHardenedChildIndex, TransparentKeyScope};
use zcash_transparent::pczt::Bip32Derivation;
use zip32::fingerprint::SeedFingerprint;

/// Fixed seeds (shared with `spoof_pczt.rs`). `OUR_SEED` is the key the Snap
/// holds; the others stand in for third parties.
const OUR_SEED: &[u8; 32] = &[0x01; 32];
const ATTACKER_SEED: &[u8; 32] = &[0x02; 32];
const BRIDGE_SEED: &[u8; 32] = &[0x03; 32];
const FOREIGN_SEED: &[u8; 32] = &[0x04; 32];

/// Derive the Orchard full viewing key for a seed on the test network.
fn orchard_fvk(seed: &[u8; 32]) -> FullViewingKey {
    UnifiedSpendingKey::from_seed(
        &Network::TestNetwork,
        seed,
        zip32::AccountId::try_from(0).unwrap(),
    )
    .expect("derive USK from seed")
    .to_unified_full_viewing_key()
    .orchard()
    .expect("UFVK has an Orchard key")
    .clone()
}

/// A spendable note owned by `fvk`, of the given value, at the given note-plaintext
/// version (V2 = Orchard pool, V3 = NU6.3 Ironwood pool).
fn make_note_versioned(
    rng: &mut StdRng,
    fvk: &FullViewingKey,
    value: u64,
    version: orchard::note::NoteVersion,
) -> Note {
    let recipient = fvk.address_at(0u32, Scope::External);
    // A small canonical field element is a fine `rho` for an off-chain note.
    let mut rho_bytes = [0u8; 32];
    rho_bytes[0] = 7;
    let rho = Rho::from_bytes(&rho_bytes).into_option().expect("valid rho");
    loop {
        let mut rseed_bytes = [0u8; 32];
        rng.fill_bytes(&mut rseed_bytes);
        let rseed = match RandomSeed::from_bytes(rseed_bytes, &rho).into_option() {
            Some(rseed) => rseed,
            None => continue,
        };
        if let Some(note) =
            Note::from_parts(recipient, NoteValue::from_raw(value), rho, rseed, version)
                .into_option()
        {
            break note;
        }
    }
}

/// A spendable Orchard (V2) note owned by `fvk`.
fn make_note(rng: &mut StdRng, fvk: &FullViewingKey, value: u64) -> Note {
    make_note_versioned(rng, fvk, value, orchard::note::NoteVersion::V2)
}

/// Build an Orchard-only PCZT spending one note under `spend_fvk` and creating
/// the given outputs.
fn make_orchard_pczt(
    rng: &mut StdRng,
    spend_fvk: &FullViewingKey,
    spend_value: u64,
    outputs: &[(Option<OutgoingViewingKey>, Address, u64)],
) -> pczt::Pczt {
    let note = make_note(rng, spend_fvk, spend_value);
    let cmx: ExtractedNoteCommitment = note.commitment().into();

    // Synthesize a self-consistent witness: arbitrary siblings, anchor computed
    // from them. (The Verifier never checks tree membership.)
    let sibling = MerkleHashOrchard::from_cmx(&cmx);
    let path = MerklePath::from_parts(0, [sibling; 32]);
    let anchor = path.root(cmx);

    // orchard 0.15 (NU6.3): Builder::new now takes the bundle version (Orchard v2 here,
    // i.e. the pre-Ironwood pool) and its flags, and is fallible.
    let mut builder = Builder::new(
        BundleType::DEFAULT,
        BundleVersion::orchard_v2(),
        BundleVersion::orchard_v2().default_flags(),
        anchor,
    )
    .expect("Builder::new");
    builder
        .add_spend(spend_fvk.clone(), note, path)
        .expect("add_spend");
    for (ovk, recipient, value) in outputs {
        builder
            .add_output(ovk.clone(), *recipient, NoteValue::from_raw(*value), [0u8; 512])
            .expect("add_output");
    }

    let (bundle, _meta) = builder.build_for_pczt(&mut *rng).expect("build_for_pczt");

    let parts = PcztParts {
        params: Network::TestNetwork,
        version: TxVersion::V5,
        consensus_branch_id: BranchId::Nu5,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(0),
        transparent: None,
        sapling: None,
        orchard: Some(bundle),
        ironwood: None,
    };
    Creator::build_from_parts(parts).expect("build_from_parts (V5 is PCZT-compatible)")
}

/// Build an Ironwood-only (NU6.3, v6) PCZT spending one V3 note under `spend_fvk`
/// and creating the given outputs. Mirrors `make_orchard_pczt` but targets the
/// Ironwood pool: `BundleVersion::ironwood_v3()`, tx version V6, branch Nu6_3, and
/// the bundle placed in `PcztParts.ironwood`. Exercises the `.with_ironwood()`
/// describe/validate arm and `sign_ironwood`.
fn make_ironwood_pczt(
    rng: &mut StdRng,
    spend_fvk: &FullViewingKey,
    spend_value: u64,
    outputs: &[(Option<OutgoingViewingKey>, Address, u64)],
) -> pczt::Pczt {
    let note = make_note_versioned(rng, spend_fvk, spend_value, orchard::note::NoteVersion::V3);
    let cmx: ExtractedNoteCommitment = note.commitment().into();

    let sibling = MerkleHashOrchard::from_cmx(&cmx);
    let path = MerklePath::from_parts(0, [sibling; 32]);
    let anchor = path.root(cmx);

    let mut builder = Builder::new(
        BundleType::DEFAULT,
        BundleVersion::ironwood_v3(),
        BundleVersion::ironwood_v3().default_flags(),
        anchor,
    )
    .expect("Builder::new (ironwood)");
    builder
        .add_spend(spend_fvk.clone(), note, path)
        .expect("add_spend");
    for (ovk, recipient, value) in outputs {
        builder
            .add_output(ovk.clone(), *recipient, NoteValue::from_raw(*value), [0u8; 512])
            .expect("add_output");
    }

    let (bundle, _meta) = builder.build_for_pczt(&mut *rng).expect("build_for_pczt");

    let parts = PcztParts {
        params: Network::TestNetwork,
        version: TxVersion::V6,
        consensus_branch_id: BranchId::Nu6_3,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(0),
        transparent: None,
        sapling: None,
        orchard: None,
        ironwood: Some(bundle),
    };
    Creator::build_from_parts(parts).expect("build_from_parts (ironwood-only V6)")
}

/// Build a **turnstile** Path-A migration PCZT (NU6.3, v6) — the real migration
/// shape: an **Orchard** bundle spending one of our Orchard (V2) notes (value
/// *leaving* Orchard → positive Orchard value balance) plus an **Ironwood** bundle
/// with a single output (value *entering* Ironwood → negative Ironwood value
/// balance), the two netting to a ZIP-317 fee. Unlike `make_ironwood_pczt` (a
/// single-pool Ironwood tx), this crosses Orchard→Ironwood in one transaction,
/// exactly as a ZIP-318 Path-A migration does.
fn make_turnstile_migration_pczt(
    rng: &mut StdRng,
    spend_fvk: &FullViewingKey,
    spend_value: u64,
    out_ovk: Option<OutgoingViewingKey>,
    out_addr: Address,
    out_value: u64,
) -> pczt::Pczt {
    // --- Orchard side: spend one of our notes, no output. ---
    let note = make_note(rng, spend_fvk, spend_value); // V2 Orchard note
    let cmx: ExtractedNoteCommitment = note.commitment().into();
    let sibling = MerkleHashOrchard::from_cmx(&cmx);
    let path = MerklePath::from_parts(0, [sibling; 32]);
    let anchor = path.root(cmx);
    let mut orchard_builder = Builder::new(
        BundleType::DEFAULT,
        BundleVersion::orchard_v2(),
        BundleVersion::orchard_v2().default_flags(),
        anchor,
    )
    .expect("orchard Builder::new");
    orchard_builder
        .add_spend(spend_fvk.clone(), note, path)
        .expect("add_spend");
    let (orchard_bundle, _) = orchard_builder
        .build_for_pczt(&mut *rng)
        .expect("orchard build_for_pczt");

    // --- Ironwood side: a single output, no spend (anchor unused w/o spends). ---
    let mut iw_builder = Builder::new(
        BundleType::DEFAULT,
        BundleVersion::ironwood_v3(),
        BundleVersion::ironwood_v3().default_flags(),
        Anchor::empty_tree(),
    )
    .expect("ironwood Builder::new");
    iw_builder
        .add_output(out_ovk, out_addr, NoteValue::from_raw(out_value), [0u8; 512])
        .expect("add_output");
    let (iw_bundle, _) = iw_builder
        .build_for_pczt(&mut *rng)
        .expect("ironwood build_for_pczt");

    let parts = PcztParts {
        params: Network::TestNetwork,
        version: TxVersion::V6,
        consensus_branch_id: BranchId::Nu6_3,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(0),
        transparent: None,
        sapling: None,
        orchard: Some(orchard_bundle),
        ironwood: Some(iw_bundle),
    };
    Creator::build_from_parts(parts).expect("build_from_parts (turnstile v6)")
}

/// Hardened-derivation flag for raw BIP-32 path components.
const HARDENED: u32 = 0x8000_0000;

/// Derive the transparent account pubkey (ZIP-32 transparent component) for a seed.
fn transparent_apk(seed: &[u8; 32]) -> AccountPubKey {
    UnifiedSpendingKey::from_seed(
        &Network::TestNetwork,
        seed,
        zip32::AccountId::try_from(0).unwrap(),
    )
    .expect("derive USK from seed")
    .to_unified_full_viewing_key()
    .transparent()
    .expect("UFVK has a transparent key")
    .clone()
}

/// The external address-0 P2PKH key + address for a seed's transparent account.
fn transparent_addr0(seed: &[u8; 32]) -> (secp256k1::PublicKey, TransparentAddress) {
    let pk = transparent_apk(seed)
        .derive_address_pubkey(
            TransparentKeyScope::EXTERNAL,
            NonHardenedChildIndex::from_index(0).unwrap(),
        )
        .expect("derive external/0 pubkey");
    (pk, TransparentAddress::from_pubkey(&pk))
}

/// Build a transparent-only PCZT that spends one P2PKH coin owned by `spend_seed`
/// (`m/44'/<coin>'/0'/0/0`) and pays `recipient`. The input's `bip32_derivation` is
/// populated (as a real Updater would), which is what lets `pczt_describe` /
/// `pczt_validate` attribute the spend to a UFVK without the seed.
fn make_transparent_pczt(
    spend_seed: &[u8; 32],
    spend_value: u64,
    recipient: &TransparentAddress,
    out_value: u64,
) -> pczt::Pczt {
    let coin_type = Network::TestNetwork.network_type().coin_type();
    let (pk, taddr) = transparent_addr0(spend_seed);

    // The coin being spent: a P2PKH output paying our own address.
    let coin = TxOut::new(Zatoshis::from_u64(spend_value).unwrap(), taddr.script().into());
    let utxo = OutPoint::new([0u8; 32], 0);

    let mut builder = TransparentBuilder::empty();
    builder.add_p2pkh_input(pk, utxo, coin).expect("add p2pkh input");
    builder
        .add_output(recipient, Zatoshis::from_u64(out_value).unwrap())
        .expect("add transparent output");

    let mut bundle = builder.build_for_pczt().expect("transparent pczt bundle");

    // Populate the input's BIP-32 derivation (`m/44'/coin'/0'/0/0`). The recorded
    // seed fingerprint is what a real wallet's Updater would write; our validator
    // ignores it and re-derives from the UFVK, but we set it for realism.
    let seed_fp = SeedFingerprint::from_seed(spend_seed).expect("seed fingerprint");
    let path = vec![44 | HARDENED, coin_type | HARDENED, 0 | HARDENED, 0, 0];
    let deriv = Bip32Derivation::parse(seed_fp.to_bytes(), path).expect("derivation");
    bundle
        .update_with(|mut u| {
            u.update_input_with(0, |mut iu| {
                iu.set_bip32_derivation(pk.serialize(), deriv);
                Ok(())
            })
        })
        .expect("inject bip32_derivation");

    let parts = PcztParts {
        params: Network::TestNetwork,
        version: TxVersion::V5,
        consensus_branch_id: BranchId::Nu5,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(0),
        transparent: Some(bundle),
        sapling: None,
        orchard: None,
        ironwood: None,
    };
    Creator::build_from_parts(parts).expect("build_from_parts (transparent-only)")
}

/// Derive the sapling diversifiable FVK for a seed on the test network.
fn sapling_dfvk(seed: &[u8; 32]) -> sapling::zip32::DiversifiableFullViewingKey {
    UnifiedSpendingKey::from_seed(
        &Network::TestNetwork,
        seed,
        zip32::AccountId::try_from(0).unwrap(),
    )
    .expect("derive USK from seed")
    .to_unified_full_viewing_key()
    .sapling()
    .expect("UFVK has a Sapling key")
    .clone()
}

/// A spendable sapling note owned by `dfvk` (external address 0).
fn make_sapling_note(
    rng: &mut StdRng,
    dfvk: &sapling::zip32::DiversifiableFullViewingKey,
    value: u64,
) -> sapling::Note {
    let recipient = dfvk.default_address().1;
    let mut rseed = [0u8; 32];
    rng.fill_bytes(&mut rseed);
    sapling::Note::from_parts(
        recipient,
        sapling::value::NoteValue::from_raw(value),
        sapling::note::Rseed::AfterZip212(rseed),
    )
}

/// Build a Sapling-only PCZT spending one note under `spend_dfvk` and creating the
/// given outputs. The witness/anchor are synthesized self-consistently (the
/// Verifier role never checks tree membership), mirroring `make_orchard_pczt`.
fn make_sapling_pczt(
    rng: &mut StdRng,
    spend_dfvk: &sapling::zip32::DiversifiableFullViewingKey,
    spend_value: u64,
    outputs: &[(sapling::keys::OutgoingViewingKey, sapling::PaymentAddress, u64)],
) -> pczt::Pczt {
    let note = make_sapling_note(rng, spend_dfvk, spend_value);
    let node = sapling::Node::from_cmu(&note.cmu());
    let path =
        sapling::MerklePath::from_parts(vec![node; 32], 0u64.into()).expect("32-element merkle path");
    let anchor = sapling::Anchor::from(path.root(node));

    let mut builder = sapling::builder::Builder::new(
        sapling::note_encryption::Zip212Enforcement::On,
        sapling::builder::BundleType::DEFAULT,
        anchor,
    );
    builder
        .add_spend(spend_dfvk.fvk().clone(), note, path)
        .expect("add_spend");
    for (ovk, to, value) in outputs {
        builder
            .add_output(
                Some(ovk.clone()),
                *to,
                sapling::value::NoteValue::from_raw(*value),
                [0u8; 512],
            )
            .expect("add_output");
    }

    let (bundle, _meta) = builder.build_for_pczt(&mut *rng).expect("build_for_pczt");

    let parts = PcztParts {
        params: Network::TestNetwork,
        version: TxVersion::V5,
        consensus_branch_id: BranchId::Nu5,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(0),
        transparent: None,
        sapling: Some(bundle),
        orchard: None,
        ironwood: None,
    };
    Creator::build_from_parts(parts).expect("build_from_parts (sapling-only)")
}

fn write_fixture(name: &str, pczt: &pczt::Pczt) {
    let path = format!("{}/tests/fixtures/{}.pczt", env!("CARGO_MANIFEST_DIR"), name);
    let bytes = pczt.clone().serialize().expect("serialize pczt");
    std::fs::write(&path, bytes).unwrap_or_else(|e| panic!("write {path}: {e}"));
    eprintln!("wrote {path}");
}

#[test]
#[ignore = "run with --ignored to (re)generate tests/fixtures/*.pczt"]
fn generate_fixtures() {
    let mut rng = StdRng::seed_from_u64(0xC0FFEE);

    let our = orchard_fvk(OUR_SEED);
    let attacker = orchard_fvk(ATTACKER_SEED);
    let bridge = orchard_fvk(BRIDGE_SEED);
    let foreign = orchard_fvk(FOREIGN_SEED);

    let our_ext_ovk = our.to_ovk(Scope::External);
    let our_int_ovk = our.to_ovk(Scope::Internal);
    let our_change_addr = our.address_at(0u32, Scope::Internal);
    let bridge_addr = bridge.address_at(0u32, Scope::External);
    let attacker_addr = attacker.address_at(0u32, Scope::External);

    // honest_bridge_deposit: spend 100_000 of ours → pay bridge 50_000, change
    // 40_000 back to our internal address, leaving a 10_000 ZIP-317 fee.
    let honest = make_orchard_pczt(
        &mut rng,
        &our,
        100_000,
        &[
            (Some(our_ext_ovk.clone()), bridge_addr, 50_000),
            (Some(our_int_ovk.clone()), our_change_addr, 40_000),
        ],
    );
    write_fixture("honest_bridge_deposit", &honest);

    // spoof_recipient: a fully consistent PCZT that pays the ATTACKER 90_000
    // (fee 10_000). describe surfaces the attacker (all verified); the inner
    // validator accepts it — the spoof is caught by the Snap glue-layer diff
    // (describe output vs the dApp's signDetails), not here.
    let spoof = make_orchard_pczt(
        &mut rng,
        &our,
        100_000,
        &[(Some(our_ext_ovk.clone()), attacker_addr, 90_000)],
    );
    write_fixture("spoof_recipient", &spoof);

    // foreign_input: spends a note that is NOT under our UFVK.
    let foreign_pczt = make_orchard_pczt(
        &mut rng,
        &foreign,
        100_000,
        &[(Some(foreign.to_ovk(Scope::External)), bridge_addr, 90_000)],
    );
    write_fixture("foreign_input", &foreign_pczt);

    // unprovable_output: honest-shaped, then strip the output's rseed so its
    // commitment can no longer be recomputed (verify_note_commitment fails).
    let base = make_orchard_pczt(
        &mut rng,
        &our,
        100_000,
        &[(Some(our_ext_ovk.clone()), bridge_addr, 90_000)],
    );
    let unprovable = Redactor::new(base)
        .redact_orchard_with(|mut o| {
            o.redact_action(0, |mut a| a.clear_output_rseed());
        })
        .finish();
    write_fixture("unprovable_output", &unprovable);

    // --- Transparent fixtures (pool coverage for the global attribution fix) ---
    let (_bridge_pk, bridge_taddr) = transparent_addr0(BRIDGE_SEED);

    // honest_transparent: spend 100_000 of OUR t-coin → pay the bridge 90_000,
    // 10_000 ZIP-317 fee. The input is under our key, so it must validate and
    // `describe` must surface the bridge t-address.
    let honest_t = make_transparent_pczt(OUR_SEED, 100_000, &bridge_taddr, 90_000);
    write_fixture("honest_transparent", &honest_t);

    // foreign_transparent: the spent coin belongs to a FOREIGN key (not ours), so
    // our UFVK cannot re-derive its pubkey → the spend is unattributable → reject.
    let foreign_t = make_transparent_pczt(FOREIGN_SEED, 100_000, &bridge_taddr, 90_000);
    write_fixture("foreign_transparent", &foreign_t);

    // --- Sapling fixture (pool coverage + change detection) ---
    let our_s = sapling_dfvk(OUR_SEED);
    let bridge_s = sapling_dfvk(BRIDGE_SEED);
    let bridge_s_addr = bridge_s.default_address().1; // external payee
    let our_s_change = our_s.change_address().1; // internal change address

    // sapling_change: spend 100_000 of ours → pay bridge 50_000 (external) and
    // 40_000 change back to our internal address, 10_000 ZIP-317 fee. `describe`
    // must flag the internal output as change and the bridge output as a payment.
    let sapling = make_sapling_pczt(
        &mut rng,
        &our_s,
        100_000,
        &[
            (our_s.to_ovk(zip32::Scope::External), bridge_s_addr, 50_000),
            (our_s.to_ovk(zip32::Scope::Internal), our_s_change, 40_000),
        ],
    );
    write_fixture("sapling_change", &sapling);

    // --- Ironwood fixtures (NU6.3). Generated LAST so the RNG sequence for every
    // fixture above is unchanged (the shared `rng` is consumed in order; inserting
    // these earlier would reshuffle later bundles' action layout — e.g. move
    // `unprovable_output`'s real output off action index 0). ---

    // honest_ironwood: the Ironwood-pool analogue of honest_bridge_deposit — spend
    // 100_000 of our Ironwood note, pay the bridge 90_000, 10_000 ZIP-317 fee.
    // Exercises the `.with_ironwood()` describe/validate arm and `sign_ironwood`;
    // `describe` surfaces the bridge as an ironwood-pool payment (verified) and
    // recognises a migration to a FOREIGN address (`to_self = false`).
    let honest_iw = make_ironwood_pczt(
        &mut rng,
        &our,
        100_000,
        &[(Some(our_ext_ovk.clone()), bridge_addr, 90_000)],
    );
    write_fixture("honest_ironwood", &honest_iw);

    // self_migrate_ironwood: the realistic Path-A shape — the whole balance moves
    // into a single Ironwood output paying OUR OWN address (a self-migration),
    // 10_000 fee. `describe` must recognise a clean Path-A migration with
    // `to_self = true` and `is_clean_path_a = true`.
    let our_ext_addr = our.address_at(0u32, Scope::External);
    let self_migrate = make_ironwood_pczt(
        &mut rng,
        &our,
        100_000,
        &[(Some(our_ext_ovk.clone()), our_ext_addr, 90_000)],
    );
    write_fixture("self_migrate_ironwood", &self_migrate);

    // turnstile_migration: the REAL Path-A shape — an Orchard bundle spending
    // 100_000 of our Orchard note (leaving Orchard) + an Ironwood bundle with one
    // 90_000 output to our OWN address (entering Ironwood), netting a 10_000 fee.
    // `describe` must count the Orchard spend as input, the Ironwood output as
    // output, and recognise a clean self-migration; `validate` must accept it.
    let turnstile = make_turnstile_migration_pczt(
        &mut rng,
        &our,
        100_000,
        Some(our_ext_ovk.clone()),
        our_ext_addr,
        90_000,
    );
    write_fixture("turnstile_migration", &turnstile);
}

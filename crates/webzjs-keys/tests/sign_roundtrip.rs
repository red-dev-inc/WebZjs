//! Native reproduction of the "MissingSpendAuthSig" failure seen when the web
//! wallet broadcast a transaction the snap had signed after NU6.3.
//!
//! From NU6.3 the Orchard pool disallows cross-address transfers, so the builder
//! pairs every change output with a zero-valued spend at the wallet's own change
//! address. That spend has no dummy key and no ZIP 32 key path; it must be signed
//! by the account's spend authorizing key. This test follows the wallet's steps
//! (build, finalize IO, add the key path to the real spend, serialize, sign through
//! the snap's entry point, serialize again) and checks that every Orchard action
//! ends up signed.

use std::str::FromStr;

use orchard::builder::{Builder as OrchardBuilder, BundleType};
use orchard::bundle::BundleVersion;
use orchard::keys::Scope;
use orchard::note::{ExtractedNoteCommitment, Note, NoteVersion, RandomSeed, Rho};
use orchard::tree::{MerkleHashOrchard, MerklePath};
use orchard::value::NoteValue;
use orchard::Address;
use pczt::roles::{creator::Creator, io_finalizer::IoFinalizer, updater::Updater};
use rand::{rngs::StdRng, RngCore, SeedableRng};
use webzjs_common::Network;
use webzjs_keys::pczt_sign_inner;
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_primitives::transaction::{builder::PcztParts, TxVersion};
use zcash_protocol::consensus::{BlockHeight, BranchId, NetworkConstants, Parameters};

fn sig_map(p: &pczt::Pczt) -> Vec<bool> {
    p.orchard()
        .actions()
        .iter()
        .map(|a| a.spend().spend_auth_sig().is_some())
        .collect()
}

fn note_for(rng: &mut StdRng, recipient: Address, value: u64, version: NoteVersion) -> Note {
    let mut rho_bytes = [0u8; 32];
    rho_bytes[0] = 7;
    let rho = Rho::from_bytes(&rho_bytes)
        .into_option()
        .expect("valid rho");
    loop {
        let mut rseed_bytes = [0u8; 32];
        rng.fill_bytes(&mut rseed_bytes);
        if let Some(rseed) = RandomSeed::from_bytes(rseed_bytes, &rho).into_option() {
            if let Some(note) =
                Note::from_parts(recipient, NoteValue::from_raw(value), rho, rseed, version)
                    .into_option()
            {
                return note;
            }
        }
    }
}

/// Builds the Orchard-pool bundle the wallet produces when it spends one Orchard
/// note and keeps change: one real spend plus one change output. Under the NU6.3
/// rules the payment itself leaves through the value balance (to Ironwood or
/// transparent), so the Orchard bundle carries no plain output.
async fn run(label: &str, version: TxVersion, bundle_version: BundleVersion) {
    let net = Network::from_str("test").unwrap();
    let seed = [7u8; 32];
    let usk = UnifiedSpendingKey::from_seed(&net, &seed, zip32::AccountId::ZERO).unwrap();
    let ufvk = usk.to_unified_full_viewing_key();
    let fvk = ufvk.orchard().unwrap().clone();
    let seed_fp = zip32::fingerprint::SeedFingerprint::from_seed(&seed).unwrap();

    let mut rng = StdRng::seed_from_u64(1);
    let note = note_for(
        &mut rng,
        fvk.address_at(0u32, Scope::External),
        100_000,
        NoteVersion::V2,
    );
    let cmx: ExtractedNoteCommitment = note.commitment().into();
    let path = MerklePath::from_parts(0, [MerkleHashOrchard::from_cmx(&cmx); 32]);
    let anchor = path.root(cmx);

    let mut b = OrchardBuilder::new(
        BundleType::DEFAULT,
        bundle_version,
        bundle_version.default_flags(),
        anchor,
    )
    .unwrap();
    b.add_spend(fvk.clone(), note, path).unwrap();
    b.add_change_output(
        fvk.clone(),
        Some(fvk.to_ovk(Scope::Internal)),
        fvk.address_at(0u32, Scope::Internal),
        NoteValue::from_raw(25_000),
        [0; 512],
    )
    .unwrap();
    let (bundle, meta) = b.build_for_pczt(&mut rng).unwrap();

    let parts = PcztParts {
        params: net,
        version,
        consensus_branch_id: BranchId::Nu6_3,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(0),
        transparent: None,
        sapling: None,
        orchard: Some(bundle),
        ironwood: None,
    };
    let created = Creator::build_from_parts(parts).unwrap();
    println!("[{label}] after create:      sigs={:?}", sig_map(&created));

    let finalized = IoFinalizer::new(created).finalize_io().unwrap();
    println!(
        "[{label}] after finalize_io: sigs={:?}",
        sig_map(&finalized)
    );

    // What zcash_client_backend's create_pczt_from_proposal does: tag the real spends
    // only, never the change-paired spend.
    let spend_idx = meta.spend_action_index(0).unwrap();
    let coin_type = net.network_type().coin_type();
    let updated = Updater::new(finalized)
        .update_orchard_with(|mut u| {
            u.update_action_with(spend_idx, |mut a| {
                a.set_spend_zip32_derivation(
                    orchard::pczt::Zip32Derivation::parse(
                        seed_fp.to_bytes(),
                        vec![
                            zip32::ChildIndex::hardened(32).index(),
                            zip32::ChildIndex::hardened(coin_type).index(),
                            zip32::ChildIndex::hardened(0).index(),
                        ],
                    )
                    .unwrap(),
                );
                Ok(())
            })?;
            Ok(())
        })
        .unwrap()
        .finish();

    let bytes = updated.serialize().unwrap();
    let parsed = pczt::Pczt::parse(&bytes).unwrap();
    println!(
        "[{label}] after roundtrip:   sigs={:?} ({} bytes)",
        sig_map(&parsed),
        bytes.len()
    );

    let signed = pczt_sign_inner(net, parsed, usk, seed_fp).await.unwrap();
    println!("[{label}] after sign:        sigs={:?}", sig_map(&signed));

    let bytes2 = signed.serialize().unwrap();
    let signed2 = pczt::Pczt::parse(&bytes2).unwrap();
    println!(
        "[{label}] after sign rt:     sigs={:?} ({} bytes)",
        sig_map(&signed2),
        bytes2.len()
    );

    assert_eq!(
        sig_map(&signed2).len(),
        2,
        "[{label}] expected a spend action and a change action"
    );
    assert!(
        sig_map(&signed2).iter().all(|s| *s),
        "[{label}] some Orchard action is still unsigned: {:?}",
        sig_map(&signed2)
    );
}

#[tokio::test]
async fn nu63_orchard_pool_v5_signs_change_paired_spend() {
    run("v5/orchard_v3", TxVersion::V5, BundleVersion::orchard_v3()).await;
}

#[tokio::test]
async fn nu63_orchard_pool_v6_signs_change_paired_spend() {
    run("v6/orchard_v3", TxVersion::V6, BundleVersion::orchard_v3()).await;
}

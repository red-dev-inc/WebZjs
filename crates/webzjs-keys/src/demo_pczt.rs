// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

//! **Demo-only** (feature `demo-builder`). Builds the dialog-spoofing scenario for
//! the connected wallet's own identity, so the PoC dApp can show the real attack:
//!
//! A website asks the wallet to sign a payment and *claims* it pays the bridge.
//! For each pool we build two transactions that both spend the **connected
//! wallet's own coins** (so both are perfectly valid and pass `pczt_validate`):
//!   * `honest` — actually pays the bridge (matches the claim), and
//!   * `spoof`  — actually pays an **attacker** (the claim is a lie).
//!
//! `pczt_describe` recovers the *true* recipient in each case, which is what lets
//! the wallet catch the spoof — `validate` cannot, because a redirected-payment
//! transaction is still cryptographically valid.
//!
//! Needs only the UFVK (viewing key); the validator re-derives attribution from
//! it. Never compiled into the production Snap WASM (lean default build).

use crate::error::Error;
use crate::UnifiedFullViewingKey;
use std::str::FromStr;
use wasm_bindgen::prelude::*;

use rand::rngs::StdRng;
use rand::{RngCore, SeedableRng};
use serde::Serialize;

use orchard::builder::{Builder as OrchardBuilder, BundleType as OrchardBundleType};
use orchard::keys::{OutgoingViewingKey as OrchardOvk, Scope as OrchardScope};
use orchard::note::{ExtractedNoteCommitment, Note as OrchardNote, RandomSeed, Rho};
use orchard::tree::{MerkleHashOrchard, MerklePath as OrchardMerklePath};
use orchard::value::NoteValue as OrchardNoteValue;
use orchard::Address as OrchardAddress;

use pczt::roles::creator::Creator;
use zcash_keys::address::UnifiedAddress;
use zcash_keys::encoding::AddressCodec;
use zcash_keys::keys::{UnifiedFullViewingKey as InnerUfvk, UnifiedSpendingKey};
use zcash_primitives::transaction::builder::PcztParts;
use zcash_primitives::transaction::TxVersion;
use zcash_protocol::consensus::{BlockHeight, BranchId, NetworkConstants, Parameters};
use zcash_protocol::value::Zatoshis;
use webzjs_common::Network;

use zcash_transparent::address::TransparentAddress;
use zcash_transparent::bundle::{OutPoint, TxOut};
use zcash_transparent::builder::TransparentBuilder;
use zcash_transparent::keys::{NonHardenedChildIndex, TransparentKeyScope};
use zcash_transparent::pczt::Bip32Derivation;

/// The legitimate destination the dApp *claims* every payment goes to.
const BRIDGE_SEED: &[u8; 32] = &[0x03; 32];
/// Where the spoofed transactions actually send the money.
const ATTACKER_SEED: &[u8; 32] = &[0x02; 32];
const HARDENED: u32 = 0x8000_0000;
const SPEND_VALUE: u64 = 100_000;
const PAY_VALUE: u64 = 90_000; // leaves a 10_000 ZIP-317 fee

#[derive(Serialize)]
struct PoolDemo {
    /// Pays the bridge (matches the claim).
    honest: String,
    /// Pays the attacker (the claim is a lie).
    spoof: String,
    /// The bridge address the dApp claims to pay, encoded as `describe` encodes it.
    claimed: String,
}

#[derive(Serialize)]
struct DemoPczts {
    transparent: PoolDemo,
    sapling: PoolDemo,
    orchard: PoolDemo,
}

/// Build the spoof scenario (honest + spoof per pool) for `ufvk`. Demo-only.
#[wasm_bindgen]
pub fn build_owned_demo_pczts(
    network: &str,
    ufvk: &UnifiedFullViewingKey,
) -> Result<JsValue, Error> {
    let net = Network::from_str(network)?;
    let inner = ufvk.as_inner();
    let bridge = ufvk_from_seed(&net, BRIDGE_SEED)?;
    let attacker = ufvk_from_seed(&net, ATTACKER_SEED)?;

    let out = DemoPczts {
        transparent: transparent_demo(&net, inner, &bridge, &attacker)?,
        sapling: sapling_demo(&net, inner, &bridge, &attacker)?,
        orchard: orchard_demo(&net, inner, &bridge, &attacker)?,
    };
    serde_wasm_bindgen::to_value(&out).map_err(|e| Error::PcztDescribe(e.to_string()))
}

fn ufvk_from_seed(net: &Network, seed: &[u8; 32]) -> Result<InnerUfvk, Error> {
    let usk = UnifiedSpendingKey::from_seed(net, seed, zip32::AccountId::try_from(0).unwrap())
        .map_err(|e| Error::PcztDescribe(format!("USK from seed: {e:?}")))?;
    Ok(usk.to_unified_full_viewing_key())
}

fn to_hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 0xf) as usize] as char);
    }
    s
}

// ----------------------------- Transparent --------------------------------

fn transparent_demo(
    net: &Network,
    ufvk: &InnerUfvk,
    bridge: &InnerUfvk,
    attacker: &InnerUfvk,
) -> Result<PoolDemo, Error> {
    let bridge_addr = transparent_addr(bridge)?;
    let attacker_addr = transparent_addr(attacker)?;
    Ok(PoolDemo {
        honest: to_hex(&build_transparent(net, ufvk, &bridge_addr)?),
        spoof: to_hex(&build_transparent(net, ufvk, &attacker_addr)?),
        claimed: bridge_addr.encode(net),
    })
}

fn transparent_addr(ufvk: &InnerUfvk) -> Result<TransparentAddress, Error> {
    let pk = ufvk
        .transparent()
        .ok_or_else(|| Error::PcztDescribe("no transparent component".into()))?
        .derive_address_pubkey(
            TransparentKeyScope::EXTERNAL,
            NonHardenedChildIndex::from_index(0).unwrap(),
        )
        .map_err(|e| Error::PcztDescribe(format!("derive t-pubkey: {e:?}")))?;
    Ok(TransparentAddress::from_pubkey(&pk))
}

fn build_transparent(
    net: &Network,
    ufvk: &InnerUfvk,
    recipient: &TransparentAddress,
) -> Result<Vec<u8>, Error> {
    let apk = ufvk
        .transparent()
        .ok_or_else(|| Error::PcztDescribe("no transparent component".into()))?;
    let coin_type = net.network_type().coin_type();
    let pk = apk
        .derive_address_pubkey(
            TransparentKeyScope::EXTERNAL,
            NonHardenedChildIndex::from_index(0).unwrap(),
        )
        .map_err(|e| Error::PcztDescribe(format!("derive t-pubkey: {e:?}")))?;
    let taddr = TransparentAddress::from_pubkey(&pk);

    let coin = TxOut::new(Zatoshis::from_u64(SPEND_VALUE).unwrap(), taddr.script().into());
    let mut builder = TransparentBuilder::empty();
    builder
        .add_p2pkh_input(pk, OutPoint::new([0u8; 32], 0), coin)
        .map_err(|e| Error::PcztDescribe(format!("add input: {e:?}")))?;
    builder
        .add_output(recipient, Zatoshis::from_u64(PAY_VALUE).unwrap())
        .map_err(|e| Error::PcztDescribe(format!("add output: {e:?}")))?;
    let mut bundle = builder
        .build_for_pczt()
        .ok_or_else(|| Error::PcztDescribe("empty transparent bundle".into()))?;

    let path = vec![44 | HARDENED, coin_type | HARDENED, HARDENED, 0, 0];
    let deriv = Bip32Derivation::parse([0u8; 32], path)
        .map_err(|e| Error::PcztDescribe(format!("derivation: {e:?}")))?;
    bundle
        .update_with(|mut u| {
            u.update_input_with(0, |mut iu| {
                iu.set_bip32_derivation(pk.serialize(), deriv);
                Ok(())
            })
        })
        .map_err(|e| Error::PcztDescribe(format!("update: {e:?}")))?;

    finalize(PcztParts {
        params: *net,
        version: TxVersion::V5,
        consensus_branch_id: BranchId::Nu5,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(0),
        transparent: Some(bundle),
        sapling: None,
        orchard: None,
    })
}

// ------------------------------- Sapling ----------------------------------

fn sapling_demo(
    net: &Network,
    ufvk: &InnerUfvk,
    bridge: &InnerUfvk,
    attacker: &InnerUfvk,
) -> Result<PoolDemo, Error> {
    let bridge_addr = bridge
        .sapling()
        .ok_or_else(|| Error::PcztDescribe("bridge no sapling".into()))?
        .default_address()
        .1;
    let attacker_addr = attacker
        .sapling()
        .ok_or_else(|| Error::PcztDescribe("attacker no sapling".into()))?
        .default_address()
        .1;
    let claimed = UnifiedAddress::from_receivers(None, Some(bridge_addr), None)
        .ok_or_else(|| Error::PcztDescribe("encode sapling claimed".into()))?
        .encode(net);
    Ok(PoolDemo {
        honest: to_hex(&build_sapling(net, ufvk, bridge_addr)?),
        spoof: to_hex(&build_sapling(net, ufvk, attacker_addr)?),
        claimed,
    })
}

fn build_sapling(
    net: &Network,
    ufvk: &InnerUfvk,
    recipient: sapling::PaymentAddress,
) -> Result<Vec<u8>, Error> {
    let dfvk = ufvk
        .sapling()
        .ok_or_else(|| Error::PcztDescribe("no sapling component".into()))?;
    let mut rng = StdRng::seed_from_u64(0x5A_91_u64);

    let mut rseed = [0u8; 32];
    rng.fill_bytes(&mut rseed);
    let note = sapling::Note::from_parts(
        dfvk.default_address().1,
        sapling::value::NoteValue::from_raw(SPEND_VALUE),
        sapling::note::Rseed::AfterZip212(rseed),
    );
    let node = sapling::Node::from_cmu(&note.cmu());
    let path = sapling::MerklePath::from_parts(vec![node; 32], 0u64.into())
        .map_err(|_| Error::PcztDescribe("sapling merkle path".into()))?;
    let anchor = sapling::Anchor::from(path.root(node));

    let mut builder = sapling::builder::Builder::new(
        sapling::note_encryption::Zip212Enforcement::On,
        sapling::builder::BundleType::DEFAULT,
        anchor,
    );
    builder
        .add_spend(dfvk.fvk().clone(), note, path)
        .map_err(|e| Error::PcztDescribe(format!("sapling add_spend: {e:?}")))?;
    builder
        .add_output(
            Some(dfvk.to_ovk(zip32::Scope::External)),
            recipient,
            sapling::value::NoteValue::from_raw(PAY_VALUE),
            [0u8; 512],
        )
        .map_err(|e| Error::PcztDescribe(format!("sapling pay: {e:?}")))?;
    let (bundle, _meta) = builder
        .build_for_pczt(&mut rng)
        .map_err(|e| Error::PcztDescribe(format!("sapling build: {e:?}")))?;

    finalize(PcztParts {
        params: *net,
        version: TxVersion::V5,
        consensus_branch_id: BranchId::Nu5,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(0),
        transparent: None,
        sapling: Some(bundle),
        orchard: None,
    })
}

// ------------------------------- Orchard ----------------------------------

fn orchard_demo(
    net: &Network,
    ufvk: &InnerUfvk,
    bridge: &InnerUfvk,
    attacker: &InnerUfvk,
) -> Result<PoolDemo, Error> {
    let bridge_addr = bridge
        .orchard()
        .ok_or_else(|| Error::PcztDescribe("bridge no orchard".into()))?
        .address_at(0u32, OrchardScope::External);
    let attacker_addr = attacker
        .orchard()
        .ok_or_else(|| Error::PcztDescribe("attacker no orchard".into()))?
        .address_at(0u32, OrchardScope::External);
    let claimed = UnifiedAddress::from_receivers(Some(bridge_addr), None, None)
        .ok_or_else(|| Error::PcztDescribe("encode orchard claimed".into()))?
        .encode(net);
    Ok(PoolDemo {
        honest: to_hex(&build_orchard(net, ufvk, bridge_addr)?),
        spoof: to_hex(&build_orchard(net, ufvk, attacker_addr)?),
        claimed,
    })
}

fn build_orchard(
    net: &Network,
    ufvk: &InnerUfvk,
    recipient: OrchardAddress,
) -> Result<Vec<u8>, Error> {
    let fvk = ufvk
        .orchard()
        .ok_or_else(|| Error::PcztDescribe("no orchard component".into()))?
        .clone();
    let mut rng = StdRng::seed_from_u64(0x0_C_5A_u64);

    let note = make_orchard_note(&mut rng, fvk.address_at(0u32, OrchardScope::External), SPEND_VALUE);
    let cmx: ExtractedNoteCommitment = note.commitment().into();
    let sibling = MerkleHashOrchard::from_cmx(&cmx);
    let path = OrchardMerklePath::from_parts(0, [sibling; 32]);
    let anchor = path.root(cmx);

    let mut builder = OrchardBuilder::new(OrchardBundleType::DEFAULT, anchor);
    builder
        .add_spend(fvk.clone(), note, path)
        .map_err(|e| Error::PcztDescribe(format!("orchard add_spend: {e:?}")))?;
    builder
        .add_output(
            Some(fvk.to_ovk(OrchardScope::External)),
            recipient,
            OrchardNoteValue::from_raw(PAY_VALUE),
            [0u8; 512],
        )
        .map_err(|e| Error::PcztDescribe(format!("orchard add_output: {e:?}")))?;
    let (bundle, _meta) = builder
        .build_for_pczt(&mut rng)
        .map_err(|e| Error::PcztDescribe(format!("orchard build: {e:?}")))?;

    finalize(PcztParts {
        params: *net,
        version: TxVersion::V5,
        consensus_branch_id: BranchId::Nu5,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(0),
        transparent: None,
        sapling: None,
        orchard: Some(bundle),
    })
}

fn make_orchard_note(rng: &mut StdRng, recipient: OrchardAddress, value: u64) -> OrchardNote {
    let mut rho_bytes = [0u8; 32];
    rho_bytes[0] = 7;
    let rho = Rho::from_bytes(&rho_bytes).into_option().expect("valid rho");
    loop {
        let mut rseed_bytes = [0u8; 32];
        rng.fill_bytes(&mut rseed_bytes);
        if let Some(rseed) = RandomSeed::from_bytes(rseed_bytes, &rho).into_option() {
            if let Some(note) =
                OrchardNote::from_parts(recipient, OrchardNoteValue::from_raw(value), rho, rseed)
                    .into_option()
            {
                break note;
            }
        }
    }
}

fn finalize(parts: PcztParts<Network>) -> Result<Vec<u8>, Error> {
    let pczt = Creator::build_from_parts(parts)
        .ok_or_else(|| Error::PcztDescribe("build_from_parts failed".into()))?;
    Ok(pczt.serialize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{pczt_describe_inner, pczt_validate_inner};

    fn ufvk(seed: &[u8; 32]) -> InnerUfvk {
        ufvk_from_seed(&Network::TestNetwork, seed).unwrap()
    }

    /// Both honest and spoof transactions spend our coins, so BOTH validate (the
    /// scary part). describe must surface the bridge for honest and a DIFFERENT
    /// (attacker) recipient for spoof — that mismatch is what catches the lie.
    #[test]
    fn spoof_is_valid_but_describe_reveals_the_attacker() {
        let net = Network::TestNetwork;
        let me = ufvk(&[0x09; 32]);
        let bridge = ufvk_from_seed(&net, BRIDGE_SEED).unwrap();
        let attacker = ufvk_from_seed(&net, ATTACKER_SEED).unwrap();

        for (pool, demo) in [
            ("transparent", transparent_demo(&net, &me, &bridge, &attacker).unwrap()),
            ("sapling", sapling_demo(&net, &me, &bridge, &attacker).unwrap()),
            ("orchard", orchard_demo(&net, &me, &bridge, &attacker).unwrap()),
        ] {
            let honest = hex_to_pczt(&demo.honest);
            let spoof = hex_to_pczt(&demo.spoof);

            // Both spend our coins → both are valid transactions.
            pczt_validate_inner(net, honest.clone(), &me)
                .unwrap_or_else(|e| panic!("{pool} honest validate: {e}"));
            pczt_validate_inner(net, spoof.clone(), &me)
                .unwrap_or_else(|e| panic!("{pool} spoof validate: {e}"));

            // describe surfaces the true recipient.
            let h = pczt_describe_inner(net, honest, &me).unwrap();
            let s = pczt_describe_inner(net, spoof, &me).unwrap();
            let h_pay = h.outputs.iter().find(|o| !o.is_change).unwrap();
            let s_pay = s.outputs.iter().find(|o| !o.is_change).unwrap();
            assert_eq!(
                h_pay.recipient.as_deref(),
                Some(demo.claimed.as_str()),
                "{pool}: honest must pay the claimed bridge address"
            );
            assert_ne!(
                s_pay.recipient, h_pay.recipient,
                "{pool}: spoof must pay a DIFFERENT recipient than the claimed bridge"
            );
        }
    }

    fn hex_to_pczt(hex: &str) -> pczt::Pczt {
        let bytes: Vec<u8> = (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        pczt::Pczt::parse(&bytes).unwrap()
    }
}

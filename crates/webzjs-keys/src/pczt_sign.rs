use crate::error::Error;
use crate::{SeedFingerprint, UnifiedSpendingKey};
use pczt::roles::signer::Signer;
use pczt::roles::updater::Updater;
use pczt::roles::verifier::Verifier;
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::str::FromStr;
use wasm_bindgen::prelude::wasm_bindgen;
use webzjs_common::{Network, Pczt};
use zcash_protocol::consensus::{NetworkConstants, Parameters};
use zcash_transparent::keys::{NonHardenedChildIndex, TransparentKeyScope};

/// Signs and applies signatures to a PCZT.
/// Should in a secure environment (e.g. Metamask snap).
///
/// # Arguments
///
/// * `pczt` - The PCZT that needs to signed
/// * `usk` - UnifiedSpendingKey used to sign the PCZT
/// * `seed_fp` - The fingerprint of the seed used to create `usk`
///
#[wasm_bindgen]
pub async fn pczt_sign(
    network: &str,
    pczt: Pczt,
    usk: UnifiedSpendingKey,
    seed_fp: SeedFingerprint,
) -> Result<Pczt, Error> {
    pczt_sign_inner(
        Network::from_str(network)?,
        pczt.into(),
        usk.into(),
        seed_fp.into(),
    )
    .await
    .map(Into::into)
}

pub async fn pczt_sign_inner(
    network: Network,
    pczt: pczt::Pczt,
    usk: zcash_keys::keys::UnifiedSpendingKey,
    seed_fp: zip32::fingerprint::SeedFingerprint,
) -> Result<pczt::Pczt, Error> {
    // Find all the spends matching our seed.
    #[derive(Debug)]
    enum KeyRef {
        Orchard {
            index: usize,
        },
        // Ironwood reuses the Orchard spend-authorizing key and ZIP-32 derivation;
        // collected and signed like Orchard, via the Ironwood bundle.
        Ironwood {
            index: usize,
        },
        Sapling {
            index: usize,
        },
        Transparent {
            index: usize,
            scope: TransparentKeyScope,
            address_index: NonHardenedChildIndex,
        },
    }
    let mut keys = BTreeMap::<zip32::AccountId, Vec<KeyRef>>::new();
    let pczt =
        Verifier::new(pczt)
            .with_orchard::<Infallible, _>(|bundle| {
                for (index, action) in bundle.actions().iter().enumerate() {
                    if let Some(account_index) = action
                        .spend()
                        .zip32_derivation()
                        .as_ref()
                        .and_then(|derivation| {
                            derivation.extract_account_index(
                                &seed_fp,
                                zip32::ChildIndex::hardened(network.network_type().coin_type()),
                            )
                        })
                    {
                        keys.entry(account_index)
                            .or_default()
                            .push(KeyRef::Orchard { index });
                    }
                }
                Ok(())
            })
            .map_err(|e| Error::PcztSign(format!("Invalid PCZT: {e:?}")))?
            .with_ironwood::<Infallible, _>(|bundle| {
                // Ironwood reuses the Orchard action/key shape, so collect spendable
                // Ironwood actions exactly as for Orchard (same zip32 derivation).
                for (index, action) in bundle.actions().iter().enumerate() {
                    if let Some(account_index) = action
                        .spend()
                        .zip32_derivation()
                        .as_ref()
                        .and_then(|derivation| {
                            derivation.extract_account_index(
                                &seed_fp,
                                zip32::ChildIndex::hardened(network.network_type().coin_type()),
                            )
                        })
                    {
                        keys.entry(account_index)
                            .or_default()
                            .push(KeyRef::Ironwood { index });
                    }
                }
                Ok(())
            })
            .map_err(|e| Error::PcztSign(format!("Invalid PCZT: {e:?}")))?
            .with_sapling::<Infallible, _>(|bundle| {
                for (index, spend) in bundle.spends().iter().enumerate() {
                    if let Some(account_index) =
                        spend.zip32_derivation().as_ref().and_then(|derivation| {
                            derivation.extract_account_index(
                                &seed_fp,
                                zip32::ChildIndex::hardened(network.network_type().coin_type()),
                            )
                        })
                    {
                        keys.entry(account_index)
                            .or_default()
                            .push(KeyRef::Sapling { index });
                    }
                }
                Ok(())
            })
            .map_err(|e| Error::PcztSign(format!("Invalid PCZT: {e:?}")))?
            .with_transparent::<Infallible, _>(|bundle| {
                for (index, input) in bundle.inputs().iter().enumerate() {
                    for derivation in input.bip32_derivation().values() {
                        if let Some((account_index, scope, address_index)) = derivation
                            .extract_bip_44_fields(
                                &seed_fp,
                                bip32::ChildNumber(
                                    network.network_type().coin_type()
                                        | bip32::ChildNumber::HARDENED_FLAG,
                                ),
                            )
                        {
                            keys.entry(account_index)
                                .or_default()
                                .push(KeyRef::Transparent {
                                    index,
                                    scope,
                                    address_index,
                                });
                        }
                    }
                }
                Ok(())
            })
            .map_err(|e| Error::PcztSign(format!("Invalid PCZT: {e:?}")))?
            .finish();

    // Attach the Sapling proof-generation key: the stateless worker prover has no key,
    // so the PGK must travel in the PCZT. It grants proving/viewing only, never spend.
    let sapling_spend_indices: Vec<usize> = keys
        .values()
        .flatten()
        .filter_map(|keyref| match keyref {
            KeyRef::Sapling { index } => Some(*index),
            _ => None,
        })
        .collect();
    let pczt = if sapling_spend_indices.is_empty() {
        pczt
    } else {
        let pgk = usk.sapling().expsk().proof_generation_key();
        Updater::new(pczt)
            .update_sapling_with(|mut updater| {
                for index in &sapling_spend_indices {
                    updater.update_spend_with(*index, |mut spend_updater| {
                        spend_updater.set_proof_generation_key(pgk.clone())
                    })?;
                }
                Ok(())
            })
            .map_err(|e| {
                Error::PcztSign(format!(
                    "Failed to attach Sapling proof generation key: {e:?}"
                ))
            })?
            .finish()
    };

    let mut signer = Signer::new(pczt).unwrap();
    //.map_err(|e| anyhow!("Failed to initialize Signer: {:?}", e))?;
    for (_, spends) in keys {
        // let usk = UnifiedSpendingKey::from_seed(&params, seed, account_index)?;
        for keyref in spends {
            match keyref {
                KeyRef::Orchard { index } => {
                    signer
                        .sign_orchard(
                            rand10::rng(),
                            index,
                            &orchard::keys::SpendAuthorizingKey::from(usk.orchard()),
                        )
                        .map_err(|e| {
                            Error::PcztSign(format!("Failed to sign Orchard spend {index}: {e:?}"))
                        })?;
                }
                KeyRef::Ironwood { index } => {
                    // Ironwood reuses the Orchard spend-authorizing key.
                    signer
                        .sign_ironwood(
                            rand10::rng(),
                            index,
                            &orchard::keys::SpendAuthorizingKey::from(usk.orchard()),
                        )
                        .map_err(|e| {
                            Error::PcztSign(format!("Failed to sign Ironwood spend {index}: {e:?}"))
                        })?;
                }
                KeyRef::Sapling { index } => {
                    signer
                        .sign_sapling(rand10::rng(), index, usk.sapling().expsk().ask())
                        .map_err(|e| {
                            Error::PcztSign(format!("Failed to sign Sapling spend {index}: {e:?}"))
                        })?;
                }
                KeyRef::Transparent {
                    index,
                    scope,
                    address_index,
                } => {
                    signer
                        .sign_transparent(
                            index,
                            &usk.transparent()
                                .derive_secret_key(scope, address_index)
                                .map_err(|e| {
                                    Error::PcztSign(format!(
                                        "Failed to derive transparent key at .../{scope:?}/{address_index:?}: {e:?}"
                                    ))
                                })?,
                        )
                        .map_err(|e| {
                            Error::PcztSign(format!(
                                "Failed to sign transparent input {index}: {e:?}"
                            ))
                        })?;
                }
            }
        }
    }

    Ok(signer.finish())
}

use crate::error::Error;
use crate::{SeedFingerprint, UnifiedSpendingKey};
use pczt::roles::signer::Signer;
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
        // NU6.3 Ironwood spends reuse the Orchard spend-authorizing key and ZIP-32
        // derivation; they are collected and signed exactly like Orchard, only via
        // the Ironwood bundle / `sign_ironwood`.
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
    let mut signer = Signer::new(pczt).unwrap();
    //.map_err(|e| anyhow!("Failed to initialize Signer: {:?}", e))?;
    for (_, spends) in keys {
        // let usk = UnifiedSpendingKey::from_seed(&params, seed, account_index)?;
        for keyref in spends {
            match keyref {
                KeyRef::Orchard { index } => {
                    signer
                        .sign_orchard(
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
                            index,
                            &orchard::keys::SpendAuthorizingKey::from(usk.orchard()),
                        )
                        .map_err(|e| {
                            Error::PcztSign(format!("Failed to sign Ironwood spend {index}: {e:?}"))
                        })?;
                }
                KeyRef::Sapling { index } => {
                    signer
                        .sign_sapling(index, &usk.sapling().expsk.ask)
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

    // NU6.3: a bundle that disables cross-address transfers (the Orchard pool from
    // NU6.3 on) pairs every change output with a zero-valued spend at the wallet's own
    // change address. The builder gives that spend no dummy key; it is meant to be
    // signed "through the normal signing flow" by the spend authorizing key matching
    // its `fvk`. The wallet backend only attaches a ZIP 32 key path to the real spends,
    // so the loop above never sees these. Try every action with the account key and
    // keep the signatures the key actually controls (the signer rejects the rest with
    // `WrongSpendAuthorizingKey`), the same approach librustzcash's own test harness
    // takes. Without this, extraction fails with `MissingSpendAuthSig`.
    let ask = orchard::keys::SpendAuthorizingKey::from(usk.orchard());
    sign_all_controlled_orchard_actions(&mut signer, &ask, OrchardPool::Orchard)?;
    sign_all_controlled_orchard_actions(&mut signer, &ask, OrchardPool::Ironwood)?;

    Ok(signer.finish())
}

#[derive(Clone, Copy, Debug)]
enum OrchardPool {
    Orchard,
    Ironwood,
}

/// Signs every action of the given Orchard-protocol bundle that `ask` controls.
///
/// Actions spending notes under another key, including dummy spends already signed
/// by the IO finalizer, are left untouched. Any error other than "wrong key" is
/// returned.
fn sign_all_controlled_orchard_actions(
    signer: &mut Signer,
    ask: &orchard::keys::SpendAuthorizingKey,
    pool: OrchardPool,
) -> Result<(), Error> {
    use pczt::roles::signer::Error as SignerError;

    for index in 0.. {
        let result = match pool {
            OrchardPool::Orchard => signer.sign_orchard(index, ask),
            OrchardPool::Ironwood => signer.sign_ironwood(index, ask),
        };
        match result {
            Err(SignerError::InvalidIndex) => break,
            Ok(())
            | Err(SignerError::OrchardSign(orchard::pczt::SignerError::WrongSpendAuthorizingKey))
            | Err(SignerError::IronwoodSign(
                orchard::pczt::SignerError::WrongSpendAuthorizingKey,
            )) => {}
            Err(e) => {
                return Err(Error::PcztSign(format!(
                    "Failed to sign {pool:?} action {index}: {e:?}"
                )))
            }
        }
    }
    Ok(())
}

// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

use std::str::FromStr;
use wasm_bindgen::prelude::*;

use crate::error::Error;
use bip0039::{Count, English, Mnemonic};
use webzjs_common::Network;
use zip32::AccountId;

/// A ZIP32 seed fingerprint. Essentially a Blake2b hash of the seed.
///
/// This is a wrapper around the `zip32::fingerprint::SeedFingerprint` type.
///
#[wasm_bindgen]
pub struct SeedFingerprint {
    inner: zip32::fingerprint::SeedFingerprint,
}
#[wasm_bindgen]
impl SeedFingerprint {
    /// Construct a new SeedFingerprint
    ///
    /// # Arguments
    ///
    /// * `seed` - At least 32 bytes of entry. Care should be taken as to how this is derived
    ///
    #[wasm_bindgen(constructor)]
    pub fn new(seed: Box<[u8]>) -> Result<SeedFingerprint, Error> {
        Ok(Self {
            inner: zip32::fingerprint::SeedFingerprint::from_seed(&seed)
                .ok_or(Error::SeedFingerprint)?,
        })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        self.inner.to_bytes().to_vec()
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<SeedFingerprint, Error> {
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| Error::SeedFingerprint)?;
        Ok(Self {
            inner: zip32::fingerprint::SeedFingerprint::from_bytes(bytes),
        })
    }
}

impl From<SeedFingerprint> for zip32::fingerprint::SeedFingerprint {
    fn from(value: SeedFingerprint) -> Self {
        value.inner
    }
}

impl From<zip32::fingerprint::SeedFingerprint> for SeedFingerprint {
    fn from(value: zip32::fingerprint::SeedFingerprint) -> Self {
        Self { inner: value }
    }
}
/// A Zcash Sapling proof generation key
///
/// This is a wrapper around the `sapling::ProofGenerationKey` type. It is used for generating proofs for Sapling PCZTs.
#[wasm_bindgen]
pub struct ProofGenerationKey {
    inner: sapling::ProofGenerationKey,
}

impl From<ProofGenerationKey> for sapling::ProofGenerationKey {
    fn from(value: ProofGenerationKey) -> sapling::ProofGenerationKey {
        value.inner
    }
}

impl From<sapling::ProofGenerationKey> for ProofGenerationKey {
    fn from(value: sapling::ProofGenerationKey) -> Self {
        Self { inner: value }
    }
}

/// A Zcash spending key
///
/// This is a wrapper around the `zcash_keys::keys::SpendingKey` type. It can be created from at least 32 bytes of seed entropy
#[wasm_bindgen]
pub struct UnifiedSpendingKey {
    inner: zcash_keys::keys::UnifiedSpendingKey,
}

#[wasm_bindgen]
impl UnifiedSpendingKey {
    /// Construct a new UnifiedSpendingKey
    ///
    /// # Arguments
    ///
    /// * `network` - Must be either "main" or "test"
    /// * `seed` - At least 32 bytes of entry. Care should be taken as to how this is derived
    /// * `hd_index` - [ZIP32](https://zips.z.cash/zip-0032) hierarchical deterministic index of the account
    ///
    #[wasm_bindgen(constructor)]
    pub fn new(network: &str, seed: Box<[u8]>, hd_index: u32) -> Result<UnifiedSpendingKey, Error> {
        let network = Network::from_str(network)?;
        Ok(Self {
            inner: zcash_keys::keys::UnifiedSpendingKey::from_seed(
                &network,
                &seed,
                AccountId::try_from(hd_index)?,
            )?,
        })
    }

    /// Obtain the UFVK corresponding to this spending key
    pub fn to_unified_full_viewing_key(&self) -> UnifiedFullViewingKey {
        UnifiedFullViewingKey {
            inner: self.inner.to_unified_full_viewing_key(),
        }
    }

    pub fn to_sapling_proof_generation_key(&self) -> ProofGenerationKey {
        ProofGenerationKey {
            inner: self.inner.sapling().expsk().proof_generation_key(),
        }
    }
}

impl From<UnifiedSpendingKey> for zcash_keys::keys::UnifiedSpendingKey {
    fn from(value: UnifiedSpendingKey) -> Self {
        value.inner
    }
}

/// A Zcash viewing key
///
/// This is a wrapper around the `zcash_keys::keys::ViewingKey` type.
/// UFVKs should be generated from a spending key by calling `to_unified_full_viewing_key`
/// They can also be encoded and decoded to a canonical string representation
#[wasm_bindgen]
pub struct UnifiedFullViewingKey {
    inner: zcash_keys::keys::UnifiedFullViewingKey,
}

#[wasm_bindgen]
impl UnifiedFullViewingKey {
    /// Encode the UFVK to a string
    ///
    /// # Arguments
    ///
    /// * `network` - Must be either "main" or "test"
    ///
    pub fn encode(&self, network: &str) -> Result<String, Error> {
        let network = Network::from_str(network)?;
        self.inner
            .encode(&network)
            .map_err(|e| Error::KeyEncoding(e.to_string()))
    }

    /// Construct a UFVK from its encoded string representation
    ///
    /// # Arguments
    ///
    /// * `network` - Must be either "main" or "test"
    /// * `encoding` - The encoded string representation of the UFVK
    ///
    #[wasm_bindgen(constructor)]
    pub fn new(network: &str, encoding: &str) -> Result<UnifiedFullViewingKey, Error> {
        let network = Network::from_str(network)?;
        Ok(Self {
            inner: zcash_keys::keys::UnifiedFullViewingKey::decode(&network, encoding)
                .map_err(|e| Error::KeyDecoding(e.to_string()))?,
        })
    }

    /// Get the default transparent address derived from this UFVK.
    ///
    /// This can be used before creating an account to detect the wallet birthday
    /// by querying for transactions to this address.
    ///
    /// # Arguments
    ///
    /// * `network` - Must be either "main" or "test"
    ///
    /// # Returns
    ///
    /// The transparent address as a string, or None if this UFVK has no transparent component.
    ///
    pub fn get_transparent_address(&self, network: &str) -> Result<Option<String>, Error> {
        let network = Network::from_str(network)?;
        let (ua, _) = self
            .inner
            .default_address(zcash_keys::keys::UnifiedAddressRequest::ALLOW_ALL)
            .map_err(|_| Error::TransparentAddressDerivation)?;
        Ok(ua
            .transparent()
            .map(|addr| zcash_keys::encoding::AddressCodec::encode(addr, &network)))
    }

    /// Default unified (shielded) address for this UFVK, encoded for `network`
    /// ("main"/"test"). Destination for the v1 → v2 migration sweep.
    pub fn get_unified_address(&self, network: &str) -> Result<String, Error> {
        let network = Network::from_str(network)?;
        let (ua, _) = self
            .inner
            .default_address(zcash_keys::keys::UnifiedAddressRequest::ALLOW_ALL)
            .map_err(|_| Error::TransparentAddressDerivation)?;
        Ok(ua.encode(&network))
    }
}

impl UnifiedFullViewingKey {
    /// Borrow the wrapped key for in-crate PCZT inspection (describe/validate).
    /// Not exported to JS — the wasm boundary only sees the methods above.
    pub(crate) fn as_inner(&self) -> &zcash_keys::keys::UnifiedFullViewingKey {
        &self.inner
    }
}

/// Generate a new BIP39 24-word seed phrase
///
/// IMPORTANT: This probably does not use secure randomness when used in the browser
/// and should not be used for anything other than testing
///
/// # Returns
///
/// A string containing a 24-word seed phrase
#[wasm_bindgen]
pub fn generate_seed_phrase() -> String {
    let mnemonic = <Mnemonic<English>>::generate(Count::Words24);
    mnemonic.phrase().to_string()
}

/// Encode raw entropy as a standard BIP-39 mnemonic (portable v2 derivation):
/// 32 bytes → the user's exportable 24-word phrase. Deterministic.
#[wasm_bindgen]
pub fn mnemonic_from_entropy(entropy: Box<[u8]>) -> Result<String, Error> {
    let mnemonic = <Mnemonic<English>>::from_entropy(entropy.into_vec())
        .map_err(|e| Error::Bip39(e.to_string()))?;
    Ok(mnemonic.phrase().to_string())
}

/// Derive the 64-byte BIP-39 seed from a mnemonic (portable v2), using an empty
/// passphrase so standard wallets reproduce the same account.
#[wasm_bindgen]
pub fn seed_from_mnemonic(phrase: &str) -> Result<Vec<u8>, Error> {
    let mnemonic =
        <Mnemonic<English>>::from_phrase(phrase).map_err(|e| Error::Bip39(e.to_string()))?;
    Ok(mnemonic.to_seed("").to_vec())
}

#[cfg(test)]
mod portable_derivation_tests {
    use super::*;

    // Standard BIP-39 test vector: 32 bytes of 0x00 → this exact 24-word phrase.
    // Confirms our encoding is standard (so other wallets reproduce the account).
    const ALL_ZERO_PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon \
        abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
        abandon abandon abandon abandon abandon abandon art";

    #[test]
    fn mnemonic_matches_standard_bip39_vector() {
        let phrase = mnemonic_from_entropy(vec![0u8; 32].into_boxed_slice()).unwrap();
        assert_eq!(phrase, ALL_ZERO_PHRASE);
    }

    #[test]
    fn derivation_is_deterministic() {
        let entropy = [7u8; 32];
        let p1 = mnemonic_from_entropy(Box::new(entropy)).unwrap();
        let p2 = mnemonic_from_entropy(Box::new(entropy)).unwrap();
        assert_eq!(p1, p2, "same entropy must give the same phrase");

        let s1 = seed_from_mnemonic(&p1).unwrap();
        let s2 = seed_from_mnemonic(&p2).unwrap();
        assert_eq!(s1, s2, "same phrase must give the same seed");
        assert_eq!(s1.len(), 64, "BIP-39 seed is 64 bytes");
    }

    #[test]
    fn roundtrip_entropy_to_portable_usk() {
        // entropy -> mnemonic -> seed -> USK -> UFVK, twice, must match.
        let entropy = [0x42u8; 32];
        let ufvk = |e: [u8; 32]| {
            let phrase = mnemonic_from_entropy(Box::new(e)).unwrap();
            let seed = seed_from_mnemonic(&phrase).unwrap();
            UnifiedSpendingKey::new("main", seed.into_boxed_slice(), 0)
                .unwrap()
                .to_unified_full_viewing_key()
                .encode("main")
                .unwrap()
        };
        assert_eq!(ufvk(entropy), ufvk(entropy), "portable UFVK must be stable");
    }

    #[test]
    fn v2_portable_differs_from_v1_raw() {
        // The whole point of the fix: routing the SAME 32 bytes through BIP-39 (v2)
        // yields a DIFFERENT account than using them directly as a seed (v1, the bug).
        let entropy = [0x99u8; 32];
        let v1 = UnifiedSpendingKey::new("main", Box::new(entropy), 0)
            .unwrap()
            .to_unified_full_viewing_key()
            .encode("main")
            .unwrap();
        let phrase = mnemonic_from_entropy(Box::new(entropy)).unwrap();
        let seed = seed_from_mnemonic(&phrase).unwrap();
        let v2 = UnifiedSpendingKey::new("main", seed.into_boxed_slice(), 0)
            .unwrap()
            .to_unified_full_viewing_key()
            .encode("main")
            .unwrap();
        assert_ne!(v1, v2, "v2 must be a distinct (portable) account from v1");
    }
}

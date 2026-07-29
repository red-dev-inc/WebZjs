use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct Pczt(pczt::Pczt);

impl From<pczt::Pczt> for Pczt {
    fn from(pczt: pczt::Pczt) -> Self {
        Self(pczt)
    }
}

impl From<Pczt> for pczt::Pczt {
    fn from(pczt: Pczt) -> Self {
        pczt.0
    }
}

// NU6.3 (librustzcash @413717da): the version-agnostic `pczt::Pczt` no longer
// derives serde `Serialize`/`Deserialize` (only the inner versioned wire structs
// do), and `serialize` now takes `self` by value and returns a `Result`. The old
// serde-based `to_json`/`from_json` wrappers were unused, so they were dropped;
// the byte round-trip below is the supported path.
#[wasm_bindgen]
impl Pczt {
    /// Returns the postcard serialization of the Pczt (latest PCZT version).
    pub fn serialize(&self) -> Vec<u8> {
        self.0
            .clone()
            .serialize()
            .expect("serializing a PCZT to its latest version should not fail")
    }

    /// Deserialize to a Pczt from postcard bytes.
    pub fn from_bytes(bytes: &[u8]) -> Pczt {
        Self(pczt::Pczt::parse(bytes).unwrap())
    }
}

use wasm_bindgen::prelude::*;

use crate::error::Error;

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
    ///
    /// Errors are returned to JS as exceptions. A panic here would become a WASM
    /// trap ("RuntimeError: unreachable") that carries no detail.
    pub fn serialize(&self) -> Result<Vec<u8>, Error> {
        self.0
            .clone()
            .serialize()
            .map_err(|e| Error::PcztSerialize(format!("{e:?}")))
    }

    /// Deserialize to a Pczt from postcard bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Pczt, Error> {
        pczt::Pczt::parse(bytes)
            .map(Self)
            .map_err(|e| Error::PcztParse(format!("{e:?}")))
    }
}

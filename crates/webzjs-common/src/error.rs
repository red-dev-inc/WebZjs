use wasm_bindgen::JsValue;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("Invalid network string given: {0}")]
    InvalidNetwork(String),
    #[error("Could not parse PCZT: {0}")]
    PcztParse(String),
    #[error("Could not serialize PCZT: {0}")]
    PcztSerialize(String),
}

impl From<Error> for JsValue {
    fn from(e: Error) -> Self {
        js_sys::Error::new(&e.to_string()).into()
    }
}

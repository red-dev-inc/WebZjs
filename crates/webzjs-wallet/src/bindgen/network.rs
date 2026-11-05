//! JavaScript-facing side of the network-upgrade check.

use js_sys::{Array, Object, Reflect};
use wasm_bindgen::prelude::*;

use crate::network_upgrade::{NetworkStatus, UpgradeInfo};

#[wasm_bindgen(typescript_custom_section)]
const NETWORK_TYPES: &'static str = r#"
/** A network upgrade in the library's compiled-in consensus parameters. */
export interface KnownUpgrade {
    /** For example "Nu6.3". */
    name: string;
    /** Consensus branch ID, 8 hex digits. */
    branch_id: string;
    /** Height at which it activates on this network. */
    activation_height: number;
}

export interface NextUpgrade {
    name: string;
    height: number;
    /** True if the library's parameters schedule an upgrade at exactly this height. */
    supported_by_library: boolean;
    /** "lightwalletd": announced by the server. "library": only in the library's own schedule. */
    source: "lightwalletd" | "library";
}

/** Result of comparing the server's chain with the library's consensus parameters. */
export interface NetworkStatus {
    /** Consensus branch ID the server reported, as reported. */
    chain_branch_id: string;
    chain_height: number;
    /** True if the chain is on the branch the library gives for that height. */
    supported: boolean;
    /** Branch ID the library expects at the chain's height. */
    expected_branch_id: string;
    /** Every upgrade in the library's parameters for this network, oldest first. */
    known_upgrades: KnownUpgrade[];
    /** Newest of known_upgrades. */
    newest_known_upgrade: string;
    /** Announced by the server, else scheduled by the library; absent if none is known. */
    next_upgrade?: NextUpgrade;
    /** Worth showing the user, e.g. an announced upgrade this library does not support. */
    warnings: string[];
}

/**
 * Thrown (as an Error with code "unsupported_network_upgrade") by sync and by anything that
 * builds a transaction when the chain is on a branch the library does not support.
 */
export interface UnsupportedNetworkUpgradeError extends Error {
    code: "unsupported_network_upgrade";
    chain_branch_id: string;
    chain_height: number;
    newest_known_upgrade: string;
}
"#;

fn set(obj: &Object, key: &str, value: impl Into<JsValue>) {
    let _ = Reflect::set(obj, &key.into(), &value.into());
}

fn upgrade(u: &UpgradeInfo) -> Object {
    let o = Object::new();
    set(&o, "name", u.name.as_str());
    set(&o, "branch_id", u.branch_id.as_str());
    set(&o, "activation_height", u.activation_height);
    o
}

pub fn to_js(status: &NetworkStatus) -> JsValue {
    let o = Object::new();
    set(&o, "chain_branch_id", status.chain_branch_id.as_str());
    set(&o, "chain_height", status.chain_height as f64);
    set(&o, "supported", status.supported);
    set(&o, "expected_branch_id", status.expected_branch_id.as_str());
    let known = Array::new();
    for u in &status.known_upgrades {
        known.push(&upgrade(u));
    }
    set(&o, "known_upgrades", known);
    set(
        &o,
        "newest_known_upgrade",
        status
            .known_upgrades
            .last()
            .map(|u| u.name.as_str())
            .unwrap_or(""),
    );
    if let Some(n) = &status.next_upgrade {
        let next = Object::new();
        set(&next, "name", n.name.as_str());
        set(&next, "height", n.height as f64);
        set(&next, "supported_by_library", n.supported_by_library);
        set(&next, "source", n.source);
        set(&o, "next_upgrade", next);
    }
    let warnings = Array::new();
    for w in &status.warnings {
        warnings.push(&JsValue::from_str(w));
    }
    set(&o, "warnings", warnings);
    o.into()
}

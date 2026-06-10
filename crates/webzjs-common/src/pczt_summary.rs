// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

//! Trusted-display types for the dialog-spoofing fix.
//!
//! A [`PcztSummary`] is a human-verifiable description of what a PCZT actually
//! does, recovered **from the PCZT itself** (plus the user's UFVK) — never from
//! caller-supplied `signDetails`. See
//! `Architecture/Snap Issue Resolution Plan - Dialog Spoofing & Key Derivation.md` §1.4.

use serde::{Deserialize, Serialize};

/// Pool an output belongs to (used as the `pool` string in [`PcztOutputSummary`]).
pub mod pool {
    pub const ORCHARD: &str = "orchard";
    pub const SAPLING: &str = "sapling";
    pub const TRANSPARENT: &str = "transparent";
}

/// A single output recovered from a PCZT, with its trust status.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PcztOutputSummary {
    /// `"orchard"`, `"sapling"`, or `"transparent"` (see [`pool`]).
    pub pool: String,
    /// Decoded recipient address, or `None` if it could not be recovered
    /// (e.g. `ovk = None` and no note plaintext carried in the PCZT).
    pub recipient: Option<String>,
    /// Value in zatoshis.
    pub value: u64,
    /// UTF-8 memo if present and decodable.
    pub memo: Option<String>,
    /// `true` if this output is change / a self-send recognised via the IVK.
    pub is_change: bool,
    /// `true` if the displayed `(recipient, value)` is cryptographically bound
    /// to the note commitment that will be signed (Layer A.3), or is a
    /// transparent output read directly. `false` means "shown but not provable"
    /// — the Snap MUST refuse to sign such a PCZT.
    pub verified: bool,
}

/// Human-verifiable summary of what a PCZT does. All values in zatoshis.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PcztSummary {
    /// `"main"` or `"test"`.
    pub network: String,
    /// Every output the PCZT creates.
    pub outputs: Vec<PcztOutputSummary>,
    /// Sum of input note values spent under this user's key.
    pub total_in: u64,
    /// Sum of output values.
    pub total_out: u64,
    /// Fee = `total_in - total_out`.
    pub fee: u64,
}

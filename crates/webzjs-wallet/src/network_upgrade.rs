// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

//! Is the server's chain on a network upgrade this library supports?
//!
//! A wallet that builds a transaction with the wrong consensus branch ID produces a transaction
//! the network rejects, and a wallet that scans a chain with rules it does not know can mislead
//! its user. So before syncing and before building anything, the wallet asks the server
//! (`GetLightdInfo`) which consensus branch the chain is on and refuses to go on unless that is
//! the branch the library's own consensus parameters give for that height.
//!
//! The upgrades the library supports are read from its compiled-in consensus parameters
//! (`zcash_protocol`); no list of upgrades is kept here.
//!
//! Everything in this module is plain functions over plain data, so it is unit-tested with
//! made-up server answers (labelled as fakes in the tests) and no network.

use std::fmt;

use zcash_protocol::consensus::{BlockHeight, BranchId, Parameters};

/// What the server told us about its chain (the relevant part of `LightdInfo`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainInfo {
    /// `consensusBranchId`: the branch ID as 8 hex digits, as the server reports it.
    pub consensus_branch_id: String,
    /// `blockHeight`: the tip of the server's best chain.
    pub block_height: u64,
    /// `upgradeName`: the next pending upgrade the server knows of; empty if none.
    pub upgrade_name: String,
    /// `upgradeHeight`: its activation height; zero if none is scheduled.
    pub upgrade_height: u64,
}

impl From<&zcash_client_backend::proto::service::LightdInfo> for ChainInfo {
    fn from(info: &zcash_client_backend::proto::service::LightdInfo) -> Self {
        Self {
            consensus_branch_id: info.consensus_branch_id.clone(),
            block_height: info.block_height,
            upgrade_name: info.upgrade_name.clone(),
            upgrade_height: info.upgrade_height,
        }
    }
}

/// A network upgrade (or the original Sprout rules) the library's parameters know.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpgradeInfo {
    /// For example `"Nu6.3"`.
    pub name: String,
    /// The consensus branch ID as 8 hex digits.
    pub branch_id: String,
    /// The height it activates at on this network (`0` for Sprout).
    pub activation_height: u32,
}

/// The next upgrade, if one is known.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NextUpgrade {
    pub name: String,
    pub height: u64,
    /// Whether the library's parameters schedule an upgrade at exactly this height.
    pub supported_by_library: bool,
    /// `"lightwalletd"` if the server announced it, `"library"` if only the library's own
    /// parameters schedule it.
    pub source: &'static str,
}

/// Why the chain is not supported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnsupportedReason {
    /// The server's branch ID is not a branch this library has ever heard of (or is not a valid
    /// branch ID): the chain is probably on an upgrade newer than the library.
    UnknownBranch,
    /// The branch is one the library knows, but it is not the one the library's parameters give
    /// for the chain's height. Either the chain is ahead of the library (a known upgrade the
    /// library does not schedule on this network, such as one not yet given a mainnet height) or
    /// the library is ahead of the chain (the library expects an upgrade that has not happened).
    NotInForceAtHeight { expected_branch_id: String },
}

/// The chain is on a consensus branch this library does not support. The wallet must not sync or
/// build transactions against it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsupportedNetworkUpgrade {
    /// The branch ID the server reported, exactly as reported.
    pub chain_branch_id: String,
    pub chain_height: u64,
    /// The newest upgrade the library's parameters know for this network, for example `"Nu7"`.
    pub newest_known_upgrade: String,
    pub reason: UnsupportedReason,
}

impl UnsupportedNetworkUpgrade {
    /// Stable identifier for programmatic handling.
    pub const CODE: &'static str = "unsupported_network_upgrade";
}

impl fmt::Display for UnsupportedNetworkUpgrade {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Unsupported network upgrade: the chain reports consensus branch {} at height {}, but the newest upgrade this library knows is {}. ",
            self.chain_branch_id, self.chain_height, self.newest_known_upgrade
        )?;
        match &self.reason {
            UnsupportedReason::UnknownBranch => {
                write!(f, "That branch is unknown to this library; update the library.")
            }
            UnsupportedReason::NotInForceAtHeight { expected_branch_id } => write!(
                f,
                "This library expects branch {expected_branch_id} at that height; the library and the chain disagree about the upgrade schedule."
            ),
        }
    }
}

impl std::error::Error for UnsupportedNetworkUpgrade {}

/// The result of comparing the chain with the library.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkStatus {
    /// The branch ID the server reported, exactly as reported.
    pub chain_branch_id: String,
    pub chain_height: u64,
    /// True if the chain's branch is the one the library's parameters give for its height.
    pub supported: bool,
    /// The branch ID the library's parameters give for the chain's height, 8 hex digits.
    pub expected_branch_id: String,
    /// Every upgrade in the library's parameters for this network, oldest first.
    pub known_upgrades: Vec<UpgradeInfo>,
    /// Why the chain is unsupported; `None` when it is supported.
    pub unsupported: Option<UnsupportedNetworkUpgrade>,
    /// The next upgrade, if the server announced one or the library schedules one.
    pub next_upgrade: Option<NextUpgrade>,
    /// Things worth telling the user even though the chain is currently supported.
    pub warnings: Vec<String>,
}

impl NetworkStatus {
    /// `Ok` if the chain is supported, otherwise the typed error.
    pub fn require_supported(&self) -> Result<(), UnsupportedNetworkUpgrade> {
        match &self.unsupported {
            None => Ok(()),
            Some(e) => Err(e.clone()),
        }
    }
}

fn hex8(id: BranchId) -> String {
    format!("{:08x}", u32::from(id))
}

fn upgrade_name(id: BranchId) -> String {
    match id.network_upgrade() {
        Some(nu) => nu.to_string(),
        None => "Sprout".to_string(),
    }
}

/// Every upgrade in force at some height on this network, oldest first, derived only from the
/// parameters: start from the branch in force at the highest possible height and walk back
/// through the epoch that precedes each activation.
pub fn known_upgrades<P: Parameters>(params: &P) -> Vec<UpgradeInfo> {
    let mut found = Vec::new();
    let mut branch = BranchId::for_height(params, BlockHeight::from_u32(u32::MAX));
    loop {
        let lower = branch
            .height_bounds(params)
            .map(|(lower, _)| lower)
            .unwrap_or(BlockHeight::from_u32(0));
        found.push(UpgradeInfo {
            name: upgrade_name(branch),
            branch_id: hex8(branch),
            activation_height: u32::from(lower),
        });
        if u32::from(lower) == 0 {
            break;
        }
        let previous = BranchId::for_height(params, lower - 1);
        if previous == branch {
            break; // cannot happen with consistent parameters; never loop forever
        }
        branch = previous;
    }
    found.reverse();
    found
}

/// Parse a branch ID as the server reports it: 8 hex digits, optionally `0x`-prefixed.
fn parse_branch_id(s: &str) -> Option<BranchId> {
    let digits = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    if digits.is_empty() || digits.len() > 8 {
        return None;
    }
    BranchId::try_from(u32::from_str_radix(digits, 16).ok()?).ok()
}

/// Compare the server's chain with the library's consensus parameters.
pub fn evaluate<P: Parameters>(params: &P, chain: &ChainInfo) -> NetworkStatus {
    let known = known_upgrades(params);
    let newest = known.last().map(|u| u.name.clone()).unwrap_or_default();
    // Heights beyond u32 cannot be real; treat them as the highest height.
    let height = u32::try_from(chain.block_height).unwrap_or(u32::MAX);
    let expected = BranchId::for_height(params, BlockHeight::from_u32(height));
    let expected_hex = hex8(expected);

    let reported = parse_branch_id(&chain.consensus_branch_id);
    let unsupported = match reported {
        Some(id) if id == expected => None,
        Some(_) => Some(UnsupportedReason::NotInForceAtHeight {
            expected_branch_id: expected_hex.clone(),
        }),
        None => Some(UnsupportedReason::UnknownBranch),
    }
    .map(|reason| UnsupportedNetworkUpgrade {
        chain_branch_id: chain.consensus_branch_id.clone(),
        chain_height: chain.block_height,
        newest_known_upgrade: newest.clone(),
        reason,
    });

    // The next upgrade: what the server announces, else what the library's own schedule says.
    let library_next = expected
        .height_bounds(params)
        .and_then(|(_, upper)| upper)
        .map(|upper| {
            let id = BranchId::for_height(params, upper);
            NextUpgrade {
                name: upgrade_name(id),
                height: u64::from(u32::from(upper)),
                supported_by_library: true,
                source: "library",
            }
        });
    let announced =
        (chain.upgrade_height > 0 && !chain.upgrade_name.trim().is_empty()).then(|| NextUpgrade {
            name: chain.upgrade_name.trim().to_string(),
            height: chain.upgrade_height,
            supported_by_library: known
                .iter()
                .any(|u| u64::from(u.activation_height) == chain.upgrade_height),
            source: "lightwalletd",
        });
    let next_upgrade = announced.or(library_next);

    let mut warnings = Vec::new();
    if let Some(next) = &next_upgrade {
        if next.source == "lightwalletd" && !next.supported_by_library {
            let away = next.height.saturating_sub(chain.block_height);
            warnings.push(format!(
                "The chain announces the network upgrade {} at height {} ({} blocks away), which this library does not support. Update before then.",
                next.name, next.height, away
            ));
        }
    }

    NetworkStatus {
        chain_branch_id: chain.consensus_branch_id.clone(),
        chain_height: chain.block_height,
        supported: unsupported.is_none(),
        expected_branch_id: expected_hex,
        known_upgrades: known,
        unsupported,
        next_upgrade,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    // Every ChainInfo below is a FAKE: a made-up answer standing in for `GetLightdInfo`, so the
    // cases the live network cannot produce on demand (an unknown branch, a chain on a newer
    // upgrade, a library ahead of the chain) can be tested. Nothing here talks to a server.
    use webzjs_common::Network;
    use zcash_protocol::consensus::NetworkUpgrade;

    use super::*;

    const TESTNET_NU7: u32 = 4_465_026;

    fn fake(branch: &str, height: u64) -> ChainInfo {
        ChainInfo {
            consensus_branch_id: branch.to_string(),
            block_height: height,
            upgrade_name: String::new(),
            upgrade_height: 0,
        }
    }

    #[test]
    fn fake_match_on_testnet_after_nu7() {
        let s = evaluate(&Network::TestNetwork, &fake("77190ad9", 4_508_000));
        assert!(s.supported);
        assert_eq!(s.unsupported, None);
        assert_eq!(s.expected_branch_id, "77190ad9");
        assert!(s.require_supported().is_ok());
    }

    #[test]
    fn fake_match_on_the_height_just_before_nu7() {
        let net = Network::TestNetwork;
        let before = fake(&hex8(BranchId::Nu6_3), u64::from(TESTNET_NU7) - 1);
        assert!(evaluate(&net, &before).supported);
        let at = fake(&hex8(BranchId::Nu7), u64::from(TESTNET_NU7));
        assert!(evaluate(&net, &at).supported);
    }

    #[test]
    fn fake_accepts_0x_prefix_and_upper_case() {
        assert!(evaluate(&Network::TestNetwork, &fake("0x77190AD9", 4_508_000)).supported);
    }

    #[test]
    fn fake_unknown_branch_is_unsupported() {
        let s = evaluate(&Network::TestNetwork, &fake("deadbeef", 4_508_000));
        assert!(!s.supported);
        let e = s.require_supported().unwrap_err();
        assert_eq!(e.reason, UnsupportedReason::UnknownBranch);
        assert_eq!(e.chain_branch_id, "deadbeef");
        assert_eq!(e.chain_height, 4_508_000);
        assert_eq!(e.newest_known_upgrade, "Nu7");
        assert_eq!(
            UnsupportedNetworkUpgrade::CODE,
            "unsupported_network_upgrade"
        );
    }

    #[test]
    fn fake_garbage_branch_ids_are_unknown_not_a_panic() {
        for bad in ["", "zzzz", "1234567890", "0x"] {
            let s = evaluate(&Network::TestNetwork, &fake(bad, 4_508_000));
            assert!(!s.supported, "{bad:?}");
            assert_eq!(
                s.unsupported.unwrap().reason,
                UnsupportedReason::UnknownBranch
            );
        }
    }

    #[test]
    fn fake_chain_on_a_newer_upgrade_than_the_library_knows() {
        // Mainnet: the library has no NU7 height yet, so a chain that reports NU7's branch (a
        // branch ID the library does know) is on an upgrade the library does not schedule.
        let s = evaluate(&Network::MainNetwork, &fake("77190ad9", 3_600_000));
        assert!(!s.supported);
        let e = s.require_supported().unwrap_err();
        assert!(matches!(
            e.reason,
            UnsupportedReason::NotInForceAtHeight { .. }
        ));
        assert_eq!(e.newest_known_upgrade, "Nu6.3");
        // And a branch ID no version of the library has ever heard of.
        let s = evaluate(&Network::TestNetwork, &fake("a1b2c3d4", 5_000_000));
        assert_eq!(
            s.unsupported.unwrap().reason,
            UnsupportedReason::UnknownBranch
        );
    }

    #[test]
    fn fake_library_ahead_of_the_chain() {
        // The library expects NU7 from 4_465_026; this fake chain is past that height but still
        // reports NU6.3's branch: the chain has not activated what the library expects.
        let s = evaluate(
            &Network::TestNetwork,
            &fake(&hex8(BranchId::Nu6_3), 4_500_000),
        );
        assert!(!s.supported);
        let e = s.require_supported().unwrap_err();
        assert_eq!(
            e.reason,
            UnsupportedReason::NotInForceAtHeight {
                expected_branch_id: "77190ad9".to_string()
            }
        );
        assert_eq!(e.chain_branch_id, hex8(BranchId::Nu6_3));
    }

    #[test]
    fn known_upgrades_come_from_the_parameters_in_order() {
        let net = Network::TestNetwork;
        let k = known_upgrades(&net);
        // Oldest first, strictly increasing heights, starting at Sprout.
        assert_eq!(k.first().unwrap().name, "Sprout");
        assert!(k
            .windows(2)
            .all(|w| w[0].activation_height < w[1].activation_height));
        // Every upgrade the parameters schedule is present, at its height.
        for nu in [NetworkUpgrade::Nu6_3, NetworkUpgrade::Nu7] {
            let h = net.activation_height(nu).unwrap();
            assert!(
                k.iter()
                    .any(|u| u.branch_id == hex8(nu.branch_id())
                        && u.activation_height == u32::from(h)),
                "{nu}"
            );
        }
        assert_eq!(k.last().unwrap().name, "Nu7");
        // Mainnet has no NU7 height, so NU7 is not a known upgrade there.
        let m = known_upgrades(&Network::MainNetwork);
        assert_eq!(m.last().unwrap().name, "Nu6.3");
        assert!(!m.iter().any(|u| u.name == "Nu7"));
    }

    #[test]
    fn announced_unknown_upgrade_produces_a_warning() {
        let mut chain = fake("77190ad9", 4_508_000);
        chain.upgrade_name = "NU8".to_string();
        chain.upgrade_height = 4_600_000;
        let s = evaluate(&Network::TestNetwork, &chain);
        assert!(s.supported);
        let next = s.next_upgrade.unwrap();
        assert_eq!(
            (next.name.as_str(), next.height, next.source),
            ("NU8", 4_600_000, "lightwalletd")
        );
        assert!(!next.supported_by_library);
        assert_eq!(s.warnings.len(), 1);
        assert!(s.warnings[0].contains("NU8") && s.warnings[0].contains("92000 blocks"));
    }

    #[test]
    fn announced_upgrade_the_library_schedules_is_not_a_warning() {
        // Before NU7 on testnet, a server announcing NU7 at the height the library has.
        let mut chain = fake(&hex8(BranchId::Nu6_3), 4_400_000);
        chain.upgrade_name = "NU7".to_string();
        chain.upgrade_height = u64::from(TESTNET_NU7);
        let s = evaluate(&Network::TestNetwork, &chain);
        assert!(s.supported);
        assert!(s.warnings.is_empty());
        assert!(s.next_upgrade.unwrap().supported_by_library);
    }

    #[test]
    fn without_an_announcement_the_librarys_own_schedule_gives_the_next_upgrade() {
        let s = evaluate(
            &Network::TestNetwork,
            &fake(&hex8(BranchId::Nu6_3), 4_400_000),
        );
        let next = s.next_upgrade.unwrap();
        assert_eq!(
            (next.name.as_str(), next.height, next.source),
            ("Nu7", u64::from(TESTNET_NU7), "library")
        );
        assert!(s.warnings.is_empty());
        // After the last scheduled upgrade there is nothing next.
        assert_eq!(
            evaluate(&Network::TestNetwork, &fake("77190ad9", 4_508_000)).next_upgrade,
            None
        );
    }

    #[test]
    fn error_message_names_branch_height_and_newest_upgrade() {
        let e = evaluate(&Network::TestNetwork, &fake("deadbeef", 123))
            .unsupported
            .unwrap();
        let m = e.to_string();
        assert!(m.contains("deadbeef") && m.contains("123") && m.contains("Nu7"));
    }
}

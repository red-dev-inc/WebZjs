//! Wallet behaviour that depends on the network upgrade in force at the height a transaction
//! will be mined, so it stays correct across upgrades instead of being fixed to one pool.

use std::time::SystemTime;

use orchard::circuit::OrchardCircuitVersion;
use zcash_client_backend::util::Clock;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, OrchardProtocolRevision, Parameters},
    ShieldedPool,
};

/// Returns the shielded pool that receives new value (and so change) in a transaction mined at
/// `target_height`.
///
/// Since NU6.3 the Orchard pool no longer accepts new value: shielded outputs go to the Ironwood
/// pool, which every later upgrade so far keeps (NU7 included). Before NU6.3 they go to Orchard.
/// The answer is derived from the Orchard protocol revision of the consensus branch, never from a
/// hard-coded pool, so a future upgrade that selects a different revision is a compile-time
/// reminder to revisit this function rather than a silent misbehaviour.
pub(crate) fn change_pool_at<P: Parameters>(
    params: &P,
    target_height: BlockHeight,
) -> ShieldedPool {
    match BranchId::for_height(params, target_height).orchard_protocol_revision() {
        Some(OrchardProtocolRevision::V3) => ShieldedPool::Ironwood,
        Some(OrchardProtocolRevision::InsecureV1 | OrchardProtocolRevision::V2) | None => {
            ShieldedPool::Orchard
        }
    }
}

/// Returns the Orchard circuit version used for proofs and verification under `branch`, or
/// `None` if proofs are not (or are no longer) created for that branch.
///
/// Derived from the branch's Orchard protocol revision, so every branch from NU6.3 onward
/// (including NU7) uses the post-NU6.3 circuit.
pub(crate) fn orchard_circuit_version(branch: BranchId) -> Option<OrchardCircuitVersion> {
    match branch.orchard_protocol_revision()? {
        OrchardProtocolRevision::V3 => Some(OrchardCircuitVersion::PostNu6_3),
        OrchardProtocolRevision::V2 => Some(OrchardCircuitVersion::FixedPostNu6_2),
        // The pre-NU6.2 circuit is unsound and is never used to prove.
        OrchardProtocolRevision::InsecureV1 => None,
    }
}

/// A [`Clock`] that works in a browser.
///
/// `std::time::SystemTime::now()` panics on `wasm32-unknown-unknown`, which is what the
/// backend's `SystemClock` uses, so on that target the time comes from `Date.now()`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct WalletClock;

impl Clock for WalletClock {
    fn now(&self) -> SystemTime {
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        {
            // `Date.now()` is milliseconds since the Unix epoch, as a float.
            std::time::UNIX_EPOCH + std::time::Duration::from_millis(js_sys::Date::now() as u64)
        }
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        {
            SystemTime::now()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::UNIX_EPOCH;

    use webzjs_common::Network;
    use zcash_protocol::consensus::NetworkUpgrade;

    use super::*;

    fn h(n: u32) -> BlockHeight {
        BlockHeight::from_u32(n)
    }

    #[test]
    fn testnet_change_pool_follows_the_active_upgrade() {
        let net = Network::TestNetwork;
        let nu6_3 = net.activation_height(NetworkUpgrade::Nu6_3).unwrap();
        let nu7 = net.activation_height(NetworkUpgrade::Nu7).unwrap();
        assert_eq!(u32::from(nu6_3), 4_134_000);
        assert_eq!(u32::from(nu7), 4_465_026);

        assert_eq!(change_pool_at(&net, nu6_3 - 1), ShieldedPool::Orchard);
        assert_eq!(change_pool_at(&net, nu6_3), ShieldedPool::Ironwood);
        assert_eq!(change_pool_at(&net, nu7 - 1), ShieldedPool::Ironwood);
        // NU7 keeps the Ironwood pool.
        assert_eq!(change_pool_at(&net, nu7), ShieldedPool::Ironwood);
        assert_eq!(change_pool_at(&net, h(4_483_500)), ShieldedPool::Ironwood);
    }

    #[test]
    fn mainnet_change_pool_before_and_after_nu6_3() {
        let net = Network::MainNetwork;
        let nu6_3 = net.activation_height(NetworkUpgrade::Nu6_3).unwrap();
        assert_eq!(u32::from(nu6_3), 3_428_143);
        assert_eq!(change_pool_at(&net, nu6_3 - 1), ShieldedPool::Orchard);
        assert_eq!(change_pool_at(&net, nu6_3), ShieldedPool::Ironwood);
        // Mainnet has no NU7 height yet; the pool does not depend on it.
        assert_eq!(net.activation_height(NetworkUpgrade::Nu7), None);
        assert_eq!(change_pool_at(&net, h(4_000_000)), ShieldedPool::Ironwood);
    }

    #[test]
    fn circuit_version_follows_the_branch() {
        assert_eq!(
            orchard_circuit_version(BranchId::Nu6_2),
            Some(OrchardCircuitVersion::FixedPostNu6_2)
        );
        assert_eq!(
            orchard_circuit_version(BranchId::Nu6_3),
            Some(OrchardCircuitVersion::PostNu6_3)
        );
        // The old mapping treated every branch other than NU6.3 as the pre-Ironwood circuit,
        // which would have produced invalid proofs under NU7.
        assert_eq!(
            orchard_circuit_version(BranchId::Nu7),
            Some(OrchardCircuitVersion::PostNu6_3)
        );
        assert_eq!(orchard_circuit_version(BranchId::Sapling), None);
        assert_eq!(orchard_circuit_version(BranchId::Nu6_1), None);
    }

    #[test]
    fn native_clock_reports_a_plausible_time() {
        let now = WalletClock.now().duration_since(UNIX_EPOCH).unwrap();
        // After 2024-01-01.
        assert!(now.as_secs() > 1_704_067_200);
    }
}

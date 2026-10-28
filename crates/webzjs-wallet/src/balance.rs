//! The per-account balance reported to JavaScript.
//!
//! Kept outside the `bindgen` module (which only builds for the browser) so the conversion from the
//! backend's balance can be unit-tested natively. A pool that is missing here is a pool whose
//! funds a JavaScript caller cannot see: the wallet would report a zero balance for them.

use serde::{Deserialize, Serialize};

// Only the browser bindings construct it outside tests.
#[cfg_attr(not(feature = "wasm"), allow(dead_code))]
#[derive(Debug, Serialize, Deserialize)]
pub struct AccountBalance {
    pub sapling_balance: u64,
    pub orchard_balance: u64,
    /// Spendable value in the Ironwood pool, which receives new shielded value since NU6.3.
    /// Absent (zero) in summaries produced before this field existed.
    #[serde(default)]
    pub ironwood_balance: u64,
    pub unshielded_balance: u64,
    /// Change from sent transactions waiting for mining confirmation
    pub pending_change: u64,
    /// Received notes waiting for required confirmations to become spendable
    pub pending_spendable: u64,
}

impl From<zcash_client_backend::data_api::AccountBalance> for AccountBalance {
    fn from(balance: zcash_client_backend::data_api::AccountBalance) -> Self {
        AccountBalance {
            sapling_balance: balance.sapling_balance().spendable_value().into(),
            orchard_balance: balance.orchard_balance().spendable_value().into(),
            ironwood_balance: balance.ironwood_balance().spendable_value().into(),
            unshielded_balance: balance.unshielded_balance().spendable_value().into(),
            pending_change: balance.change_pending_confirmation().into(),
            pending_spendable: balance.value_pending_spendability().into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use zcash_client_backend::data_api::{AccountBalance as BackendBalance, Balance};
    use zcash_protocol::value::{BalanceError, Zatoshis};

    use super::AccountBalance;

    #[test]
    fn ironwood_value_reaches_the_javascript_balance() {
        let mut backend = BackendBalance::ZERO;
        backend
            .with_ironwood_balance_mut::<_, BalanceError>(|b: &mut Balance| {
                b.add_spendable_value(Zatoshis::const_from_u64(12_345))
            })
            .unwrap();

        let js = AccountBalance::from(backend);

        assert_eq!(js.ironwood_balance, 12_345);
        // The other pools are untouched, so Ironwood is neither double counted nor dropped.
        assert_eq!(js.orchard_balance, 0);
        assert_eq!(js.sapling_balance, 0);
    }

    #[test]
    fn older_serialized_balances_without_the_ironwood_field_still_load() {
        let json = r#"{"sapling_balance":1,"orchard_balance":2,"unshielded_balance":3,
                       "pending_change":4,"pending_spendable":5}"#;
        let b: AccountBalance = serde_json::from_str(json).unwrap();
        assert_eq!(
            (b.sapling_balance, b.orchard_balance, b.ironwood_balance),
            (1, 2, 0)
        );
    }
}

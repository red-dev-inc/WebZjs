# Spoof-PCZT test fixtures

Binary fixtures (`*.pczt`, postcard-serialized `pczt::Pczt`) consumed by
`tests/spoof_pczt.rs`.

They are produced **deterministically** by the committed generator
`tests/gen_fixtures.rs` — there is no manual hand-editing step. Regenerate with:

```
cargo test -p webzjs-keys --test gen_fixtures -- --ignored
```

Fixtures cover all three pools (Orchard, Transparent, Sapling) on the `"test"`
network. Keys are ZIP-32 UFVKs derived from fixed 32-byte seeds shared between
the generator and the tests, so addresses are reproducible without hardcoding
strings:

| Seed | Role |
|---|---|
| `[0x01; 32]` | our key (`TEST_SEED` / `OUR_SEED`) |
| `[0x02; 32]` | attacker (`ATTACKER_SEED`) |
| `[0x03; 32]` | bridge / honest payee |
| `[0x04; 32]` | a foreign (not-ours) key |

| Fixture | What it contains | Expected verdict |
|---|---|---|
| `honest_bridge_deposit.pczt` | Spends 100 000 of our notes; pays the bridge 50 000, change 40 000 back to our internal address; 10 000 ZIP-317 fee. | `pczt_validate` → `Ok` |
| `spoof_recipient.pczt` | A fully consistent PCZT that pays the **attacker** 90 000 (fee 10 000). | `describe` **surfaces the attacker** (all outputs `verified`); `pczt_validate` → **`Ok`** (see note). |
| `foreign_input.pczt` | Spends a note under the foreign key, not our UFVK. | `pczt_validate` → `Err` |
| `unprovable_output.pczt` | An honest-shaped deposit whose output `rseed` is stripped via the `Redactor` role, so its commitment can't be recomputed. | `pczt_validate` → `Err` (refuse) |
| `honest_transparent.pczt` | **Transparent**: spends a P2PKH coin under our key (`m/44'/<coin>'/0'/0/0`, `bip32_derivation` populated); pays the bridge t-address 90 000, 10 000 fee. | `describe` surfaces the bridge t-address; `pczt_validate` → `Ok` (input re-derived from our UFVK's transparent component) |
| `foreign_transparent.pczt` | **Transparent**: spends a P2PKH coin under the **foreign** key, which our UFVK cannot re-derive. | `pczt_validate` → `Err` (unattributable transparent input) |
| `sapling_change.pczt` | **Sapling**: spends 100 000 of our notes; pays the bridge 50 000 (external) + 40 000 change to our **internal** address; 10 000 fee. | `describe` flags the internal output as change; `pczt_validate` → `Ok` |

The transparent fixtures exercise the viewing-key-only attribution fix (derive each
claimed pubkey from `ufvk.transparent()` at its BIP-32 path and bind it to the spent
coin). The sapling fixture exercises change detection (via `diversified_change_address`,
since `decrypt_diversifier` is unreliable for the internal scope in sapling-crypto 0.6).

## Why `spoof_recipient` validates

A PCZT that *consistently* pays an attacker is a cryptographically valid
transaction. `pczt_validate_inner(network, pczt, ufvk)` is given no
`signDetails`, so it cannot — and must not pretend to — reject it. The
anti-spoof guarantee at this layer is **`pczt_describe` surfacing the true
recipient**: the Snap renders that (never the dApp's `signDetails`) and the
glue layer (`packages/snap/src/rpc/signPczt.tsx`) diffs the two and rejects on
mismatch. That glue-layer diff is out of scope for these inner-crate tests.

## How generation works (no proving keys)

`describe` / `validate` use the `pczt` `Verifier` role, which never checks the
zk-proof — so fixtures don't need proving. The generator builds the Orchard
bundle with `orchard::builder::Builder`, synthesizes a self-consistent Merkle
witness by hand (`MerklePath::from_parts` + a computed anchor; on-chain tree
membership is irrelevant here), wraps it into a `pczt::Pczt` via
`Creator::build_from_parts`, and writes `Pczt::serialize()` bytes here.

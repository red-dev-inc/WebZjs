# Changelog

All notable changes to the Zcash WebZjs Snap are documented here.

## [1.1.0] — unreleased (NU7)

### Added
- NU7 portable (v2) key derivation, key export (`exportZcashSecret`), and the
  v1→v2 account migration (`getPortableAddress`, `completeMigration`,
  `signMigration`).
- Ironwood (NU6.3) pool support in the trusted-display and signing paths.

### Security
- `signPczt`: warn when a transaction has more than one non-change output (a split
  payment could otherwise match the claimed total and suppress every warning).
- `signPczt`: the self-migration "✓ your own wallet" confirmation now also requires
  the clean-path-A check — a self-migration carrying an extra third-party payment is
  flagged, not shown as green.
- `pczt_describe`: a transparent output whose recipient cannot be recovered is marked
  unverified, so `pczt_validate` refuses it instead of signing behind a "refused"
  label.
- `setSnapStete`: strict schema; the derivation version can no longer be changed by a
  caller (the switch is gated by `completeMigration`).
- `setBirthdayBlock` / sync start: the chain tip is validated and the start height is
  clamped to NU5 on every path, preventing a scan-from-genesis denial of service.
- `getViewingKey`, `getPortableAddress`, `exportZcashSecret`: network and account are
  no longer caller-supplied.
- Input hardening: PCZT hex must be even length; `getViewingKey` no longer masks a
  user rejection as a generation failure.

### Changed
- Export dialog no longer over-promises cross-wallet portability; it names only the
  wallet we verified and tells users to confirm their full balance after import.
- Install dialog name matches the manifest (`Zcash WebZjs Wallet`).

### Migration notes
- Requires the web wallet to request version `>= 1.1.0`; connecting with an older
  Snap now prompts an update instead of failing with "Method not found".

# Vendored `tonic-web-wasm-client` 0.8.0, with one fix

This is `tonic-web-wasm-client` 0.8.0 from crates.io (MIT/Apache-2.0, see the licence files) with
the change in `trailers-only.patch`, wired in through `[patch.crates-io]` in the workspace
`Cargo.toml`.

## Why

A gRPC server may answer a call that returns no messages with a *trailers-only* response: HTTP 200,
`grpc-status` in the HTTP headers, and an empty body. lightwalletd v0.5.4 (the Zcash testnet
endpoint, `https://zjs.zec.rocks/testnet`) does this for an empty `GetAddressUtxosStream`, which
every new wallet issues during sync. Mainnet (lightwalletd v0.5.3) sends a body frame instead.

Upstream 0.8.0 (and 0.9.2) reads the empty body as a truncated message and fails with
`MalformedResponse`, so a wallet could not sync at all on testnet.

## The change

`ResponseBody` records whether the response headers carried `grpc-status`. If the body ends before
any frame header *and* the response was trailers-only, it is treated as an empty body. A body that
ends early on any other response is still `MalformedResponse`.

## Not bumped to 0.9.2

0.9.2 has the same behaviour (checked), and requires `js-sys ^0.3.85`, which conflicts with the
workspace's deliberate `wasm-bindgen =0.2.100` / `js-sys =0.3.77` pins (newer versions break the
MetaMask Snap sandbox).

## Upstream status (checked 2026-10-13)

Reported upstream as devashishdxt/tonic-web-wasm-client issue #99 (2026-09-25) with PR #113 open
(same idea: end the body when the stream ends between frames with nothing buffered; unmerged, no
reviews). Release 0.9.2 (2026-09-14) does not include it. Do not send our patch separately.

## To remove

Drop this directory, the `[patch.crates-io]` entry and the `exclude` entry once the fix is
released upstream. `trailers-only.patch` is a ready-made upstream change (apply with `patch -p1`
from a `tonic-web-wasm-client` checkout).

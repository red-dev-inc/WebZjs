# Vendored `tonic-web-wasm-client` 0.8.0, with two fixes

This is `tonic-web-wasm-client` 0.8.0 from crates.io (MIT/Apache-2.0, see the licence files) with
the changes in `trailers-only.patch` and then `trailers.patch`, wired in through
`[patch.crates-io]` in the workspace `Cargo.toml`. The unit tests in `src/response_body/` are ours.
`trailers.patch` carries only their two `cfg(test)` hooks (`mod tests;` and
`BodyStream::from_chunks`), not the test files, so on a plain upstream checkout the patched crate
builds but `cargo test` needs `src/response_body/` copied too.

## Fix 1: trailers-only responses (`trailers-only.patch`)

### Why

A gRPC server may answer a call that returns no messages with a *trailers-only* response: HTTP 200,
`grpc-status` in the HTTP headers, and an empty body. lightwalletd v0.5.4 (the Zcash testnet
endpoint, `https://zjs.zec.rocks/testnet`) does this for an empty `GetAddressUtxosStream`, which
every new wallet issues during sync. Mainnet (lightwalletd v0.5.3) sends a body frame instead.

Upstream 0.8.0 (and 0.9.2) reads the empty body as a truncated message and fails with
`MalformedResponse`, so a wallet could not sync at all on testnet.

### The change

`ResponseBody` records whether the response headers carried `grpc-status`. If the body ends before
any frame header *and* the response was trailers-only, it is treated as an empty body. A body that
ends early on any other response is still `MalformedResponse`.

## Fix 2: the trailer frame reaches tonic (`trailers.patch`)

Found, reproduced and first fixed by Crackdevs in their browser OHTTP proof
(https://github.com/Crackdevs/zcash-browser-ohttp-proof). That repository has no licence file, so
none of their code is used here; this fix was written separately.

### Why

0.8.0 parses the gRPC-web trailer frame, stores it in a field nothing reads, and ends the body as
soon as it sees the trailer flag. tonic never receives the trailers, and tonic 0.14.3 (the locked
version) treats "HTTP 200, no trailers" as success. So a status sent in the body trailer is lost:
a server-streaming call that fails part-way looks complete, a unary call that returns a message and
then an error status looks successful, and an error with no message at all (for example
`OutOfRange` from `GetBlock` past the tip, which a public mainnet endpoint sends as a body trailer)
becomes an empty successful stream. Errors sent in the HTTP headers are not affected.

tonic 0.14.6 and later report "HTTP 200, no trailers" as `Unknown: missing grpc-status trailer`,
so without this fix a `cargo update` of tonic would fail every call that has a body.

### The change

- After the last data frame the body yields the parsed trailers as one trailers frame, then ends.
  This is the `src/response_body.rs` part of upstream commit 0f232d33
  (https://github.com/devashishdxt/tonic-web-wasm-client/pull/90, released in 0.9.1).
- The body counts as finished only once the trailer frame has been read in full. A trailer frame
  split across chunks is read; a stream that ends inside it is `MalformedResponse` instead of a
  clean end. The split case is upstream issue
  https://github.com/devashishdxt/tonic-web-wasm-client/issues/97; the open upstream PR
  https://github.com/devashishdxt/tonic-web-wasm-client/pull/112 makes the same predicate change
  (unmerged).
- A stream that ends between frames with no trailer frame is unchanged: `MalformedResponse`, except
  for the trailers-only case of fix 1.

Behaviour that changes besides the fix: a trailer block that does not parse now fails with
`HeaderParsingError` whether it arrives in one chunk or split (before, the split case ended
silently); and since body trailers now reach tonic, an invalid `grpc-status-details-bin` there hits
the same tonic handling as one in the HTTP headers.

Known and not changed: a response with `grpc-status: 0` in the headers and an error in a body
trailer still reports success (tonic does not read the body then); repeated trailer keys keep only
the last value (upstream issue 103); bytes after the trailer frame are ignored; like a data frame,
a trailer frame is buffered until its announced length has arrived.

### Tests

`cargo test --locked -p tonic-web-wasm-client` from the workspace root runs them natively against
the workspace lock (CI: the `vendored-tonic-web-wasm-client` job in `rust-checks.yml`).

## Not bumped to 0.9.2

0.9.2 has the same trailers-only behaviour (checked), and its `wasm-streams ^0.7` dependency requires `js-sys ^0.3.85`, which conflicts with the
workspace's deliberate `wasm-bindgen =0.2.100` / `js-sys =0.3.77` pins (newer versions break the
MetaMask Snap sandbox).

## Upstream status (checked 2026-10-13)

Reported upstream as devashishdxt/tonic-web-wasm-client issue #99 (2026-09-25) with PR #113 open
(same idea: end the body when the stream ends between frames with nothing buffered; unmerged, no
reviews). Release 0.9.2 (2026-09-14) does not include it. Do not send our patch separately.

## To remove

Drop this directory, the `[patch.crates-io]` entry, the `exclude` entry and the CI job once both
fixes are in an upstream release the pins allow. `trailers-only.patch` is a ready-made upstream
change (apply with `patch -p1` from a `tonic-web-wasm-client` checkout); `trailers.patch` applies
on top of it.

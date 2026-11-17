# Vendored `tonic-web-wasm-client` 0.8.0

This is `tonic-web-wasm-client` 0.8.0 from crates.io (MIT/Apache-2.0, see the licence files) with
the patches below, wired in through `[patch.crates-io]` in the workspace `Cargo.toml`.
The patches carry the `cfg(test)` hooks. Copy `src/response_body/` from this directory to run
the tests, including Daniel/Konclave's tests and captured fixtures from WebZjs #28.

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

Crackdevs found, reproduced and first fixed the lost trailer in their browser OHTTP proof
(https://github.com/Crackdevs/zcash-browser-ohttp-proof). Daniel/Konclave prepared the minimal
WebZjs backport in [#28](https://github.com/red-dev-inc/WebZjs/pull/28) using the upstream fixes
credited below.

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

- After the last data frame the body yields the parsed trailers as one trailers frame.
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

## Fix 3: validate the body trailer and wait for EOF (`trailers-completion.patch`)

This follows the decoder behavior from the [Crackdevs proof](https://github.com/Crackdevs/zcash-browser-ohttp-proof/blob/main/continuation-02/wallet.patch)
and the [follow-up proposed by Daniel/Konclave](https://github.com/Crackdevs/zcash-browser-ohttp-proof/issues/1#issuecomment-6898562403).

- Emit complete data frames as they are read. After parsing the trailer, wait for HTTP body EOF
  before yielding it once. Reject buffered or later bytes beyond that frame and surface any stream
  error while awaiting EOF. A pending body read uses the ordinary stream waker and the existing
  fetch cancellation and deadline behavior. WebZjs currently constructs this client without a request timeout. If a server leaves the response body open after the trailer, the call can remain pending until the body ends, a transport error occurs, or the request is cancelled.
- Require one `grpc-status` field in the body trailer. Reject duplicates after header-name
  normalization, missing status and values other than decimal ASCII without leading zeros. Tonic
  receives the original value, message and other metadata. Its bytewise status decoder preserves
  codes 0–16 and maps unrecognized numeric codes of any length to `Unknown`.
- Keep the headers-only path for empty responses. Header status 0 ends an empty server stream
  successfully. An empty unary response still has no message and returns Tonic's missing-message
  error. A nonzero HTTP-header status continues to reach the caller.

Native tests use the workspace lock and exercise Tonic unary and streaming decoding, including
split and truncated frames, delayed EOF, cancellation, trailing bytes, and malformed or unfamiliar
status values. Run `cargo test --locked -p tonic-web-wasm-client` from the workspace root. CI uses
the `vendored-tonic-web-wasm-client` job in `rust-checks.yml`.

### Existing limitations

- Tonic 0.14.3 gives HTTP-header status priority and can skip the body entirely. A conflicting
  header and body status therefore still follows the header path. Header-only status validation
  remains Tonic's responsibility.
- Metadata other than `grpc-status` retains the existing last-value behavior for duplicates.
  [Upstream #117](https://github.com/devashishdxt/tonic-web-wasm-client/pull/117) addresses that
  separately. Error metadata still uses Tonic's existing decoding, including its panic on
  invalid base64 in `grpc-status-details-bin`.
- The checks target binary gRPC-web. The existing text/base64 path has a buffer bug and
  compressed body trailers are unsupported. Frames are still buffered individually up to
  their announced length.

## Not bumped to 0.9.2

0.9.2 has the same trailers-only behaviour (checked), and its `wasm-streams ^0.7` dependency requires `js-sys ^0.3.85`, which conflicts with the
workspace's deliberate `wasm-bindgen =0.2.100` / `js-sys =0.3.77` pins (newer versions break the
MetaMask Snap sandbox).

## Upstream status (checked 2026-10-13)

Reported upstream as devashishdxt/tonic-web-wasm-client issue #99 (2026-09-25) with PR #113 open
(same idea: end the body when the stream ends between frames with nothing buffered; unmerged, no
reviews). Release 0.9.2 (2026-09-14) does not include it. Do not send our patch separately.

## Reapplying the vendor changes

From the published `tonic-web-wasm-client` 0.8.0 source root, apply the WebZjs patches in order.
Set `webzjs_vendor` to the absolute path of this directory.

```sh
patch -p1 < "$webzjs_vendor/trailers-only.patch"
patch -p1 < "$webzjs_vendor/trailers.patch"
patch -p1 < "$webzjs_vendor/trailers-completion.patch"
cp -R "$webzjs_vendor/src/response_body" src/
```

Drop this directory, the `[patch.crates-io]` entry, the `exclude` entry and the CI job once these
fixes are in an upstream release the pins allow.

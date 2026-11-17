//! Native unit tests for the gRPC-web response body: the trailer frame must reach tonic.
//!
//! The body is fed from in-memory chunks, so these run with `cargo test` on the host, without a
//! browser. Frames are built by hand: one flag byte (`0x00` data, `0x80` trailer), a 4-byte
//! big-endian length, then the payload.

use std::{
    future::Future,
    pin::{pin, Pin},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll, Wake, Waker},
};

use bytes::{Buf, BufMut, Bytes};
use futures_util::{stream, Stream, StreamExt};
use http::{uri::PathAndQuery, HeaderMap, StatusCode};
use http_body::Body;
use tonic::{
    codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder, Streaming},
    Code, Status,
};

use super::ResponseBody;
use crate::{body_stream::BodyStream, Error};

const CONTENT_TYPE: &str = "application/grpc-web+proto";
const STATUS_13: &[u8] = b"grpc-status: 13\r\ngrpc-message: boom\r\n";
const STATUS_5: &[u8] = b"grpc-status: 5\r\ngrpc-message: not found\r\n";
const STATUS_0: &[u8] = b"grpc-status: 0\r\n";

/// A real body captured from a public gRPC-web endpoint (2026-11-15): HTTP 200, no `grpc-status`
/// in the headers, and one trailer frame carrying `grpc-status: 11` for a block past the tip.
const CAPTURED_BODY_TRAILER_ERROR: &[u8] = include_bytes!("fixtures/body-trailer-error.bin");
/// A real successful unary body (2026-11-15): one data frame, then a trailer frame with status 0.
const CAPTURED_DATA_THEN_TRAILER_OK: &[u8] = include_bytes!("fixtures/data-then-trailer-ok.bin");

fn frame(flag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(flag);
    out.put_u32(payload.len() as u32);
    out.extend_from_slice(payload);
    out
}

fn data_frame(payload: &[u8]) -> Vec<u8> {
    frame(0x00, payload)
}

fn trailer_frame(payload: &[u8]) -> Vec<u8> {
    frame(0x80, payload)
}

fn body(chunks: Vec<Vec<u8>>, trailers_only: bool) -> ResponseBody {
    let chunks = chunks.into_iter().map(Bytes::from).collect();
    ResponseBody::from_body_stream(BodyStream::from_chunks(chunks), CONTENT_TYPE, trailers_only)
        .expect("binary content type is accepted")
}

/// Drives a future that never waits on I/O (every body here is in memory).
fn run<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(output) => output,
        Poll::Pending => panic!("an in-memory body never returns Pending"),
    }
}

#[derive(Debug, PartialEq)]
enum Item {
    Data(Bytes),
    Trailers(HeaderMap),
    Malformed,
    OtherError(String),
}

/// Every frame the body yields, up to the end or the first error.
fn frames(mut body: ResponseBody) -> Vec<Item> {
    let mut items = Vec::new();
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        match std::pin::Pin::new(&mut body).poll_frame(&mut cx) {
            Poll::Pending => panic!("an in-memory body never returns Pending"),
            Poll::Ready(None) => return items,
            Poll::Ready(Some(Err(Error::MalformedResponse))) => {
                items.push(Item::Malformed);
                return items;
            }
            Poll::Ready(Some(Err(e))) => {
                items.push(Item::OtherError(e.to_string()));
                return items;
            }
            Poll::Ready(Some(Ok(frame))) => match frame.into_data() {
                Ok(data) => items.push(Item::Data(data)),
                Err(frame) => items.push(Item::Trailers(
                    frame.into_trailers().expect("a frame is data or trailers"),
                )),
            },
        }
    }
}

fn status_of(item: &Item) -> Option<&str> {
    match item {
        Item::Trailers(map) => map.get("grpc-status").and_then(|v| v.to_str().ok()),
        _ => None,
    }
}

/// Every way to cut `bytes` into two chunks, plus one byte per chunk.
fn splits(bytes: &[u8]) -> Vec<Vec<Vec<u8>>> {
    let mut all: Vec<Vec<Vec<u8>>> = (1..bytes.len())
        .map(|at| vec![bytes[..at].to_vec(), bytes[at..].to_vec()])
        .collect();
    all.push(bytes.iter().map(|b| vec![*b]).collect());
    all
}

/// A codec that passes message bytes through unchanged.
#[derive(Default)]
struct RawCodec;

impl Codec for RawCodec {
    type Encode = Bytes;
    type Decode = Bytes;
    type Encoder = RawCodec;
    type Decoder = RawCodec;

    fn encoder(&mut self) -> Self::Encoder {
        RawCodec
    }

    fn decoder(&mut self) -> Self::Decoder {
        RawCodec
    }
}

impl Encoder for RawCodec {
    type Item = Bytes;
    type Error = Status;

    fn encode(&mut self, item: Bytes, dst: &mut EncodeBuf<'_>) -> Result<(), Status> {
        dst.put(item);
        Ok(())
    }
}

impl Decoder for RawCodec {
    type Item = Bytes;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Bytes>, Status> {
        Ok(Some(src.copy_to_bytes(src.remaining())))
    }
}

/// What tonic's streaming decoder reports for a body: each message, then the final outcome.
fn through_tonic_stream(body: ResponseBody) -> (Vec<Bytes>, Result<(), Status>) {
    let mut stream = Streaming::new_response(RawCodec, body, StatusCode::OK, None, None);
    let mut messages = Vec::new();
    loop {
        match run(stream.message()) {
            Ok(Some(message)) => messages.push(message),
            Ok(None) => return (messages, Ok(())),
            Err(status) => return (messages, Err(status)),
        }
    }
}

/// A gRPC service that answers every call with a fixed gRPC-web body and HTTP 200.
struct FixedResponse(Option<ResponseBody>, HeaderMap);

impl tower_service::Service<http::Request<tonic::body::Body>> for FixedResponse {
    type Response = http::Response<ResponseBody>;
    type Error = Error;
    type Future = std::future::Ready<Result<Self::Response, Error>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _: http::Request<tonic::body::Body>) -> Self::Future {
        let body = self.0.take().expect("one call per test");
        let mut response = http::Response::builder()
            .status(StatusCode::OK)
            .header(http::header::CONTENT_TYPE, CONTENT_TYPE)
            .body(body)
            .expect("static response parts are valid");
        response.headers_mut().extend(std::mem::take(&mut self.1));
        std::future::ready(Ok(response))
    }
}

fn through_tonic_unary(body: ResponseBody) -> Result<Bytes, Status> {
    let mut grpc = tonic::client::Grpc::new(FixedResponse(Some(body), HeaderMap::new()));
    let path = http::uri::PathAndQuery::from_static("/test.Service/Unary");
    run(grpc.unary(tonic::Request::new(Bytes::new()), path, RawCodec)).map(|r| r.into_inner())
}

// T1
#[test]
fn trailer_after_data_is_yielded_as_a_trailers_frame() {
    let mut bytes = data_frame(b"hello");
    bytes.extend(trailer_frame(STATUS_13));

    let items = frames(body(vec![bytes], false));

    assert_eq!(items.len(), 2, "{items:?}");
    assert_eq!(items[0], Item::Data(Bytes::from(data_frame(b"hello"))));
    assert_eq!(status_of(&items[1]), Some("13"), "{items:?}");
}

// T2
#[test]
fn trailer_is_yielded_whatever_the_chunk_boundaries() {
    let mut bytes = data_frame(b"hello");
    bytes.extend(trailer_frame(STATUS_13));

    for chunks in splits(&bytes) {
        let shape: Vec<usize> = chunks.iter().map(Vec::len).collect();
        let items = frames(body(chunks, false));
        let data: Vec<u8> = items
            .iter()
            .filter_map(|i| match i {
                Item::Data(d) => Some(d.to_vec()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(data, data_frame(b"hello"), "chunks {shape:?}: {items:?}");
        assert_eq!(
            items.last().and_then(status_of),
            Some("13"),
            "chunks {shape:?}: {items:?}"
        );
    }
}

// T3
#[test]
fn trailer_frame_alone_is_yielded() {
    let items = frames(body(vec![trailer_frame(STATUS_5)], false));

    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(status_of(&items[0]), Some("5"));
}

// T4
#[test]
fn stream_that_ends_inside_the_trailer_frame_is_malformed() {
    let mut bytes = data_frame(b"hello");
    let data_len = bytes.len();
    bytes.extend(trailer_frame(STATUS_13));

    // Cut after the trailer flag, inside and after its length, and inside its payload.
    for cut in [
        data_len + 1,
        data_len + 3,
        data_len + 5,
        data_len + 8,
        bytes.len() - 1,
    ] {
        let items = frames(body(vec![bytes[..cut].to_vec()], false));
        assert_eq!(
            items.last(),
            Some(&Item::Malformed),
            "cut at {cut}: {items:?}"
        );
    }
}

// T5
#[test]
fn tonic_stream_reports_the_status_sent_in_the_body_trailer() {
    let mut bytes = data_frame(b"hello");
    bytes.extend(trailer_frame(STATUS_13));

    for chunks in splits(&bytes) {
        let (messages, outcome) = through_tonic_stream(body(chunks, false));
        assert_eq!(messages, vec![Bytes::from_static(b"hello")]);
        let status = outcome.expect_err("status 13 must reach the caller");
        assert_eq!(status.code(), Code::Internal);
        assert_eq!(status.message(), "boom");
    }
}

// T5, unary
#[test]
fn tonic_unary_call_reports_the_status_sent_after_its_message() {
    let mut bytes = data_frame(b"hello");
    bytes.extend(trailer_frame(STATUS_13));

    let status = through_tonic_unary(body(vec![bytes], false))
        .expect_err("a message followed by status 13 is a failed call");
    assert_eq!(status.code(), Code::Internal);
    assert_eq!(status.message(), "boom");
}

// T5, a captured body
#[test]
fn tonic_reports_the_status_of_a_captured_body_trailer() {
    for chunks in splits(CAPTURED_BODY_TRAILER_ERROR) {
        let (messages, outcome) = through_tonic_stream(body(chunks, false));
        assert!(messages.is_empty());
        let status = outcome.expect_err("status 11 must reach the caller");
        assert_eq!(status.code(), Code::OutOfRange);
        assert!(status.message().contains("newer than the latest block"));
    }
}

// T6
#[test]
fn ok_trailer_is_yielded_and_ends_the_call_cleanly() {
    let mut bytes = data_frame(b"hello");
    bytes.extend(trailer_frame(STATUS_0));

    let items = frames(body(vec![bytes.clone()], false));
    assert_eq!(items.len(), 2, "{items:?}");
    assert_eq!(status_of(&items[1]), Some("0"));

    let (messages, outcome) = through_tonic_stream(body(vec![bytes], false));
    assert_eq!(messages, vec![Bytes::from_static(b"hello")]);
    assert!(outcome.is_ok(), "{outcome:?}");
}

// T6, a captured body
#[test]
fn captured_successful_unary_body_still_succeeds() {
    for chunks in splits(CAPTURED_DATA_THEN_TRAILER_OK) {
        let message = through_tonic_unary(body(chunks, false)).expect("status 0 is success");
        assert!(!message.is_empty());
    }
}

// G1
#[test]
fn trailers_only_response_with_an_empty_body_ends_cleanly() {
    assert_eq!(frames(body(vec![], true)), vec![]);
}

// G1, the exception is narrow
#[test]
fn trailers_only_response_with_a_truncated_body_is_still_malformed() {
    let bytes = data_frame(b"hello");
    for cut in [1, 3, bytes.len() - 1] {
        let items = frames(body(vec![bytes[..cut].to_vec()], true));
        assert_eq!(items, vec![Item::Malformed], "cut at {cut}");
    }
}

// G2
#[test]
fn data_without_any_trailer_is_malformed() {
    let items = frames(body(vec![data_frame(b"hello")], false));
    assert_eq!(items.last(), Some(&Item::Malformed), "{items:?}");
}

// G3
#[test]
fn stream_that_ends_inside_a_data_frame_is_malformed() {
    let bytes = data_frame(b"hello");
    let items = frames(body(vec![bytes[..bytes.len() - 2].to_vec()], false));
    assert_eq!(items, vec![Item::Malformed]);
}

#[test]
fn nothing_is_yielded_after_the_trailers() {
    let mut bytes = data_frame(b"hello");
    bytes.extend(trailer_frame(STATUS_0));
    let mut body = body(vec![bytes], false);
    let mut cx = Context::from_waker(Waker::noop());

    let mut seen = 0;
    while let Poll::Ready(Some(_)) = std::pin::Pin::new(&mut body).poll_frame(&mut cx) {
        seen += 1;
        assert!(seen <= 2, "at most one data and one trailers frame");
    }
    for _ in 0..3 {
        assert!(matches!(
            std::pin::Pin::new(&mut body).poll_frame(&mut cx),
            Poll::Ready(None)
        ));
    }
}

fn data_then_trailer(trailer: &[u8]) -> Vec<u8> {
    [data_frame(b"hello"), trailer_frame(trailer)].concat()
}

fn assert_protocol_error(status: Status) {
    assert_eq!(status.code(), Code::Unknown);
    assert!(
        status.message().contains("malformed response")
            || status.message().contains("failed to parse headers"),
        "{status:?}"
    );
}

#[test]
fn invalid_body_status_fails_both_tonic_paths() {
    for trailers in [
        &b"x-meta: present\r\n"[..],
        b"grpc-status: 13\r\ngrpc-status: 0\r\n",
        b"grpc-status: 0\r\nGrpc-Status: 0\r\n",
        b"grpc-status: 0\r\n\r\nGrpc-Status: 13\r\n",
        b"grpc-status:\r\n",
        b"grpc-status: +0\r\n",
        b"grpc-status: -1\r\n",
        b"grpc-status: 0, 0\r\n",
        b"grpc-status: 13junk\r\n",
        b"grpc-status: 00\r\n",
    ] {
        let bytes = data_then_trailer(trailers);
        let (messages, result) = through_tonic_stream(body(vec![bytes.clone()], false));
        assert_eq!(messages, [Bytes::from_static(b"hello")]);
        assert_protocol_error(result.expect_err("invalid body status ended the stream cleanly"));
        assert_protocol_error(
            through_tonic_unary(body(vec![bytes], false))
                .expect_err("invalid body status produced a unary response"),
        );
    }
}

#[test]
fn tonic_preserves_all_recognized_body_status_codes() {
    for code in 0..=16 {
        let trailers = format!("grpc-status: {code}\r\n");
        let bytes = data_then_trailer(trailers.as_bytes());
        let result = through_tonic_unary(body(vec![bytes], false));
        if code == 0 {
            assert_eq!(result.unwrap(), Bytes::from_static(b"hello"));
        } else {
            assert_eq!(result.unwrap_err().code(), Code::from_i32(code));
        }
    }
}

#[test]
fn unfamiliar_body_status_maps_to_unknown_with_server_metadata() {
    let oversized = "9".repeat(128);
    for code in ["17", "4294967296", &oversized] {
        let trailers = format!(
            "grpc-status: {code}\r\ngrpc-message: newer%20code\r\n\
             grpc-status-details-bin: AQID\r\nx-proof: retained\r\n"
        );
        let bytes = data_then_trailer(trailers.as_bytes());
        let (messages, result) = through_tonic_stream(body(vec![bytes.clone()], false));
        assert_eq!(messages, [Bytes::from_static(b"hello")]);
        for status in [
            result.unwrap_err(),
            through_tonic_unary(body(vec![bytes], false)).unwrap_err(),
        ] {
            assert_eq!(status.code(), Code::Unknown);
            assert_eq!(status.message(), "newer code");
            assert_eq!(status.details(), [1, 2, 3]);
            assert_eq!(status.metadata().get("x-proof").unwrap(), "retained");
        }
    }
}

#[test]
fn bytes_after_body_trailer_fail_even_after_an_ok_status() {
    let initial = data_then_trailer(STATUS_0);
    for tail in [vec![0xff], data_frame(b"extra"), trailer_frame(STATUS_5)] {
        for chunks in [
            vec![[initial.clone(), tail.clone()].concat()],
            vec![initial.clone(), tail],
        ] {
            let (messages, result) = through_tonic_stream(body(chunks.clone(), false));
            assert_eq!(messages, [Bytes::from_static(b"hello")]);
            assert_protocol_error(result.expect_err("trailing bytes ended the stream cleanly"));
            assert_protocol_error(
                through_tonic_unary(body(chunks, false))
                    .expect_err("trailing bytes produced a unary response"),
            );
        }
    }
}

#[test]
fn truncated_data_or_trailer_does_not_erase_preceding_message() {
    for next in [data_frame(b"more"), trailer_frame(STATUS_0)] {
        for cut in [1, 4, 5, next.len() - 1] {
            let bytes = [data_frame(b"hello"), next[..cut].to_vec()].concat();
            let (messages, result) = through_tonic_stream(body(vec![bytes], false));
            assert_eq!(messages, [Bytes::from_static(b"hello")]);
            assert_protocol_error(result.expect_err("truncation ended the stream cleanly"));
        }
    }
}

#[derive(Default)]
struct TailState {
    completion: Option<Result<(), Error>>,
    waker: Option<Waker>,
    polls: usize,
    dropped: bool,
}

struct ControlledTail(Arc<Mutex<TailState>>);

impl Stream for ControlledTail {
    type Item = Result<Bytes, Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let mut state = self.0.lock().unwrap();
        state.polls += 1;
        match state.completion.take() {
            Some(Ok(())) => Poll::Ready(None),
            Some(Err(error)) => Poll::Ready(Some(Err(error))),
            None => {
                state.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

impl Drop for ControlledTail {
    fn drop(&mut self) {
        self.0.lock().unwrap().dropped = true;
    }
}

fn body_with_controlled_tail() -> (ResponseBody, Arc<Mutex<TailState>>) {
    let state = Arc::new(Mutex::new(TailState::default()));
    let first = Ok(Bytes::from(data_then_trailer(STATUS_0)));
    let source = stream::iter([first]).chain(ControlledTail(state.clone()));
    let body = ResponseBody::from_body_stream(BodyStream::from_stream(source), CONTENT_TYPE, false)
        .unwrap();
    (body, state)
}

fn complete_tail(state: &Mutex<TailState>, result: Result<(), Error>) {
    let waker = {
        let mut state = state.lock().unwrap();
        state.completion = Some(result);
        state.waker.take().expect("the body is waiting on its tail")
    };
    waker.wake();
}

#[derive(Default)]
struct WakeCount(AtomicUsize);

impl Wake for WakeCount {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

#[test]
fn streaming_message_arrives_before_eof_but_final_success_waits() {
    let (body, tail) = body_with_controlled_tail();
    let mut stream = Streaming::new_response(RawCodec, body, StatusCode::OK, None, None);
    assert_eq!(
        run(stream.message()).unwrap(),
        Some(Bytes::from_static(b"hello"))
    );
    assert_eq!(tail.lock().unwrap().polls, 0);

    let count = Arc::new(WakeCount::default());
    let waker = Waker::from(count.clone());
    let mut cx = Context::from_waker(&waker);
    let mut completion = pin!(stream.message());
    assert!(completion.as_mut().poll(&mut cx).is_pending());
    assert_eq!(tail.lock().unwrap().polls, 1);
    assert_eq!(count.0.load(Ordering::Relaxed), 0);

    complete_tail(&tail, Ok(()));
    assert_eq!(count.0.load(Ordering::Relaxed), 1);
    assert!(matches!(
        completion.as_mut().poll(&mut cx),
        Poll::Ready(Ok(None))
    ));
}

#[test]
fn unary_result_waits_for_eof() {
    let (body, tail) = body_with_controlled_tail();
    let mut grpc = tonic::client::Grpc::new(FixedResponse(Some(body), HeaderMap::new()));
    let path = PathAndQuery::from_static("/test.Service/Unary");
    let mut result = pin!(grpc.unary(tonic::Request::new(Bytes::new()), path, RawCodec));
    let mut cx = Context::from_waker(Waker::noop());
    assert!(result.as_mut().poll(&mut cx).is_pending());
    complete_tail(&tail, Ok(()));
    let Poll::Ready(Ok(response)) = result.as_mut().poll(&mut cx) else {
        panic!("clean EOF should finish the unary call");
    };
    assert_eq!(response.into_inner(), Bytes::from_static(b"hello"));
}

#[test]
fn transport_error_after_complete_trailer_reaches_tonic() {
    let initial = Bytes::from(data_then_trailer(STATUS_0));
    let failure = || {
        Err(Error::JsError(
            "connection closed while reading body".into(),
        ))
    };
    let make_body = || {
        ResponseBody::from_body_stream(
            BodyStream::from_stream(stream::iter([Ok(initial.clone()), failure()])),
            CONTENT_TYPE,
            false,
        )
        .unwrap()
    };
    let (messages, result) = through_tonic_stream(make_body());
    assert_eq!(messages, [Bytes::from_static(b"hello")]);
    for status in [
        result.unwrap_err(),
        through_tonic_unary(make_body()).unwrap_err(),
    ] {
        assert!(
            status
                .message()
                .contains("connection closed while reading body"),
            "{status:?}"
        );
    }
}

#[test]
fn cancelling_while_waiting_for_eof_drops_the_source() {
    let (body, tail) = body_with_controlled_tail();
    let mut stream = Streaming::new_response(RawCodec, body, StatusCode::OK, None, None);
    assert!(run(stream.message()).unwrap().is_some());
    let mut cx = Context::from_waker(Waker::noop());
    {
        let mut completion = pin!(stream.message());
        assert!(completion.as_mut().poll(&mut cx).is_pending());
        assert!(!tail.lock().unwrap().dropped);
    }
    drop(stream);
    let state = tail.lock().unwrap();
    assert!(state.dropped);
    assert_eq!(state.polls, 1);
}

#[test]
fn tonic_handles_headers_only_without_an_extra_body_trailer() {
    let request = || tonic::Request::new(Bytes::new());
    let path = PathAndQuery::from_static("/test.Service/Call");
    for (value, code) in [("0", Code::Ok), ("5", Code::NotFound)] {
        let client = || {
            let mut headers = HeaderMap::new();
            headers.insert("grpc-status", http::HeaderValue::from_static(value));
            headers.insert(
                "grpc-message",
                http::HeaderValue::from_static("header%20status"),
            );
            tonic::client::Grpc::new(FixedResponse(Some(body(vec![], true)), headers))
        };
        let streaming = run(client().server_streaming(request(), path.clone(), RawCodec));
        let unary = run(client().unary(request(), path.clone(), RawCodec)).unwrap_err();
        if code == Code::Ok {
            let mut stream = streaming.unwrap().into_inner();
            assert_eq!(run(stream.message()).unwrap(), None);
            assert_eq!(unary.code(), Code::Internal);
            assert_eq!(unary.message(), "Missing response message.");
        } else {
            let status = streaming.unwrap_err();
            assert_eq!(status.code(), code);
            assert_eq!(status.message(), "header status");
            assert_eq!(unary.code(), code);
            assert_eq!(unary.message(), "header status");
        }
    }
}

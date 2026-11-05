// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

//! Validation of multi-payment requests, each with an optional memo.
//!
//! A transaction can pay several recipients, and each shielded recipient can be sent a memo
//! (up to 512 bytes, encoded per [ZIP 302]). This module checks a list of payments, or a
//! [ZIP 321] payment URI, *before* anything is proposed to the wallet, so mistakes come back as
//! a typed [`PaymentsError`] that names the offending payment instead of an opaque failure from
//! deep inside transaction construction.
//!
//! Everything here is plain functions over plain data so it can be unit-tested without a network.
//!
//! [ZIP 302]: https://zips.z.cash/zip-0302
//! [ZIP 321]: https://zips.z.cash/zip-0321

use std::convert::Infallible;
use std::fmt;

use zcash_address::{unified, ConversionError, TryFromAddress, ZcashAddress};
use zcash_client_backend::data_api::AccountBalance;
use zcash_client_backend::zip321::{Payment, TransactionRequest, Zip321Error};
use zcash_protocol::consensus::NetworkType;
use zcash_protocol::memo::{self, Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;

/// The largest memo, in bytes, that a shielded output can carry.
pub const MAX_MEMO_BYTES: usize = 512;

/// A memo to attach to a payment.
///
/// An empty text or an empty byte string means "no memo", exactly as if no memo had been given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MemoInput {
    /// Human-readable text, sent as a ZIP 302 text memo. Its UTF-8 encoding must fit in
    /// [`MAX_MEMO_BYTES`].
    Text(String),
    /// Arbitrary bytes, at most [`MAX_MEMO_BYTES`], sent exactly as given (zero-padded to 512
    /// bytes by ZIP 302). The caller is responsible for the leading byte's meaning: ZIP 302 uses
    /// `0xFF` for arbitrary data, and a leading byte of `0xF4` or less marks a text memo.
    Bytes(Vec<u8>),
}

/// One payment of a multi-payment transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentSpec {
    /// The recipient, as an encoded Zcash address (unified, Sapling or transparent).
    pub to: String,
    /// The amount, in zatoshis.
    pub value: u64,
    /// An optional memo. Only shielded recipients can receive one.
    pub memo: Option<MemoInput>,
}

/// Why a set of payments was rejected.
///
/// `index` always refers to the position of the payment in the list the caller supplied (for a
/// payment URI, the index used inside the URI).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaymentsError {
    /// No payments were given.
    NoPayments,
    /// The recipient is not a valid Zcash address.
    InvalidAddress { index: usize },
    /// The recipient is a valid address, but for a different network than the wallet's.
    WrongNetwork {
        index: usize,
        expected: &'static str,
        found: &'static str,
    },
    /// The amount is not a valid amount of ZEC (for example it exceeds the maximum supply).
    InvalidAmount { index: usize },
    /// A payment in a URI has no amount, so the wallet cannot know how much to send.
    MissingAmount { index: usize },
    /// A zero amount was requested for a transparent recipient, which consensus forbids.
    ZeroValuedTransparentOutput { index: usize },
    /// A memo was given for a recipient that cannot receive one (a transparent address).
    MemoForTransparentRecipient { index: usize },
    /// The memo is longer than [`MAX_MEMO_BYTES`] bytes.
    MemoTooLong { index: usize, len: usize },
    /// The payments add up to more than can be represented.
    TotalOverflow,
    /// A payment from JavaScript is not an object with a string `to` and a whole-number `value`.
    MalformedPayment { index: usize },
    /// A memo from JavaScript is neither a string nor a `Uint8Array`.
    InvalidMemoType { index: usize },
    /// The payments total more than the account can currently spend.
    InsufficientFunds { requested: u64, spendable: u64 },
    /// The payment URI could not be parsed.
    InvalidUri(String),
    /// The wallet could not build a proposal for these payments (for example, because fees would
    /// exceed the remaining balance).
    Proposal(String),
}

impl PaymentsError {
    /// A short, stable identifier for the kind of error, suitable for programmatic handling
    /// (the human-readable message may change between releases; this will not).
    pub fn code(&self) -> &'static str {
        match self {
            PaymentsError::NoPayments => "no_payments",
            PaymentsError::InvalidAddress { .. } => "invalid_address",
            PaymentsError::WrongNetwork { .. } => "wrong_network",
            PaymentsError::InvalidAmount { .. } => "invalid_amount",
            PaymentsError::MissingAmount { .. } => "missing_amount",
            PaymentsError::ZeroValuedTransparentOutput { .. } => "zero_valued_transparent_output",
            PaymentsError::MemoForTransparentRecipient { .. } => "memo_for_transparent_recipient",
            PaymentsError::MemoTooLong { .. } => "memo_too_long",
            PaymentsError::MalformedPayment { .. } => "malformed_payment",
            PaymentsError::InvalidMemoType { .. } => "invalid_memo_type",
            PaymentsError::TotalOverflow => "total_overflow",
            PaymentsError::InsufficientFunds { .. } => "insufficient_funds",
            PaymentsError::InvalidUri(_) => "invalid_uri",
            PaymentsError::Proposal(_) => "proposal_failed",
        }
    }
}

impl fmt::Display for PaymentsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PaymentsError::NoPayments => write!(f, "At least one payment is required"),
            PaymentsError::InvalidAddress { index } => {
                write!(f, "Payment {index}: the recipient is not a valid Zcash address")
            }
            PaymentsError::WrongNetwork {
                index,
                expected,
                found,
            } => write!(
                f,
                "Payment {index}: the recipient address is for the {found} network, but this wallet is on the {expected} network"
            ),
            PaymentsError::InvalidAmount { index } => {
                write!(f, "Payment {index}: the amount is not a valid amount of ZEC")
            }
            PaymentsError::MissingAmount { index } => {
                write!(f, "Payment {index}: the payment request has no amount")
            }
            PaymentsError::ZeroValuedTransparentOutput { index } => write!(
                f,
                "Payment {index}: a zero amount cannot be sent to a transparent address"
            ),
            PaymentsError::MemoForTransparentRecipient { index } => write!(
                f,
                "Payment {index}: a memo cannot be sent to a transparent address; only shielded recipients can receive memos"
            ),
            PaymentsError::MemoTooLong { index, len } => write!(
                f,
                "Payment {index}: the memo is {len} bytes, but at most {MAX_MEMO_BYTES} are allowed"
            ),
            PaymentsError::MalformedPayment { index } => write!(
                f,
                "Payment {index}: expected an object with a string `to`, a whole-number `value` in zatoshis and an optional `memo`"
            ),
            PaymentsError::InvalidMemoType { index } => write!(
                f,
                "Payment {index}: a memo must be a string (text) or a Uint8Array (raw bytes)"
            ),
            PaymentsError::TotalOverflow => write!(f, "The payments add up to too large an amount"),
            PaymentsError::InsufficientFunds {
                requested,
                spendable,
            } => write!(
                f,
                "The payments total {requested} zatoshis, but only {spendable} zatoshis are spendable"
            ),
            PaymentsError::InvalidUri(reason) => {
                write!(f, "Invalid payment request URI: {reason}")
            }
            PaymentsError::Proposal(reason) => {
                write!(f, "Could not build a transaction proposal: {reason}")
            }
        }
    }
}

impl std::error::Error for PaymentsError {}

/// Payments that passed validation, ready to be proposed.
#[derive(Debug)]
pub struct ValidatedPayments {
    pub(crate) request: TransactionRequest,
    pub(crate) total: Zatoshis,
}

impl ValidatedPayments {
    /// The sum of all payment amounts (fees are not included).
    pub fn total(&self) -> Zatoshis {
        self.total
    }
}

/// One payment after its fields have been parsed, before it becomes a ZIP 321 [`Payment`].
struct Parsed {
    address: ZcashAddress,
    value: Zatoshis,
    memo: Option<MemoBytes>,
}

fn network_name(net: NetworkType) -> &'static str {
    match net {
        NetworkType::Main => "main",
        NetworkType::Test => "test",
        NetworkType::Regtest => "regtest",
    }
}

/// A converter that accepts every address kind, so that [`ZcashAddress::convert_if_network`] can be
/// used purely to learn whether an address belongs to a given network.
struct AnyAddress;

impl TryFromAddress for AnyAddress {
    type Error = Infallible;

    fn try_from_sprout(_: NetworkType, _: [u8; 64]) -> Result<Self, ConversionError<Infallible>> {
        Ok(AnyAddress)
    }
    fn try_from_sapling(_: NetworkType, _: [u8; 43]) -> Result<Self, ConversionError<Infallible>> {
        Ok(AnyAddress)
    }
    fn try_from_unified(
        _: NetworkType,
        _: unified::Address,
    ) -> Result<Self, ConversionError<Infallible>> {
        Ok(AnyAddress)
    }
    fn try_from_transparent_p2pkh(
        _: NetworkType,
        _: [u8; 20],
    ) -> Result<Self, ConversionError<Infallible>> {
        Ok(AnyAddress)
    }
    fn try_from_transparent_p2sh(
        _: NetworkType,
        _: [u8; 20],
    ) -> Result<Self, ConversionError<Infallible>> {
        Ok(AnyAddress)
    }
    fn try_from_tex(_: NetworkType, _: [u8; 20]) -> Result<Self, ConversionError<Infallible>> {
        Ok(AnyAddress)
    }
}

fn check_network(
    index: usize,
    address: &ZcashAddress,
    expected: NetworkType,
) -> Result<(), PaymentsError> {
    match address.clone().convert_if_network::<AnyAddress>(expected) {
        Ok(_) => Ok(()),
        Err(ConversionError::IncorrectNetwork { expected, actual }) => {
            Err(PaymentsError::WrongNetwork {
                index,
                expected: network_name(expected),
                found: network_name(actual),
            })
        }
        // `AnyAddress` accepts every kind and has no error of its own.
        Err(_) => Err(PaymentsError::InvalidAddress { index }),
    }
}

fn to_memo_bytes(index: usize, memo: &MemoInput) -> Result<Option<MemoBytes>, PaymentsError> {
    let too_long = |len: usize| PaymentsError::MemoTooLong { index, len };
    match memo {
        MemoInput::Text(text) if text.is_empty() => Ok(None),
        MemoInput::Text(text) => {
            let parsed: Memo = text.parse().map_err(|e| match e {
                memo::Error::TooLong(len) => too_long(len),
                // `Memo::from_str` only fails for length.
                memo::Error::InvalidUtf8(_) => too_long(text.len()),
            })?;
            Ok(Some(MemoBytes::from(&parsed)))
        }
        MemoInput::Bytes(bytes) if bytes.is_empty() => Ok(None),
        MemoInput::Bytes(bytes) => MemoBytes::from_bytes(bytes).map(Some).map_err(|e| match e {
            memo::Error::TooLong(len) => too_long(len),
            memo::Error::InvalidUtf8(_) => too_long(bytes.len()),
        }),
    }
}

/// Checks the parsed payments and assembles the ZIP 321 request.
fn assemble(items: Vec<Parsed>) -> Result<ValidatedPayments, PaymentsError> {
    if items.is_empty() {
        return Err(PaymentsError::NoPayments);
    }

    let mut total = Zatoshis::ZERO;
    let mut payments = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        if item.memo.is_some() && !item.address.can_receive_memo() {
            return Err(PaymentsError::MemoForTransparentRecipient { index });
        }
        if item.value == Zatoshis::ZERO && item.address.is_transparent_only() {
            return Err(PaymentsError::ZeroValuedTransparentOutput { index });
        }
        total = (total + item.value).ok_or(PaymentsError::TotalOverflow)?;
        // The checks above cover every way `Payment::new` can refuse.
        let payment = Payment::new(
            item.address,
            Some(item.value),
            item.memo,
            None,
            None,
            vec![],
        )
        .map_err(|_| PaymentsError::InvalidAddress { index })?;
        payments.push(payment);
    }

    let request =
        TransactionRequest::new(payments).map_err(|e| PaymentsError::Proposal(e.to_string()))?;
    Ok(ValidatedPayments { request, total })
}

/// Validates a list of payments for a wallet on `network`.
///
/// Checks, in this order for each payment: the address parses, it belongs to `network`, the amount
/// is valid, the memo fits and the recipient can receive it. At least one payment is required.
pub fn validate_payments(
    network: NetworkType,
    payments: &[PaymentSpec],
) -> Result<ValidatedPayments, PaymentsError> {
    if payments.is_empty() {
        return Err(PaymentsError::NoPayments);
    }

    let mut items = Vec::with_capacity(payments.len());
    for (index, spec) in payments.iter().enumerate() {
        let address = ZcashAddress::try_from_encoded(&spec.to)
            .map_err(|_| PaymentsError::InvalidAddress { index })?;
        check_network(index, &address, network)?;
        let value =
            Zatoshis::from_u64(spec.value).map_err(|_| PaymentsError::InvalidAmount { index })?;
        let memo = spec
            .memo
            .as_ref()
            .map(|m| to_memo_bytes(index, m))
            .transpose()?
            .flatten();
        items.push(Parsed {
            address,
            value,
            memo,
        });
    }
    assemble(items)
}

/// Translates the URI parser's error into one of ours.
///
/// A payment URI can contain an address and a memo, and the parser's own messages may quote the
/// text that failed to parse. Errors can end up in logs, so this never forwards that text: each
/// case becomes a typed error or a fixed description.
fn uri_error(error: Zip321Error) -> PaymentsError {
    let invalid = |reason: &str| PaymentsError::InvalidUri(reason.to_string());
    match error {
        Zip321Error::TransparentMemo(index) => PaymentsError::MemoForTransparentRecipient { index },
        Zip321Error::ZeroValuedTransparentOutput(index) => {
            PaymentsError::ZeroValuedTransparentOutput { index }
        }
        Zip321Error::RecipientMissing(index) => PaymentsError::InvalidAddress { index },
        Zip321Error::TooManyPayments(count) => {
            PaymentsError::InvalidUri(format!("the request has too many payments ({count})"))
        }
        Zip321Error::DuplicateParameter(param, index) => PaymentsError::InvalidUri(format!(
            "payment {index} has a duplicate {} parameter",
            param.name()
        )),
        Zip321Error::InvalidBase64(_) => invalid("a memo is not valid base64"),
        Zip321Error::MemoBytesError(_) => {
            invalid("a memo is longer than 512 bytes or is not valid text")
        }
        _ => invalid("the request is malformed"),
    }
}

/// Validates a [ZIP 321](https://zips.z.cash/zip-0321) payment request URI for a wallet on
/// `network`. Every payment in the URI must specify an amount.
pub fn validate_uri(network: NetworkType, uri: &str) -> Result<ValidatedPayments, PaymentsError> {
    let request = TransactionRequest::from_uri(uri).map_err(uri_error)?;

    let mut items = Vec::new();
    for (&index, payment) in request.payments() {
        check_network(index, payment.recipient_address(), network)?;
        let value = payment
            .amount()
            .ok_or(PaymentsError::MissingAmount { index })?;
        items.push(Parsed {
            address: payment.recipient_address().clone(),
            value,
            memo: payment.memo().cloned(),
        });
    }
    assemble(items)
}

/// Checks that the payments' total does not exceed what the account can spend.
///
/// This compares amounts only; the network fee is added later when the proposal is built, and a
/// shortfall caused by the fee is reported as [`PaymentsError::InsufficientFunds`] too.
pub fn check_spendable(total: Zatoshis, spendable: Zatoshis) -> Result<(), PaymentsError> {
    if total > spendable {
        Err(PaymentsError::InsufficientFunds {
            requested: total.into_u64(),
            spendable: spendable.into_u64(),
        })
    } else {
        Ok(())
    }
}

/// The value an account can spend from its shielded pools right now.
///
/// Counts Sapling, Orchard and Ironwood. Transparent funds must be shielded first, and value that
/// is still waiting for confirmations is not spendable.
pub fn spendable_shielded(balance: &AccountBalance) -> Zatoshis {
    [
        balance.sapling_balance().spendable_value(),
        balance.orchard_balance().spendable_value(),
        balance.ironwood_balance().spendable_value(),
    ]
    .into_iter()
    .fold(Zatoshis::ZERO, |acc, v| (acc + v).unwrap_or(acc))
}

/// How a memo reads back to a caller: text when it is a ZIP 302 text memo, the raw 512 bytes
/// otherwise. Raw bytes are never trimmed, because trailing zeros cannot be told apart from
/// payload: what is reported is exactly what goes on chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MemoView {
    Text(String),
    Bytes(Vec<u8>),
}

impl MemoView {
    /// `None` for the empty memo (`0xF6` followed by zeros), which means "no memo".
    pub fn from_memo_bytes(bytes: &MemoBytes) -> Option<Self> {
        match Memo::try_from(bytes) {
            Ok(Memo::Empty) => None,
            Ok(Memo::Text(t)) => Some(MemoView::Text(String::from(t))),
            // Arbitrary data, future formats and undecodable text all report the raw bytes.
            _ => Some(MemoView::Bytes(bytes.as_array().to_vec())),
        }
    }
}

/// One output the proposal pays to a recipient.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputSummary {
    pub to: String,
    pub value: u64,
    pub memo: Option<MemoView>,
}

/// One change output the wallet adds back to itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeSummary {
    /// `"sapling"`, `"orchard"`, `"ironwood"` or `"transparent"`.
    pub pool: &'static str,
    pub value: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepSummary {
    pub outputs: Vec<OutputSummary>,
    pub change: Vec<ChangeSummary>,
    /// ZIP 317 fee of this step, in zatoshis.
    pub fee: u64,
}

/// What a proposal will do, for showing to a user before they approve it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalSummary {
    /// Total ZIP 317 fee over all steps, in zatoshis.
    pub fee: u64,
    pub steps: Vec<StepSummary>,
}

fn pool_name(pool: zcash_protocol::PoolType) -> &'static str {
    use zcash_protocol::{PoolType, ShieldedPool};
    match pool {
        PoolType::Transparent => "transparent",
        PoolType::Shielded(ShieldedPool::Sapling) => "sapling",
        PoolType::Shielded(ShieldedPool::Orchard) => "orchard",
        PoolType::Shielded(ShieldedPool::Ironwood) => "ironwood",
    }
}

/// Describe a proposal: its fee and the outputs it pays.
pub fn summarize_proposal<FeeRuleT, NoteRef>(
    proposal: &zcash_client_backend::proposal::Proposal<FeeRuleT, NoteRef>,
) -> ProposalSummary {
    let steps: Vec<StepSummary> = proposal
        .steps()
        .iter()
        .map(|step| StepSummary {
            outputs: step
                .transaction_request()
                .payments()
                .values()
                .map(|p| OutputSummary {
                    to: p.recipient_address().encode(),
                    value: p.amount().map(u64::from).unwrap_or(0),
                    memo: p.memo().and_then(MemoView::from_memo_bytes),
                })
                .collect(),
            change: step
                .balance()
                .proposed_change()
                .iter()
                .map(|c| ChangeSummary {
                    pool: pool_name(c.output_pool()),
                    value: u64::from(c.value()),
                })
                .collect(),
            fee: u64::from(step.balance().fee_required()),
        })
        .collect();
    ProposalSummary {
        fee: steps.iter().map(|s| s.fee).sum(),
        steps,
    }
}

#[cfg(test)]
mod tests {
    use zcash_address::ToAddress;
    use zcash_client_backend::data_api::Balance;
    use zcash_protocol::consensus::NetworkType;
    use zcash_protocol::value::BalanceError;

    use super::*;

    const MAIN: NetworkType = NetworkType::Main;
    const TEST: NetworkType = NetworkType::Test;

    // Well-formed addresses of each kind, built from fixed bytes so the tests need no network.
    fn sapling(net: NetworkType) -> String {
        ZcashAddress::from_sapling(net, [7u8; 43]).encode()
    }
    fn transparent(net: NetworkType) -> String {
        ZcashAddress::from_transparent_p2pkh(net, [9u8; 20]).encode()
    }

    fn pay(to: String, value: u64, memo: Option<MemoInput>) -> PaymentSpec {
        PaymentSpec { to, value, memo }
    }

    fn text(s: &str) -> Option<MemoInput> {
        Some(MemoInput::Text(s.to_string()))
    }

    // ---- rule: at least one payment ----

    #[test]
    fn no_payments_is_rejected() {
        assert_eq!(
            validate_payments(TEST, &[]).unwrap_err(),
            PaymentsError::NoPayments
        );
    }

    // ---- rule: addresses belong to the wallet's network ----

    #[test]
    fn address_for_another_network_is_rejected_with_both_names() {
        let err = validate_payments(TEST, &[pay(sapling(MAIN), 1000, None)]).unwrap_err();
        assert_eq!(
            err,
            PaymentsError::WrongNetwork {
                index: 0,
                expected: "test",
                found: "main"
            }
        );
        // And the other way round.
        let err = validate_payments(MAIN, &[pay(transparent(TEST), 1000, None)]).unwrap_err();
        assert_eq!(
            err,
            PaymentsError::WrongNetwork {
                index: 0,
                expected: "main",
                found: "test"
            }
        );
    }

    #[test]
    fn wrong_network_names_the_offending_payment() {
        let err = validate_payments(
            TEST,
            &[
                pay(sapling(TEST), 1000, None),
                pay(sapling(MAIN), 1000, None),
            ],
        )
        .unwrap_err();
        assert!(matches!(err, PaymentsError::WrongNetwork { index: 1, .. }));
    }

    #[test]
    fn malformed_address_is_rejected() {
        let err = validate_payments(TEST, &[pay("not an address".into(), 1000, None)]).unwrap_err();
        assert_eq!(err, PaymentsError::InvalidAddress { index: 0 });
    }

    // ---- rule: no memo for a transparent recipient ----

    #[test]
    fn memo_to_a_transparent_recipient_is_rejected() {
        let err =
            validate_payments(TEST, &[pay(transparent(TEST), 1000, text("hello"))]).unwrap_err();
        assert_eq!(err, PaymentsError::MemoForTransparentRecipient { index: 0 });
        let err = validate_payments(
            TEST,
            &[pay(
                transparent(TEST),
                1000,
                Some(MemoInput::Bytes(vec![0xff, 1, 2])),
            )],
        )
        .unwrap_err();
        assert_eq!(err, PaymentsError::MemoForTransparentRecipient { index: 0 });
    }

    #[test]
    fn transparent_recipient_without_memo_is_accepted() {
        assert!(validate_payments(TEST, &[pay(transparent(TEST), 1000, None)]).is_ok());
    }

    #[test]
    fn empty_memo_counts_as_no_memo_even_for_transparent() {
        let v = validate_payments(
            TEST,
            &[
                pay(transparent(TEST), 1000, text("")),
                pay(transparent(TEST), 1000, Some(MemoInput::Bytes(vec![]))),
            ],
        );
        assert!(v.is_ok());
    }

    // ---- rule: memo is at most 512 bytes ----

    #[test]
    fn memo_of_exactly_512_bytes_is_accepted() {
        let at_limit = "a".repeat(MAX_MEMO_BYTES);
        assert!(validate_payments(TEST, &[pay(sapling(TEST), 1000, text(&at_limit))]).is_ok());
        let bytes = Some(MemoInput::Bytes(vec![0xff; MAX_MEMO_BYTES]));
        assert!(validate_payments(TEST, &[pay(sapling(TEST), 1000, bytes)]).is_ok());
    }

    #[test]
    fn memo_over_512_bytes_is_rejected_with_its_length() {
        let over = "a".repeat(MAX_MEMO_BYTES + 1);
        let err = validate_payments(TEST, &[pay(sapling(TEST), 1000, text(&over))]).unwrap_err();
        assert_eq!(err, PaymentsError::MemoTooLong { index: 0, len: 513 });
        let err = validate_payments(
            TEST,
            &[pay(
                sapling(TEST),
                1000,
                Some(MemoInput::Bytes(vec![0xff; 600])),
            )],
        )
        .unwrap_err();
        assert_eq!(err, PaymentsError::MemoTooLong { index: 0, len: 600 });
    }

    #[test]
    fn text_memo_length_is_counted_in_utf8_bytes_not_characters() {
        // 200 three-byte characters = 600 bytes.
        let multibyte = "€".repeat(200);
        assert_eq!(multibyte.chars().count(), 200);
        let err =
            validate_payments(TEST, &[pay(sapling(TEST), 1000, text(&multibyte))]).unwrap_err();
        assert_eq!(err, PaymentsError::MemoTooLong { index: 0, len: 600 });
    }

    // ---- memo encoding follows ZIP 302 (built from librustzcash's own types) ----

    #[test]
    fn text_memo_is_encoded_as_a_zip302_text_memo() {
        let v = validate_payments(TEST, &[pay(sapling(TEST), 1000, text("hello"))]).unwrap();
        let payment = v.request.payments().values().next().unwrap();
        let encoded = payment.memo().unwrap();
        assert_eq!(&encoded.as_array()[..5], b"hello");
        assert!(encoded.as_array()[5..].iter().all(|b| *b == 0));
        assert_eq!(
            Memo::try_from(encoded.clone()).unwrap(),
            "hello".parse::<Memo>().unwrap()
        );
    }

    #[test]
    fn binary_memo_is_sent_byte_for_byte_and_zero_padded() {
        let raw = vec![0xff, 0xde, 0xad, 0xbe, 0xef];
        let v = validate_payments(
            TEST,
            &[pay(
                sapling(TEST),
                1000,
                Some(MemoInput::Bytes(raw.clone())),
            )],
        )
        .unwrap();
        let encoded = v
            .request
            .payments()
            .values()
            .next()
            .unwrap()
            .memo()
            .unwrap();
        assert_eq!(&encoded.as_array()[..5], &raw[..]);
        assert!(encoded.as_array()[5..].iter().all(|b| *b == 0));
        // ZIP 302: a leading 0xFF byte marks arbitrary data.
        assert!(matches!(
            Memo::try_from(encoded.clone()).unwrap(),
            Memo::Arbitrary(_)
        ));
    }

    // ---- multi-payment behaviour ----

    #[test]
    fn several_payments_with_and_without_memos_are_accepted_and_totalled() {
        let v = validate_payments(
            TEST,
            &[
                pay(sapling(TEST), 1_000, text("first")),
                pay(sapling(TEST), 2_000, Some(MemoInput::Bytes(vec![0xff, 9]))),
                pay(transparent(TEST), 3_000, None),
            ],
        )
        .unwrap();
        assert_eq!(v.total(), Zatoshis::const_from_u64(6_000));
        assert_eq!(v.request.payments().len(), 3);
        // Payments keep the caller's order.
        let amounts: Vec<u64> = v
            .request
            .payments()
            .values()
            .map(|p| p.amount().unwrap().into_u64())
            .collect();
        assert_eq!(amounts, vec![1_000, 2_000, 3_000]);
    }

    #[test]
    fn amount_above_the_maximum_supply_is_rejected() {
        let err = validate_payments(TEST, &[pay(sapling(TEST), u64::MAX, None)]).unwrap_err();
        assert_eq!(err, PaymentsError::InvalidAmount { index: 0 });
    }

    #[test]
    fn totals_that_overflow_the_maximum_supply_are_rejected() {
        let max = zcash_protocol::value::MAX_MONEY;
        let err = validate_payments(
            TEST,
            &[pay(sapling(TEST), max, None), pay(sapling(TEST), 1, None)],
        )
        .unwrap_err();
        assert_eq!(err, PaymentsError::TotalOverflow);
    }

    #[test]
    fn zero_to_a_transparent_address_is_rejected_but_zero_to_shielded_with_memo_is_fine() {
        let err = validate_payments(TEST, &[pay(transparent(TEST), 0, None)]).unwrap_err();
        assert_eq!(err, PaymentsError::ZeroValuedTransparentOutput { index: 0 });
        assert!(validate_payments(TEST, &[pay(sapling(TEST), 0, text("memo only"))]).is_ok());
    }

    // ---- rule: total within the spendable balance ----

    #[test]
    fn total_above_the_spendable_balance_is_rejected() {
        let total = Zatoshis::const_from_u64(5_000);
        let spendable = Zatoshis::const_from_u64(4_999);
        assert_eq!(
            check_spendable(total, spendable).unwrap_err(),
            PaymentsError::InsufficientFunds {
                requested: 5_000,
                spendable: 4_999
            }
        );
        assert!(check_spendable(total, total).is_ok());
    }

    #[test]
    fn spendable_balance_counts_every_shielded_pool_but_not_transparent_or_pending() {
        let mut b = AccountBalance::ZERO;
        let add =
            |v: u64| move |bal: &mut Balance| bal.add_spendable_value(Zatoshis::const_from_u64(v));
        b.with_sapling_balance_mut::<_, BalanceError>(add(100))
            .unwrap();
        b.with_orchard_balance_mut::<_, BalanceError>(add(20))
            .unwrap();
        b.with_ironwood_balance_mut::<_, BalanceError>(add(3))
            .unwrap();
        b.with_unshielded_regular_balance_mut::<_, BalanceError>(add(9_000))
            .unwrap();
        b.with_ironwood_balance_mut::<_, BalanceError>(|bal: &mut Balance| {
            bal.add_pending_spendable_value(Zatoshis::const_from_u64(70_000))
        })
        .unwrap();
        assert_eq!(spendable_shielded(&b), Zatoshis::const_from_u64(123));
    }

    // ---- ZIP 321 URIs ----

    fn uri_for(addr: &str, query: &str) -> String {
        format!("zcash:{addr}?{query}")
    }

    #[test]
    fn uri_with_a_memo_is_parsed_and_validated() {
        // memo "Thanks" in base64url
        let uri = uri_for(&sapling(TEST), "amount=0.0001&memo=VGhhbmtz");
        let v = validate_uri(TEST, &uri).unwrap();
        assert_eq!(v.total(), Zatoshis::const_from_u64(10_000));
        let memo = v
            .request
            .payments()
            .values()
            .next()
            .unwrap()
            .memo()
            .unwrap();
        assert_eq!(&memo.as_array()[..6], b"Thanks");
    }

    #[test]
    fn uri_for_another_network_is_rejected() {
        let uri = uri_for(&sapling(MAIN), "amount=1");
        assert!(matches!(
            validate_uri(TEST, &uri).unwrap_err(),
            PaymentsError::WrongNetwork { index: 0, .. }
        ));
    }

    #[test]
    fn uri_payment_without_an_amount_is_rejected() {
        let uri = format!("zcash:{}", sapling(TEST));
        assert_eq!(
            validate_uri(TEST, &uri).unwrap_err(),
            PaymentsError::MissingAmount { index: 0 }
        );
    }

    #[test]
    fn garbage_uri_is_rejected_without_echoing_it() {
        let err = validate_uri(TEST, "https://example.com").unwrap_err();
        assert!(matches!(err, PaymentsError::InvalidUri(_)));
        assert!(!err.to_string().contains("example.com"));
    }

    #[test]
    fn uri_memo_to_a_transparent_address_gets_the_typed_error_with_its_index() {
        let uri = uri_for(&transparent(TEST), "amount=1&memo=VGhhbmtz");
        assert_eq!(
            validate_uri(TEST, &uri).unwrap_err(),
            PaymentsError::MemoForTransparentRecipient { index: 0 }
        );
    }

    #[test]
    fn uri_errors_never_quote_the_address_or_memo_text() {
        let addr = sapling(TEST);
        // A real address, then a memo that is not valid base64, and a stray parameter.
        for query in [
            "amount=1&memo=%%%not-base64%%%",
            "amount=1&amount=2",
            "amount=notanumber&memo=VGhhbmtz",
            "&&&memo=secret-memo-text",
        ] {
            let err = validate_uri(TEST, &uri_for(&addr, query)).unwrap_err();
            let shown = format!("{err} {err:?}");
            assert!(
                !shown.contains(&addr),
                "address leaked for {query}: {shown}"
            );
            assert!(
                !shown.contains("secret-memo-text"),
                "memo leaked for {query}: {shown}"
            );
            assert!(
                !shown.contains("not-base64"),
                "memo leaked for {query}: {shown}"
            );
        }
    }

    #[test]
    fn multi_payment_uri_keeps_each_payments_index() {
        let uri = format!(
            "zcash:?address={}&amount=1&address.1={}&amount.1=2&memo.1=VGhhbmtz",
            sapling(TEST),
            sapling(TEST)
        );
        let v = validate_uri(TEST, &uri).unwrap();
        assert_eq!(v.request.payments().len(), 2);
        assert_eq!(v.total(), Zatoshis::const_from_u64(3 * 100_000_000));
    }

    // ---- stable codes ----

    #[test]
    fn every_error_has_a_distinct_stable_code() {
        let all = [
            PaymentsError::NoPayments,
            PaymentsError::InvalidAddress { index: 0 },
            PaymentsError::WrongNetwork {
                index: 0,
                expected: "test",
                found: "main",
            },
            PaymentsError::InvalidAmount { index: 0 },
            PaymentsError::MissingAmount { index: 0 },
            PaymentsError::ZeroValuedTransparentOutput { index: 0 },
            PaymentsError::MemoForTransparentRecipient { index: 0 },
            PaymentsError::MemoTooLong { index: 0, len: 513 },
            PaymentsError::TotalOverflow,
            PaymentsError::InsufficientFunds {
                requested: 2,
                spendable: 1,
            },
            PaymentsError::MalformedPayment { index: 0 },
            PaymentsError::InvalidMemoType { index: 0 },
            PaymentsError::InvalidUri(String::new()),
            PaymentsError::Proposal(String::new()),
        ];
        let mut codes: Vec<_> = all.iter().map(PaymentsError::code).collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), all.len());
        assert_eq!(PaymentsError::NoPayments.code(), "no_payments");
        // The message always mentions which payment is wrong.
        assert!(PaymentsError::MemoTooLong { index: 3, len: 600 }
            .to_string()
            .contains("Payment 3"));
    }

    #[test]
    fn memo_view_reports_text_bytes_and_nothing() {
        let text = MemoBytes::from(&"hi there".parse::<Memo>().unwrap());
        assert_eq!(
            MemoView::from_memo_bytes(&text),
            Some(MemoView::Text("hi there".into()))
        );

        let mut raw = vec![0xFF, 1, 2, 3];
        let bin = MemoBytes::from_bytes(&raw).unwrap();
        raw.resize(512, 0);
        assert_eq!(MemoView::from_memo_bytes(&bin), Some(MemoView::Bytes(raw)));

        assert_eq!(MemoView::from_memo_bytes(&MemoBytes::empty()), None);
    }
}

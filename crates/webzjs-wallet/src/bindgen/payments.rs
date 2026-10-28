//! JavaScript-facing side of the multi-payment API: reading `{ to, value, memo }` objects from
//! JS and describing proposals back to JS.

use js_sys::{Array, BigInt, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

use crate::error::Error;
use crate::payments::{summarize_proposal, MemoInput, MemoView, PaymentSpec, PaymentsError};

#[wasm_bindgen(typescript_custom_section)]
const PAYMENT_TYPES: &'static str = r#"
/** One recipient of a multi-payment transaction. */
export interface PaymentRequest {
    /** Recipient address (unified, Sapling or transparent). */
    to: string;
    /** Amount in zatoshis (1 ZEC = 100_000_000). Use a bigint above 2^53. */
    value: number | bigint;
    /**
     * Optional memo, shielded recipients only (at most 512 bytes).
     * A string is sent as a text memo; a Uint8Array is sent as raw bytes. Empty means no memo.
     */
    memo?: string | Uint8Array;
}

/** A memo as it will appear on chain. Raw bytes are the full 512 bytes, never trimmed. */
export type ProposedMemo = string | Uint8Array;

export interface ProposedOutput {
    to: string;
    /** Zatoshis, as a bigint. */
    value: bigint;
    /** Absent when the output carries no memo. */
    memo?: ProposedMemo;
}

export interface ProposedChange {
    pool: "sapling" | "orchard" | "ironwood" | "transparent";
    value: bigint;
}

export interface ProposedStep {
    outputs: ProposedOutput[];
    change: ProposedChange[];
    /** ZIP 317 fee of this step, in zatoshis. */
    fee: bigint;
}

export interface ProposalDescription {
    /** Total ZIP 317 fee over all steps, in zatoshis. */
    fee: bigint;
    steps: ProposedStep[];
}
"#;

fn get(obj: &JsValue, key: &str) -> Option<JsValue> {
    Reflect::get(obj, &key.into())
        .ok()
        .filter(|v| !v.is_undefined() && !v.is_null())
}

fn read_value(v: &JsValue, index: usize) -> Result<u64, PaymentsError> {
    if let Some(n) = v.as_f64() {
        // Only whole numbers that a double represents exactly.
        if n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n) {
            return Ok(n as u64);
        }
        return Err(PaymentsError::InvalidAmount { index });
    }
    if v.is_bigint() {
        return u64::try_from(v.clone()).map_err(|_| PaymentsError::InvalidAmount { index });
    }
    Err(PaymentsError::MalformedPayment { index })
}

fn read_memo(v: &JsValue, index: usize) -> Result<MemoInput, PaymentsError> {
    if let Some(s) = v.as_string() {
        return Ok(MemoInput::Text(s));
    }
    if v.is_instance_of::<Uint8Array>() {
        return Ok(MemoInput::Bytes(Uint8Array::from(v.clone()).to_vec()));
    }
    Err(PaymentsError::InvalidMemoType { index })
}

/// Read a JS array of `PaymentRequest` objects.
pub fn payments_from_js(payments: &JsValue) -> Result<Vec<PaymentSpec>, Error> {
    if !Array::is_array(payments) {
        return Err(PaymentsError::NoPayments.into());
    }
    Array::from(payments)
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let to = get(&item, "to")
                .and_then(|v| v.as_string())
                .ok_or(PaymentsError::MalformedPayment { index })?;
            let value = read_value(
                &get(&item, "value").ok_or(PaymentsError::MalformedPayment { index })?,
                index,
            )?;
            let memo = get(&item, "memo")
                .map(|m| read_memo(&m, index))
                .transpose()?;
            Ok(PaymentSpec { to, value, memo })
        })
        .collect::<Result<_, PaymentsError>>()
        .map_err(Error::from)
}

fn set(obj: &Object, key: &str, value: &JsValue) {
    let _ = Reflect::set(obj, &key.into(), value);
}

/// Describe a proposal as a plain JS object (`ProposalDescription`).
pub fn describe(
    proposal: &zcash_client_backend::proposal::Proposal<
        zcash_client_backend::fees::StandardFeeRule,
        super::wallet::NoteRef,
    >,
) -> JsValue {
    let summary = summarize_proposal(proposal);
    let steps = Array::new();
    for step in &summary.steps {
        let outputs = Array::new();
        for o in &step.outputs {
            let out = Object::new();
            set(&out, "to", &o.to.as_str().into());
            set(&out, "value", &BigInt::from(o.value).into());
            match &o.memo {
                Some(MemoView::Text(t)) => set(&out, "memo", &t.as_str().into()),
                Some(MemoView::Bytes(b)) => {
                    set(&out, "memo", &Uint8Array::from(b.as_slice()).into())
                }
                None => {}
            }
            outputs.push(&out);
        }
        let change = Array::new();
        for c in &step.change {
            let ch = Object::new();
            set(&ch, "pool", &c.pool.into());
            set(&ch, "value", &BigInt::from(c.value).into());
            change.push(&ch);
        }
        let st = Object::new();
        set(&st, "outputs", &outputs);
        set(&st, "change", &change);
        set(&st, "fee", &BigInt::from(step.fee).into());
        steps.push(&st);
    }
    let result = Object::new();
    set(&result, "fee", &BigInt::from(summary.fee).into());
    set(&result, "steps", &steps);
    result.into()
}

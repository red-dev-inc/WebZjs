// Copyright 2024 ChainSafe Systems
// SPDX-License-Identifier: Apache-2.0, MIT

//! How a memo is reported to callers: its kind, its raw bytes and, for text, the decoded text.
//!
//! Memo encoding is [ZIP 302]; classification is done by librustzcash's `Memo`, not by hand.
//!
//! **Raw bytes are always the full 512 bytes, exactly as they are on chain; they are never
//! trimmed.** A memo shorter than 512 bytes is zero-padded by the protocol, and trailing zeros
//! cannot be told apart from real zero bytes in the data, so trimming would lose information. A
//! caller that wants the unpadded text should use `text`.
//!
//! [ZIP 302]: https://zips.z.cash/zip-0302

use zcash_protocol::memo::{Memo, MemoBytes};

/// What kind of memo it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoKind {
    /// No memo (`0xF6` followed by zeros).
    Empty,
    /// UTF-8 text.
    Text,
    /// Arbitrary data (leading byte `0xFF`).
    Arbitrary,
    /// A format reserved for future use by ZIP 302 (leading byte `0xF5`..=`0xFE`, or `0xF6`
    /// followed by non-zero bytes). The raw bytes are kept; nothing is decoded.
    Future,
    /// Leading byte says text, but the bytes are not valid UTF-8. ZIP 302 says such a memo must
    /// not be displayed as text; the raw bytes are kept.
    InvalidText,
}

impl MemoKind {
    /// Stable string used in JavaScript: `"empty" | "text" | "arbitrary" | "future" | "invalid_text"`.
    pub fn as_str(self) -> &'static str {
        match self {
            MemoKind::Empty => "empty",
            MemoKind::Text => "text",
            MemoKind::Arbitrary => "arbitrary",
            MemoKind::Future => "future",
            MemoKind::InvalidText => "invalid_text",
        }
    }
}

/// A memo as reported to callers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoRecord {
    pub kind: MemoKind,
    /// The full 512 bytes, as on chain.
    pub bytes: Vec<u8>,
    /// The decoded text, only for [`MemoKind::Text`].
    pub text: Option<String>,
}

impl MemoRecord {
    pub fn from_memo_bytes(memo: &MemoBytes) -> Self {
        let bytes = memo.as_array().to_vec();
        match Memo::try_from(memo) {
            Ok(Memo::Empty) => Self {
                kind: MemoKind::Empty,
                bytes,
                text: None,
            },
            Ok(Memo::Text(t)) => Self {
                kind: MemoKind::Text,
                bytes,
                text: Some(String::from(t)),
            },
            Ok(Memo::Arbitrary(_)) => Self {
                kind: MemoKind::Arbitrary,
                bytes,
                text: None,
            },
            Ok(Memo::Future(_)) => Self {
                kind: MemoKind::Future,
                bytes,
                text: None,
            },
            Err(_) => Self {
                kind: MemoKind::InvalidText,
                bytes,
                text: None,
            },
        }
    }

    pub fn from_memo(memo: &Memo) -> Self {
        Self::from_memo_bytes(&MemoBytes::from(memo))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(raw: &[u8]) -> MemoRecord {
        MemoRecord::from_memo_bytes(&MemoBytes::from_bytes(raw).unwrap())
    }

    #[test]
    fn empty_memo() {
        let r = MemoRecord::from_memo_bytes(&MemoBytes::empty());
        assert_eq!(r.kind, MemoKind::Empty);
        assert_eq!(r.bytes.len(), 512);
        assert_eq!(r.text, None);
    }

    #[test]
    fn text_memo_has_text_and_full_padded_bytes() {
        let r = MemoRecord::from_memo(&"héllo".parse::<Memo>().unwrap());
        assert_eq!(r.kind, MemoKind::Text);
        assert_eq!(r.text.as_deref(), Some("héllo"));
        assert_eq!(r.bytes.len(), 512);
        assert_eq!(&r.bytes[..6], "héllo".as_bytes());
        assert!(r.bytes[6..].iter().all(|b| *b == 0));
    }

    #[test]
    fn arbitrary_data_round_trips_byte_for_byte() {
        let mut raw = vec![0xFF, 0x00, 0x01, 0xFE, 0x00];
        let r = record(&raw);
        raw.resize(512, 0);
        assert_eq!(r.kind, MemoKind::Arbitrary);
        assert_eq!(r.bytes, raw);
        assert_eq!(r.text, None);
    }

    #[test]
    fn future_formats_keep_their_bytes() {
        for lead in [0xF5u8, 0xF7, 0xFE] {
            let r = record(&[lead, 1, 2, 3]);
            assert_eq!(r.kind, MemoKind::Future, "lead byte {lead:#x}");
            assert_eq!(r.bytes[..4], [lead, 1, 2, 3]);
        }
        // 0xF6 followed by anything but zeros is not the empty memo.
        assert_eq!(record(&[0xF6, 1]).kind, MemoKind::Future);
    }

    #[test]
    fn text_lead_byte_with_bad_utf8_is_invalid_text_not_text() {
        let r = record(&[b'a', 0xC0, 0xAF]);
        assert_eq!(r.kind, MemoKind::InvalidText);
        assert_eq!(r.text, None);
        assert_eq!(r.bytes[..3], [b'a', 0xC0, 0xAF]);
    }

    #[test]
    fn full_512_byte_memo_is_unchanged() {
        let mut raw = vec![0xFF];
        raw.extend((1..512).map(|i| (i % 251) as u8));
        let r = record(&raw);
        assert_eq!(r.bytes, raw);
    }

    #[test]
    fn kind_strings_are_distinct() {
        let all = [
            MemoKind::Empty,
            MemoKind::Text,
            MemoKind::Arbitrary,
            MemoKind::Future,
            MemoKind::InvalidText,
        ];
        let mut s: Vec<_> = all.iter().map(|k| k.as_str()).collect();
        s.sort_unstable();
        s.dedup();
        assert_eq!(s.len(), all.len());
    }
}

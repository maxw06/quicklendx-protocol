#![cfg(all(test, feature = "fuzz-tests"))]

//! Fuzz harness for the raw invoice search text helpers.
//!
//! The implementation performs ASCII-only case folding. For that reason, the
//! semantic reference check is limited to ASCII byte vectors. Arbitrary byte
//! vectors are still passed through Soroban `String::from_bytes` to prove the
//! helpers do not panic and preserve the basic empty/reflexive match contracts
//! when callers provide non-UTF-8 bytes.
//!
//! Run with:
//!   cargo test -p quicklendx-contracts --features fuzz-tests test_fuzz_search_text -- --nocapture

use crate::invoice_search::InvoiceSearch;
use alloc::vec::Vec as StdVec;
use proptest::prelude::*;
use soroban_sdk::{Env, String as SString};

fn arbitrary_bytes() -> impl Strategy<Value = StdVec<u8>> {
    prop::collection::vec(any::<u8>(), 0..=96)
}

fn ascii_bytes() -> impl Strategy<Value = StdVec<u8>> {
    prop::collection::vec(0u8..=0x7f, 0..=96)
}

fn soroban_string(env: &Env, bytes: &[u8]) -> SString {
    SString::from_bytes(env, bytes)
}

fn string_bytes(value: &SString) -> StdVec<u8> {
    let bytes = value.to_bytes();
    let mut out = StdVec::with_capacity(bytes.len() as usize);
    for i in 0..bytes.len() {
        out.push(bytes.get(i).expect("index is bounded by bytes.len()"));
    }
    out
}

fn ascii_lowercase(bytes: &[u8]) -> StdVec<u8> {
    bytes
        .iter()
        .map(|byte| {
            if byte.is_ascii_uppercase() {
                byte + 32
            } else {
                *byte
            }
        })
        .collect()
}

fn ascii_contains_reference(text: &[u8], query: &[u8]) -> bool {
    if query.is_empty() {
        return true;
    }
    if query.len() > text.len() {
        return false;
    }

    let text_lower = ascii_lowercase(text);
    let query_lower = ascii_lowercase(query);
    text_lower
        .windows(query_lower.len())
        .any(|window| window == query_lower.as_slice())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn test_fuzz_search_text_lowercase_never_panics_and_is_idempotent(bytes in arbitrary_bytes()) {
        let env = Env::default();
        let text = soroban_string(&env, &bytes);

        let lowered_once = InvoiceSearch::to_lowercase(&text);
        let lowered_twice = InvoiceSearch::to_lowercase(&lowered_once);

        prop_assert_eq!(lowered_once, lowered_twice);
    }

    #[test]
    fn test_fuzz_search_text_empty_query_always_matches(text_bytes in arbitrary_bytes()) {
        let env = Env::default();
        let text = soroban_string(&env, &text_bytes);
        let query = soroban_string(&env, b"");

        prop_assert!(InvoiceSearch::contains_substring(&text, &query));
    }

    #[test]
    fn test_fuzz_search_text_reflexive_on_arbitrary_bytes(bytes in arbitrary_bytes()) {
        let env = Env::default();
        let text = soroban_string(&env, &bytes);

        prop_assert!(InvoiceSearch::contains_substring(&text, &text));
    }

    #[test]
    fn test_fuzz_search_text_ascii_matches_reference(
        text_bytes in ascii_bytes(),
        query_bytes in ascii_bytes(),
    ) {
        let env = Env::default();
        let text = soroban_string(&env, &text_bytes);
        let query = soroban_string(&env, &query_bytes);

        prop_assert_eq!(
            InvoiceSearch::contains_substring(&text, &query),
            ascii_contains_reference(&text_bytes, &query_bytes)
        );
    }
}

#[test]
fn test_fuzz_search_text_documents_ascii_only_case_folding() {
    let env = Env::default();
    let non_ascii_upper = soroban_string(&env, b"\xC3\x89");

    let lowered = InvoiceSearch::to_lowercase(&non_ascii_upper);

    assert_eq!(string_bytes(&lowered), b"\xC3\x89");
}

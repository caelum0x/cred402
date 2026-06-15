//! Canonical JSON + blake2b-256 that exactly reproduces the Cred402 TypeScript
//! reference (`lib/core/hash.ts` `stableStringify` + `blake2b256`).
//!
//! `stableStringify` rules (mirrored here):
//!  - objects emit keys in lexicographically-sorted (UTF-16 code-unit) order,
//!    which for the ASCII field names used by Cred402 envelopes is identical to
//!    byte order;
//!  - no insignificant whitespace;
//!  - strings are JSON-escaped exactly like `JSON.stringify`;
//!  - integers are emitted with no decimal point or exponent;
//!  - booleans / null as literals.
//!
//! `blake2b256` returns `0x` + lowercase-hex of the 32-byte blake2b digest of
//! the UTF-8 bytes of the canonical JSON string.

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};

/// A minimal canonical JSON value. Only the shapes used by Cred402 envelopes are
/// representable: objects, strings, and (non-negative) integers. This is enough
/// to canonicalize a URE/CAN deterministically.
#[derive(Clone, Debug, PartialEq)]
pub enum CanonValue {
    Str(String),
    /// Integer value emitted without quotes (e.g. `created_at`, `confidence_bps`).
    Int(i128),
    /// Boolean literal.
    Bool(bool),
    /// Object with insertion-time keys; canonicalization sorts them.
    Obj(Vec<(String, CanonValue)>),
}

impl CanonValue {
    pub fn obj(pairs: Vec<(&str, CanonValue)>) -> Self {
        CanonValue::Obj(
            pairs
                .into_iter()
                .map(|(k, v)| (String::from(k), v))
                .collect(),
        )
    }

    pub fn str(s: impl Into<String>) -> Self {
        CanonValue::Str(s.into())
    }

    pub fn int(n: i128) -> Self {
        CanonValue::Int(n)
    }
}

/// Serialize to the canonical JSON string (sorted keys, no whitespace).
pub fn canonical_json(value: &CanonValue) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &CanonValue) {
    match value {
        CanonValue::Str(s) => write_json_string(out, s),
        CanonValue::Int(n) => out.push_str(&n.to_string()),
        CanonValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        CanonValue::Obj(pairs) => {
            // Sort by key (byte order == UTF-16 order for ASCII field names).
            let mut sorted: Vec<&(String, CanonValue)> = pairs.iter().collect();
            sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            out.push('{');
            for (i, (k, v)) in sorted.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, k);
                out.push(':');
                write_value(out, v);
            }
            out.push('}');
        }
    }
}

/// JSON-escape a string exactly like `JSON.stringify` for the BMP ASCII subset
/// used in Cred402 envelopes (control chars, quote, backslash escaped).
fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str("\\u");
                let code = c as u32;
                for shift in [12u32, 8, 4, 0] {
                    let nibble = (code >> shift) & 0xf;
                    out.push(core::char::from_digit(nibble, 16).unwrap());
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// blake2b-256 of arbitrary bytes, rendered as `0x` + lowercase hex, matching
/// `lib/core/hash.ts::blake2b256`.
pub fn blake2b256_hex(bytes: &[u8]) -> String {
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut s = String::from("0x");
    s.push_str(&hex::encode(digest));
    s
}

/// Convenience: canonical-JSON a value and blake2b-256 it (== `hashObject`).
pub fn hash_canonical(value: &CanonValue) -> String {
    blake2b256_hex(canonical_json(value).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_keys_and_omits_whitespace() {
        let v = CanonValue::obj(vec![
            ("b", CanonValue::int(2)),
            ("a", CanonValue::str("x")),
        ]);
        assert_eq!(canonical_json(&v), r#"{"a":"x","b":2}"#);
    }

    #[test]
    fn escapes_strings() {
        let v = CanonValue::str("a\"b\\c\n");
        assert_eq!(canonical_json(&v), r#""a\"b\\c\n""#);
    }

    #[test]
    fn blake2b_known_empty() {
        // blake2b-256 of the empty string == the @noble/hashes result used by TS.
        assert_eq!(
            blake2b256_hex(b""),
            "0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"
        );
    }
}

//! EJSON — extended JSON with tagged representations for Date,
//! RegExp, NaN/Inf, Binary, escape wrappers, and registered custom
//! types. Port of the Python / TypeScript EJSON implementations.
//!
//! See `PROTOCOL.md` §3 for the normative wire-form specification.

pub mod base64 {
    //! Base64 encoding/decoding with the MIME alphabet.
    //!
    //! Mirrors `typeferry-ts/src/ejson/base64.ts` byte-for-byte. We
    //! intentionally vendor the implementation (instead of delegating
    //! to the `base64` crate) so behavior stays byte-identical across
    //! the three language ports.

    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const INVALID: u8 = 0xFF;

    fn build_lookup() -> [u8; 256] {
        let mut lookup = [INVALID; 256];
        let mut i = 0usize;
        while i < 64 {
            lookup[ALPHABET[i] as usize] = i as u8;
            i += 1;
        }
        // URL-safe aliases accepted on decode.
        lookup[b'-' as usize] = 62;
        lookup[b'_' as usize] = 63;
        lookup
    }

    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        let mut i = 0usize;
        while i < bytes.len() {
            let b0 = bytes[i] as u32;
            let b1 = if i + 1 < bytes.len() {
                bytes[i + 1] as u32
            } else {
                0
            };
            let b2 = if i + 2 < bytes.len() {
                bytes[i + 2] as u32
            } else {
                0
            };
            let chunk = (b0 << 16) | (b1 << 8) | b2;
            let remaining = bytes.len() - i;

            out.push(ALPHABET[((chunk >> 18) & 63) as usize] as char);
            out.push(ALPHABET[((chunk >> 12) & 63) as usize] as char);
            out.push(if remaining > 1 {
                ALPHABET[((chunk >> 6) & 63) as usize] as char
            } else {
                '='
            });
            out.push(if remaining > 2 {
                ALPHABET[(chunk & 63) as usize] as char
            } else {
                '='
            });
            i += 3;
        }
        out
    }

    #[derive(Debug, thiserror::Error)]
    pub enum Base64Error {
        #[error("Invalid base64 string length")]
        InvalidLength,
        #[error("Invalid base64 character")]
        InvalidChar,
    }

    pub fn decode(value: &str) -> Result<Vec<u8>, Base64Error> {
        if !value.len().is_multiple_of(4) {
            return Err(Base64Error::InvalidLength);
        }

        let lookup = build_lookup();
        let bytes = value.as_bytes();
        let padding = if bytes.ends_with(b"==") {
            2
        } else {
            usize::from(bytes.ends_with(b"="))
        };
        let data_length = bytes.len() - padding;

        if bytes[..data_length].contains(&b'=') {
            return Err(Base64Error::InvalidChar);
        }

        let mut out = Vec::with_capacity(bytes.len() / 4 * 3 - padding);
        let read = |byte: u8| -> Result<u8, Base64Error> {
            let value = lookup[byte as usize];

            if value == INVALID {
                Err(Base64Error::InvalidChar)
            } else {
                Ok(value)
            }
        };

        for (index, chunk) in bytes.as_chunks::<4>().0.iter().enumerate() {
            let last = (index + 1) * 4 == bytes.len();
            let chunk_padding = if last { padding } else { 0 };
            let c0 = read(chunk[0])?;
            let c1 = read(chunk[1])?;
            let c2 = if chunk_padding < 2 {
                read(chunk[2])?
            } else {
                0
            };
            let c3 = if chunk_padding == 0 {
                read(chunk[3])?
            } else {
                0
            };
            // Reject non-canonical non-zero unused padding bits (RFC 4648 §3.5).
            if (chunk_padding == 1 && (c2 & 0x03) != 0) || (chunk_padding == 2 && (c1 & 0x0F) != 0)
            {
                return Err(Base64Error::InvalidChar);
            }
            let decoded =
                ((c0 as u32) << 18) | ((c1 as u32) << 12) | ((c2 as u32) << 6) | c3 as u32;

            out.push((decoded >> 16) as u8);
            if chunk_padding < 2 {
                out.push((decoded >> 8) as u8);
            }
            if chunk_padding == 0 {
                out.push(decoded as u8);
            }
        }

        Ok(out)
    }
}

pub mod stable_stringify {
    //! JavaScript object ordering for ordinary and canonical JSON output.

    use serde_json::{Map, Value};

    pub const MAX_STRINGIFY_DEPTH: usize = 128;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
    #[error("Maximum JSON nesting depth exceeded")]
    pub struct StringifyDepthError;

    pub fn try_sort_value(value: Value) -> Result<Value, StringifyDepthError> {
        order_value(value, true, 0)
    }

    pub fn sort_value(value: Value) -> Value {
        try_sort_value(value).expect("JSON nesting depth exceeded")
    }

    fn array_index(key: &str) -> Option<u32> {
        let index = key.parse::<u32>().ok()?;

        (index != u32::MAX && index.to_string() == key).then_some(index)
    }

    fn order_value(
        value: Value,
        canonical: bool,
        depth: usize,
    ) -> Result<Value, StringifyDepthError> {
        if depth > MAX_STRINGIFY_DEPTH {
            return Err(StringifyDepthError);
        }
        match value {
            Value::Array(items) => {
                let mut mapped = Vec::with_capacity(items.len());
                for item in items {
                    mapped.push(order_value(item, canonical, depth + 1)?);
                }
                Ok(Value::Array(mapped))
            }
            Value::Object(map) => {
                let mut entries: Vec<(String, Value)> = Vec::with_capacity(map.len());
                for (key, value) in map {
                    entries.push((key, order_value(value, canonical, depth + 1)?));
                }

                // JavaScript enumerates array indices numerically even when
                // canonical insertion requested a different lexical order.
                entries.sort_by(|a, b| match (array_index(&a.0), array_index(&b.0)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) if canonical => a.0.encode_utf16().cmp(b.0.encode_utf16()),
                    (None, None) => std::cmp::Ordering::Equal,
                });

                let sorted: Map<String, Value> = entries.into_iter().collect();
                Ok(Value::Object(sorted))
            }
            other => Ok(other),
        }
    }

    pub fn try_stringify(value: &Value) -> Result<String, StringifyDepthError> {
        let sorted = try_sort_value(value.clone())?;
        Ok(serde_json::to_string(&sorted).expect("canonical JSON serialization is total"))
    }

    pub fn stringify(value: &Value) -> String {
        try_stringify(value).expect("JSON nesting depth exceeded")
    }

    pub fn try_stringify_noncanonical(value: &Value) -> Result<String, StringifyDepthError> {
        let ordered = order_value(value.clone(), false, 0)?;
        Ok(serde_json::to_string(&ordered).expect("ordinary JSON serialization is total"))
    }

    /**
     * Serialize ordinary JSON using JavaScript property enumeration, preserving
     * insertion order for non-index keys. Anonymous cache identities use this
     * form rather than canonical sorting.
     */
    pub fn stringify_noncanonical(value: &Value) -> String {
        try_stringify_noncanonical(value).expect("JSON nesting depth exceeded")
    }
}

pub mod converters;
pub mod presentation;
pub mod value;

pub use converters::{Regex, from_json_value, to_json_value};
pub use presentation::Presentation;
pub use value::{EjsonDate, EjsonValue, InfNaNSign};

#[cfg(test)]
mod tests;

//! `Presentation::encode` / `decode` — the wire-layer wrapper used by
//! every TypeFerry transport.

use crate::converters::{from_json_value, to_json_value};
use crate::value::EjsonValue;
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum PresentationError {
    #[error("malformed JSON: {0}")]
    Json(#[from] serde_json::Error),
}

/// Namespace struct mirroring the TS / Python `Presentation` exports.
pub struct Presentation;

impl Presentation {
    /// Encode an `EjsonValue` as a JSON text frame.
    pub fn encode(value: &EjsonValue) -> String {
        let json = to_json_value(value);
        crate::stable_stringify::stringify_noncanonical(&json)
    }

    /**
     * Encode canonical EJSON using JavaScript index enumeration and UTF-16
     * ordering for all other object keys.
     */
    pub fn encode_canonical(value: &EjsonValue) -> String {
        crate::stable_stringify::stringify(&to_json_value(value))
    }

    /// Decode a JSON text frame into an `EjsonValue`.
    pub fn decode(source: &str) -> Result<EjsonValue, PresentationError> {
        let parsed: Value = serde_json::from_str(source)?;

        validate_binary_tags(&parsed)?;
        Ok(from_json_value(&parsed))
    }

    /// Generate a fresh UUID v4 (matches TS / Python output).
    pub fn uuid() -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

fn validate_binary_tags(value: &Value) -> Result<(), serde_json::Error> {
    match value {
        Value::Array(items) => {
            for item in items {
                validate_binary_tags(item)?;
            }
        }
        Value::Object(map) => {
            if map.len() == 1 {
                if let Some(Value::String(binary)) = map.get("$binary") {
                    crate::base64::decode(binary).map_err(|error| {
                        <serde_json::Error as serde::de::Error>::custom(error.to_string())
                    })?;
                }
                if let Some(Value::Object(literal)) = map.get("$escape") {
                    // Escaping protects this object's tag-shaped keys; nested
                    // values still use normal EJSON decoding rules.
                    for nested in literal.values() {
                        validate_binary_tags(nested)?;
                    }
                    return Ok(());
                }
            }
            for nested in map.values() {
                validate_binary_tags(nested)?;
            }
        }
        _ => {}
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_returns_v4_string() {
        let id = Presentation::uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_ne!(id, Presentation::uuid());
    }
}

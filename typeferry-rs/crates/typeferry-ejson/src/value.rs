//! `EjsonValue` — a Rust value domain that can represent every
//! TypeFerry wire-level type without losing fidelity through
//! `serde_json::Value` (which can't round-trip NaN / Inf, Date, or
//! typed binary without help).

use chrono::{DateTime, Utc};
use indexmap::IndexMap;

/**
 * A JavaScript date, including its invalid state and complete TimeClip range.
 *
 * Chrono has a smaller date range. Milliseconds remain authoritative on the
 * wire, while conversion to chrono is explicit and checked.
 */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EjsonDate(Option<i64>);

impl EjsonDate {
    pub const MAX_MILLIS: i64 = 8_640_000_000_000_000;

    /**
     * Construct a date using JavaScript's inclusive millisecond bounds.
     * Values outside that interval produce an invalid date.
     */
    pub const fn from_millis(millis: i64) -> Self {
        if millis >= -Self::MAX_MILLIS && millis <= Self::MAX_MILLIS {
            Self(Some(millis))
        } else {
            Self(None)
        }
    }

    /**
     * Return the exact epoch milliseconds, or None for an invalid date.
     */
    pub const fn timestamp_millis(self) -> Option<i64> {
        self.0
    }

    /**
     * Convert only dates representable by chrono. Invalid dates and valid
     * JavaScript dates outside chrono's range return None.
     */
    pub fn to_chrono(self) -> Option<DateTime<Utc>> {
        DateTime::from_timestamp_millis(self.0?)
    }

    pub(crate) fn from_number(millis: f64) -> Self {
        if millis.is_finite() && millis.abs() <= Self::MAX_MILLIS as f64 {
            Self(Some(millis.trunc() as i64))
        } else {
            Self(None)
        }
    }
}

impl From<DateTime<Utc>> for EjsonDate {
    fn from(date: DateTime<Utc>) -> Self {
        Self::from_millis(date.timestamp_millis())
    }
}

/// Insertion-order-preserving map used for `EjsonValue::Object` so the
/// encoder emits keys in the order they were inserted — matching the
/// TS / Python wire output. Switching to `BTreeMap` would alphabetize
/// keys and break byte-level wire parity for any object whose keys
/// aren't already sorted.
pub type EjsonMap = IndexMap<String, EjsonValue>;

/// A value that can be converted to/from an EJSON-tagged
/// `serde_json::Value`.
#[derive(Debug, Clone, PartialEq)]
pub enum EjsonValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
    Array(Vec<EjsonValue>),
    Object(EjsonMap),
    /// JS `Date` — always treated as UTC (JS Date has no timezone).
    Date(EjsonDate),
    /// JS `Uint8Array` / Node `Buffer`.
    Binary(Vec<u8>),
    /// JS `RegExp`.
    Regex(super::converters::Regex),
    /// NaN, +Infinity, -Infinity.
    InfNaN(InfNaNSign),
    /// Registered custom type: `{"$type": name, "$value": ...}`.
    Custom {
        name: String,
        value: Box<EjsonValue>,
    },
}

/// Sign discriminator used in the `$InfNaN` tag form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InfNaNSign {
    NaN = 0,
    PositiveInfinity = 1,
    NegativeInfinity = -1,
}

impl EjsonValue {
    /// Convenience constructor that preserves JS number semantics:
    /// integers stay `Int`, non-finite floats become `InfNaN`.
    pub fn from_f64(value: f64) -> Self {
        if value.is_nan() {
            EjsonValue::InfNaN(InfNaNSign::NaN)
        } else if value == f64::INFINITY {
            EjsonValue::InfNaN(InfNaNSign::PositiveInfinity)
        } else if value == f64::NEG_INFINITY {
            EjsonValue::InfNaN(InfNaNSign::NegativeInfinity)
        } else if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
            EjsonValue::Int(value as i64)
        } else {
            EjsonValue::Float(value)
        }
    }
}

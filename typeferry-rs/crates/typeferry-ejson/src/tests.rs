//! Unit tests for the EJSON layer. Covers base64 round-trips, every
//! tag form, decoy escaping, and end-to-end `Presentation` encode/
//! decode parity.

use super::*;
use crate::base64::{decode, encode};
use crate::value::EjsonMap as BTreeMap;
use crate::value::{EjsonValue, InfNaNSign};
use chrono::{TimeZone, Utc};

#[test]
fn base64_round_trip_matches_mime_alphabet() {
    assert_eq!(encode(b""), "");
    assert_eq!(encode(b"a"), "YQ==");
    assert_eq!(encode(b"ab"), "YWI=");
    assert_eq!(encode(b"abc"), "YWJj");

    let payload: Vec<u8> = (0u8..=255u8).collect();
    let encoded = encode(&payload);
    let decoded = decode(&encoded).unwrap();
    assert_eq!(decoded, payload);
}

#[test]
fn base64_accepts_url_safe_input() {
    let data = b"\xfa\xff\xf0";
    assert_eq!(encode(data), "+v/w");
    assert_eq!(decode("-v_w").unwrap(), data);
}

#[test]
fn base64_rejects_bad_inputs() {
    assert!(matches!(
        decode("abc"),
        Err(base64::Base64Error::InvalidLength)
    ));
    assert!(matches!(
        decode("!!!!"),
        Err(base64::Base64Error::InvalidChar)
    ));
}

#[test]
fn date_round_trips_through_json() {
    let dt = Utc.with_ymd_and_hms(2024, 6, 1, 12, 30, 45).unwrap();
    let encoded = Presentation::encode(&EjsonValue::Date(dt.into()));
    let decoded = Presentation::decode(&encoded).unwrap();
    assert_eq!(decoded, EjsonValue::Date(dt.into()));
    assert!(encoded.contains("\"$date\""));
}

#[test]
fn binary_decoder_round_trips_generated_short_inputs() {
    for length in 0..=32 {
        let bytes: Vec<u8> = (0..length).map(|index| (index * 37) as u8).collect();
        let encoded = encode(&bytes);

        assert_eq!(decode(&encoded).unwrap(), bytes, "length {length}");
    }
}

#[test]
fn binary_decoder_rejects_malformed_padding_without_panicking() {
    for encoded in ["====", "A===", "=AAA", "AA=A", "AA==AAAA", "AAA====="] {
        assert!(decode(encoded).is_err(), "accepted {encoded}");
    }
}

#[test]
fn date_decoder_preserves_the_entire_javascript_range() {
    for millis in [-8_640_000_000_000_000_i64, 8_640_000_000_000_000] {
        let wire = format!("{{\"$date\":{millis}}}");
        let decoded = Presentation::decode(&wire).unwrap();

        assert_eq!(Presentation::encode(&decoded), wire);
    }
}

#[test]
fn invalid_dates_follow_javascript_encoding_without_panicking() {
    for millis in [
        i64::MIN,
        -8_640_000_000_000_001,
        8_640_000_000_000_001,
        i64::MAX,
    ] {
        let wire = format!("{{\"nested\":[{{\"$date\":{millis}}}]}}");
        let decoded = Presentation::decode(&wire).unwrap();

        assert_eq!(
            Presentation::encode(&decoded),
            r#"{"nested":[{"$date":null}]}"#
        );
    }
}

#[test]
fn date_api_converts_to_chrono_only_when_representable() {
    let ordinary = Utc.with_ymd_and_hms(2024, 6, 1, 12, 30, 45).unwrap();
    let date = EjsonDate::from(ordinary);

    assert_eq!(date.to_chrono(), Some(ordinary));
    assert_eq!(date.timestamp_millis(), Some(ordinary.timestamp_millis()));
    for millis in [-EjsonDate::MAX_MILLIS, EjsonDate::MAX_MILLIS] {
        let boundary = EjsonDate::from_millis(millis);

        assert_eq!(boundary.timestamp_millis(), Some(millis));
        assert!(boundary.to_chrono().is_none());
    }
    assert!(EjsonDate::from_millis(i64::MAX).to_chrono().is_none());
    assert!(
        EjsonDate::from_millis(i64::MAX)
            .timestamp_millis()
            .is_none()
    );
}

#[test]
fn date_tag_coercion_matches_the_typescript_converter() {
    for (raw, millis) in [
        ("null", Some(0)),
        ("false", Some(0)),
        ("true", Some(1)),
        ("1.9", Some(1)),
        (r#""123""#, Some(123)),
        ("[]", Some(0)),
        ("[1]", Some(1)),
        ("{}", None),
    ] {
        let date = Presentation::decode(&format!("{{\"$date\":{raw}}}")).unwrap();
        let expected = serde_json::json!({"$date":millis});

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&Presentation::encode(&date)).unwrap(),
            expected
        );
    }
}

#[test]
fn date_number_coercion_uses_ecmascript_whitespace() {
    for (whitespace, millis) in [('\u{feff}', Some(1)), ('\u{85}', None)] {
        let encoded = serde_json::json!({"$date":format!("{whitespace}1{whitespace}")}).to_string();
        let decoded = Presentation::decode(&encoded).unwrap();
        let expected = serde_json::json!({"$date":millis}).to_string();

        assert_eq!(Presentation::encode(&decoded), expected);
    }
}

#[test]
fn presentation_rejects_invalid_binary_tags_but_preserves_escaped_literals() {
    for encoded in ["abc", "====", "AA=A", "!!!!"] {
        let wire = serde_json::json!({"nested":[{"$binary":encoded}]}).to_string();

        assert!(Presentation::decode(&wire).is_err(), "accepted {encoded}");
        let literal = serde_json::json!({"$escape":{"$binary":encoded}}).to_string();

        assert!(Presentation::decode(&literal).is_ok());
    }
}

#[test]
fn ordinary_encoding_enumerates_array_index_keys_before_other_keys() {
    let mut entries = BTreeMap::new();
    for key in ["z", "10", "2", "01", "4294967295", "a"] {
        entries.insert(key.into(), EjsonValue::String(key.into()));
    }

    assert_eq!(
        Presentation::encode(&EjsonValue::Object(entries)),
        r#"{"2":"2","10":"10","z":"z","01":"01","4294967295":"4294967295","a":"a"}"#
    );
}

#[test]
fn canonical_encoding_preserves_index_order_and_uses_utf16_for_other_keys() {
    let value = serde_json::from_str::<serde_json::Value>(
        r#"{"nested":{"\ue000":1,"𐀀":2,"10":10,"2":2,"z":0,"a":3}}"#,
    )
    .unwrap();

    assert_eq!(
        stable_stringify::stringify(&value),
        "{\"nested\":{\"2\":2,\"10\":10,\"a\":3,\"z\":0,\"𐀀\":2,\"\u{e000}\":1}}"
    );
}

#[test]
fn nan_and_infinities_use_tag_form() {
    for (value, sign) in [
        (EjsonValue::InfNaN(InfNaNSign::NaN), 0),
        (EjsonValue::InfNaN(InfNaNSign::PositiveInfinity), 1),
        (EjsonValue::InfNaN(InfNaNSign::NegativeInfinity), -1),
    ] {
        let encoded = Presentation::encode(&value);
        assert!(encoded.contains("\"$InfNaN\""));
        assert!(encoded.contains(&sign.to_string()));
        assert_eq!(Presentation::decode(&encoded).unwrap(), value);
    }
}

#[test]
fn binary_round_trip() {
    let value = EjsonValue::Binary(b"\xde\xad\xbe\xef".to_vec());
    let encoded = Presentation::encode(&value);
    assert!(encoded.contains("\"$binary\""));
    assert_eq!(Presentation::decode(&encoded).unwrap(), value);
}

#[test]
fn regex_flag_sanitization_round_trip() {
    let rx = converters::Regex {
        source: "^foo$".into(),
        flags: "gix".into(),
    };
    let encoded = Presentation::encode(&EjsonValue::Regex(rx));
    let decoded = Presentation::decode(&encoded).unwrap();
    // 'x' is not in the allowed JS flag set — it MUST be stripped.
    match decoded {
        EjsonValue::Regex(rx) => {
            assert_eq!(rx.source, "^foo$");
            assert_eq!(rx.flags, "gi");
        }
        other => panic!("unexpected: {other:?}"),
    }
}

#[test]
fn escape_wraps_decoy_date_shape() {
    let mut decoy = BTreeMap::new();
    decoy.insert("$date".to_string(), EjsonValue::Int(123));
    let encoded = Presentation::encode(&EjsonValue::Object(decoy.clone()));
    // Must be wrapped in $escape to survive decode.
    assert!(encoded.contains("\"$escape\""));

    let decoded = Presentation::decode(&encoded).unwrap();
    // Decoding the $escape form returns the original plain object —
    // NOT a Date.
    match decoded {
        EjsonValue::Object(map) => {
            assert_eq!(map.get("$date"), Some(&EjsonValue::Int(123)));
        }
        other => panic!("unexpected: {other:?}"),
    }
}

#[test]
fn custom_type_round_trip() {
    let value = EjsonValue::Custom {
        name: "address".to_string(),
        value: Box::new({
            let mut m = BTreeMap::new();
            m.insert(
                "street".to_string(),
                EjsonValue::String("1 Main".to_string()),
            );
            m.insert(
                "city".to_string(),
                EjsonValue::String("Springfield".to_string()),
            );
            EjsonValue::Object(m)
        }),
    };
    let encoded = Presentation::encode(&value);
    assert!(encoded.contains("\"$type\""));
    assert_eq!(Presentation::decode(&encoded).unwrap(), value);
}

#[test]
fn nested_containers_recurse() {
    let mut inner = BTreeMap::new();
    inner.insert(
        "at".to_string(),
        EjsonValue::Date(Utc.timestamp_opt(0, 0).unwrap().into()),
    );
    inner.insert("blob".to_string(), EjsonValue::Binary(vec![1, 2, 3]));

    let mut outer = BTreeMap::new();
    outer.insert(
        "list".to_string(),
        EjsonValue::Array(vec![EjsonValue::Int(1), EjsonValue::Object(inner.clone())]),
    );
    outer.insert("meta".to_string(), EjsonValue::Object(inner));

    let encoded = Presentation::encode(&EjsonValue::Object(outer.clone()));
    let decoded = Presentation::decode(&encoded).unwrap();
    assert_eq!(decoded, EjsonValue::Object(outer));
}

#[test]
fn stable_stringify_sorts_keys_recursively() {
    let input = serde_json::json!({
        "z": {"b": 1, "a": 2},
        "a": [1, 2, 3],
    });
    let out = stable_stringify::stringify(&input);
    assert_eq!(out, r#"{"a":[1,2,3],"z":{"a":2,"b":1}}"#);
}

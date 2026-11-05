//! Replay every EJSON fixture against the Rust encoder/decoder.

use typeferry_conformance::{list_cases, load_json, rehydrate};
use typeferry_ejson::Presentation;

#[test]
fn ejson_fixtures_encode_to_expected_wire_bytes() {
    let cases = list_cases("ejson", ".case.json");
    assert!(!cases.is_empty(), "no EJSON fixtures found");
    for case_path in &cases {
        let fixture = load_json(case_path);
        let value = rehydrate(&fixture["value"]);
        let actual = if fixture["canonical"].as_bool().unwrap_or(false) {
            Presentation::encode_canonical(&value)
        } else {
            Presentation::encode(&value)
        };
        let expected = fixture["encoded"].as_str().expect("encoded is a string");
        assert_eq!(actual, expected, "{}: encode mismatch", case_path.display());
    }
}

#[test]
fn ejson_fixtures_decode_then_re_encode_identically() {
    let cases = list_cases("ejson", ".case.json");
    for case_path in &cases {
        let fixture = load_json(case_path);
        let encoded = fixture["encoded"].as_str().unwrap();
        let decoded = Presentation::decode(encoded).expect("decode succeeds");
        let re_encoded = if fixture["canonical"].as_bool().unwrap_or(false) {
            Presentation::encode_canonical(&decoded)
        } else {
            Presentation::encode(&decoded)
        };
        assert_eq!(
            re_encoded,
            encoded,
            "{}: decode/re-encode mismatch",
            case_path.display()
        );
    }
}

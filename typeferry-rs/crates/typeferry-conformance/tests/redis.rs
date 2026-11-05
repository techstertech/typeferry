//! Replay the shared Redis envelopes through the production encoding helpers.

use serde_json::Value;
use typeferry_conformance::{list_cases, load_json};
use typeferry_redis::{build_publish_envelope, decode_inbound};

#[test]
fn shared_redis_fixtures_match_publish_and_inbound_envelopes() {
    let cases = list_cases("redis", ".case.json");
    assert!(!cases.is_empty());

    for path in cases {
        let fixture = load_json(&path);

        if fixture["direction"] == "inbound" {
            let decoded = decode_inbound(fixture["incoming_payload"].as_str().unwrap()).unwrap();
            let expected = &fixture["expected_propagate_call"];

            assert_eq!(
                decoded.event,
                expected["event"].as_str().unwrap(),
                "{}",
                path.display()
            );
            assert_eq!(decoded.channel, expected["channel"].as_str().unwrap());
            assert_eq!(decoded.message, expected["payload"].as_str().unwrap());
            assert_eq!(
                decoded.exclude_uuid.as_deref(),
                expected["exclude_uuid"].as_str()
            );
        } else {
            let publish = &fixture["publish"];
            let encoded = build_publish_envelope(
                publish["event"].as_str().unwrap(),
                publish["channel"].as_str().unwrap(),
                publish["message"].as_str().unwrap(),
                publish["exclude_uuid"].as_str(),
            );
            let decoded: Value = serde_json::from_str(&encoded).unwrap();

            assert_eq!(
                typeferry_protocol::REDIS_EVENTS_CHANNEL,
                fixture["expected_redis_channel"].as_str().unwrap()
            );
            assert_eq!(
                decoded,
                fixture["expected_payload_decoded"],
                "{}",
                path.display()
            );
        }
    }
}

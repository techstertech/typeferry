//! Replay every WebSocket sequence fixture against the Rust WS
//! transport using a real tokio-tungstenite client over an axum
//! server bound to 127.0.0.1:0.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use futures::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use typeferry_conformance::{configure_server, list_cases, load_ndjson};
use typeferry_runtime::{Server, ServerOptions};

/// Spin up a server with the given setup, return (server, http_port).
async fn spawn_server(setup: Option<&Value>) -> (Arc<Server>, u16) {
    let server = Server::new(ServerOptions::default());
    configure_server(&server, setup);

    let app: Router = typeferry_ws::router(server.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    // Tiny grace period for the listener to register.
    tokio::time::sleep(Duration::from_millis(20)).await;
    (server, port)
}

fn build_query(query: &Value) -> String {
    if let Some(obj) = query.as_object()
        && !obj.is_empty()
    {
        let pairs: Vec<String> = obj
            .iter()
            .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default()))
            .collect();
        return format!("?{}", pairs.join("&"));
    }
    String::new()
}

async fn next_text<
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
>(
    stream: &mut S,
) -> String {
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let s = text.to_string();
                // Skip server-initiated pings (PROTOCOL.md §5.2.4).
                if let Ok(decoded) = serde_json::from_str::<Value>(&s)
                    && decoded.get("t").and_then(|v| v.as_str()) == Some("ping")
                {
                    continue;
                }
                return s;
            }
            Ok(Message::Close(_)) => panic!("server closed connection unexpectedly"),
            Ok(_) => continue,
            Err(e) => panic!("ws stream error: {e}"),
        }
    }
    panic!("ws stream ended without expected frame");
}

#[tokio::test]
async fn ws_fixtures_match_rust_runtime() {
    let cases = list_cases("ws", ".seq.ndjson");
    assert!(!cases.is_empty(), "no WS fixtures found");

    for path in cases {
        let mut script = load_ndjson(&path);
        let setup = script.remove(0);
        assert_eq!(
            setup["op"],
            "setup",
            "{}: first op must be setup",
            path.display()
        );
        let (server, port) = spawn_server(Some(&setup)).await;

        let connect = script.remove(0);
        assert_eq!(
            connect["op"],
            "connect",
            "{}: 2nd op must be connect",
            path.display()
        );

        let url = format!(
            "ws://127.0.0.1:{port}/typeferry-ws{}",
            build_query(&connect["query"])
        );

        let (mut ws_stream, _) = connect_async(&url).await.unwrap_or_else(|e| {
            panic!("{}: connect failed: {e}", path.display());
        });

        for op in script {
            let kind = op["op"].as_str().unwrap();
            match kind {
                "send" => {
                    let frame = serde_json::to_string(&op["frame"]).unwrap();
                    ws_stream.send(Message::Text(frame.into())).await.unwrap();
                }
                "expect_server_frame" => {
                    let raw = timeout(Duration::from_secs(2), next_text(&mut ws_stream))
                        .await
                        .unwrap_or_else(|_| {
                            panic!("{}: timed out waiting for server frame", path.display())
                        });
                    let mut decoded: Value = serde_json::from_str(&raw).unwrap();

                    // Event frames carry a server-assigned uuid that
                    // fixtures can't predict — strip before compare.
                    if decoded.get("t").and_then(|v| v.as_str()) == Some("event")
                        && !op["frame"]
                            .as_object()
                            .map(|m| m.contains_key("uuid"))
                            .unwrap_or(false)
                        && let Value::Object(map) = &mut decoded
                    {
                        map.remove("uuid");
                    }

                    let expected = sort_object_keys(op["frame"].clone());
                    let actual = sort_object_keys(decoded);
                    assert_eq!(actual, expected, "{}: expected != actual", path.display());
                }
                "expect_no_server_frame" => {
                    let window = Duration::from_millis(
                        op.get("within_ms").and_then(|v| v.as_u64()).unwrap_or(100),
                    );
                    expect_no_server_frame(&mut ws_stream, window)
                        .await
                        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
                }
                "server_emit" => {
                    let channel = op["channel"].as_str().unwrap().to_string();
                    let event = op["event"].as_str().unwrap().to_string();
                    let params = op["params"].clone();
                    let event_obj = server
                        .events
                        .read()
                        .unwrap()
                        .get(&event)
                        .cloned()
                        .expect("event registered");
                    let (payload, _exclude) = event_obj.encode_payload(&channel, &params);
                    server
                        .channel(&channel)
                        .propagate(&event, &payload, None)
                        .await;
                }
                "disconnect" => {
                    ws_stream.close(None).await.ok();
                    break;
                }
                other => panic!("unknown op {other} in {}", path.display()),
            }
        }
    }
}

async fn expect_no_server_frame<
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
>(
    stream: &mut S,
    window: Duration,
) -> Result<(), String> {
    match timeout(window, next_text(stream)).await {
        Ok(text) => Err(format!("unexpected frame within {window:?}: {text}")),
        Err(_) => Ok(()),
    }
}

#[tokio::test]
async fn negative_fixture_assertions_reject_an_unexpected_frame() {
    let mut stream = futures::stream::iter([Ok(Message::Text("unexpected".into()))]);

    let error = expect_no_server_frame(&mut stream, Duration::from_millis(100))
        .await
        .unwrap_err();

    assert!(error.contains("unexpected"));
}

/// Recursively sort object keys so `assert_eq` is order-insensitive
/// for top-level field comparison. WS fixtures specify expected
/// frames with a particular key order; the real Rust server emits in
/// whatever order serde_json's preserve_order keeps. Sorting both
/// sides eliminates that as a source of false-positive mismatches.
fn sort_object_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut out = Map::new();
            for (k, v) in entries {
                out.insert(k, sort_object_keys(v));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sort_object_keys).collect()),
        other => other,
    }
}

// Suppress unused-import warning when no fixture uses these.
#[allow(dead_code)]
fn _shut_up_unused_json_macro() -> Value {
    json!({})
}

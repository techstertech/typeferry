use futures::{FutureExt, SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use typeferry_runtime::{Server, ServerOptions};
use typeferry_ws::WebSocketOptions;

#[tokio::test]
async fn ws_duplicate_origin_size_limit_collision_and_user_index() {
    let server = Server::new(ServerOptions::default());
    server.set_auth(Arc::new(|_node, ctx| {
        async move {
            if ctx.get("token").and_then(|v| v.as_str()) == Some("victim-tok") {
                json!({"user": {"_id": "u1"}})
            } else {
                Value::Null
            }
        }
        .boxed()
    }));

    let app = typeferry_ws::router_with_options(
        server.clone(),
        WebSocketOptions {
            origins: Some(vec!["https://allowed.test".into()]),
            allow_originless: false,
        },
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;

    // 1) Duplicate Origin rejected cleanly
    let dup_req = Request::builder()
        .uri(format!("ws://127.0.0.1:{port}/typeferry-ws"))
        .header("Host", format!("127.0.0.1:{port}"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("Origin", "https://allowed.test")
        .header("Origin", "https://evil.test")
        .body(())
        .unwrap();
    assert!(connect_async(dup_req).await.is_err());

    // 2) Victim connects + authenticates -> clients_by_user_id must contain victim
    let victim_req = Request::builder()
        .uri(format!(
            "ws://127.0.0.1:{port}/typeferry-ws?uuid=victim-id&token=victim-tok"
        ))
        .header("Host", format!("127.0.0.1:{port}"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("Origin", "https://allowed.test")
        .body(())
        .unwrap();
    let (mut victim_ws, _) = connect_async(victim_req).await.unwrap();
    let auth_frame = victim_ws.next().await.unwrap().unwrap();
    let v_json: Value = serde_json::from_str(auth_frame.to_text().unwrap()).unwrap();
    assert_eq!(v_json["authenticated"], true);
    assert!(server.clients_by_user_id.read().unwrap().contains_key("u1"));

    // 3) Attacker tries colliding uuid -> assigned fresh UUID, victim remains intact!
    let attacker_req = Request::builder()
        .uri(format!("ws://127.0.0.1:{port}/typeferry-ws?uuid=victim-id"))
        .header("Host", format!("127.0.0.1:{port}"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("Origin", "https://allowed.test")
        .body(())
        .unwrap();
    let (mut attacker_ws, _) = connect_async(attacker_req).await.unwrap();
    let a_auth = attacker_ws.next().await.unwrap().unwrap();
    let a_json: Value = serde_json::from_str(a_auth.to_text().unwrap()).unwrap();
    assert_eq!(a_json["authenticated"], false);

    let victim_node = server
        .clients
        .read()
        .unwrap()
        .get("victim-id")
        .cloned()
        .unwrap();
    assert!(victim_node.is_authenticated());
    assert_eq!(server.clients.read().unwrap().len(), 2);

    // 4) Oversized WS frame > 1 MiB closes connection
    let _ = attacker_ws
        .send(Message::Text("a".repeat(1024 * 1024 + 1024).into()))
        .await;
    let next = tokio::time::timeout(Duration::from_secs(2), attacker_ws.next()).await;
    if let Ok(Some(Ok(Message::Text(_)))) = next {
        panic!("oversized message should have closed socket");
    }

    let _ = victim_ws.close(None).await;
}

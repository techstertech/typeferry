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
            ..Default::default()
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
    let next = tokio::time::timeout(Duration::from_secs(2), attacker_ws.next())
        .await
        .expect("timed out waiting for close frame after oversized message");
    assert!(
        !matches!(next, Some(Ok(Message::Text(_)))),
        "oversized message should have closed socket"
    );

    // 5) Server-initiated socket.close() tears down handle_connection promptly even with open peer
    victim_node.close().await;
    let closed_frame = tokio::time::timeout(Duration::from_secs(2), victim_ws.next())
        .await
        .expect("server close() did not terminate peer WS promptly");
    assert!(
        !matches!(closed_frame, Some(Ok(Message::Text(_)))),
        "expected victim WS close after node.close()"
    );
}

#[tokio::test]
async fn ws_handshake_authenticator_query_opt_out_and_rate_limit() {
    use typeferry_runtime::MethodOptions;
    use typeferry_ws::RateLimit;

    // 1) allow_query_token: false blocks ?token= while handshake_authenticator still authenticates
    let server = Server::new(ServerOptions::default());
    server.set_auth(Arc::new(|_n, ctx| {
        async move {
            if ctx.get("token").and_then(|v| v.as_str()) == Some("query-secret") {
                json!({"user": {"_id": "query-user"}})
            } else {
                Value::Null
            }
        }
        .boxed()
    }));
    server.add_method(
        "echo",
        Arc::new(|_n, p| async move { Ok(p) }.boxed()),
        MethodOptions::default(),
    );

    let blocked_app = typeferry_ws::router_with_options(
        server.clone(),
        WebSocketOptions {
            allow_query_token: false,
            rate_limit: Some(RateLimit {
                max: 2,
                window: Duration::from_secs(60),
            }),
            ..Default::default()
        },
    );
    let listener1 = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port1 = listener1.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener1, blocked_app).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;

    let (mut ws1, _) = connect_async(format!(
        "ws://127.0.0.1:{port1}/typeferry-ws?token=query-secret"
    ))
    .await
    .unwrap();
    let auth1: Value =
        serde_json::from_str(ws1.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(auth1["authenticated"], false);

    // Rate limit 2 per window: 3rd RPC returns Rate Limit Exceeded, pong still accepted.
    ws1.send(Message::Text(
        r#"{"t":"rpc","id":"1","method":"echo"}"#.into(),
    ))
    .await
    .unwrap();
    ws1.send(Message::Text(
        r#"{"t":"rpc","id":"2","method":"echo"}"#.into(),
    ))
    .await
    .unwrap();
    ws1.send(Message::Text(
        r#"{"t":"rpc","id":"3","method":"echo"}"#.into(),
    ))
    .await
    .unwrap();
    let _ = ws1.next().await.unwrap().unwrap();
    let _ = ws1.next().await.unwrap().unwrap();
    let r3: Value =
        serde_json::from_str(ws1.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(r3["id"], "3");
    assert_eq!(r3["error"], typeferry_protocol::errors::RATE_LIMIT_EXCEEDED);
    ws1.send(Message::Text(r#"{"t":"pong"}"#.into()))
        .await
        .unwrap();

    // 2) handshake_authenticator takes precedence and never falls back to ?token=
    let hs_app = typeferry_ws::router_with_options(
        server,
        WebSocketOptions {
            handshake_authenticator: Some(Arc::new(|_node, handshake| {
                async move {
                    if handshake.headers.get("cookie").map(String::as_str) == Some("sid=good") {
                        json!({"user": {"_id": "cookie-user"}})
                    } else {
                        Value::Null
                    }
                }
                .boxed()
            })),
            ..Default::default()
        },
    );
    let listener2 = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port2 = listener2.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener2, hs_app).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;

    let fail_req = Request::builder()
        .uri(format!(
            "ws://127.0.0.1:{port2}/typeferry-ws?token=query-secret"
        ))
        .header("Host", format!("127.0.0.1:{port2}"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_fail, _) = connect_async(fail_req).await.unwrap();
    let auth_fail: Value =
        serde_json::from_str(ws_fail.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(auth_fail["authenticated"], false);

    let ok_req = Request::builder()
        .uri(format!(
            "ws://127.0.0.1:{port2}/typeferry-ws?token=query-secret"
        ))
        .header("Host", format!("127.0.0.1:{port2}"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("Cookie", "sid=good")
        .body(())
        .unwrap();
    let (mut ws_ok, _) = connect_async(ok_req).await.unwrap();
    let auth_ok: Value =
        serde_json::from_str(ws_ok.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(auth_ok["authenticated"], true);
}

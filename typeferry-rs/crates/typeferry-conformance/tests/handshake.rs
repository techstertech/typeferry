//! Handshake contracts require a real upgraded connection, not dispatch mocks.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use futures::{FutureExt, SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Error, Message, client::IntoClientRequest},
};
use typeferry_protocol::{AUTH_TIMEOUT_MS, MAX_META_SIZE, MAX_UUID_LENGTH};
use typeferry_runtime::{MethodOptions, Server, ServerOptions};
use url::Url;

type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct RunningServer {
    server: Arc<Server>,
    port: u16,
    task: JoinHandle<()>,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn spawn(server: Arc<Server>) -> RunningServer {
    spawn_with_options(server, typeferry_ws::WebSocketOptions::default()).await
}

async fn spawn_with_options(
    server: Arc<Server>,
    options: typeferry_ws::WebSocketOptions,
) -> RunningServer {
    server.add_method(
        "inspect",
        Arc::new(|node, _params| {
            async move {
                Ok(json!({"uuid": node.uuid(), "meta": node.meta.read().unwrap().clone()}))
            }
            .boxed()
        }),
        MethodOptions::default(),
    );
    server.add_method(
        "secret",
        Arc::new(|_node, _params| async move { Ok(json!("secret")) }.boxed()),
        MethodOptions {
            protected: true,
            ..Default::default()
        },
    );

    let app = typeferry_ws::router_with_options(server.clone(), options);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    RunningServer { server, port, task }
}

async fn connect(server: &RunningServer, query: &[(&str, &str)]) -> TestSocket {
    let mut url = Url::parse(&format!("ws://127.0.0.1:{}/typeferry-ws", server.port)).unwrap();
    url.query_pairs_mut().extend_pairs(query.iter().copied());

    connect_async(url.as_str()).await.unwrap().0
}

async fn receive(socket: &mut TestSocket) -> Value {
    let message = timeout(Duration::from_secs(6), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    serde_json::from_str(message.to_text().unwrap()).unwrap()
}

async fn rpc(socket: &mut TestSocket, method: &str) -> Value {
    let frame = json!({"t":"rpc", "id":"probe", "method":method});

    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .unwrap();
    receive(socket).await
}

#[tokio::test]
async fn handshake_rejects_falsey_authentication_and_preserves_truthy_containers() {
    for result in [
        Value::Null,
        json!(false),
        json!(0),
        json!(-0.0),
        json!(""),
        json!([]),
        json!({}),
    ] {
        let allowed = matches!(result, Value::Array(_) | Value::Object(_));
        let server = Server::new(ServerOptions::default());
        server.set_auth(Arc::new(move |_node, _context| {
            let result = result.clone();

            async move { result }.boxed()
        }));
        let running = spawn(server).await;
        let mut socket = connect(&running, &[("token", "provided")]).await;

        assert_eq!(
            receive(&mut socket).await,
            json!({"t":"auth", "authenticated":allowed})
        );
        let response = rpc(&mut socket, "secret").await;

        if allowed {
            assert_eq!(response["result"], "secret");
        } else {
            assert_eq!(response["error"], "Method Forbidden");
        }

        socket.close(None).await.unwrap();
    }
}

#[tokio::test]
async fn missing_token_never_invokes_authentication() {
    let calls = Arc::new(AtomicUsize::new(0));
    let auth_calls = calls.clone();
    let server = Server::new(ServerOptions::default());
    server.set_auth(Arc::new(move |_node, _context| {
        auth_calls.fetch_add(1, Ordering::Relaxed);

        async move { json!({"user":{"_id":"u1"}}) }.boxed()
    }));
    let running = spawn(server).await;
    let mut socket = connect(&running, &[]).await;

    assert_eq!(
        receive(&mut socket).await,
        json!({"t":"auth", "authenticated":false})
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn authentication_timeout_fails_closed_and_cancels_late_completion() {
    let completed = Arc::new(AtomicBool::new(false));
    let auth_completed = completed.clone();
    let server = Server::new(ServerOptions::default());
    server.set_auth(Arc::new(move |_node, _context| {
        let completed = auth_completed.clone();

        async move {
            tokio::time::sleep(Duration::from_millis(AUTH_TIMEOUT_MS + 100)).await;
            completed.store(true, Ordering::Relaxed);
            json!({"user":{"_id":"late-user"}})
        }
        .boxed()
    }));
    let running = spawn(server).await;
    let mut socket = connect(&running, &[("token", "slow")]).await;

    assert_eq!(
        receive(&mut socket).await,
        json!({"t":"auth", "authenticated":false})
    );
    assert_eq!(
        rpc(&mut socket, "secret").await["error"],
        "Method Forbidden"
    );
    assert!(
        timeout(Duration::from_millis(250), socket.next())
            .await
            .is_err()
    );
    assert!(!completed.load(Ordering::Relaxed));
    assert!(
        running
            .server
            .clients
            .read()
            .unwrap()
            .values()
            .all(|node| !node.is_authenticated())
    );
}

#[tokio::test]
async fn handshake_replaces_invalid_uuids_and_preserves_valid_uuids() {
    let running = spawn(Server::new(ServerOptions::default())).await;
    let oversized = "x".repeat(MAX_UUID_LENGTH + 1);

    for candidate in [
        "",
        "invalid_/value",
        "!",
        "😀",
        oversized.as_str(),
        "client-A-42",
    ] {
        let mut socket = connect(&running, &[("uuid", candidate)]).await;
        receive(&mut socket).await;
        let response = rpc(&mut socket, "inspect").await;
        let uuid = response["result"]["uuid"].as_str().unwrap();

        if candidate == "client-A-42" {
            assert_eq!(uuid, candidate);
        } else {
            assert_ne!(uuid, candidate);
        }

        assert!(!uuid.is_empty() && uuid.len() <= MAX_UUID_LENGTH);
        assert!(
            uuid.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        );
        socket.close(None).await.unwrap();
    }
}

#[tokio::test]
async fn metadata_preserves_raw_objects_and_enforces_raw_utf8_limit() {
    let running = spawn(Server::new(ServerOptions::default())).await;
    let exact = format!(r#"{{"v":"{}"}}"#, "é".repeat((MAX_META_SIZE - 8) / 2));
    assert_eq!(exact.len(), MAX_META_SIZE);
    let oversized = format!(r#"{{"v":"{}"}}"#, "é".repeat(MAX_META_SIZE / 2));
    let whitespace = format!("{}{{}}", " ".repeat(MAX_META_SIZE));

    for raw in [
        r#"{"$date":0,"nested":{"$binary":"AA=="}}"#,
        exact.as_str(),
        oversized.as_str(),
        whitespace.as_str(),
        "[]",
        "null",
        "invalid",
    ] {
        let expected = if raw.len() <= MAX_META_SIZE {
            serde_json::from_str::<Value>(raw)
                .ok()
                .filter(Value::is_object)
                .unwrap_or(json!({}))
        } else {
            json!({})
        };
        let mut socket = connect(&running, &[("meta", raw)]).await;
        receive(&mut socket).await;

        assert_eq!(
            rpc(&mut socket, "inspect").await["result"]["meta"],
            expected
        );
        socket.close(None).await.unwrap();
    }
}

#[tokio::test]
async fn websocket_origin_admission_precedes_authentication() {
    for (origins, allow_originless, origin, admitted) in [
        (None, false, None, true),
        (None, false, Some("https://other.test"), true),
        (Some(vec![]), false, None, false),
        (Some(vec![]), false, Some("https://allowed.test"), false),
        (Some(vec![]), true, None, true),
        (Some(vec!["".into()]), false, Some(""), false),
        (Some(vec!["".into()]), true, Some(""), false),
        (
            Some(vec!["https://allowed.test".into()]),
            false,
            Some("https://allowed.test"),
            true,
        ),
        (
            Some(vec!["https://allowed.test".into()]),
            false,
            None,
            false,
        ),
        (Some(vec!["https://allowed.test".into()]), true, None, true),
        (
            Some(vec!["https://allowed.test".into()]),
            true,
            Some("https://other.test"),
            false,
        ),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let auth_calls = calls.clone();
        let server = Server::new(ServerOptions::default());
        server.set_auth(Arc::new(move |_node, _context| {
            auth_calls.fetch_add(1, Ordering::Relaxed);

            async move { json!({}) }.boxed()
        }));
        let running = spawn_with_options(
            server,
            typeferry_ws::WebSocketOptions {
                origins,
                allow_originless,
            },
        )
        .await;
        let mut request = format!("ws://127.0.0.1:{}/typeferry-ws?token=present", running.port)
            .into_client_request()
            .unwrap();

        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
        }

        let result = connect_async(request).await;

        if admitted {
            let mut socket = result.unwrap().0;

            assert_eq!(receive(&mut socket).await["authenticated"], true);
            socket.close(None).await.unwrap();
        } else {
            match result {
                Err(Error::Http(response)) => {
                    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN)
                }
                _ => panic!("disallowed origin reached the WebSocket transport"),
            }
        }
        assert_eq!(calls.load(Ordering::Relaxed), usize::from(admitted));
    }
}

#[tokio::test]
async fn originless_optins_are_independent_between_transports() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    for (allow_http, allow_ws) in [(true, false), (false, true)] {
        let server = Server::new(ServerOptions::default());
        let origins = Some(vec!["https://allowed.test".into()]);
        let running = spawn_with_options(
            server.clone(),
            typeferry_ws::WebSocketOptions {
                origins: origins.clone(),
                allow_originless: allow_ws,
            },
        )
        .await;
        let http = typeferry_http::router_with_options(
            server,
            typeferry_http::HttpOptions {
                origins,
                allow_originless: allow_http,
            },
        );
        let response = http
            .oneshot(
                Request::post("/__h")
                    .body(Body::from(r#"{"payload":{"method":"inspect"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            if allow_http {
                StatusCode::OK
            } else {
                StatusCode::FORBIDDEN
            }
        );
        let result = connect_async(format!("ws://127.0.0.1:{}/typeferry-ws", running.port)).await;

        if allow_ws {
            let mut socket = result.unwrap().0;

            assert_eq!(receive(&mut socket).await["authenticated"], false);
        } else {
            assert!(
                matches!(result, Err(Error::Http(response)) if response.status() == StatusCode::FORBIDDEN)
            );
        }
    }
}

#[tokio::test]
async fn websocket_dispatch_uses_ejson_date_and_binary_decoding() {
    let server = Server::new(ServerOptions::default());
    server.add_method(
        "echo",
        Arc::new(|_node, params| async move { Ok(params) }.boxed()),
        MethodOptions::default(),
    );
    let running = spawn(server).await;
    let mut socket = connect(&running, &[]).await;
    receive(&mut socket).await;

    for millis in [-8_640_000_000_000_000_i64, 8_640_000_000_000_000, i64::MAX] {
        let frame = json!({"t":"rpc","id":"date","method":"echo","params":{"$date":millis}});

        socket
            .send(Message::Text(frame.to_string().into()))
            .await
            .unwrap();
        let expected = if millis == i64::MAX {
            Value::Null
        } else {
            json!(millis)
        };

        assert_eq!(
            receive(&mut socket).await["result"],
            json!({"$date":expected})
        );
    }

    let invalid =
        json!({"t":"rpc","id":"invalid-binary","method":"echo","params":{"$binary":"===="}});

    socket
        .send(Message::Text(invalid.to_string().into()))
        .await
        .unwrap();
    assert!(
        timeout(Duration::from_millis(100), socket.next())
            .await
            .is_err()
    );
    assert_eq!(rpc(&mut socket, "inspect").await["t"], "rpc:res");
}

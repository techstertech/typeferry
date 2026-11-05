//! HTTP transport wire-level tests (PROTOCOL.md §2.1).
//!
//! Uses `tower::ServiceExt::oneshot` to drive the axum router without
//! spinning up a real socket.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use futures::FutureExt;
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use typeferry_http::router;
use typeferry_runtime::error::PublicError;
use typeferry_runtime::{ClientNode, MethodOptions, Server, ServerOptions};

async fn post(
    server: Arc<Server>,
    headers: Vec<(&'static str, &'static str)>,
    body: &str,
) -> (StatusCode, Value) {
    let router = router(server);
    let mut builder = Request::builder()
        .method("POST")
        .uri("/__h")
        .header(header::CONTENT_TYPE, "text/plain");
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let req = builder.body(Body::from(body.to_string())).unwrap();
    let response = router.oneshot(req).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    let parsed: Value = if text.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap()
    };
    (status, parsed)
}

fn build_server() -> Arc<Server> {
    Server::new(ServerOptions::default())
}

#[tokio::test]
async fn protected_http_calls_follow_javascript_authentication_truthiness() {
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
        let server = build_server();
        server.set_auth(Arc::new(move |_node, _context| {
            let result = result.clone();

            async move { result }.boxed()
        }));
        server.add_method(
            "secret",
            Arc::new(|_node, _params| async move { Ok(json!("secret")) }.boxed()),
            MethodOptions {
                protected: true,
                ..Default::default()
            },
        );
        let (_, body) = post(server, vec![], r#"{"payload":{"method":"secret"}}"#).await;

        if allowed {
            assert_eq!(body["result"], "secret");
        } else {
            assert_eq!(body["message"], "Method Forbidden");
        }
    }
}

#[tokio::test]
async fn invalid_ejson_binary_returns_invalid_request_instead_of_panicking() {
    let (_, body) = post(
        build_server(),
        vec![],
        r#"{"payload":{"method":"echo","params":{"$binary":"===="}}}"#,
    )
    .await;

    assert_eq!(body["message"], "Invalid Request");
}

#[tokio::test]
async fn happy_path_returns_result_envelope() {
    let server = build_server();
    let handler = Arc::new(|_n: Arc<ClientNode>, p: Value| {
        async move { Ok(json!(p["a"].as_i64().unwrap() + p["b"].as_i64().unwrap())) }.boxed()
    });
    server.add_method("add", handler, MethodOptions::default());

    let (status, body) = post(
        server,
        vec![],
        r#"{"context":{},"payload":{"method":"add","params":{"a":2,"b":3},"uuid":"c1"}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["type"], "result");
    assert_eq!(body["uuid"], "c1");
    assert_eq!(body["method"], "add");
    assert_eq!(body["result"], json!(5));
}

#[tokio::test]
async fn missing_payload_returns_invalid_request() {
    let server = build_server();
    let (_, body) = post(server, vec![], r#"{"context":{}}"#).await;
    assert_eq!(body["type"], "error");
    assert_eq!(body["message"], "Invalid Request");
}

#[tokio::test]
async fn method_not_found_echoes_method_name() {
    let server = build_server();
    let (_, body) = post(
        server,
        vec![],
        r#"{"context":{},"payload":{"method":"nope","uuid":"c1"}}"#,
    )
    .await;
    assert_eq!(body["message"], "Method Not Found");
    // METHOD_NOT_FOUND envelope carries `method`, no `uuid` (TS parity).
    assert_eq!(body["method"], "nope");
    assert_eq!(body.get("uuid"), None);
}

#[tokio::test]
async fn protected_method_without_auth_is_forbidden() {
    let server = build_server();
    let handler =
        Arc::new(|_n: Arc<ClientNode>, _p: Value| async move { Ok(json!("secret")) }.boxed());
    server.add_method(
        "secret",
        handler,
        MethodOptions {
            protected: true,
            ..Default::default()
        },
    );
    let (_, body) = post(
        server,
        vec![],
        r#"{"context":{},"payload":{"method":"secret"}}"#,
    )
    .await;
    assert_eq!(body["message"], "Method Forbidden");
    assert_eq!(body["method"], "secret");
}

#[tokio::test]
async fn public_error_passes_through() {
    let server = build_server();
    let handler = Arc::new(|_n: Arc<ClientNode>, _p: Value| {
        async move {
            Err(typeferry_runtime::TypeFerryError::Public(PublicError::new(
                "intentional",
            )))
        }
        .boxed()
    });
    server.add_method("boom", handler, MethodOptions::default());

    let (_, body) = post(
        server,
        vec![],
        r#"{"context":{},"payload":{"method":"boom","uuid":"c1"}}"#,
    )
    .await;
    assert_eq!(body["message"], "intentional");
    assert_eq!(body["uuid"], "c1");
}

#[tokio::test]
async fn void_does_not_suppress_success_body() {
    // Per PROTOCOL.md §2.1.3 / TS+Python parity: void on HTTP suppresses
    // error responses ONLY. Success bodies still return.
    let server = build_server();
    let handler =
        Arc::new(|_n: Arc<ClientNode>, _p: Value| async move { Ok(json!("ignored")) }.boxed());
    server.add_method("track", handler, MethodOptions::default());

    let (status, body) = post(
        server,
        vec![],
        r#"{"context":{},"payload":{"method":"track","void":true}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["type"], "result");
    assert_eq!(body["result"], "ignored");
}

#[tokio::test]
async fn void_call_suppresses_error_body() {
    let server = build_server();
    let handler = Arc::new(|_n: Arc<ClientNode>, _p: Value| {
        async move {
            Err(typeferry_runtime::TypeFerryError::Public(PublicError::new(
                "silent",
            )))
        }
        .boxed()
    });
    server.add_method("boom", handler, MethodOptions::default());

    let (status, body) = post(
        server,
        vec![],
        r#"{"context":{},"payload":{"method":"boom","void":true}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, Value::Null);
}

#[tokio::test]
async fn internal_error_normalizes_unknown_exceptions() {
    let server = build_server();
    let handler = Arc::new(|_n: Arc<ClientNode>, _p: Value| {
        async move {
            Err(typeferry_runtime::TypeFerryError::Internal(
                "never leaks".to_string(),
            ))
        }
        .boxed()
    });
    server.add_method("crash", handler, MethodOptions::default());

    let (_, body) = post(
        server,
        vec![],
        r#"{"context":{},"payload":{"method":"crash"}}"#,
    )
    .await;
    assert_eq!(body["message"], "Internal Error");
}

#[tokio::test]
async fn schema_validation_surfaces_errors_field() {
    use typeferry_runtime::{SchemaValidator, ValidationIssue, ValidationResult};

    struct RejectAll;
    impl SchemaValidator for RejectAll {
        fn safe_parse(&self, _value: &Value) -> ValidationResult {
            ValidationResult::failure(vec![
                ValidationIssue {
                    path: vec!["a".into()],
                    message: "required".into(),
                },
                ValidationIssue {
                    path: vec!["b".into(), "c".into()],
                    message: "too short".into(),
                },
            ])
        }
    }

    let server = build_server();
    let handler = Arc::new(|_n: Arc<ClientNode>, _p: Value| async move { unreachable!() }.boxed());
    server.add_method(
        "v",
        handler,
        MethodOptions {
            schema: Some(Arc::new(RejectAll)),
            ..Default::default()
        },
    );

    let (_, body) = post(server, vec![], r#"{"context":{},"payload":{"method":"v"}}"#).await;
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .starts_with("Invalid Params")
    );
    assert_eq!(body["errors"], json!(["a: required", "b.c: too short"]));
}

#[tokio::test]
async fn x_client_id_overrides_node_uuid() {
    let server = build_server();
    let handler =
        Arc::new(|node: Arc<ClientNode>, _p: Value| async move { Ok(json!(node.uuid())) }.boxed());
    server.add_method("who", handler, MethodOptions::default());

    let (_, body) = post(
        server,
        vec![("x-client-id", "client-abc")],
        r#"{"context":{},"payload":{"method":"who"}}"#,
    )
    .await;
    assert_eq!(body["result"], json!("client-abc"));
}

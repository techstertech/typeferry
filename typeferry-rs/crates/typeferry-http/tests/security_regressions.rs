use axum::body::Body;
use axum::http::{HeaderValue, Request, StatusCode, header};
use futures::FutureExt;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
use typeferry_http::{HttpOptions, router, router_with_options};
use typeferry_runtime::{MethodOptions, Server, ServerOptions};

#[tokio::test]
async fn duplicate_origin_rejected_with_403() {
    let server = Server::new(ServerOptions::default());
    let app = router_with_options(
        server,
        HttpOptions {
            origins: Some(vec!["https://allowed.test".into()]),
            allow_originless: false,
        },
    );
    let mut req = Request::post("/__h")
        .body(Body::from(r#"{"payload":{"method":"missing"}}"#))
        .unwrap();
    req.headers_mut().append(
        header::ORIGIN,
        HeaderValue::from_static("https://allowed.test"),
    );
    req.headers_mut().append(
        header::ORIGIN,
        HeaderValue::from_static("https://evil.test"),
    );

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn body_limit_4mib_and_bearer_strip_and_client_id_validation() {
    let server = Server::new(ServerOptions::default());
    let seen_token = Arc::new(Mutex::new(None::<String>));
    let seen_id = Arc::new(Mutex::new(None::<String>));
    let st = seen_token.clone();
    let si = seen_id.clone();

    server.set_auth(Arc::new(move |node, ctx| {
        let st = st.clone();
        let si = si.clone();
        async move {
            *st.lock().unwrap() = ctx
                .get("token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            *si.lock().unwrap() = Some(node.uuid());
            Value::Null
        }
        .boxed()
    }));
    server.add_method(
        "ping",
        Arc::new(|_n, _p| async move { Ok(json!(true)) }.boxed()),
        MethodOptions::default(),
    );

    let app = router(server);

    // 1) Bearer prefix corruption check: "BearerBtok" must NOT strip "Bearer"/"B"/"e"...
    let resp = app
        .clone()
        .oneshot(
            Request::post("/__h")
                .header("x-api-key", "BearerBtok")
                .header("x-client-id", "bad/id!")
                .body(Body::from(r#"{"payload":{"method":"ping"}}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let _ = resp.into_body().collect().await.unwrap();
    assert_eq!(seen_token.lock().unwrap().as_deref(), Some("BearerBtok"));
    let got_id = seen_id.lock().unwrap().clone().unwrap();
    assert_ne!(got_id, "bad/id!");
    assert!(
        !got_id.is_empty()
            && got_id.len() <= 64
            && got_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    );

    // 2) Body > 4 MiB rejected with 413 PAYLOAD_TOO_LARGE
    let huge = "x".repeat(4 * 1024 * 1024 + 1024);
    let resp_big = app
        .oneshot(Request::post("/__h").body(Body::from(huge)).unwrap())
        .await
        .unwrap();
    assert_eq!(resp_big.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

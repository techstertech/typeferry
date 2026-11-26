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
            ..Default::default()
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

#[tokio::test]
async fn http_context_filtered_by_allowed_keys() {
    let server = Server::new(ServerOptions::default());
    server.set_allowed_context_keys(vec!["locale".into(), "token".into(), "__proto__".into()]);
    let seen = Arc::new(Mutex::new(None::<Value>));
    let seen_c = seen.clone();
    server.set_auth(Arc::new(move |_n, ctx| {
        let seen_c = seen_c.clone();
        async move {
            *seen_c.lock().unwrap() = Some(ctx);
            json!({"user": {"_id": "u1"}})
        }
        .boxed()
    }));
    server.add_method(
        "ok",
        Arc::new(|_n, _p| async move { Ok(json!(true)) }.boxed()),
        MethodOptions::default(),
    );

    let app = router(server);
    let resp = app
        .oneshot(
            Request::post("/__h")
                .header("x-api-key", "Bearer real-tok")
                .body(Body::from(
                    r#"{"context":{"locale":"pt","role":"admin","token":"spoof"},"payload":{"method":"ok"}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ctx = seen.lock().unwrap().clone().unwrap();
    assert_eq!(ctx.get("locale"), Some(&json!("pt")));
    assert_eq!(ctx.get("role"), None);
    assert_eq!(ctx.get("token"), Some(&json!("real-tok")));
}

#[tokio::test]
async fn http_rate_limit_emits_headers_and_returns_429() {
    use std::time::Duration;
    use typeferry_http::RateLimit;
    use typeferry_protocol::OriginPolicy;

    let server = Server::new(ServerOptions::default());
    server.add_method(
        "ok",
        Arc::new(|_n, _p| async move { Ok(json!(true)) }.boxed()),
        MethodOptions::default(),
    );

    let converted = HttpOptions::from(OriginPolicy {
        origins: Some(vec!["https://a.test".into()]),
        allow_originless: true,
    });
    assert!(converted.rate_limit.is_some());

    let app = router_with_options(
        server,
        HttpOptions {
            rate_limit: Some(RateLimit {
                max: 2,
                window: Duration::from_secs(60),
            }),
            ..Default::default()
        },
    );

    let r1 = app
        .clone()
        .oneshot(
            Request::post("/__h")
                .body(Body::from(r#"{"payload":{"method":"ok"}}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r1.status(), StatusCode::OK);
    assert_eq!(r1.headers()["ratelimit-limit"], "2");
    assert_eq!(r1.headers()["ratelimit-remaining"], "1");
    assert!(r1.headers().contains_key("ratelimit-reset"));

    let r2 = app
        .clone()
        .oneshot(
            Request::post("/__h")
                .body(Body::from(r#"{"payload":{"method":"ok"}}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r2.status(), StatusCode::OK);
    assert_eq!(r2.headers()["ratelimit-remaining"], "0");

    let r3 = app
        .oneshot(
            Request::post("/__h")
                .body(Body::from(r#"{"payload":{"method":"ok"}}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r3.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r3.headers()["ratelimit-limit"], "2");
    assert_eq!(r3.headers()["ratelimit-remaining"], "0");
}

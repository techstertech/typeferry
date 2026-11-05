//! Origin admission must precede body extraction and application callbacks.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use futures::FutureExt;
use serde_json::json;
use tower::ServiceExt;
use typeferry_http::{HttpOptions, router, router_with_options};
use typeferry_runtime::{MethodOptions, Server, ServerOptions};

#[tokio::test]
async fn default_router_remains_unrestricted_without_automatic_cors_headers() {
    let app = router(Server::new(ServerOptions::default()));
    let response = app
        .oneshot(
            Request::post("/__h")
                .header(header::ORIGIN, "https://other.test")
                .body(Body::from(r#"{"payload":{"method":"absent"}}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    for name in [
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        header::ACCESS_CONTROL_ALLOW_METHODS,
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        header::VARY,
    ] {
        assert!(
            !response.headers().contains_key(&name),
            "default router added {name}"
        );
    }
}

#[tokio::test]
async fn default_router_does_not_add_automatic_preflight_handling() {
    let app = router(Server::new(ServerOptions::default()));
    let response = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/__h")
                .header(header::ORIGIN, "https://other.test")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert!(
        !response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );
}

#[tokio::test]
async fn origin_policies_admit_only_the_selected_requests() {
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
        let handler_calls = calls.clone();
        let server = Server::new(ServerOptions::default());
        server.set_auth(Arc::new(move |_node, _context| {
            auth_calls.fetch_add(1, Ordering::Relaxed);

            async move { json!({}) }.boxed()
        }));
        server.add_method(
            "ok",
            Arc::new(move |_node, _params| {
                handler_calls.fetch_add(1, Ordering::Relaxed);

                async move { Ok(json!(true)) }.boxed()
            }),
            MethodOptions::default(),
        );
        let configured = origins.is_some();
        let options = HttpOptions {
            origins,
            allow_originless,
        };
        let app = router_with_options(server, options);
        let mut request = Request::post("/__h");

        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }

        let response = app
            .oneshot(
                request
                    .body(Body::from(r#"{"payload":{"method":"ok"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            if admitted {
                StatusCode::OK
            } else {
                StatusCode::FORBIDDEN
            }
        );
        assert_eq!(calls.load(Ordering::Relaxed), if admitted { 2 } else { 0 });
        if admitted
            && configured
            && let Some(origin) = origin
        {
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                origin
            );
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS],
                "true"
            );
        } else {
            assert!(
                !response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            );
            assert!(
                !response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
            );
        }
    }
}

#[tokio::test]
async fn rejected_origins_do_not_read_the_request_body_or_affect_unrelated_routes() {
    let polls = Arc::new(AtomicUsize::new(0));
    let body_polls = polls.clone();
    let body = Body::from_stream(futures::stream::once(async move {
        body_polls.fetch_add(1, Ordering::Relaxed);

        Ok::<_, std::io::Error>("not-json")
    }));
    let options = HttpOptions {
        origins: Some(vec![]),
        ..Default::default()
    };
    let app = router_with_options(Server::new(ServerOptions::default()), options)
        .route("/health", axum::routing::get(|| async { "ok" }));
    let response = app
        .clone()
        .oneshot(Request::post("/__h").body(body).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(polls.load(Ordering::Relaxed), 0);
    assert_eq!(
        app.oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn admitted_preflight_returns_cors_headers_without_running_authentication() {
    let server = Server::new(ServerOptions::default());
    server.set_auth(Arc::new(|_node, _context| {
        async move { panic!("preflight must not authenticate") }.boxed()
    }));
    let app = router_with_options(
        server,
        HttpOptions {
            origins: Some(vec!["https://allowed.test".into()]),
            ..Default::default()
        },
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/__h")
                .header(header::ORIGIN, "https://allowed.test")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(response.status().is_success());
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS],
        "true"
    );
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "https://allowed.test"
    );
    assert!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_METHODS]
            .to_str()
            .unwrap()
            .contains("POST")
    );
}

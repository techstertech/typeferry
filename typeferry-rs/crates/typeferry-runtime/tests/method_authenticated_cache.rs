//! Authenticated callers execute authorization on every cached-method invocation.

use futures::FutureExt;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use typeferry_runtime::{ClientNode, Method, MethodOptions, PublicError, TypeFerryError};

fn authenticated_node(user_id: &str) -> Arc<ClientNode> {
    let node = ClientNode::new(None);
    node.set_authenticated(true);
    node.set_context(json!({"user": {"_id": user_id}}));
    node
}

#[tokio::test]
async fn authenticated_cached_methods_isolate_callers_and_repeat_handlers() {
    for protected in [false, true] {
        let calls = Arc::new(AtomicUsize::new(0));
        let handler_calls = calls.clone();
        let handler = Arc::new(move |node: Arc<ClientNode>, _params: Value| {
            let calls = handler_calls.clone();
            async move {
                calls.fetch_add(1, Ordering::Relaxed);
                Ok(json!(node.user_id.read().unwrap().clone()))
            }
            .boxed()
        });
        let method = Method::new(
            "caller",
            handler,
            MethodOptions {
                cache: true,
                protected,
                ..Default::default()
            },
        );
        let alice = authenticated_node("alice");
        let bob = authenticated_node("bob");

        assert_eq!(
            method.exec(json!({}), alice.clone()).await.unwrap(),
            json!("alice")
        );
        assert_eq!(method.exec(json!({}), bob).await.unwrap(), json!("bob"));
        assert_eq!(method.exec(json!({}), alice).await.unwrap(), json!("alice"));
        assert_eq!(calls.load(Ordering::Relaxed), 3);
    }
}

#[tokio::test]
async fn authenticated_cached_method_rechecks_inline_authorization() {
    let allowed = Arc::new(AtomicBool::new(true));
    let handler_allowed = allowed.clone();
    let handler = Arc::new(move |_node: Arc<ClientNode>, _params: Value| {
        let allowed = handler_allowed.clone();
        async move {
            if !allowed.load(Ordering::Relaxed) {
                return Err(PublicError::new("access revoked").into());
            }
            Ok(json!("private result"))
        }
        .boxed()
    });
    let method = Method::new(
        "private",
        handler,
        MethodOptions {
            cache: true,
            ..Default::default()
        },
    );
    let node = authenticated_node("alice");

    assert_eq!(
        method.exec(json!({}), node.clone()).await.unwrap(),
        json!("private result")
    );
    allowed.store(false, Ordering::Relaxed);

    assert!(matches!(
        method.exec(json!({}), node).await,
        Err(TypeFerryError::Public(error)) if error.message == "access revoked"
    ));
}

#[tokio::test]
async fn authentication_transitions_neither_read_nor_populate_anonymous_cache() {
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = calls.clone();
    let handler = Arc::new(move |node: Arc<ClientNode>, _params: Value| {
        let calls = handler_calls.clone();
        async move {
            let invocation = calls.fetch_add(1, Ordering::Relaxed) + 1;
            Ok(json!({"authenticated": node.is_authenticated(), "invocation": invocation}))
        }
        .boxed()
    });
    let method = Method::new(
        "transition",
        handler,
        MethodOptions {
            cache: true,
            ..Default::default()
        },
    );
    let node = ClientNode::new(None);

    let anonymous = method.exec(json!({"key": 1}), node.clone()).await.unwrap();
    node.set_authenticated(true);
    assert_eq!(
        method.exec(json!({"key": 1}), node.clone()).await.unwrap(),
        json!({"authenticated": true, "invocation": 2})
    );
    assert_eq!(
        method.exec(json!({"key": 2}), node.clone()).await.unwrap(),
        json!({"authenticated": true, "invocation": 3})
    );
    node.set_authenticated(false);
    assert_eq!(
        method.exec(json!({"key": 1}), node.clone()).await.unwrap(),
        anonymous
    );
    assert_eq!(
        method.exec(json!({"key": 2}), node.clone()).await.unwrap(),
        json!({"authenticated": false, "invocation": 4})
    );
    assert_eq!(
        method.exec(json!({"key": 2}), node).await.unwrap(),
        json!({"authenticated": false, "invocation": 4})
    );
    assert_eq!(calls.load(Ordering::Relaxed), 4);
}

#[tokio::test]
async fn anonymous_cached_method_preserves_hits_and_ttl_expiration() {
    const MAX_AGE_MS: u64 = 20;

    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = calls.clone();
    let handler = Arc::new(move |_node: Arc<ClientNode>, _params: Value| {
        let calls = handler_calls.clone();
        async move { Ok(json!(calls.fetch_add(1, Ordering::Relaxed) + 1)) }.boxed()
    });
    let method = Method::new(
        "anonymous",
        handler,
        MethodOptions {
            cache: true,
            max_age_ms: Some(MAX_AGE_MS),
            ..Default::default()
        },
    );
    let node = ClientNode::new(None);

    assert_eq!(
        method.exec(json!({}), node.clone()).await.unwrap(),
        json!(1)
    );
    assert_eq!(
        method.exec(json!({}), node.clone()).await.unwrap(),
        json!(1)
    );
    tokio::time::sleep(Duration::from_millis(MAX_AGE_MS * 2)).await;
    assert_eq!(method.exec(json!({}), node).await.unwrap(), json!(2));
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}

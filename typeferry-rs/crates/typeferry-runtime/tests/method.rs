//! Unit tests for `Method` execution: schema, middleware, cache, context.

use futures::FutureExt;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use typeferry_runtime::{
    ClientNode, Method, MethodOptions, SchemaValidator, TypeFerryContext, ValidationIssue,
    ValidationResult,
};

fn node() -> Arc<ClientNode> {
    ClientNode::new(None)
}

#[tokio::test]
async fn anonymous_cache_preserves_non_index_key_insertion_order() {
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = calls.clone();
    let handler = Arc::new(move |_node: Arc<ClientNode>, _params: Value| {
        let calls = handler_calls.clone();

        async move { Ok(json!(calls.fetch_add(1, Ordering::Relaxed) + 1)) }.boxed()
    });
    let method = Method::new(
        "cached",
        handler,
        MethodOptions {
            cache: true,
            ..Default::default()
        },
    );
    let first: Value = serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap();
    let reordered: Value = serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap();

    assert_eq!(method.exec(first.clone(), node()).await.unwrap(), json!(1));
    assert_eq!(method.exec(reordered, node()).await.unwrap(), json!(2));
    assert_eq!(method.exec(first, node()).await.unwrap(), json!(1));
}

#[tokio::test]
async fn anonymous_cache_normalizes_array_index_order() {
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = calls.clone();
    let handler = Arc::new(move |_node: Arc<ClientNode>, _params: Value| {
        let calls = handler_calls.clone();

        async move { Ok(json!(calls.fetch_add(1, Ordering::Relaxed) + 1)) }.boxed()
    });
    let method = Method::new(
        "cached",
        handler,
        MethodOptions {
            cache: true,
            ..Default::default()
        },
    );

    for wire in [r#"{"10":10,"2":2,"a":1}"#, r#"{"2":2,"10":10,"a":1}"#] {
        let params = serde_json::from_str(wire).unwrap();

        assert_eq!(method.exec(params, node()).await.unwrap(), json!(1));
    }
}

#[tokio::test]
async fn basic_handler_invocation() {
    let handler = Arc::new(|_node: Arc<ClientNode>, params: Value| {
        async move {
            let a = params["a"].as_i64().unwrap();
            let b = params["b"].as_i64().unwrap();
            Ok(json!(a + b))
        }
        .boxed()
    });
    let method = Method::new("add", handler, MethodOptions::default());
    let out = method.exec(json!({"a": 2, "b": 3}), node()).await.unwrap();
    assert_eq!(out, json!(5));
}

#[tokio::test]
async fn middleware_runs_in_order() {
    let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));

    let order_mw_a = order.clone();
    let mw_a = Arc::new(move |_n: Arc<ClientNode>, p: Value| {
        let order = order_mw_a.clone();
        async move {
            order.lock().unwrap().push("a");
            let mut v = p.as_object().unwrap().clone();
            let n = v["n"].as_i64().unwrap();
            v.insert("n".into(), json!(n + 1));
            Ok(Value::Object(v))
        }
        .boxed()
    });

    let order_mw_b = order.clone();
    let mw_b = Arc::new(move |_n: Arc<ClientNode>, p: Value| {
        let order = order_mw_b.clone();
        async move {
            order.lock().unwrap().push("b");
            let mut v = p.as_object().unwrap().clone();
            let n = v["n"].as_i64().unwrap();
            v.insert("n".into(), json!(n * 2));
            Ok(Value::Object(v))
        }
        .boxed()
    });

    let order_handler = order.clone();
    let handler = Arc::new(move |_n: Arc<ClientNode>, p: Value| {
        let order = order_handler.clone();
        async move {
            order.lock().unwrap().push("handler");
            Ok(p["n"].clone())
        }
        .boxed()
    });

    let method = Method::new(
        "m",
        handler,
        MethodOptions {
            middleware: vec![mw_a, mw_b],
            ..Default::default()
        },
    );
    let out = method.exec(json!({"n": 3}), node()).await.unwrap();
    assert_eq!(out, json!(8)); // (3 + 1) * 2
    assert_eq!(*order.lock().unwrap(), vec!["a", "b", "handler"]);
}

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

#[tokio::test]
async fn schema_failure_surfaces_errors_list() {
    let handler = Arc::new(|_n: Arc<ClientNode>, _p: Value| {
        async move { panic!("handler should not run") }.boxed()
    });
    let method = Method::new(
        "v",
        handler,
        MethodOptions {
            schema: Some(Arc::new(RejectAll)),
            ..Default::default()
        },
    );
    let err = method.exec(json!({}), node()).await.unwrap_err();
    match err {
        typeferry_runtime::TypeFerryError::Schema(schema_err) => {
            assert_eq!(
                schema_err.errors,
                vec!["a: required".to_string(), "b.c: too short".to_string()]
            );
            assert!(schema_err.message.starts_with("Invalid Params:"));
        }
        other => panic!("unexpected: {other:?}"),
    }
}

#[tokio::test]
async fn cached_method_hits_cache_on_identical_params() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_in_handler = calls.clone();
    let handler = Arc::new(move |_n: Arc<ClientNode>, p: Value| {
        let calls = calls_in_handler.clone();
        async move {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(p["a"].clone())
        }
        .boxed()
    });
    let method = Method::new(
        "cached",
        handler,
        MethodOptions {
            cache: true,
            max_age_ms: Some(60_000),
            ..Default::default()
        },
    );
    let a = method.exec(json!({"a": 1}), node()).await.unwrap();
    let b = method.exec(json!({"a": 1}), node()).await.unwrap();
    let c = method.exec(json!({"a": 2}), node()).await.unwrap();
    assert_eq!(a, json!(1));
    assert_eq!(b, json!(1));
    assert_eq!(c, json!(2));
    // Two distinct keys → two handler invocations; identical second {a:1} hits cache.
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn context_is_visible_inside_handler() {
    let captured = Arc::new(Mutex::new(Value::Null));
    let captured_handler = captured.clone();
    let handler = Arc::new(move |_n: Arc<ClientNode>, _p: Value| {
        let captured = captured_handler.clone();
        async move {
            if let Some(ctx) = TypeFerryContext::try_current() {
                *captured.lock().unwrap() = ctx.context.clone();
            }
            Ok(Value::Null)
        }
        .boxed()
    });
    let method = Method::new("m", handler, MethodOptions::default());

    let n = node();
    n.set_authenticated(true);
    n.set_context(json!({"user": {"_id": "u1"}}));

    method.exec(json!({}), n).await.unwrap();
    assert_eq!(*captured.lock().unwrap(), json!({"user": {"_id": "u1"}}));
}

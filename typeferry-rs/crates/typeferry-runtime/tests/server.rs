//! Unit tests for the `Server` registry surface.

use futures::FutureExt;
use serde_json::{Value, json};
use std::sync::Arc;
use typeferry_runtime::{ClientNode, MethodOptions, Server, ServerOptions};

fn new_server() -> Arc<Server> {
    Server::new(ServerOptions::default())
}

#[test]
fn no_channel_anchor_is_installed() {
    let server = new_server();
    let channel = server.channel(typeferry_protocol::NO_CHANNEL);
    assert_eq!(channel.channel_name, typeferry_protocol::NO_CHANNEL);
}

#[test]
fn channel_creates_lazily_and_memoizes() {
    let server = new_server();
    let a = server.channel("chat");
    let b = server.channel("chat");
    assert!(Arc::ptr_eq(&a, &b));
}

#[test]
fn empty_channel_name_maps_to_no_channel() {
    let server = new_server();
    let anchor = server.channel(typeferry_protocol::NO_CHANNEL);
    let empty = server.channel("");
    assert!(Arc::ptr_eq(&anchor, &empty));
}

#[tokio::test]
async fn add_method_and_call_method_on_node_round_trip() {
    let server = new_server();
    let handler =
        Arc::new(|_n: Arc<ClientNode>, p: Value| async move { Ok(p["v"].clone()) }.boxed());
    server.add_method("echo", handler, MethodOptions::default());

    let node = ClientNode::new(None);
    let out = server
        .call_method_on_node("echo", json!({"v": 7}), node)
        .await
        .unwrap();
    assert_eq!(out, json!(7));
}

#[tokio::test]
async fn call_method_on_node_returns_not_found() {
    let server = new_server();
    let node = ClientNode::new(None);
    let err = server
        .call_method_on_node("missing", Value::Null, node)
        .await
        .unwrap_err();
    match err {
        typeferry_runtime::TypeFerryError::MethodNotFound(name) => {
            assert_eq!(name, "missing");
        }
        other => panic!("unexpected: {other:?}"),
    }
}

#[test]
fn clients_index_add_and_delete() {
    let server = new_server();
    let node = ClientNode::new(None);
    node.set_authenticated(true);
    node.set_context(json!({"user": {"_id": "u1"}}));
    server.add_client(node.clone());
    assert!(server.clients.read().unwrap().contains_key(&node.uuid()));

    server.delete_client(&node);
    assert!(!server.clients.read().unwrap().contains_key(&node.uuid()));
}

#[tokio::test]
async fn authentication_normalizes_javascript_falsey_values() {
    for result in [Value::Null, json!(false), json!(0), json!(-0.0), json!("")] {
        let server = new_server();
        let expected = result.clone();
        server.set_auth(Arc::new(move |_node, _context| {
            let result = result.clone();

            async move { result }.boxed()
        }));

        let authenticated = server.run_auth(ClientNode::new(None), json!({})).await;

        assert!(
            matches!(authenticated, Value::Null | Value::Bool(false)),
            "accepted falsey authentication result {expected}"
        );
    }
}

#[tokio::test]
async fn authentication_preserves_javascript_truthy_containers_and_scalars() {
    for result in [
        json!({}),
        json!([]),
        json!(1),
        json!(-1),
        json!("user"),
        json!(true),
    ] {
        let server = new_server();
        let expected = result.clone();
        server.set_auth(Arc::new(move |_node, _context| {
            let result = result.clone();

            async move { result }.boxed()
        }));

        assert_eq!(
            server.run_auth(ClientNode::new(None), json!({})).await,
            expected
        );
    }
}

#[tokio::test]
async fn rejected_authentication_clears_existing_principal_state() {
    let server = new_server();
    let node = ClientNode::new(None);
    node.set_authenticated(true);
    node.set_context(json!({"user":{"_id":"previous-user"}}));
    server.set_auth(Arc::new(|_node, _context| async move { json!(0) }.boxed()));

    server.run_auth(node.clone(), json!({})).await;

    assert!(!node.is_authenticated());
    assert!(node.context.read().unwrap().is_null());
    assert!(node.user_id.read().unwrap().is_none());
}

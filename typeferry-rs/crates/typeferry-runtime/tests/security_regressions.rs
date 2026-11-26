use async_trait::async_trait;
use futures::FutureExt;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use typeferry_protocol::{methods, room_name};
use typeferry_runtime::{
    ClientNode, EventOptions, Method, MethodOptions, RoomRegistry, Server, ServerOptions,
    SocketState, TypeFerrySocket,
};

struct TestSocket {
    id: u64,
    state: AtomicU8,
    sent: Mutex<Vec<String>>,
}

impl TestSocket {
    fn new(id: u64) -> Arc<Self> {
        Arc::new(Self {
            id,
            state: AtomicU8::new(SocketState::OPEN),
            sent: Mutex::new(vec![]),
        })
    }
}

#[async_trait]
impl TypeFerrySocket for TestSocket {
    fn ready_state(&self) -> u8 {
        self.state.load(Ordering::Relaxed)
    }
    async fn send(&self, data: String) {
        self.sent.lock().unwrap().push(data);
    }
    async fn close(&self) {
        self.state.store(SocketState::CLOSED, Ordering::Relaxed);
    }
    fn id(&self) -> u64 {
        self.id
    }
}

#[test]
fn room_name_prevents_colon_boundary_collision() {
    assert_ne!(room_name("user:42", "alert"), room_name("user", "42:alert"));
    assert_eq!(room_name("user:42", "alert"), "typeferry:7:user:42:alert");
}

#[tokio::test]
async fn rpc_logout_evicts_rooms_and_user_index() {
    let server = Server::new(ServerOptions::default());
    let rooms = Arc::new(RoomRegistry::new());
    server.attach_room_registry(rooms.clone());
    server.add_event_named(
        "secret",
        EventOptions {
            protected: true,
            ..Default::default()
        },
    );

    let sock = TestSocket::new(1);
    let dyn_sock: Arc<dyn TypeFerrySocket> = sock.clone();
    let node = ClientNode::new(Some(dyn_sock));
    node.set_authenticated(true);
    node.set_context(json!({"user": {"_id": "u1"}}));
    server.add_client(node.clone());

    assert!(server.clients_by_user_id.read().unwrap().contains_key("u1"));

    let on_res = server
        .call_method_on_node(
            methods::RPC_ON,
            json!({"events": ["secret"], "channel": "vip"}),
            node.clone(),
        )
        .await
        .unwrap();
    assert_eq!(on_res, json!({"secret": true}));
    assert_eq!(rooms.room_size(&room_name("vip", "secret")), 1);

    let out = server
        .call_method_on_node(methods::RPC_LOGOUT, Value::Null, node.clone())
        .await
        .unwrap();
    assert_eq!(out, json!(true));
    assert_eq!(rooms.room_size(&room_name("vip", "secret")), 0);
    assert!(!server.clients_by_user_id.read().unwrap().contains_key("u1"));
}

#[tokio::test]
async fn rpc_on_bounds_and_post_await_auth_recheck() {
    let server = Server::new(ServerOptions::default());
    let rooms = Arc::new(RoomRegistry::new());
    server.attach_room_registry(rooms.clone());
    for i in 0..1030 {
        server.add_event_named(&format!("e-{i}"), EventOptions::default());
    }

    let sock = TestSocket::new(2);
    let dyn_sock: Arc<dyn TypeFerrySocket> = sock.clone();
    let node = ClientNode::new(Some(dyn_sock.clone()));
    server.add_client(node.clone());

    let too_many: Vec<Value> = (0..257).map(|i| json!(format!("e-{i}"))).collect();
    let res = server
        .call_method_on_node(methods::RPC_ON, json!({"events": too_many}), node.clone())
        .await
        .unwrap();
    assert_eq!(res, json!({}));

    let long_ch = "a".repeat(257);
    let res_ch = server
        .call_method_on_node(
            methods::RPC_ON,
            json!({"events": ["e-0"], "channel": long_ch}),
            node.clone(),
        )
        .await
        .unwrap();
    assert_eq!(res_ch, json!({}));

    for batch in 0..11 {
        let evs: Vec<Value> = (0..100)
            .map(|j| batch * 100 + j)
            .filter(|&i| i < 1030)
            .map(|i| json!(format!("e-{i}")))
            .collect();
        let _ = server
            .call_method_on_node(methods::RPC_ON, json!({"events": evs}), node.clone())
            .await
            .unwrap();
    }
    // Check <= 1024 events joined across client
    let mut joined = 0usize;
    for i in 0..1030 {
        if rooms.has(
            &*dyn_sock,
            &room_name(typeferry_protocol::NO_CHANNEL, &format!("e-{i}")),
        ) {
            joined += 1;
        }
    }
    assert!(joined <= 1024, "joined {joined} > 1024");

    // Post-await auth recheck on protected event
    server.add_event_named(
        "priv-race",
        EventOptions {
            protected: true,
            should_subscribe: Some(Arc::new(|n, _ev, _ch| {
                async move {
                    n.set_authenticated(false);
                    true
                }
                .boxed()
            })),
            ..Default::default()
        },
    );
    let sock2 = TestSocket::new(3);
    let node2 = ClientNode::new(Some(sock2));
    node2.set_authenticated(true);
    server.add_client(node2.clone());
    let res_race = server
        .call_method_on_node(methods::RPC_ON, json!({"events": ["priv-race"]}), node2)
        .await
        .unwrap();
    assert_eq!(res_race, json!({"priv-race": false}));
}

#[tokio::test]
async fn client_node_auth_clear_empty_id_and_delete_identity() {
    let server = Server::new(ServerOptions::default());
    let node = ClientNode::new(None);
    node.set_authenticated(true);
    node.set_context(json!({"user": {"_id": "u1"}}));
    assert_eq!(node.user_id.read().unwrap().as_deref(), Some("u1"));

    node.set_authenticated(false);
    assert!(node.context.read().unwrap().is_null());
    assert!(node.user_id.read().unwrap().is_none());

    node.set_authenticated(true);
    node.set_context(json!({"user": {"_id": ""}}));
    assert!(node.user_id.read().unwrap().is_none());

    let active = ClientNode::new(None);
    active.set_id("shared");
    let stale = ClientNode::new(None);
    stale.set_id("shared");
    server.add_client(active.clone());
    server.delete_client(&stale);
    let stored = server
        .clients
        .read()
        .unwrap()
        .get("shared")
        .cloned()
        .unwrap();
    assert!(Arc::ptr_eq(&stored, &active));
}

#[tokio::test]
async fn method_cache_post_exec_auth_and_size_bound() {
    let calls = Arc::new(AtomicUsize::new(0));
    let fail = Arc::new(AtomicBool::new(true));
    let calls_c = calls.clone();
    let fail_c = fail.clone();
    let mid_auth = Method::new(
        "mid",
        Arc::new(move |n: Arc<ClientNode>, v: Value| {
            let calls_c = calls_c.clone();
            let fail_c = fail_c.clone();
            async move {
                calls_c.fetch_add(1, Ordering::Relaxed);
                if v == json!("upgrade") {
                    n.set_authenticated(true);
                } else if fail_c.load(Ordering::Relaxed) {
                    return Err(typeferry_runtime::PublicError::new("err").into());
                }
                Ok(v)
            }
            .boxed()
        }),
        MethodOptions {
            cache: true,
            ..Default::default()
        },
    );

    let up = ClientNode::new(None);
    assert_eq!(
        mid_auth.exec(json!("upgrade"), up).await.unwrap(),
        json!("upgrade")
    );
    // Because `up` became authenticated during exec, "upgrade" MUST NOT remain cached for anon callers:
    let anon = ClientNode::new(None);
    assert_eq!(
        mid_auth.exec(json!("upgrade"), anon.clone()).await.unwrap(),
        json!("upgrade")
    );
    assert_eq!(calls.load(Ordering::Relaxed), 2);

    // Bounded at 1000 entries
    let bounded_calls = Arc::new(AtomicUsize::new(0));
    let bc = bounded_calls.clone();
    let bounded = Method::new(
        "bounded",
        Arc::new(move |_n: Arc<ClientNode>, v: Value| {
            let bc = bc.clone();
            async move {
                bc.fetch_add(1, Ordering::Relaxed);
                Ok(v)
            }
            .boxed()
        }),
        MethodOptions {
            cache: true,
            ..Default::default()
        },
    );
    for i in 0..1005 {
        bounded.exec(json!(i), anon.clone()).await.unwrap();
    }
    // Entry 0 must have been evicted
    bounded.exec(json!(0), anon).await.unwrap();
    assert_eq!(bounded_calls.load(Ordering::Relaxed), 1006);
}

#[tokio::test]
async fn set_channel_authorization_gates_rpc_on() {
    let server = Server::new(ServerOptions::default());
    let rooms = Arc::new(RoomRegistry::new());
    server.attach_room_registry(rooms);
    server.add_event_named("chat", EventOptions::default());
    server.set_channel_authorization(Arc::new(|_node, channel| {
        async move { channel == "allowed-ch" }.boxed()
    }));

    let sock = TestSocket::new(9);
    let node = ClientNode::new(Some(sock));
    server.add_client(node.clone());

    let denied = server
        .call_method_on_node(
            methods::RPC_ON,
            json!({"events": ["chat"], "channel": "forbidden-ch"}),
            node.clone(),
        )
        .await
        .unwrap();
    assert_eq!(denied, json!({"chat": false}));

    let allowed = server
        .call_method_on_node(
            methods::RPC_ON,
            json!({"events": ["chat"], "channel": "allowed-ch"}),
            node,
        )
        .await
        .unwrap();
    assert_eq!(allowed, json!({"chat": true}));
}

//! WebSocket transport — `/typeferry-ws` upgrade on axum.
//!
//! Implements PROTOCOL.md §2.2. Ships the auth frame after connect,
//! starts a 25 s application-level ping loop, dispatches `rpc` /
//! `rpc:void` via [`typeferry_runtime`], tracks pongs, and cleans up
//! rooms on disconnect.

use async_trait::async_trait;
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::Mutex;
use typeferry_ejson::{EjsonValue, Presentation};
use typeferry_protocol::{
    AUTH_TIMEOUT_MS, MAX_META_SIZE, MAX_UUID_LENGTH, MessageType, PING_INTERVAL_MS,
    TYPEFERRY_WS_PATH,
    errors::{INTERNAL_ERROR, METHOD_FORBIDDEN, METHOD_NOT_FOUND},
};
use typeferry_runtime::{ClientNode, RoomRegistry, Server, TypeFerryError, TypeFerrySocket};

static SOCKET_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

/**
 * WebSocket origin options, independent of the HTTP adapter's options.
 */
pub type WebSocketOptions = typeferry_protocol::OriginPolicy;

/// Attach the WebSocket route onto an axum router.
pub fn router(server: Arc<Server>) -> Router {
    router_with_options(server, WebSocketOptions::default())
}

/**
 * Attach the WebSocket route with origin admission before upgrade or auth.
 */
pub fn router_with_options(server: Arc<Server>, options: WebSocketOptions) -> Router {
    // Ensure the room registry is wired up on the server exactly once.
    let rooms = Arc::new(RoomRegistry::new());
    server.attach_room_registry(rooms.clone());

    Router::new()
        .route(TYPEFERRY_WS_PATH, get(upgrade))
        .route_layer(middleware::from_fn_with_state(options, admit_origin))
        .with_state(server)
}

async fn admit_origin(
    State(options): State<WebSocketOptions>,
    request: Request,
    next: Next,
) -> Response {
    let admitted = match request.headers().get(header::ORIGIN) {
        Some(origin) => origin
            .to_str()
            .is_ok_and(|origin| options.allows(Some(origin))),
        None => options.allows(None),
    };

    if admitted {
        next.run(request).await
    } else {
        StatusCode::FORBIDDEN.into_response()
    }
}

#[derive(Debug, Default, serde::Deserialize)]
struct UpgradeQuery {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    meta: Option<String>,
}

async fn upgrade(
    ws: WebSocketUpgrade,
    State(server): State<Arc<Server>>,
    Query(query): Query<UpgradeQuery>,
) -> Response {
    ws.on_upgrade(move |socket| handle_connection(server, socket, query))
}

async fn handle_connection(server: Arc<Server>, socket: WebSocket, query: UpgradeQuery) {
    let (sink, mut stream) = socket.split();
    let adapter: Arc<AxumSocket> = AxumSocket::new(sink);

    let node = ClientNode::new(Some(adapter.clone() as Arc<dyn TypeFerrySocket>));
    if let Some(client_uuid) = query.uuid.as_deref()
        && !client_uuid.is_empty()
        && client_uuid.len() <= MAX_UUID_LENGTH
        && client_uuid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        node.set_id(client_uuid);
    }
    *node.meta.write().expect("meta poisoned") = query
        .meta
        .as_deref()
        .filter(|raw| raw.len() <= MAX_META_SIZE)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    server.add_client(node.clone());

    // Run auth if a token was passed; otherwise emit `authenticated:false`
    // immediately per PROTOCOL.md §2.2.2.
    let auth_enabled = *server
        .is_auth_enabled
        .read()
        .expect("is_auth_enabled poisoned");

    if auth_enabled
        && let Some(token) = query.token.as_deref()
        && !token.is_empty()
    {
        let mut ctx = serde_json::Map::new();
        ctx.insert("token".into(), serde_json::Value::String(token.to_string()));
        // Dropping the callback future on timeout prevents a later result from
        // authenticating this connection. Runtime normalizes falsey results.
        let auth_result = tokio::time::timeout(
            Duration::from_millis(AUTH_TIMEOUT_MS),
            server.run_auth(node.clone(), serde_json::Value::Object(ctx)),
        )
        .await
        .unwrap_or(Value::Null);

        node.set_authenticated(!auth_result.is_null());
        node.set_context(auth_result);
    }
    node.emit_auth_result(node.is_authenticated()).await;

    // Ping loop.
    let pong_flag = Arc::new(AtomicBool::new(true));
    let ping_socket = adapter.clone();
    let ping_flag = pong_flag.clone();
    let ping_task = tokio::spawn(async move {
        let interval = Duration::from_millis(PING_INTERVAL_MS);
        let payload = Presentation::encode(&EjsonValue::Object({
            let mut m = typeferry_ejson::value::EjsonMap::new();
            m.insert(
                "t".into(),
                EjsonValue::String(MessageType::Ping.as_str().into()),
            );
            m
        }));
        loop {
            tokio::time::sleep(interval).await;
            if !ping_flag.swap(false, Ordering::Relaxed) {
                ping_socket.close().await;
                return;
            }
            if ping_socket.ready_state() != typeferry_runtime::SocketState::OPEN {
                return;
            }
            ping_socket.send(payload.clone()).await;
        }
    });

    let dyn_socket: Arc<dyn TypeFerrySocket> = adapter.clone();
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                dispatch_frame(&server, &node, &dyn_socket, &pong_flag, &text).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    ping_task.abort();
    adapter.mark_closed();
    if let Some(rooms) = server.rooms.read().ok().and_then(|opt| opt.clone()) {
        rooms.leave_all(&*adapter);
    }
    node.close().await;
    server.delete_client(&node);
}

/// Dispatch one decoded frame against the runtime. Public so test
/// harnesses can drive the dispatch path with a mock socket.
pub async fn dispatch_frame(
    server: &Arc<Server>,
    node: &Arc<ClientNode>,
    socket: &Arc<dyn TypeFerrySocket>,
    pong_flag: &AtomicBool,
    text: &str,
) {
    let decoded = match Presentation::decode(text) {
        Ok(value) => typeferry_ejson::to_json_value(&value),
        Err(_) => return,
    };
    let Some(obj) = decoded.as_object() else {
        return;
    };
    let Some(kind) = obj.get("t").and_then(|v| v.as_str()) else {
        return;
    };

    match kind {
        "rpc" => {
            let id = obj
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let method = obj
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = obj.get("params").cloned().unwrap_or(Value::Null);

            handle_rpc(server, node, socket, id, method, params).await;
        }
        "rpc:void" => {
            let method = obj
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            if let Some(m) = server.get_method(&method)
                && (!m.is_protected || node.is_authenticated())
            {
                let _ = m.exec(params, node.clone()).await;
            }
        }
        "pong" => {
            pong_flag.store(true, Ordering::Relaxed);
        }
        _ => {}
    }
}

async fn handle_rpc(
    server: &Arc<Server>,
    node: &Arc<ClientNode>,
    socket: &Arc<dyn TypeFerrySocket>,
    id: String,
    method: String,
    params: Value,
) {
    let m = match server.get_method(&method) {
        Some(m) => m,
        None => {
            send_rpc_error(socket, &id, METHOD_NOT_FOUND, None).await;
            return;
        }
    };
    if m.is_protected && !node.is_authenticated() {
        send_rpc_error(socket, &id, METHOD_FORBIDDEN, None).await;
        return;
    }

    match m.exec(params, node.clone()).await {
        Ok(result) => {
            let payload = json!({
                "t": MessageType::RpcResponse.as_str(),
                "id": id,
                "result": result,
            });
            socket
                .send(typeferry_ejson::stable_stringify::stringify_noncanonical(
                    &payload,
                ))
                .await;
        }
        Err(TypeFerryError::Public(err)) => {
            send_rpc_error(socket, &id, &err.message, None).await;
        }
        Err(TypeFerryError::Schema(err)) => {
            send_rpc_error(socket, &id, &err.message, Some(err.errors)).await;
        }
        Err(_) => {
            send_rpc_error(socket, &id, INTERNAL_ERROR, None).await;
        }
    }
}

async fn send_rpc_error(
    socket: &Arc<dyn TypeFerrySocket>,
    id: &str,
    message: &str,
    errors: Option<Vec<String>>,
) {
    let mut payload = json!({
        "t": MessageType::RpcResponse.as_str(),
        "id": id,
        "error": message,
    });
    if let Some(errs) = errors {
        payload["errors"] = json!(errs);
    }
    socket
        .send(typeferry_ejson::stable_stringify::stringify_noncanonical(
            &payload,
        ))
        .await;
}

// ---------------------------------------------------------------------------
// axum WebSocket adapter implementing TypeFerrySocket.
// ---------------------------------------------------------------------------

pub struct AxumSocket {
    id: u64,
    sink: Mutex<Option<SplitSink<WebSocket, Message>>>,
    state: RwLock<u8>,
}

impl AxumSocket {
    fn new(sink: SplitSink<WebSocket, Message>) -> Arc<Self> {
        Arc::new(Self {
            id: SOCKET_ID_COUNTER.fetch_add(1, Ordering::Relaxed),
            sink: Mutex::new(Some(sink)),
            state: RwLock::new(typeferry_runtime::SocketState::OPEN),
        })
    }

    fn mark_closed(&self) {
        *self.state.write().expect("state poisoned") = typeferry_runtime::SocketState::CLOSED;
    }
}

#[async_trait]
impl TypeFerrySocket for AxumSocket {
    fn ready_state(&self) -> u8 {
        *self.state.read().expect("state poisoned")
    }

    async fn send(&self, data: String) {
        let mut guard = self.sink.lock().await;
        if let Some(sink) = guard.as_mut()
            && sink.send(Message::Text(data.into())).await.is_err()
        {
            self.mark_closed();
        }
    }

    async fn close(&self) {
        self.mark_closed();
        let mut guard = self.sink.lock().await;
        if let Some(mut sink) = guard.take() {
            let _ = sink.close().await;
        }
    }

    fn id(&self) -> u64 {
        self.id
    }
}

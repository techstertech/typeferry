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
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures::future::BoxFuture;
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use typeferry_ejson::{EjsonValue, Presentation};
use typeferry_protocol::{
    AUTH_TIMEOUT_MS, MAX_META_SIZE, MAX_UUID_LENGTH, MessageType, OriginPolicy, PING_INTERVAL_MS,
    TYPEFERRY_WS_PATH,
    errors::{INTERNAL_ERROR, METHOD_FORBIDDEN, METHOD_NOT_FOUND, RATE_LIMIT_EXCEEDED},
};
use typeferry_runtime::{ClientNode, RoomRegistry, Server, TypeFerryError, TypeFerrySocket};

static SOCKET_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

const MAX_WS_MESSAGE_BYTES: usize = 1024 * 1024;
const DEFAULT_WS_RATE_MAX: usize = 120;
const DEFAULT_WS_RATE_WINDOW: Duration = Duration::from_secs(60);

/// Request snapshot passed to [`WebSocketHandshakeAuthenticator`].
#[derive(Debug, Clone, Default)]
pub struct WebSocketHandshake {
    pub path: String,
    pub headers: HashMap<String, String>,
    pub query: HashMap<String, String>,
}

/// Optional application-owned handshake authenticator; overrides `?token=` auth.
pub type WebSocketHandshakeAuthenticator =
    Arc<dyn Fn(Arc<ClientNode>, WebSocketHandshake) -> BoxFuture<'static, Value> + Send + Sync>;

/// Per-connection sliding-window rate limit applied to inbound WebSocket RPC/ping frames.
#[derive(Debug, Clone)]
pub struct RateLimit {
    pub max: usize,
    pub window: Duration,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self {
            max: DEFAULT_WS_RATE_MAX,
            window: DEFAULT_WS_RATE_WINDOW,
        }
    }
}

/**
 * WebSocket transport options configuring origin policy, per-connection rate
 * limiting, frame ceilings, and handshake authentication.
 */
#[derive(Clone)]
pub struct WebSocketOptions {
    pub origins: Option<Vec<String>>,
    pub allow_originless: bool,
    pub rate_limit: Option<RateLimit>,
    pub max_message_bytes: usize,
    pub allow_query_token: bool,
    pub handshake_authenticator: Option<WebSocketHandshakeAuthenticator>,
}

impl fmt::Debug for WebSocketOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WebSocketOptions")
            .field("origins", &self.origins)
            .field("allow_originless", &self.allow_originless)
            .field("rate_limit", &self.rate_limit)
            .field("max_message_bytes", &self.max_message_bytes)
            .field("allow_query_token", &self.allow_query_token)
            .field(
                "handshake_authenticator",
                &self.handshake_authenticator.is_some(),
            )
            .finish()
    }
}

impl Default for WebSocketOptions {
    fn default() -> Self {
        Self {
            origins: None,
            allow_originless: false,
            rate_limit: Some(RateLimit::default()),
            max_message_bytes: MAX_WS_MESSAGE_BYTES,
            allow_query_token: true,
            handshake_authenticator: None,
        }
    }
}

impl From<OriginPolicy> for WebSocketOptions {
    fn from(policy: OriginPolicy) -> Self {
        Self {
            origins: policy.origins,
            allow_originless: policy.allow_originless,
            ..Default::default()
        }
    }
}

#[derive(Clone)]
struct WsState {
    server: Arc<Server>,
    options: Arc<WebSocketOptions>,
}

struct ConnRateLimiter {
    max: usize,
    window: Duration,
    hits: VecDeque<Instant>,
}

impl ConnRateLimiter {
    fn new(config: &RateLimit) -> Self {
        Self {
            max: config.max,
            window: config.window,
            hits: VecDeque::new(),
        }
    }

    fn try_consume(&mut self) -> bool {
        let now = Instant::now();
        while let Some(&front) = self.hits.front() {
            if now.saturating_duration_since(front) >= self.window {
                self.hits.pop_front();
            } else {
                break;
            }
        }
        if self.max == 0 || self.hits.len() >= self.max {
            return false;
        }
        self.hits.push_back(now);
        true
    }
}

fn is_production_env() -> bool {
    ["TYPEFERRY_ENV", "NODE_ENV", "RUST_ENV"]
        .into_iter()
        .any(|key| std::env::var(key).is_ok_and(|value| value == "production"))
}

/// Attach the WebSocket route onto an axum router.
pub fn router(server: Arc<Server>) -> Router {
    router_with_options(server, WebSocketOptions::default())
}

/**
 * Attach the WebSocket route with origin admission before upgrade or auth.
 */
pub fn router_with_options(server: Arc<Server>, options: WebSocketOptions) -> Router {
    if options.origins.is_none() && is_production_env() {
        tracing::warn!(
            "TypeFerry WebSocket transport started without an origins allowlist in production"
        );
    }
    // Ensure the room registry is wired up on the server exactly once.
    let rooms = Arc::new(RoomRegistry::new());
    server.attach_room_registry(rooms);

    let shared_options = Arc::new(options);
    let state = WsState {
        server,
        options: shared_options.clone(),
    };

    Router::new()
        .route(TYPEFERRY_WS_PATH, get(upgrade))
        .route_layer(middleware::from_fn_with_state(shared_options, admit_origin))
        .with_state(state)
}

async fn admit_origin(
    State(options): State<Arc<WebSocketOptions>>,
    request: Request,
    next: Next,
) -> Response {
    let mut origin_iter = request.headers().get_all(header::ORIGIN).iter();
    let first = origin_iter.next();
    if origin_iter.next().is_some() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let policy = OriginPolicy {
        origins: options.origins.clone(),
        allow_originless: options.allow_originless,
    };
    let admitted = match first {
        Some(origin) => origin
            .to_str()
            .is_ok_and(|origin| policy.allows(Some(origin))),
        None => policy.allows(None),
    };

    if admitted {
        next.run(request).await
    } else {
        StatusCode::FORBIDDEN.into_response()
    }
}

fn build_headers_map(headers: &HeaderMap) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for (name, value) in headers {
        let lower = name.as_str().to_ascii_lowercase();
        let Ok(text) = value.to_str() else {
            continue;
        };
        if lower == "cookie" {
            result
                .entry(lower)
                .and_modify(|existing: &mut String| {
                    existing.push_str("; ");
                    existing.push_str(text);
                })
                .or_insert_with(|| text.to_string());
        } else {
            result.entry(lower).or_insert_with(|| text.to_string());
        }
    }
    result
}

async fn upgrade(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
    uri: Uri,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let handshake = WebSocketHandshake {
        path: uri.path().to_string(),
        headers: build_headers_map(&headers),
        query,
    };
    let limit = state.options.max_message_bytes;
    ws.max_message_size(limit)
        .max_frame_size(limit)
        .on_upgrade(move |socket| handle_connection(state, socket, handshake))
}

async fn handle_connection(state: WsState, socket: WebSocket, handshake: WebSocketHandshake) {
    let server = state.server;
    let options = state.options;
    let (sink, mut stream) = socket.split();
    let adapter: Arc<AxumSocket> = AxumSocket::new(sink);

    let node = ClientNode::new(Some(adapter.clone() as Arc<dyn TypeFerrySocket>));
    if let Some(client_uuid) = handshake.query.get("uuid").map(String::as_str)
        && !client_uuid.is_empty()
        && client_uuid.len() <= MAX_UUID_LENGTH
        && client_uuid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        node.set_id(client_uuid);
    }
    *node.meta.write().expect("meta poisoned") = handshake
        .query
        .get("meta")
        .map(String::as_str)
        .filter(|raw| raw.len() <= MAX_META_SIZE)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    server.add_ws_client(node.clone());

    if let Some(authenticator) = options.handshake_authenticator.as_ref() {
        let raw_result = tokio::time::timeout(
            Duration::from_millis(AUTH_TIMEOUT_MS),
            authenticator(node.clone(), handshake.clone()),
        )
        .await
        .unwrap_or(Value::Null);
        let auth_result = Server::normalize_auth_result(&node, raw_result);
        node.set_authenticated(!auth_result.is_null());
        node.set_context(auth_result);
        if node.is_authenticated() {
            server.refresh_client_user_index(&node);
        }
    } else {
        let auth_enabled = *server
            .is_auth_enabled
            .read()
            .expect("is_auth_enabled poisoned");

        if auth_enabled
            && options.allow_query_token
            && let Some(token) = handshake.query.get("token").map(String::as_str)
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
            if node.is_authenticated() {
                server.refresh_client_user_index(&node);
            }
        }
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

    let limiter = options
        .rate_limit
        .as_ref()
        .map(|cfg| Arc::new(Mutex::new(ConnRateLimiter::new(cfg))));
    let mut close_rx = adapter.subscribe_close();
    let dyn_socket: Arc<dyn TypeFerrySocket> = adapter.clone();
    loop {
        let msg = tokio::select! {
            biased;
            _ = close_rx.wait_for(|&closed| closed) => break,
            next = stream.next() => match next {
                Some(Ok(msg)) => msg,
                _ => break,
            }
        };
        match msg {
            Message::Text(text) => {
                dispatch_frame_with_limiter(
                    &server,
                    &node,
                    &dyn_socket,
                    &pong_flag,
                    limiter.as_deref(),
                    &text,
                )
                .await;
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
    dispatch_frame_with_limiter(server, node, socket, pong_flag, None, text).await;
}

async fn dispatch_frame_with_limiter(
    server: &Arc<Server>,
    node: &Arc<ClientNode>,
    socket: &Arc<dyn TypeFerrySocket>,
    pong_flag: &AtomicBool,
    limiter: Option<&Mutex<ConnRateLimiter>>,
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
            if let Some(lim) = limiter
                && !lim.lock().expect("ws rate limiter poisoned").try_consume()
            {
                send_rpc_error(socket, &id, RATE_LIMIT_EXCEEDED, None).await;
                return;
            }
            let method = obj
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = obj.get("params").cloned().unwrap_or(Value::Null);

            handle_rpc(server, node, socket, id, method, params).await;
        }
        "rpc:void" => {
            if let Some(lim) = limiter
                && !lim.lock().expect("ws rate limiter poisoned").try_consume()
            {
                return;
            }
            let method = obj
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            if let Some(m) = server.get_method(&method)
                && (!m.is_protected || node.is_authenticated())
                && let Err(err) = m.exec(params, node.clone()).await
            {
                if m.is_sensitive {
                    tracing::error!(method = %method, "Sensitive void method failed");
                } else {
                    tracing::error!(method = %method, error = %err, "Void method failed");
                }
            }
        }
        "ping" => {
            if let Some(lim) = limiter
                && !lim.lock().expect("ws rate limiter poisoned").try_consume()
            {
                return;
            }
            let pong = Presentation::encode(&EjsonValue::Object({
                let mut m = typeferry_ejson::value::EjsonMap::new();
                m.insert(
                    "t".into(),
                    EjsonValue::String(MessageType::Pong.as_str().into()),
                );
                m
            }));
            socket.send(pong).await;
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
            match typeferry_ejson::stable_stringify::try_stringify_noncanonical(&payload) {
                Ok(text) => socket.send(text).await,
                Err(_) => send_rpc_error(socket, &id, INTERNAL_ERROR, None).await,
            }
        }
        Err(TypeFerryError::Public(err)) => {
            send_rpc_error(socket, &id, &err.message, None).await;
        }
        Err(TypeFerryError::Schema(err)) => {
            send_rpc_error(socket, &id, &err.message, Some(err.errors)).await;
        }
        Err(err) => {
            if m.is_sensitive {
                tracing::error!(method = %method, "Sensitive RPC method failed");
            } else {
                tracing::error!(method = %method, error = %err, "RPC method failed");
            }
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
    let text = match typeferry_ejson::stable_stringify::try_stringify_noncanonical(&payload) {
        Ok(encoded) => encoded,
        Err(_) => typeferry_ejson::stable_stringify::stringify_noncanonical(&json!({
            "t": MessageType::RpcResponse.as_str(),
            "id": id,
            "error": INTERNAL_ERROR,
        })),
    };
    socket.send(text).await;
}

// ---------------------------------------------------------------------------
// axum WebSocket adapter implementing TypeFerrySocket.
// ---------------------------------------------------------------------------

const OUTBOUND_QUEUE_CAP: usize = 256;
const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct AxumSocket {
    id: u64,
    tx: RwLock<Option<mpsc::Sender<String>>>,
    state: RwLock<u8>,
    close_tx: tokio::sync::watch::Sender<bool>,
}

impl AxumSocket {
    fn new(mut sink: SplitSink<WebSocket, Message>) -> Arc<Self> {
        let (tx, mut rx) = mpsc::channel::<String>(OUTBOUND_QUEUE_CAP);
        let (close_tx, mut writer_close_rx) = tokio::sync::watch::channel(false);
        let socket = Arc::new(Self {
            id: SOCKET_ID_COUNTER.fetch_add(1, Ordering::Relaxed),
            tx: RwLock::new(Some(tx)),
            state: RwLock::new(typeferry_runtime::SocketState::OPEN),
            close_tx,
        });
        let writer_socket = Arc::downgrade(&socket);
        tokio::spawn(async move {
            loop {
                let data = tokio::select! {
                    biased;
                    _ = writer_close_rx.wait_for(|&closed| closed) => break,
                    next = rx.recv() => match next {
                        Some(data) => data,
                        None => break,
                    }
                };
                let res = tokio::time::timeout(
                    SOCKET_WRITE_TIMEOUT,
                    sink.send(Message::Text(data.into())),
                )
                .await;
                if !matches!(res, Ok(Ok(()))) {
                    if let Some(s) = writer_socket.upgrade() {
                        s.mark_closed();
                        *s.tx.write().expect("tx poisoned") = None;
                    }
                    break;
                }
            }
            let _ = tokio::time::timeout(SOCKET_WRITE_TIMEOUT, sink.close()).await;
        });
        socket
    }

    fn subscribe_close(&self) -> tokio::sync::watch::Receiver<bool> {
        self.close_tx.subscribe()
    }

    fn mark_closed(&self) {
        *self.state.write().expect("state poisoned") = typeferry_runtime::SocketState::CLOSED;
        self.close_tx.send_replace(true);
    }
}

#[async_trait]
impl TypeFerrySocket for AxumSocket {
    fn ready_state(&self) -> u8 {
        *self.state.read().expect("state poisoned")
    }

    async fn send(&self, data: String) {
        let tx = self.tx.read().expect("tx poisoned").clone();
        if let Some(sender) = tx
            && sender.try_send(data).is_err()
        {
            self.mark_closed();
            *self.tx.write().expect("tx poisoned") = None;
        }
    }

    async fn close(&self) {
        self.mark_closed();
        *self.tx.write().expect("tx poisoned") = None;
    }

    fn id(&self) -> u64 {
        self.id
    }
}

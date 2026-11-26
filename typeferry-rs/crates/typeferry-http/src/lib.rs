//! HTTP transport — `POST /__h`.
//!
//! Implements PROTOCOL.md §2.1 on top of `axum`.

use axum::{
    Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use typeferry_ejson::{EjsonValue, Presentation};
use typeferry_protocol::{
    AUTH_TIMEOUT_MS, CLIENT_ID_HEADER_KEY, HTTP_ENDPOINT_PATH, MAX_UUID_LENGTH, OriginPolicy,
    TOKEN_HEADER_KEY,
    errors::{INTERNAL_ERROR, INVALID_REQUEST, METHOD_FORBIDDEN, METHOD_NOT_FOUND},
};
use typeferry_runtime::{ClientNode, Server, TypeFerryError};

const DEFAULT_HTTP_BODY_LIMIT: usize = 4 * 1024 * 1024;
const DEFAULT_HTTP_RATE_MAX: usize = 120;
const DEFAULT_HTTP_RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_LIMITER_ENTRIES: usize = 100_000;

/// Sliding-window rate limit policy applied per peer IP on `POST /__h`.
#[derive(Debug, Clone)]
pub struct RateLimit {
    pub max: usize,
    pub window: Duration,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self {
            max: DEFAULT_HTTP_RATE_MAX,
            window: DEFAULT_HTTP_RATE_WINDOW,
        }
    }
}

/**
 * HTTP transport options configuring origin admission, default rate limiting,
 * body ceilings, and authentication timeouts.
 */
#[derive(Debug, Clone)]
pub struct HttpOptions {
    pub origins: Option<Vec<String>>,
    pub allow_originless: bool,
    pub rate_limit: Option<RateLimit>,
    pub max_body_bytes: usize,
    pub auth_timeout: Duration,
}

impl Default for HttpOptions {
    fn default() -> Self {
        Self {
            origins: None,
            allow_originless: false,
            rate_limit: Some(RateLimit::default()),
            max_body_bytes: DEFAULT_HTTP_BODY_LIMIT,
            auth_timeout: Duration::from_millis(AUTH_TIMEOUT_MS),
        }
    }
}

impl From<OriginPolicy> for HttpOptions {
    fn from(policy: OriginPolicy) -> Self {
        Self {
            origins: policy.origins,
            allow_originless: policy.allow_originless,
            ..Default::default()
        }
    }
}

#[derive(Clone)]
struct HttpState {
    server: Arc<Server>,
    auth_timeout: Duration,
}

struct SlidingWindowLimiter {
    max: usize,
    window: Duration,
    entries: HashMap<String, VecDeque<Instant>>,
    last_sweep: Instant,
}

impl SlidingWindowLimiter {
    fn new(config: RateLimit) -> Self {
        Self {
            max: config.max,
            window: config.window,
            entries: HashMap::new(),
            last_sweep: Instant::now(),
        }
    }

    fn sweep(&mut self, now: Instant) {
        self.entries.retain(|_, hits| {
            while let Some(&front) = hits.front() {
                if now.saturating_duration_since(front) >= self.window {
                    hits.pop_front();
                } else {
                    break;
                }
            }
            !hits.is_empty()
        });
        self.last_sweep = now;
    }

    fn try_consume(&mut self, key: &str) -> (bool, usize, u64) {
        let now = Instant::now();
        if now.saturating_duration_since(self.last_sweep) >= self.window {
            self.sweep(now);
        }
        if !self.entries.contains_key(key) && self.entries.len() >= MAX_LIMITER_ENTRIES {
            // Bounded capacity eviction so distinct-IP floods cannot grow memory unboundedly.
            self.sweep(now);
            if self.entries.len() >= MAX_LIMITER_ENTRIES
                && let Some(evict_key) = self.entries.keys().next().cloned()
            {
                self.entries.remove(&evict_key);
            }
        }
        let hits = self.entries.entry(key.to_string()).or_default();
        while let Some(&front) = hits.front() {
            if now.saturating_duration_since(front) >= self.window {
                hits.pop_front();
            } else {
                break;
            }
        }
        if self.max == 0 || hits.len() >= self.max {
            let reset = hits
                .front()
                .map(|front| {
                    self.window
                        .saturating_sub(now.saturating_duration_since(*front))
                })
                .unwrap_or(self.window);
            let reset_secs = reset.as_secs() + u64::from(reset.subsec_nanos() > 0);
            return (false, 0, reset_secs);
        }
        hits.push_back(now);
        let reset = hits
            .front()
            .map(|front| {
                self.window
                    .saturating_sub(now.saturating_duration_since(*front))
            })
            .unwrap_or(self.window);
        let reset_secs = reset.as_secs() + u64::from(reset.subsec_nanos() > 0);
        (true, self.max - hits.len(), reset_secs)
    }
}

fn is_production_env() -> bool {
    ["TYPEFERRY_ENV", "NODE_ENV", "RUST_ENV"]
        .into_iter()
        .any(|key| std::env::var(key).is_ok_and(|value| value == "production"))
}

/// Build the axum router for the HTTP transport.
pub fn router(server: Arc<Server>) -> Router {
    router_with_options(server, HttpOptions::default())
}

/**
 * Build the RPC router with origin admission and rate limiting before
 * request-body extraction.
 */
pub fn router_with_options(server: Arc<Server>, options: HttpOptions) -> Router {
    if options.origins.is_none() && is_production_env() {
        tracing::warn!(
            "TypeFerry HTTP transport started without an origins allowlist in production"
        );
    }

    let mut endpoint = post(handle_rpc);

    if options.origins.is_some() {
        endpoint = endpoint.options(|| async { StatusCode::NO_CONTENT });
    }

    let limiter = options
        .rate_limit
        .clone()
        .map(|cfg| Arc::new(Mutex::new(SlidingWindowLimiter::new(cfg))));
    let state = HttpState {
        server,
        auth_timeout: options.auth_timeout,
    };

    Router::new()
        .route(HTTP_ENDPOINT_PATH, endpoint)
        .route_layer(DefaultBodyLimit::max(options.max_body_bytes))
        .route_layer(middleware::from_fn_with_state(limiter, apply_rate_limit))
        .route_layer(middleware::from_fn_with_state(options, admit_origin))
        .with_state(state)
}

async fn apply_rate_limit(
    State(limiter): State<Option<Arc<Mutex<SlidingWindowLimiter>>>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(limiter) = limiter else {
        return next.run(request).await;
    };
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let (limit_max, allowed, remaining, reset_secs) = {
        let mut guard = limiter.lock().expect("http rate limiter poisoned");
        let (allowed, remaining, reset_secs) = guard.try_consume(&peer);
        (guard.max, allowed, remaining, reset_secs)
    };

    let mut response = if allowed {
        next.run(request).await
    } else {
        StatusCode::TOO_MANY_REQUESTS.into_response()
    };

    let headers = response.headers_mut();
    if let Ok(val) = HeaderValue::from_str(&limit_max.to_string()) {
        headers.insert("ratelimit-limit", val);
    }
    if let Ok(val) = HeaderValue::from_str(&remaining.to_string()) {
        headers.insert("ratelimit-remaining", val);
    }
    if let Ok(val) = HeaderValue::from_str(&reset_secs.to_string()) {
        headers.insert("ratelimit-reset", val);
    }
    response
}

async fn admit_origin(
    State(options): State<HttpOptions>,
    request: Request,
    next: Next,
) -> Response {
    let mut origin_iter = request.headers().get_all(header::ORIGIN).iter();
    let origin = origin_iter.next().cloned();
    if origin_iter.next().is_some() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let policy = OriginPolicy {
        origins: options.origins.clone(),
        allow_originless: options.allow_originless,
    };
    let admitted = match origin.as_ref() {
        Some(origin) => origin
            .to_str()
            .is_ok_and(|origin| policy.allows(Some(origin))),
        None => policy.allows(None),
    };

    if !admitted {
        return StatusCode::FORBIDDEN.into_response();
    }

    let mut response = next.run(request).await;

    if options.origins.is_some()
        && let Some(origin) = origin
    {
        let headers = response.headers_mut();

        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("POST, OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, x-api-key, x-client-id"),
        );
        headers.append(header::VARY, HeaderValue::from_static("Origin"));
    }

    response
}

async fn handle_rpc(State(state): State<HttpState>, headers: HeaderMap, body: Bytes) -> Response {
    handle_rpc_with_timeout(state.server, headers, body, state.auth_timeout).await
}

async fn handle_rpc_with_timeout(
    server: Arc<Server>,
    headers: HeaderMap,
    body: Bytes,
    auth_timeout: Duration,
) -> Response {
    let body_str = match std::str::from_utf8(&body) {
        Ok(s) => s,
        Err(_) => return error_response(INVALID_REQUEST, None, None, false),
    };

    let transport = match Presentation::decode(body_str) {
        Ok(EjsonValue::Object(map)) => map,
        _ => return error_response(INVALID_REQUEST, None, None, false),
    };

    let context_value = transport
        .get("context")
        .cloned()
        .unwrap_or(EjsonValue::Null);
    let Some(EjsonValue::Object(payload)) = transport.get("payload").cloned() else {
        return error_response(INVALID_REQUEST, None, None, false);
    };

    let method_name = match payload.get("method") {
        Some(EjsonValue::String(name)) if !name.is_empty() => name.clone(),
        _ => return error_response(METHOD_NOT_FOUND, None, None, false),
    };

    let uuid = match payload.get("uuid") {
        Some(EjsonValue::String(u)) => Some(u.clone()),
        _ => None,
    };
    let is_void = matches!(payload.get("void"), Some(EjsonValue::Bool(true)));

    let Some(method) = server.get_method(&method_name) else {
        // METHOD_NOT_FOUND envelope carries `method` only (no uuid),
        // matching TS sendError behaviour.
        return error_response(METHOD_NOT_FOUND, None, Some(&method_name), is_void);
    };

    // Build the client node with headers + auth context.
    let node = ClientNode::new(None);
    if let Some(client_uuid) = headers
        .get(CLIENT_ID_HEADER_KEY)
        .and_then(|v| v.to_str().ok())
        && !client_uuid.is_empty()
        && client_uuid.len() <= MAX_UUID_LENGTH
        && client_uuid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        node.set_id(client_uuid);
    }
    // Token extraction; Bearer prefix stripped.
    let token = headers
        .get(TOKEN_HEADER_KEY)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty() && *s != "undefined")
        .map(|s| s.strip_prefix("Bearer ").unwrap_or(s).to_string());

    // Assemble filtered auth context JSON before injecting transport token.
    let raw_ctx = typeferry_value_to_json(&context_value);
    let mut ctx_json = server.filter_context(&raw_ctx);
    if !ctx_json.is_object() {
        ctx_json = Value::Object(Map::new());
    }
    if let (Some(token), Some(obj)) = (token, ctx_json.as_object_mut()) {
        obj.insert("token".into(), Value::String(token));
    }

    // Run the auth callback with timeout; timeout fails closed as Null.
    let auth_result = tokio::time::timeout(auth_timeout, server.run_auth(node.clone(), ctx_json))
        .await
        .unwrap_or(Value::Null);
    node.set_authenticated(!auth_result.is_null());
    node.set_context(auth_result);

    if method.is_protected && !node.is_authenticated() {
        // METHOD_FORBIDDEN envelope carries `method` only (no uuid).
        return error_response(METHOD_FORBIDDEN, None, Some(&method_name), is_void);
    }

    let params_json = payload
        .get("params")
        .map(typeferry_value_to_json)
        .unwrap_or(Value::Null);

    let outcome = method.exec(params_json, node).await;

    match outcome {
        // Per PROTOCOL.md §2.1.3, void suppresses error responses ONLY;
        // success bodies still return.
        Ok(result) => success_response(&method_name, uuid.as_deref(), &result),

        // PublicError envelope carries `uuid`, no `method` — matches TS sendError.
        Err(TypeFerryError::Public(public)) => {
            if is_void {
                return empty_200();
            }
            error_response(&public.message, uuid, None, false)
        }

        // SchemaValidationError envelope carries `uuid` + `errors`, no `method`.
        Err(TypeFerryError::Schema(err)) => {
            if is_void {
                return empty_200();
            }
            let mut body = serde_json::Map::new();
            body.insert("type".into(), Value::String("error".into()));
            body.insert("message".into(), Value::String(err.message.clone()));
            if let Some(u) = uuid.as_ref() {
                body.insert("uuid".into(), Value::String(u.clone()));
            }
            body.insert("errors".into(), serde_json::to_value(&err.errors).unwrap());
            json_response(&Value::Object(body))
        }

        // Unknown errors → INTERNAL_ERROR with uuid only.
        Err(err) => {
            if method.is_sensitive {
                tracing::error!(method = %method_name, "Sensitive method failed");
            } else {
                tracing::error!(method = %method_name, error = %err, "Method execution failed");
            }
            if is_void {
                return empty_200();
            }
            error_response(INTERNAL_ERROR, uuid, None, false)
        }
    }
}

fn empty_200() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(String::new().into())
        .expect("empty response")
}

fn success_response(method: &str, uuid: Option<&str>, result: &Value) -> Response {
    // Build the envelope manually so a missing uuid is OMITTED rather
    // than serialized as null — matches TS / Python wire output.
    let mut body = serde_json::Map::new();
    body.insert("type".into(), Value::String("result".into()));
    body.insert("method".into(), Value::String(method.to_string()));
    body.insert("result".into(), result.clone());
    if let Some(u) = uuid {
        body.insert("uuid".into(), Value::String(u.to_string()));
    }
    json_response(&Value::Object(body))
}

fn error_response(
    message: &str,
    uuid: Option<String>,
    method: Option<&str>,
    is_void: bool,
) -> Response {
    if is_void {
        return empty_200();
    }
    let mut body = serde_json::Map::new();
    body.insert("type".into(), Value::String("error".into()));
    body.insert("message".into(), Value::String(message.to_string()));
    if let Some(u) = uuid {
        body.insert("uuid".into(), Value::String(u));
    }
    if let Some(m) = method {
        body.insert("method".into(), Value::String(m.to_string()));
    }
    json_response(&Value::Object(body))
}

fn json_response(body: &Value) -> Response {
    let text = match typeferry_ejson::stable_stringify::try_stringify_noncanonical(body) {
        Ok(encoded) => encoded,
        Err(_) => typeferry_ejson::stable_stringify::stringify_noncanonical(&serde_json::json!({
            "type": "error",
            "message": INTERNAL_ERROR,
        })),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(text.into())
        .expect("response build")
}

/// Convert an `EjsonValue` back to a plain `serde_json::Value` for
/// handler consumption. Lossy for Date/Binary/Regex etc. — handlers
/// wanting typed round-trips should work with `EjsonValue` directly.
fn typeferry_value_to_json(value: &EjsonValue) -> Value {
    typeferry_ejson::to_json_value(value)
}

impl IntoResponse for HttpTransportError {
    fn into_response(self) -> Response {
        match self {
            HttpTransportError::Internal => error_response(INTERNAL_ERROR, None, None, false),
        }
    }
}

pub enum HttpTransportError {
    Internal,
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;
    use http_body_util::BodyExt;
    use serde_json::json;
    use typeferry_runtime::{MethodOptions, ServerOptions};

    #[tokio::test]
    async fn http_auth_timeout_fails_closed() {
        let server = Server::new(ServerOptions::default());
        server.set_auth(Arc::new(|_n, _ctx| {
            async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                json!({"user": {"_id": "slow"}})
            }
            .boxed()
        }));
        server.add_method(
            "secret",
            Arc::new(|_n, _p| async move { Ok(json!(true)) }.boxed()),
            MethodOptions {
                protected: true,
                ..Default::default()
            },
        );

        let resp = handle_rpc_with_timeout(
            server,
            HeaderMap::new(),
            Bytes::from_static(br#"{"payload":{"method":"secret"}}"#),
            Duration::from_millis(25),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["type"], "error");
        assert_eq!(parsed["message"], "Method Forbidden");
    }
}

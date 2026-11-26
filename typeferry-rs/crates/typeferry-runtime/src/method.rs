//! RPC method primitive — port of `typeferry-py/src/typeferry/server/method.py`.

use crate::client_node::ClientNode;
use crate::context::TypeFerryContext;
use crate::error::{SchemaValidationError, TypeFerryError};
use crate::schema::SchemaValidatorArc;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use typeferry_ejson::stable_stringify;
use typeferry_protocol::errors::INVALID_PARAMS;
use uuid::Uuid;

pub type BoxResult = Result<Value, TypeFerryError>;
pub type RpcFuture = BoxFuture<'static, BoxResult>;
pub type RpcHandler = Arc<dyn Fn(Arc<ClientNode>, Value) -> RpcFuture + Send + Sync>;
pub type Middleware = Arc<dyn Fn(Arc<ClientNode>, Value) -> RpcFuture + Send + Sync>;

pub const DEFAULT_MAX_AGE_MS: u64 = 60_000;

#[derive(Clone, Default)]
pub struct MethodOptions {
    pub cache: bool,
    pub max_age_ms: Option<u64>,
    pub protected: bool,
    pub middleware: Vec<Middleware>,
    pub schema: Option<SchemaValidatorArc>,
}

pub struct Method {
    pub uuid: String,
    pub name: String,
    pub is_protected: bool,
    handler: RpcHandler,
    middleware: Vec<Middleware>,
    schema: Option<SchemaValidatorArc>,
    cache: Option<Arc<MethodCache>>,
}

struct MethodCache {
    max_age: Duration,
    entries: RwLock<HashMap<String, (Value, Instant)>>,
}

impl Method {
    pub fn new(name: impl Into<String>, handler: RpcHandler, opts: MethodOptions) -> Arc<Self> {
        let cache = if opts.cache {
            Some(Arc::new(MethodCache {
                max_age: Duration::from_millis(opts.max_age_ms.unwrap_or(DEFAULT_MAX_AGE_MS)),
                entries: RwLock::new(HashMap::new()),
            }))
        } else {
            None
        };
        Arc::new(Self {
            uuid: Uuid::new_v4().to_string(),
            name: name.into(),
            is_protected: opts.protected,
            handler,
            middleware: opts.middleware,
            schema: opts.schema,
            cache,
        })
    }

    pub async fn exec(&self, params: Value, node: Arc<ClientNode>) -> BoxResult {
        // 1. Schema validation.
        let mut clean = params;
        if let Some(schema) = &self.schema {
            let to_validate = if clean.is_null() {
                json!({})
            } else {
                clean.clone()
            };
            let result = schema.safe_parse(&to_validate);
            if !result.success {
                let messages: Vec<String> = result.issues.iter().map(|i| i.format()).collect();
                let message = format!("{INVALID_PARAMS}: {}", messages.join(", "));
                return Err(TypeFerryError::Schema(SchemaValidationError {
                    message,
                    errors: messages,
                }));
            }
            clean = result.data.unwrap_or(Value::Null);
        }

        // Authenticated calls must repeat handler authorization and never share
        // results with anonymous callers, including after connection transitions.
        let is_server = *node
            .is_server
            .read()
            .expect("ClientNode.is_server poisoned");
        if !node.is_authenticated()
            && !is_server
            && let Some(cache) = &self.cache
        {
            let key = stable_stringify::stringify_noncanonical(&clean);
            if let Some(hit) = cache_get(cache, &key) {
                return Ok(hit);
            }
            // Cache miss — fall through to execute and remember only if still anonymous.
            let result = run_with_context(self, clean.clone(), node.clone()).await?;
            let still_anon = !node.is_authenticated()
                && !*node
                    .is_server
                    .read()
                    .expect("ClientNode.is_server poisoned");
            if still_anon {
                cache_put(cache, key, result.clone());
            }
            return Ok(result);
        }

        run_with_context(self, clean, node).await
    }
}

async fn run_with_context(method: &Method, clean: Value, node: Arc<ClientNode>) -> BoxResult {
    let ctx = node
        .context
        .read()
        .expect("ClientNode.context poisoned")
        .clone();
    TypeFerryContext::run(Uuid::new_v4().to_string(), ctx, async move {
        let mut buffer = clean;
        for step in &method.middleware {
            buffer = step(node.clone(), buffer).await?;
        }
        (method.handler)(node, buffer).await
    })
    .await
}

fn cache_get(cache: &MethodCache, key: &str) -> Option<Value> {
    let entries = cache.entries.read().expect("cache poisoned");
    let hit = entries.get(key)?;
    if hit.1.elapsed() < cache.max_age {
        Some(hit.0.clone())
    } else {
        None
    }
}

const MAX_CACHE_ENTRIES: usize = 1000;

fn cache_put(cache: &MethodCache, key: String, value: Value) {
    let mut entries = cache.entries.write().expect("cache poisoned");
    if entries.len() >= MAX_CACHE_ENTRIES && !entries.contains_key(&key) {
        entries.retain(|_, (_, ts)| ts.elapsed() < cache.max_age);
        if entries.len() >= MAX_CACHE_ENTRIES
            && let Some(oldest_key) = entries
                .iter()
                .min_by_key(|(_, (_, ts))| *ts)
                .map(|(k, _)| k.clone())
        {
            entries.remove(&oldest_key);
        }
    }
    entries.insert(key, (value, Instant::now()));
}

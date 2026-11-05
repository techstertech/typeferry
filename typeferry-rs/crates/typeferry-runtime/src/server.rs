//! Top-level `Server` — method/event/channel/client registries.

use crate::client_node::ClientNode;
use crate::error::TypeFerryError;
use crate::event::{Event, EventOptions};
use crate::method::{Method, MethodOptions, RpcHandler};
use crate::room_registry::RoomRegistry;
use crate::server_channel::ServerChannel;
use futures::future::BoxFuture;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use typeferry_protocol::NO_CHANNEL;
use uuid::Uuid;

/// Auth callback — receives the partially-built ClientNode and the
/// context JSON assembled from the request body + token header.
/// Returns a truthy `Value::Object` (the user context) on success,
/// `Value::Null` / `Value::Bool(false)` on failure.
pub type AuthFn = Arc<dyn Fn(Arc<ClientNode>, Value) -> BoxFuture<'static, Value> + Send + Sync>;

#[derive(Clone)]
pub struct ServerOptions {
    pub host: String,
    pub port: u16,
    pub debug: bool,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            host: "localhost".into(),
            port: 0,
            debug: false,
        }
    }
}

pub struct Server {
    pub uuid: String,
    pub options: ServerOptions,
    pub methods: RwLock<HashMap<String, Arc<Method>>>,
    pub events: Arc<RwLock<HashMap<String, Arc<Event>>>>,
    pub channels: RwLock<HashMap<String, Arc<ServerChannel>>>,
    pub clients: RwLock<HashMap<String, Arc<ClientNode>>>,
    pub clients_by_user_id: RwLock<HashMap<String, HashSet<String>>>,
    pub rooms: Arc<RwLock<Option<Arc<RoomRegistry>>>>,
    pub is_auth_enabled: RwLock<bool>,
    pub auth_fn: RwLock<Option<AuthFn>>,
}

impl Server {
    pub fn new(options: ServerOptions) -> Arc<Self> {
        let server = Arc::new(Self {
            uuid: Uuid::new_v4().to_string(),
            options,
            methods: RwLock::new(HashMap::new()),
            events: Arc::new(RwLock::new(HashMap::new())),
            channels: RwLock::new(HashMap::new()),
            clients: RwLock::new(HashMap::new()),
            clients_by_user_id: RwLock::new(HashMap::new()),
            rooms: Arc::new(RwLock::new(None)),
            is_auth_enabled: RwLock::new(false),
            auth_fn: RwLock::new(None),
        });

        // Install the NO_CHANNEL anchor so consumers can retrieve it via
        // `channel(NO_CHANNEL)`.
        let anchor = Arc::new(ServerChannel::new(
            NO_CHANNEL,
            server.events.clone(),
            server.rooms.clone(),
        ));
        server
            .channels
            .write()
            .expect("channels poisoned")
            .insert(NO_CHANNEL.to_string(), anchor);

        // Auto-register the protocol's default methods. PROTOCOL.md §7.
        crate::default_methods::register(&server);

        server
    }

    pub fn attach_room_registry(&self, rooms: Arc<RoomRegistry>) {
        *self.rooms.write().expect("rooms poisoned") = Some(rooms);
    }

    /// Register an auth callback. Calling this also flips
    /// `is_auth_enabled` so the WS transport knows to run auth on
    /// connect rather than sending `{authenticated: false}` blindly.
    pub fn set_auth(&self, auth: AuthFn) {
        *self.auth_fn.write().expect("auth_fn poisoned") = Some(auth);
        *self
            .is_auth_enabled
            .write()
            .expect("is_auth_enabled poisoned") = true;
    }

    /**
     * Invoke the registered callback using JavaScript authentication truthiness.
     * Rejection clears the node's principal and returns Null. Truthy containers
     * and scalars remain intact for the transport to attach as context.
     */
    pub async fn run_auth(&self, node: Arc<ClientNode>, context: Value) -> Value {
        let fn_opt = self
            .auth_fn
            .read()
            .expect("auth_fn poisoned")
            .as_ref()
            .cloned();
        let result = match fn_opt {
            Some(auth) => auth(node.clone(), context).await,
            None => Value::Null,
        };
        let truthy = match &result {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
            Value::String(value) => !value.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        };

        if truthy {
            result
        } else {
            // Both transports consume this result. Normalize JS falsey scalars
            // here so neither adapter can mistake zero or an empty string for
            // an authenticated principal.
            node.set_authenticated(false);
            node.set_context(Value::Null);
            Value::Null
        }
    }

    pub fn add_method(&self, name: &str, handler: RpcHandler, opts: MethodOptions) {
        let method = Method::new(name.to_string(), handler, opts);
        self.methods
            .write()
            .expect("methods poisoned")
            .insert(name.to_string(), method);
    }

    pub fn get_method(&self, name: &str) -> Option<Arc<Method>> {
        self.methods.read().ok()?.get(name).cloned()
    }

    pub fn channel(&self, name: &str) -> Arc<ServerChannel> {
        if name.is_empty() || name == NO_CHANNEL {
            return self
                .channels
                .read()
                .expect("channels poisoned")
                .get(NO_CHANNEL)
                .cloned()
                .expect("NO_CHANNEL anchor missing");
        }
        {
            let existing = self.channels.read().expect("channels poisoned");
            if let Some(c) = existing.get(name) {
                return c.clone();
            }
        }
        let new_channel = Arc::new(ServerChannel::new(
            name,
            self.events.clone(),
            self.rooms.clone(),
        ));
        self.channels
            .write()
            .expect("channels poisoned")
            .insert(name.to_string(), new_channel.clone());
        new_channel
    }

    pub fn add_event(&self, event: Arc<Event>) {
        self.events
            .write()
            .expect("events poisoned")
            .insert(event.name.clone(), event);
    }

    pub fn add_event_named(&self, name: &str, opts: EventOptions) {
        self.add_event(Event::new(name, opts));
    }

    pub fn add_client(&self, node: Arc<ClientNode>) {
        let uuid = node.uuid();
        self.clients
            .write()
            .expect("clients poisoned")
            .insert(uuid.clone(), node.clone());
        if let Some(user_id) = node.user_id.read().ok().and_then(|opt| opt.clone()) {
            self.clients_by_user_id
                .write()
                .expect("user index poisoned")
                .entry(user_id)
                .or_default()
                .insert(uuid);
        }
    }

    pub fn delete_client(&self, node: &ClientNode) {
        let uuid = node.uuid();
        self.clients
            .write()
            .expect("clients poisoned")
            .remove(&uuid);
        if let Some(user_id) = node.user_id.read().ok().and_then(|opt| opt.clone()) {
            let mut index = self
                .clients_by_user_id
                .write()
                .expect("user index poisoned");
            if let Some(nodes) = index.get_mut(&user_id) {
                nodes.remove(&uuid);
                if nodes.is_empty() {
                    index.remove(&user_id);
                }
            }
        }
    }

    pub async fn call_method_on_node(
        &self,
        method: &str,
        params: Value,
        node: Arc<ClientNode>,
    ) -> Result<Value, TypeFerryError> {
        let m = self
            .get_method(method)
            .ok_or_else(|| TypeFerryError::MethodNotFound(method.to_string()))?;
        m.exec(params, node).await
    }
}

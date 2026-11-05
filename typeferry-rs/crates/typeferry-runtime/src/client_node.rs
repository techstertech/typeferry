//! Per-connection state — port of `typeferry-py/src/typeferry/server/client_node.py`.

use crate::socket::{SocketState, TypeFerrySocket};
use serde_json::{Value, json};
use std::sync::{Arc, RwLock};
use typeferry_protocol::MessageType;
use uuid::Uuid;

pub struct ClientNode {
    pub uuid: RwLock<String>,
    pub authenticated: RwLock<bool>,
    pub context: RwLock<Value>,
    pub user_id: RwLock<Option<String>>,
    pub meta: RwLock<Value>,
    pub headers: RwLock<std::collections::BTreeMap<String, String>>,
    pub remote_address: RwLock<String>,
    pub user_agent: RwLock<String>,
    pub is_server: RwLock<bool>,
    pub socket: Option<Arc<dyn TypeFerrySocket>>,
}

impl ClientNode {
    pub fn new(socket: Option<Arc<dyn TypeFerrySocket>>) -> Arc<Self> {
        Arc::new(Self {
            uuid: RwLock::new(Uuid::new_v4().to_string()),
            authenticated: RwLock::new(false),
            context: RwLock::new(Value::Null),
            user_id: RwLock::new(None),
            meta: RwLock::new(Value::Object(serde_json::Map::new())),
            headers: RwLock::new(Default::default()),
            remote_address: RwLock::new(String::new()),
            user_agent: RwLock::new(String::new()),
            is_server: RwLock::new(false),
            socket,
        })
    }

    pub fn set_id(&self, id: impl Into<String>) {
        *self.uuid.write().expect("ClientNode.uuid poisoned") = id.into();
    }

    pub fn uuid(&self) -> String {
        self.uuid.read().expect("ClientNode.uuid poisoned").clone()
    }

    pub fn is_authenticated(&self) -> bool {
        *self
            .authenticated
            .read()
            .expect("ClientNode.authenticated poisoned")
    }

    pub fn set_authenticated(&self, value: bool) {
        *self
            .authenticated
            .write()
            .expect("ClientNode.authenticated poisoned") = value;
    }

    pub fn set_context(&self, ctx: Value) {
        let authenticated = self.is_authenticated();
        let resolved = if authenticated && !ctx.is_null() {
            ctx
        } else {
            Value::Null
        };
        *self.context.write().expect("ClientNode.context poisoned") = resolved.clone();

        // Derive user_id from context.user._id if present.
        let id = if authenticated {
            resolved.get("user").and_then(|user| {
                user.get("_id")
                    .or_else(|| user.get("id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
        } else {
            None
        };

        *self.user_id.write().expect("ClientNode.user_id poisoned") = id;
    }

    pub async fn emit_auth_result(&self, authenticated: bool) {
        let Some(socket) = self.socket.as_ref() else {
            return;
        };
        if socket.ready_state() != SocketState::OPEN {
            return;
        }
        let payload = json!({
            "t": MessageType::Auth.as_str(),
            "authenticated": authenticated,
        });
        socket
            .send(typeferry_ejson::stable_stringify::stringify_noncanonical(
                &payload,
            ))
            .await;
    }

    pub async fn emit_event(&self, event: &str, channel: Option<&str>, params: Value) {
        let Some(socket) = self.socket.as_ref() else {
            return;
        };
        if socket.ready_state() != SocketState::OPEN {
            return;
        }
        let payload = json!({
            "t": MessageType::Event.as_str(),
            "uuid": Uuid::new_v4().to_string(),
            "event": event,
            "channel": channel,
            "params": params,
        });
        socket
            .send(typeferry_ejson::stable_stringify::stringify_noncanonical(
                &payload,
            ))
            .await;
    }

    pub async fn close(&self) {
        if let Some(socket) = self.socket.as_ref() {
            socket.close().await;
        }
    }
}

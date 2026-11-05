//! Event primitive — port of `typeferry-py/src/typeferry/server/event.py`.

use crate::client_node::ClientNode;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::Arc;
use typeferry_protocol::MessageType;
use uuid::Uuid;

pub type ShouldSubscribeFuture = BoxFuture<'static, bool>;
pub type ShouldSubscribe =
    Arc<dyn Fn(Arc<ClientNode>, String, String) -> ShouldSubscribeFuture + Send + Sync>;

#[derive(Clone, Default)]
pub struct EventOptions {
    pub protected: bool,
    pub user: bool,
    pub cluster: bool,
    pub exclude_originator: bool,
    pub should_subscribe: Option<ShouldSubscribe>,
}

pub struct Event {
    pub uuid: String,
    pub name: String,
    pub is_protected: bool,
    pub cluster: bool,
    pub exclude_originator: bool,
    pub should_subscribe: ShouldSubscribe,
}

impl Event {
    pub fn new(name: impl Into<String>, opts: EventOptions) -> Arc<Self> {
        let is_user = opts.user;
        let user_default: ShouldSubscribe = Arc::new(move |node, _ev, channel| {
            Box::pin(async move {
                let user_id = node.user_id.read().expect("user_id poisoned").clone();
                user_id.map(|id| id == channel).unwrap_or(false)
            })
        });
        let always_true: ShouldSubscribe = Arc::new(|_, _, _| Box::pin(async { true }));

        let should_subscribe = if let Some(custom) = opts.should_subscribe {
            custom
        } else if is_user {
            user_default
        } else {
            always_true
        };

        Arc::new(Self {
            uuid: Uuid::new_v4().to_string(),
            name: name.into(),
            is_protected: opts.protected || is_user,
            cluster: opts.cluster,
            exclude_originator: opts.exclude_originator,
            should_subscribe,
        })
    }

    /// Encode the wire-level event envelope for this event on `channel`
    /// with `params`. Returns the encoded frame plus the originator
    /// uuid (if exclude_originator applies).
    pub fn encode_payload(&self, channel: &str, params: &Value) -> (String, Option<String>) {
        let payload = json!({
            "t": MessageType::Event.as_str(),
            "uuid": Uuid::new_v4().to_string(),
            "event": self.name,
            "channel": channel,
            "params": params,
        });
        let exclude = if self.exclude_originator {
            params
                .get("uuid")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        } else {
            None
        };
        (
            typeferry_ejson::stable_stringify::stringify_noncanonical(&payload),
            exclude,
        )
    }
}

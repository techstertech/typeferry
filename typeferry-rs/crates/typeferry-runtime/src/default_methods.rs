//! Default RPC methods auto-registered on every `Server` — port of
//! `typeferry-py/src/typeferry/server/default_methods.py`.
//!
//! Ships:
//!
//! * `rpc:on`  — subscribe to events on an optional channel
//! * `rpc:off` — unsubscribe
//! * `rpc:logout` — clear auth state on the node
//!
//! `rpc:login` and `list:methods` are NOT auto-registered (PROTOCOL.md
//! §7.4, §7.5). The application registers `rpc:login` itself when it
//! opts into auth.

use crate::client_node::ClientNode;
use crate::method::{BoxResult, MethodOptions, RpcHandler};
use crate::server::Server;
use futures::FutureExt as _;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use typeferry_protocol::{NO_CHANNEL, methods, room_name};

/// Install `rpc:on` / `rpc:off` / `rpc:logout` on `server`.
pub(crate) fn register(server: &Arc<Server>) {
    server.add_method(
        methods::RPC_ON,
        rpc_on(server.clone()),
        MethodOptions::default(),
    );
    server.add_method(
        methods::RPC_OFF,
        rpc_off(server.clone()),
        MethodOptions::default(),
    );
    server.add_method(
        methods::RPC_LOGOUT,
        rpc_logout(server.clone()),
        MethodOptions {
            protected: true,
            ..Default::default()
        },
    );
}

const MAX_EVENTS_PER_CALL: usize = 256;
const MAX_CHANNEL_BYTES: usize = 256;
const MAX_ROOMS_PER_CLIENT: usize = 1024;

/// `rpc:on` — subscribe a connected client to a list of events on a
/// channel. Returns `{ event_name: bool }` per-event success.
fn rpc_on(server: Arc<Server>) -> RpcHandler {
    Arc::new(move |node: Arc<ClientNode>, params: Value| {
        let server = server.clone();
        async move {
            let raw_len = params
                .get("events")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let channel = channel_or_default(&params);
            if raw_len > MAX_EVENTS_PER_CALL || channel.len() > MAX_CHANNEL_BYTES {
                return Ok(Value::Object(Map::new())) as BoxResult;
            }

            let events = events_list(&params);
            if events.is_empty() {
                return Ok(Value::Object(Map::new())) as BoxResult;
            }

            let channel_auth = server
                .channel_auth
                .read()
                .expect("channel_auth poisoned")
                .clone();
            let channel_allowed = match channel_auth {
                Some(checker) => checker(node.clone(), channel.clone()).await,
                None => true,
            };

            let mut result = Map::new();
            for event_name in events {
                if !channel_allowed {
                    result.insert(event_name, Value::Bool(false));
                    continue;
                }
                let allowed = can_subscribe(&server, &node, &event_name, &channel).await;
                result.insert(event_name, Value::Bool(allowed));
            }
            Ok(Value::Object(result))
        }
        .boxed()
    })
}

/// `rpc:off` — unsubscribe from the same shape `rpc:on` accepts.
fn rpc_off(server: Arc<Server>) -> RpcHandler {
    Arc::new(move |node: Arc<ClientNode>, params: Value| {
        let server = server.clone();
        async move {
            let events = events_list(&params);
            let channel = channel_or_default(&params);

            // No socket → nothing to unsubscribe; return an empty map.
            let Some(socket) = node.socket.as_ref().cloned() else {
                return Ok(Value::Object(Map::new())) as BoxResult;
            };
            let Some(rooms) = server.rooms.read().ok().and_then(|opt| opt.clone()) else {
                return Ok(Value::Object(Map::new())) as BoxResult;
            };

            let mut result = Map::new();
            for event_name in events {
                let exists = server
                    .events
                    .read()
                    .map(|map| map.contains_key(&event_name))
                    .unwrap_or(false);
                if !exists {
                    result.insert(event_name, Value::Bool(false));
                    continue;
                }
                rooms.leave(&*socket, &room_name(&channel, &event_name));
                result.insert(event_name, Value::Bool(true));
            }
            Ok(Value::Object(result))
        }
        .boxed()
    })
}

/// `rpc:logout` — leave rooms and clear auth state on the node. Always returns `true`.
fn rpc_logout(server: Arc<Server>) -> RpcHandler {
    Arc::new(move |node: Arc<ClientNode>, _params: Value| {
        let server = server.clone();
        async move {
            if let Some(socket) = node.socket.as_ref()
                && let Some(rooms) = server.rooms.read().ok().and_then(|opt| opt.clone())
            {
                rooms.leave_all(&**socket);
            }
            server.remove_client_from_user_index(&node);
            node.set_authenticated(false);
            Ok(json!(true)) as BoxResult
        }
        .boxed()
    })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn events_list(params: &Value) -> Vec<String> {
    params
        .get("events")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn channel_or_default(params: &Value) -> String {
    params
        .get("channel")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(NO_CHANNEL)
        .to_string()
}

async fn can_subscribe(
    server: &Server,
    node: &Arc<ClientNode>,
    event_name: &str,
    channel: &str,
) -> bool {
    let event = match server
        .events
        .read()
        .ok()
        .and_then(|m| m.get(event_name).cloned())
    {
        Some(e) => e,
        None => return false,
    };
    if event.is_protected && !node.is_authenticated() {
        return false;
    }
    let allowed =
        (event.should_subscribe)(node.clone(), event_name.to_string(), channel.to_string()).await;
    if !allowed {
        return false;
    }
    if event.is_protected && !node.is_authenticated() {
        return false;
    }
    let Some(socket) = node.socket.as_ref().cloned() else {
        return false;
    };
    let Some(rooms) = server.rooms.read().ok().and_then(|opt| opt.clone()) else {
        return false;
    };
    let room = room_name(channel, event_name);
    if !rooms.has(&*socket, &room) && rooms.socket_room_count(&*socket) >= MAX_ROOMS_PER_CLIENT {
        return false;
    }
    rooms.join(socket, room);
    true
}

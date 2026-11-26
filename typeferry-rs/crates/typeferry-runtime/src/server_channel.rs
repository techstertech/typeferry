//! Server channel — per-channel event registry + broadcast path.

use crate::client_node::ClientNode;
use crate::event::Event;
use crate::room_registry::RoomRegistry;
use crate::server::ChannelAuthFn;
use crate::socket::SocketState;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use typeferry_protocol::room_name;

pub struct ServerChannel {
    pub channel_name: String,
    /// Shared event map (owned by the Server, mirrored here by reference).
    pub(crate) events: Arc<RwLock<HashMap<String, Arc<Event>>>>,
    /// Optional shared RoomRegistry; None if no WS transport is attached.
    pub(crate) rooms: Arc<RwLock<Option<Arc<RoomRegistry>>>>,
    pub(crate) channel_auth: Arc<RwLock<Option<ChannelAuthFn>>>,
    pub(crate) clients_by_socket: Arc<RwLock<HashMap<u64, Arc<ClientNode>>>>,
}

impl ServerChannel {
    pub fn new(
        channel_name: impl Into<String>,
        events: Arc<RwLock<HashMap<String, Arc<Event>>>>,
        rooms: Arc<RwLock<Option<Arc<RoomRegistry>>>>,
    ) -> Self {
        Self::with_revalidation(
            channel_name,
            events,
            rooms,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(HashMap::new())),
        )
    }

    pub fn with_revalidation(
        channel_name: impl Into<String>,
        events: Arc<RwLock<HashMap<String, Arc<Event>>>>,
        rooms: Arc<RwLock<Option<Arc<RoomRegistry>>>>,
        channel_auth: Arc<RwLock<Option<ChannelAuthFn>>>,
        clients_by_socket: Arc<RwLock<HashMap<u64, Arc<ClientNode>>>>,
    ) -> Self {
        Self {
            channel_name: channel_name.into(),
            events,
            rooms,
            channel_auth,
            clients_by_socket,
        }
    }

    pub fn add_event(&self, event: Arc<Event>) {
        let mut events = self.events.write().expect("events lock poisoned");
        events.insert(event.name.clone(), event);
    }

    pub fn get(&self, event: &str) -> Option<Arc<Event>> {
        self.events.read().ok()?.get(event).cloned()
    }

    /// Propagate a pre-encoded event frame to the local room.
    pub async fn propagate(&self, event: &str, payload: &str, exclude_id: Option<u64>) {
        let Some(event_obj) = self.get(event) else {
            return;
        };
        let rooms = self.rooms.read().ok().and_then(|opt| opt.clone());
        let Some(rooms) = rooms else { return };
        let name = room_name(&self.channel_name, event);

        if !event_obj.revalidate_on_delivery {
            rooms.broadcast(&name, payload, exclude_id).await;
            return;
        }

        let targets = rooms.snapshot_for_broadcast(&name, exclude_id);
        for socket in targets {
            let allowed = self
                .authorize_recipient(&event_obj, event, socket.id(), &rooms, &name)
                .await;
            if !allowed {
                rooms.leave(&*socket, &name);
                continue;
            }
            if socket.ready_state() == SocketState::OPEN {
                socket.send(payload.to_string()).await;
            }
        }
    }

    async fn authorize_recipient(
        &self,
        event_obj: &Arc<Event>,
        event_name: &str,
        socket_id: u64,
        rooms: &RoomRegistry,
        room: &str,
    ) -> bool {
        let node = self
            .clients_by_socket
            .read()
            .ok()
            .and_then(|map| map.get(&socket_id).cloned());
        let Some(node) = node else {
            return false;
        };
        if event_obj.is_protected && !node.is_authenticated() {
            return false;
        }
        let user_id = node.user_id.read().ok().and_then(|opt| opt.clone());

        let channel_checker = self.channel_auth.read().ok().and_then(|opt| opt.clone());
        if let Some(checker) = channel_checker
            && !checker(node.clone(), self.channel_name.clone()).await
        {
            return false;
        }

        if !(event_obj.should_subscribe)(
            node.clone(),
            event_name.to_string(),
            self.channel_name.clone(),
        )
        .await
        {
            return false;
        }

        let still_registered = self
            .get(event_name)
            .is_some_and(|current| Arc::ptr_eq(&current, event_obj));
        let same_user = node.user_id.read().ok().and_then(|opt| opt.clone()) == user_id;
        still_registered
            && same_user
            && (!event_obj.is_protected || node.is_authenticated())
            && node
                .socket
                .as_ref()
                .is_some_and(|s| s.id() == socket_id && rooms.has(&**s, room))
    }
}

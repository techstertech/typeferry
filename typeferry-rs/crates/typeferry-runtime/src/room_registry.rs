//! Room / subscription registry — bidirectional `room -> sockets` and
//! `socket -> rooms` index with O(1) join/leave/broadcast.

use crate::socket::{SocketState, TypeFerrySocket};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

/// Socket reference used internally. We key by the socket's stable
/// `id()` and keep an `Arc` so broadcast can send without holding the
/// registry lock.
type SocketArc = Arc<dyn TypeFerrySocket>;

#[derive(Default)]
pub struct RoomRegistry {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, HashMap<u64, SocketArc>>,
    socket_rooms: HashMap<u64, HashSet<String>>,
}

impl RoomRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn join(&self, socket: SocketArc, room: impl Into<String>) {
        let id = socket.id();
        let room = room.into();
        let mut inner = self.inner.write().expect("RoomRegistry lock poisoned");
        inner
            .rooms
            .entry(room.clone())
            .or_default()
            .insert(id, socket);
        inner.socket_rooms.entry(id).or_default().insert(room);
    }

    pub fn leave(&self, socket: &dyn TypeFerrySocket, room: &str) {
        let id = socket.id();
        let mut inner = self.inner.write().expect("RoomRegistry lock poisoned");
        if let Some(members) = inner.rooms.get_mut(room) {
            members.remove(&id);
            if members.is_empty() {
                inner.rooms.remove(room);
            }
        }
        if let Some(joined) = inner.socket_rooms.get_mut(&id) {
            joined.remove(room);
            if joined.is_empty() {
                inner.socket_rooms.remove(&id);
            }
        }
    }

    pub fn leave_all(&self, socket: &dyn TypeFerrySocket) {
        let id = socket.id();
        let mut inner = self.inner.write().expect("RoomRegistry lock poisoned");
        let Some(joined) = inner.socket_rooms.remove(&id) else {
            return;
        };
        for room in joined {
            if let Some(members) = inner.rooms.get_mut(&room) {
                members.remove(&id);
                if members.is_empty() {
                    inner.rooms.remove(&room);
                }
            }
        }
    }

    pub fn has(&self, socket: &dyn TypeFerrySocket, room: &str) -> bool {
        let inner = self.inner.read().expect("RoomRegistry lock poisoned");
        inner
            .rooms
            .get(room)
            .map(|members| members.contains_key(&socket.id()))
            .unwrap_or(false)
    }

    pub fn room_size(&self, room: &str) -> usize {
        let inner = self.inner.read().expect("RoomRegistry lock poisoned");
        inner.rooms.get(room).map(|m| m.len()).unwrap_or(0)
    }

    pub fn socket_room_count(&self, socket: &dyn TypeFerrySocket) -> usize {
        let inner = self.inner.read().expect("RoomRegistry lock poisoned");
        inner
            .socket_rooms
            .get(&socket.id())
            .map(|rooms| rooms.len())
            .unwrap_or(0)
    }

    /// Return the list of sockets to broadcast to, filtered by
    /// `exclude_id` and open state. The caller invokes `.send()` on
    /// each socket without holding the registry lock.
    pub fn snapshot_for_broadcast(&self, room: &str, exclude_id: Option<u64>) -> Vec<SocketArc> {
        let inner = self.inner.read().expect("RoomRegistry lock poisoned");
        inner
            .rooms
            .get(room)
            .map(|members| {
                members
                    .values()
                    .filter(|s| Some(s.id()) != exclude_id)
                    .filter(|s| s.ready_state() == SocketState::OPEN)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn broadcast(&self, room: &str, data: &str, exclude_id: Option<u64>) {
        let targets = self.snapshot_for_broadcast(room, exclude_id);
        for socket in targets {
            socket.send(data.to_string()).await;
        }
    }
}

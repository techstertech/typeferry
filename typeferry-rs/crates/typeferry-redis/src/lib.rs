//! Redis pub/sub transport — PROTOCOL.md §2.3.

use futures::StreamExt;
use redis::AsyncCommands;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use typeferry_protocol::{NO_CHANNEL, REDIS_EVENTS_CHANNEL};
use typeferry_runtime::Server;

pub struct RedisTransport {
    server: Arc<Server>,
    url: String,
    publisher: Mutex<Option<redis::aio::MultiplexedConnection>>,
    listener: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl RedisTransport {
    pub fn new(server: Arc<Server>, url: impl Into<String>) -> Arc<Self> {
        Arc::new(Self {
            server,
            url: url.into(),
            publisher: Mutex::new(None),
            listener: Mutex::new(None),
        })
    }

    pub async fn connect(self: &Arc<Self>) -> Result<(), redis::RedisError> {
        let client = redis::Client::open(self.url.as_str())?;
        let pub_conn = client.get_multiplexed_async_connection().await?;
        *self.publisher.lock().await = Some(pub_conn);

        let sub_client = redis::Client::open(self.url.as_str())?;
        let mut sub_conn = sub_client.get_async_pubsub().await?;
        sub_conn.subscribe(REDIS_EVENTS_CHANNEL).await?;

        let server = self.server.clone();
        let handle = tokio::spawn(async move {
            let mut stream = sub_conn.on_message();
            while let Some(msg) = stream.next().await {
                let payload: String = match msg.get_payload() {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let Some(decoded) = decode_inbound(&payload) else {
                    continue;
                };

                let exclude_id = decoded.exclude_uuid.and_then(|uuid| {
                    server
                        .clients
                        .read()
                        .ok()?
                        .get(&uuid)
                        .and_then(|node| node.socket.as_ref().map(|s| s.id()))
                });

                server
                    .channel(&decoded.channel)
                    .propagate(&decoded.event, &decoded.message, exclude_id)
                    .await;
            }
        });
        *self.listener.lock().await = Some(handle);
        Ok(())
    }

    pub async fn publish(
        &self,
        event: &str,
        channel: &str,
        message: &str,
        exclude_uuid: Option<&str>,
    ) -> Result<(), redis::RedisError> {
        let payload = build_publish_envelope(event, channel, message, exclude_uuid);
        if let Some(conn) = self.publisher.lock().await.as_mut() {
            let _: i64 = conn.publish(REDIS_EVENTS_CHANNEL, payload).await?;
        }
        Ok(())
    }

    pub async fn close(&self) {
        if let Some(handle) = self.listener.lock().await.take() {
            handle.abort();
            let _ = handle.await;
        }

        if let Some(mut publisher) = self.publisher.lock().await.take() {
            let cleanup: Result<(), redis::RedisError> = redis::pipe()
                .del(format!("typeferry:clients:{}", self.server.uuid))
                .ignore()
                .srem("typeferry:servers", &self.server.uuid)
                .ignore()
                .query_async(&mut publisher)
                .await;

            if let Err(error) = cleanup {
                tracing::warn!(server_uuid = %self.server.uuid, %error, "Redis close cleanup failed");
            }
        }
    }
}

/// Build the exact JSON text published to Redis for an event.
///
/// Extracted as a pure function so it can be unit-tested without a
/// running Redis instance — and so alternate transports can reuse the
/// wire shape.
pub fn build_publish_envelope(
    event: &str,
    channel: &str,
    message: &str,
    exclude_uuid: Option<&str>,
) -> String {
    let channel_name = if channel.is_empty() {
        NO_CHANNEL
    } else {
        channel
    };
    let mut obj = serde_json::Map::new();
    obj.insert("event".into(), Value::String(event.into()));
    obj.insert("channel".into(), Value::String(channel_name.into()));
    obj.insert("message".into(), Value::String(message.into()));
    if let Some(uuid) = exclude_uuid {
        obj.insert("excludeUuid".into(), Value::String(uuid.into()));
    }
    serde_json::to_string(&Value::Object(obj)).expect("publish envelope serializable")
}

/// Decode an inbound Redis message and return the fields needed to
/// route it to `ServerChannel::propagate`. Returns None when the
/// payload is malformed or missing required fields.
///
/// Shape mirrors the Python and TS ports exactly so a TS-produced
/// message propagates identically on a Rust listener.
pub fn decode_inbound(payload: &str) -> Option<DecodedInbound> {
    let decoded: Value = serde_json::from_str(payload).ok()?;
    let event = decoded.get("event")?.as_str()?.to_string();
    let channel = decoded
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or(NO_CHANNEL)
        .to_string();
    let message = decoded.get("message")?.as_str()?.to_string();
    let exclude_uuid = decoded
        .get("excludeUuid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if event.is_empty() || message.is_empty() {
        return None;
    }
    Some(DecodedInbound {
        event,
        channel,
        message,
        exclude_uuid,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedInbound {
    pub event: String,
    pub channel: String,
    pub message: String,
    pub exclude_uuid: Option<String>,
}

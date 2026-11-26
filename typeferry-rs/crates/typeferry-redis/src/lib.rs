//! Redis pub/sub transport — PROTOCOL.md §2.3.

use aws_lc_rs::hmac;
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
    signing_secret: Option<String>,
    publisher: Mutex<Option<redis::aio::MultiplexedConnection>>,
    listener: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl RedisTransport {
    pub fn new(server: Arc<Server>, url: impl Into<String>) -> Arc<Self> {
        Arc::new(Self {
            server,
            url: url.into(),
            signing_secret: None,
            publisher: Mutex::new(None),
            listener: Mutex::new(None),
        })
    }

    /// Construct a Redis transport that signs and verifies cluster envelopes with HMAC-SHA256.
    pub fn with_signing_secret(
        server: Arc<Server>,
        url: impl Into<String>,
        signing_secret: impl Into<String>,
    ) -> Arc<Self> {
        let secret = signing_secret.into();
        Arc::new(Self {
            server,
            url: url.into(),
            signing_secret: (!secret.is_empty()).then_some(secret),
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
        let signing_secret = self.signing_secret.clone();
        let handle = tokio::spawn(async move {
            let mut stream = sub_conn.on_message();
            while let Some(msg) = stream.next().await {
                let payload: String = match msg.get_payload() {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let Some(decoded) = decode_inbound_signed(&payload, signing_secret.as_deref())
                else {
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
                    .transient_channel(&decoded.channel)
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
        let payload = build_publish_envelope_signed(
            event,
            channel,
            message,
            exclude_uuid,
            self.signing_secret.as_deref(),
        );
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

/// Format the length-prefixed UTF-8 canonical signing input (`PROTOCOL.md` §2.3).
pub fn format_signing_input(
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
    let exclude = exclude_uuid.unwrap_or("");
    format!(
        "{}:{event}|{}:{channel_name}|{}:{message}|{}:{exclude}",
        event.len(),
        channel_name.len(),
        message.len(),
        exclude.len(),
    )
}

/// Compute lowercase hex HMAC-SHA256 over the canonical signing input.
pub fn sign_envelope(
    event: &str,
    channel: &str,
    message: &str,
    exclude_uuid: Option<&str>,
    signing_secret: &str,
) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, signing_secret.as_bytes());
    let input = format_signing_input(event, channel, message, exclude_uuid);
    let tag = hmac::sign(&key, input.as_bytes());
    let mut hex = String::with_capacity(tag.as_ref().len() * 2);
    for byte in tag.as_ref() {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn decode_lower_hex(input: &str) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }
    let mut bytes = Vec::with_capacity(input.len() / 2);
    for pair in input.as_bytes().as_chunks::<2>().0 {
        let hi = match pair[0] {
            b'0'..=b'9' => pair[0] - b'0',
            b'a'..=b'f' => pair[0] - b'a' + 10,
            _ => return None,
        };
        let lo = match pair[1] {
            b'0'..=b'9' => pair[1] - b'0',
            b'a'..=b'f' => pair[1] - b'a' + 10,
            _ => return None,
        };
        bytes.push((hi << 4) | lo);
    }
    Some(bytes)
}

/// Build the exact JSON text published to Redis for an event.
pub fn build_publish_envelope(
    event: &str,
    channel: &str,
    message: &str,
    exclude_uuid: Option<&str>,
) -> String {
    build_publish_envelope_signed(event, channel, message, exclude_uuid, None)
}

/// Build the JSON text published to Redis, attaching `sig` when `signing_secret` is set.
pub fn build_publish_envelope_signed(
    event: &str,
    channel: &str,
    message: &str,
    exclude_uuid: Option<&str>,
    signing_secret: Option<&str>,
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
    if let Some(secret) = signing_secret.filter(|s| !s.is_empty()) {
        obj.insert(
            "sig".into(),
            Value::String(sign_envelope(
                event,
                channel_name,
                message,
                exclude_uuid,
                secret,
            )),
        );
    }
    serde_json::to_string(&Value::Object(obj)).expect("publish envelope serializable")
}

/// Decode an inbound Redis message without requiring a signature.
pub fn decode_inbound(payload: &str) -> Option<DecodedInbound> {
    decode_inbound_signed(payload, None)
}

/// Decode and strictly validate an inbound Redis message, verifying HMAC `sig` when configured.
pub fn decode_inbound_signed(
    payload: &str,
    signing_secret: Option<&str>,
) -> Option<DecodedInbound> {
    let decoded: Value = serde_json::from_str(payload).ok()?;
    let obj = decoded.as_object()?;
    let event = obj.get("event")?.as_str()?.to_string();
    let message = obj.get("message")?.as_str()?.to_string();
    if event.is_empty() || message.is_empty() {
        return None;
    }

    let channel = match obj.get("channel") {
        None | Some(Value::Null) => NO_CHANNEL.to_string(),
        Some(Value::String(s)) if s.is_empty() => NO_CHANNEL.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return None,
    };

    let exclude_uuid = match obj.get("excludeUuid") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return None,
    };

    if let Some(secret) = signing_secret.filter(|s| !s.is_empty()) {
        let raw_sig = obj.get("sig").and_then(|v| v.as_str())?;
        let sig_bytes = decode_lower_hex(raw_sig)?;
        let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
        let input = format_signing_input(&event, &channel, &message, exclude_uuid.as_deref());
        hmac::verify(&key, input.as_bytes(), &sig_bytes).ok()?;
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

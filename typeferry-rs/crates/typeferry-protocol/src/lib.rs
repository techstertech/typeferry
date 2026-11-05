//! Wire-protocol primitives: constants, envelopes, discriminators.
//!
//! Normative spec: `PROTOCOL.md` §5 and §12.

use serde::{Deserialize, Serialize};

pub const HTTP_ENDPOINT_PATH: &str = "/__h";
pub const TYPEFERRY_WS_PATH: &str = "/typeferry-ws";
pub const NO_CHANNEL: &str = "NO_CHANNEL";
pub const CLIENT_ID_HEADER_KEY: &str = "x-client-id";
pub const TOKEN_HEADER_KEY: &str = "x-api-key";

pub const AUTH_TIMEOUT_MS: u64 = 5_000;
pub const MAX_UUID_LENGTH: usize = 64;
pub const MAX_META_SIZE: usize = 10_000;
pub const PING_INTERVAL_MS: u64 = 25_000;

pub const REDIS_EVENTS_CHANNEL: &str = "events";

/**
 * Origin admission shared by the HTTP and WebSocket adapters.
 *
 * None leaves admission unrestricted. Some(empty) denies every named origin.
 * Originless admission is explicit and applies only when the header is absent.
 * Each transport receives its own policy value.
 */
#[derive(Debug, Clone, Default)]
pub struct OriginPolicy {
    pub origins: Option<Vec<String>>,
    pub allow_originless: bool,
}

impl OriginPolicy {
    /**
     * Check a normalized Origin header against this transport's policy.
     */
    pub fn allows(&self, origin: Option<&str>) -> bool {
        match (&self.origins, origin) {
            (None, _) => true,
            (Some(_), None) => self.allow_originless,
            (Some(_), Some("")) => false,
            (Some(origins), Some(origin)) => origins.iter().any(|allowed| allowed == origin),
        }
    }
}

/// Default methods (PROTOCOL.md §7).
pub mod methods {
    pub const RPC_LOGIN: &str = "rpc:login";
    pub const RPC_LOGOUT: &str = "rpc:logout";
    pub const RPC_ON: &str = "rpc:on";
    pub const RPC_OFF: &str = "rpc:off";
    pub const LIST_METHODS: &str = "list:methods";
}

/// WebSocket message discriminator (`t` field) — PROTOCOL.md §5.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageType {
    #[serde(rename = "rpc")]
    Rpc,
    #[serde(rename = "rpc:void")]
    RpcVoid,
    #[serde(rename = "rpc:res")]
    RpcResponse,
    #[serde(rename = "event")]
    Event,
    #[serde(rename = "auth")]
    Auth,
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "pong")]
    Pong,
}

impl MessageType {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageType::Rpc => "rpc",
            MessageType::RpcVoid => "rpc:void",
            MessageType::RpcResponse => "rpc:res",
            MessageType::Event => "event",
            MessageType::Auth => "auth",
            MessageType::Ping => "ping",
            MessageType::Pong => "pong",
        }
    }
}

/// HTTP envelope discriminator (PROTOCOL.md §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PayloadType {
    Method,
    Result,
    Event,
    Error,
    #[serde(rename = "auth:result")]
    AuthResult,
}

/// Error messages used on the wire (PROTOCOL.md §9).
pub mod errors {
    pub const AUTHENTICATION_FAILED: &str = "Authentication Failed";
    pub const EVENT_FORBIDDEN: &str = "Event Forbidden";
    pub const EVENT_NOT_FOUND: &str = "Event Not Found";
    pub const EVENT_NOT_PROVIDED: &str = "Event Not Provided";
    pub const EVENT_NOT_SUBSCRIBED: &str = "Event Not Subscribed";
    pub const INTERNAL_ERROR: &str = "Internal Error";
    pub const INVALID_METHOD_NAME: &str = "Invalid Method Name";
    pub const INVALID_PARAMS: &str = "Invalid Params";
    pub const INVALID_REQUEST: &str = "Invalid Request";
    pub const INVALID_TOKEN: &str = "Invalid Token";
    pub const METHOD_FORBIDDEN: &str = "Method Forbidden";
    pub const METHOD_NOT_FOUND: &str = "Method Not Found";
    pub const METHOD_NOT_SPECIFIED: &str = "Method Not Specified";
    pub const PARAMS_NOT_FOUND: &str = "Params Not Found";
    pub const PARSE_ERROR: &str = "Parse Error";
    pub const SUBSCRIPTION_ERROR: &str = "Subscription Error";
    pub const RATE_LIMIT_EXCEEDED: &str = "Rate Limit Exceeded";
}

pub fn room_name(channel: &str, event: &str) -> String {
    format!("typeferry:{channel}:{event}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_type_string_values_match_wire_spec() {
        assert_eq!(MessageType::Rpc.as_str(), "rpc");
        assert_eq!(MessageType::RpcVoid.as_str(), "rpc:void");
        assert_eq!(MessageType::RpcResponse.as_str(), "rpc:res");
        assert_eq!(MessageType::Event.as_str(), "event");
        assert_eq!(MessageType::Auth.as_str(), "auth");
        assert_eq!(MessageType::Ping.as_str(), "ping");
        assert_eq!(MessageType::Pong.as_str(), "pong");
    }

    #[test]
    fn message_type_serde_round_trip() {
        let json = serde_json::to_string(&MessageType::RpcVoid).unwrap();
        assert_eq!(json, r#""rpc:void""#);
        let back: MessageType = serde_json::from_str(&json).unwrap();
        assert_eq!(back, MessageType::RpcVoid);
    }

    #[test]
    fn payload_type_tags() {
        assert_eq!(
            serde_json::to_string(&PayloadType::Result).unwrap(),
            r#""result""#
        );
        assert_eq!(
            serde_json::to_string(&PayloadType::AuthResult).unwrap(),
            r#""auth:result""#
        );
    }

    #[test]
    fn room_name_matches_format() {
        assert_eq!(
            room_name("user:42", "notification"),
            "typeferry:user:42:notification"
        );
    }

    #[test]
    fn constants_match_ts() {
        assert_eq!(HTTP_ENDPOINT_PATH, "/__h");
        assert_eq!(TYPEFERRY_WS_PATH, "/typeferry-ws");
        assert_eq!(NO_CHANNEL, "NO_CHANNEL");
        assert_eq!(CLIENT_ID_HEADER_KEY, "x-client-id");
        assert_eq!(TOKEN_HEADER_KEY, "x-api-key");
        assert_eq!(REDIS_EVENTS_CHANNEL, "events");
        assert_eq!(methods::LIST_METHODS, "list:methods");
    }
}

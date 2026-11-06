# typeferry-rs

The Rust implementation of TypeFerry is a modular server workspace with runtime, protocol, EJSON, Axum HTTP/WebSocket, Redis, auth, and authoring-macro crates. It does not provide a browser client or UI adapter.

> [!IMPORTANT]
> These crates are not published to crates.io. The workspace sets `publish = false`; use repository path dependencies until an identity and release process are approved.

## Use the local facade crate

```toml
# Cargo.toml
[dependencies]
typeferry = { path = "../typeferry/typeferry-rs/crates/typeferry", features = ["full"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
serde_json = "1"
```

Default features include `http`, `ws`, and `macros`. Select `redis`, `auth`, or `full` only when the application needs them.

## Register methods

```rust
// src/main.rs
use std::sync::Arc;

use serde_json::Value;
use typeferry::{BoxResult, ClientNode, Server, ServerOptions};

#[typeferry::method]
async fn echo(_node: Arc<ClientNode>, params: Value) -> BoxResult {
    Ok(params)
}

#[tokio::main]
async fn main() {
    let server = Server::new(ServerOptions::default());
    typeferry::register!(server, [echo]);

    // Attach the HTTP and WebSocket routers to the application's Axum server.
}
```

The method macro requires an async handler accepting `Arc<ClientNode>` and `serde_json::Value`, returning `BoxResult`. It supports explicit wire names, protected methods, caching, and namespace registration.

## Attach transports

The runtime does not bind a socket on construction. Compose `typeferry::http::router(server.clone())` and `typeferry::ws::router(server.clone())` into the application-owned Axum router, then bind and serve it with the application's Tokio lifecycle. See [`typeferry-conformance-server`](crates/typeferry-conformance-server/src/main.rs) for an executable HTTP/WebSocket assembly.

Use `router_with_options` to restrict protocol endpoints to specific origins:

```rust
let http = typeferry::http::router_with_options(
    server.clone(),
    typeferry::http::HttpOptions {
        origins: Some(vec!["https://app.example.com".into()]),
        allow_originless: false,
    },
);
let ws = typeferry::ws::router_with_options(
    server.clone(),
    typeferry::ws::WebSocketOptions {
        origins: Some(vec!["https://app.example.com".into()]),
        allow_originless: true,
    },
);
```

`origins: None` permits every origin. `Some(vec![])` denies every named origin.
Configured lists reject absent headers unless that transport explicitly sets
`allow_originless: true`. The HTTP and WebSocket options remain independent.
HTTP admission precedes body extraction and authentication. Unrelated application
routes keep their own policy. Configured HTTP allowlists emit credentialed CORS
headers and handle preflight requests. Omitted allowlists add neither behavior.
Rate limiting remains application-owned; these options configure origin admission.

Enable `auth` for JWT, cookie, session, device, and OAuth helpers. Authentication establishes a principal; protected handlers must still authorize tenant, role, and resource access. Reject invalid or expired credentials, restrict origins, and keep secrets out of URLs, logs, and compiled configuration.

JWT signing and verification support the configured HS256, HS384, or HS512
algorithm. Verification requires integer `exp` and `iat` claims and checks
expiration. The workspace selects the AWS-LC crypto backend explicitly;
the HMAC-only API does not enable PEM decoding. `decode_token` inspects claims
without checking the signature and must not establish authentication.

Use the Redis feature when events must propagate between server instances. Keep application durability in a database or service of record rather than event payloads.

## EJSON dates and ordering

`EjsonValue::Date` now contains `EjsonDate`, rather than `chrono::DateTime<Utc>`.
Migrate an existing constructor from `EjsonValue::Date(date_time)` to
`EjsonValue::Date(date_time.into())`. Match arms now receive an `EjsonDate`.

`EjsonDate::from_millis` preserves the complete JavaScript range, including
`-8640000000000000` and `8640000000000000`. Its `timestamp_millis()` returns
`Some(milliseconds)` for valid dates and `None` for invalid dates. Out-of-range
inputs produce an invalid date, not an epoch fallback.

Use `EjsonDate::to_chrono()` for checked conversion. It returns `None` for an
invalid date or a valid JavaScript date outside chrono's smaller range.
`EjsonDate::from(date_time)` converts an existing UTC chrono value.

Invalid dates encode as `{"$date":null}`, matching TypeScript. Decoding that
representation produces epoch zero because the existing TypeScript converter
applies `Number(null)`. This asymmetry preserves the existing wire behavior.

`Presentation::encode` uses JavaScript property enumeration: array-index keys
appear first in numeric order, followed by other keys in insertion order.
`Presentation::encode_canonical` sorts the other keys by UTF-16 code units.
Both forms apply recursively. Anonymous method caches use ordinary ordering.

## Workspace crates

| Crate | Purpose |
|---|---|
| `typeferry` | Feature-gated facade and common re-exports |
| `typeferry-ejson` | Extended JSON conversion |
| `typeferry-protocol` | Wire envelopes, constants, and errors |
| `typeferry-runtime` | Methods, events, channels, rooms, context, and middleware |
| `typeferry-http` | Axum `POST /__h` transport |
| `typeferry-ws` | Axum `/typeferry-ws` transport |
| `typeferry-redis` | Multi-instance event propagation |
| `typeferry-auth` | JWT, cookies, sessions, device data, and OAuth |

## Development and verification

```sh
cd typeferry-rs
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

The Redis lifecycle test is explicitly ignored without a disposable service.
With Docker running, execute it against a newly owned container:

```sh
env -u REDIS_URL ../scripts/run-with-redis.sh \
  cargo test -p typeferry-redis --test lifecycle -- --ignored
```

The wrapper removes its container after success or failure. The test verifies
cleanup of the current server's keys while preserving other server state.

## Boundaries and references

- [`PROTOCOL.md`](../PROTOCOL.md) is the normative wire contract.
- [Rust runtime architecture](../docs/architecture/rust-runtime.md) explains crate boundaries.
- [Shared conformance](../docs/conformance/README.md) covers interoperability.
- The [feature-parity plan](../docs/plans/2026-04-12-rust-server-feature-parity.md) is historical, not the current API contract.

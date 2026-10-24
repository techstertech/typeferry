# TypeFerry Wire Protocol Specification

**Version:** 2 (clean-break TypeFerry rename of the protocol previously
implemented by the TypeScript package)

**Status:** Normative. Any alternate implementation
(`typeferry-py`, Rust `typeferry-runtime`, …) MUST match this specification
to be considered protocol-conformant. Feature-parity implementations
MUST additionally match the authoring surface documented in
`docs/plans/2026-04-20-python-server-port-and-monorepo.md` and
`docs/plans/2026-04-12-rust-server-feature-parity.md`.

This document cites the canonical TS implementation at `file:line` for
every contract point. When this document and the TS source disagree, the
TS source wins and this document is a bug.

## Table of Contents

1. [Scope and Conformance Terms](#1-scope-and-conformance-terms)
2. [Transports](#2-transports)
3. [Serialization: Presentation / EJSON](#3-serialization-presentation--ejson)
4. [`Presentation` payload types](#4-presentation-payload-types)
5. [WebSocket message envelopes](#5-websocket-message-envelopes)
6. [RPC semantics](#6-rpc-semantics)
7. [Default methods](#7-default-methods)
8. [Authentication](#8-authentication)
9. [Error codes](#9-error-codes)
10. [Events, channels, and rooms](#10-events-channels-and-rooms)
11. [Authoring surface (feature-parity only)](#11-authoring-surface-feature-parity-only)
12. [Constants reference](#12-constants-reference)
13. [Conformance testing](#13-conformance-testing)
14. [Versioning](#14-versioning)

---

## 1. Scope and Conformance Terms

- **MUST / MUST NOT / REQUIRED / SHALL / SHALL NOT** — strict requirements
  (RFC 2119).
- **SHOULD / RECOMMENDED** — preferences; non-conforming behavior must be
  justified.
- **MAY / OPTIONAL** — truly optional.

A **protocol-conformant server** MUST implement every MUST in sections
2–10. A **feature-parity server** MUST additionally implement the
authoring surface in section 11.

The existing JavaScript client (`typeferry-ts/src/client`) is the canonical
consumer. Any behavior that breaks the JS client against a conformant
server is a protocol regression.

---

## 2. Transports

TypeFerry exposes two client-facing transports (HTTP and WebSocket) and
one server-to-server transport (Redis pub/sub for multi-instance event
propagation).

### 2.1 HTTP transport

| Property                | Value                                   |
|-------------------------|-----------------------------------------|
| Method                  | `POST`                                  |
| Path                    | `/__h`                                  |
| Request Content-Type    | `text/plain` (primary), `application/x-www-form-urlencoded` (accepted) |
| Request body encoding   | EJSON-text (UTF-8)                      |
| Response Content-Type   | implementation variance (see note)      |
| Response body encoding  | EJSON-text (UTF-8) — the client decodes on content, not header |
| Success status          | `200`                                   |
| Rate-limit status       | `429` (when limiter exceeded)           |
| CORS failure status     | `403`                                   |
| Oversized body status   | `413` (when a configured transport limit is exceeded) |

**Content-Type variance:** The Express transport calls
`res.send(string)`, which defaults to
`text/html; charset=utf-8`. The Bun/Hono transport calls `c.text(string)`,
which emits `text/plain; charset=UTF-8`. Both serve identical EJSON-text
bodies; the JS client decodes on body content, not Content-Type. An
alternate implementation MAY choose either header value but MUST serve
EJSON-text.

Servers that configure an origin allowlist MUST reject missing and non-matching
browser origins by default. A host MAY explicitly allow an absent `Origin` for
a trusted non-browser integration. Implementations SHOULD reject request bodies
above a configurable finite byte limit before EJSON decoding.

Sources: `src/server/transports/http-transport.ts:47-48,68`,
`src/server/transports/bun-hono-transport.ts:87,90,262,279`.

#### 2.1.1 Request envelope

The request body, after EJSON decode, MUST be an object of the shape:

```ts
{
  context: unknown,        // opaque context forwarded to the auth function
  payload?: {
    method: string,        // method name; colon-scoped (e.g. "users.list")
    params?: unknown,      // method parameters
    uuid?: string,         // correlation id; echoed in success/error response
    void?: boolean,        // if true, server MUST NOT send an error response
  },
}
```

Source: `src/server/transports/http-transport.ts:32-35,201-217`.

If `payload` is missing, the server MUST reply with an error envelope
whose `message` is the string `Invalid Request`
(`src/server/transports/http-transport.ts:208`, `src/utils/errors.ts:27`).

#### 2.1.2 Success response envelope

```ts
{
  type: "result",          // PayloadType.RESULT
  uuid?: string,            // echoed from request.payload.uuid
  method: string,           // echoed from request.payload.method
  result: unknown,          // method return value
}
```

Source: `src/server/transports/http-transport.ts:233-240`,
`src/utils/presentation.ts:5-11`.

#### 2.1.3 Error response envelope

```ts
{
  type: "error",           // PayloadType.ERROR
  message: string,         // see section 9 (Error codes)
  uuid?: string,           // echoed from request when available
  errors?: string[],       // present only for SchemaValidationError
  method?: string,         // present for METHOD_NOT_FOUND errors
}
```

Sources: `src/server/transports/http-transport.ts:108-111,150-154,215-217`,
`src/server/method.ts:170-182`, `src/utils/errors.ts:8-16`.

If the request had `payload.void === true`, the server MUST suppress
error responses entirely (empty body, status 200 on `bun-hono-transport`
at line 296; no body on Express transport). **Successful void responses
DO still carry the result envelope** — full request-silence is a
WebSocket-only guarantee via `rpc:void` frames (section 5.1.2).

#### 2.1.4 Headers

Request headers the server MUST recognize:

| Header           | Purpose                                                    |
|------------------|------------------------------------------------------------|
| `x-client-id`    | Binds this HTTP call to a WebSocket client uuid (optional) |
| `x-api-key`      | Bearer-prefixed or raw auth token; populates `context.token` |
| `origin`         | CORS validation                                            |

Constants: `CLIENT_ID_HEADER_KEY = 'x-client-id'`,
`TOKEN_HEADER_KEY = 'x-api-key'` (`src/utils/constants.ts:68-69`).

Token extraction strips a leading `Bearer ` prefix
(`src/server/transports/http-transport.ts:94`,
`src/server/transports/bun-hono-transport.ts:232`). The literal string
`"undefined"` is treated as no token.

Response headers:

- `Set-Cookie` — emitted when auth sets a refresh-token cookie. The
  Hono transport queues pending cookies via an append-mode header
  write (`bun-hono-transport.ts:271-277`).

#### 2.1.5 Rate limiting

Default (`limit === true`): `windowMs: 60_000`, `max: 120`
requests per window.

Custom: `{ interval: <ms>, max: <count> }`.

Sources: `src/server/transports/http-transport.ts:50-57`,
`src/server/transports/bun-hono-transport.ts:82-88`.

Rate-limit headers MUST use the `RateLimit-*` standard header set
(`standardHeaders: true`, `legacyHeaders: false`).

### 2.2 WebSocket transport

| Property       | Value                                           |
|----------------|-------------------------------------------------|
| Path           | `/typeferry-ws`                                   |
| Constant       | `TYPEFERRY_WS_PATH` in `src/utils/constants.ts:64` |
| Frame type     | Text (UTF-8)                                    |
| Frame encoding | EJSON-text via `Presentation.encode/decode`     |

#### 2.2.1 Query parameters

| Param  | Type   | Required | Constraint                                    |
|--------|--------|----------|-----------------------------------------------|
| `uuid` | string | no       | 1–64 chars; MUST be sanitized to `[a-zA-Z0-9-]`; if missing/invalid the server MUST assign a fresh random UUID |
| `token`| string | no       | auth bearer token; omission means unauthenticated |
| `meta` | string | no       | JSON-encoded object; MUST NOT exceed 10 000 bytes; invalid or oversize values MUST be normalized to `{}` |

Sources: `src/server/transports/ws-shared.ts:17-20,204-240`.

#### 2.2.2 Connection lifecycle

1. Client opens WebSocket to `/typeferry-ws?uuid=...&token=...&meta=...`.
2. If the server enforces CORS, the Origin MUST be validated.
3. Upgrade completes. The server calls `handleOpen`
   (`src/server/transports/bun-ws-transport.ts:140`).
4. Server runs `authenticateNode`
   (`src/server/transports/ws-shared.ts:164-197`):
   - If auth is disabled **or** no `token` query param is provided,
     the server MUST emit `{ t: "auth", authenticated: false }`
     immediately and MUST NOT call the auth function.
   - Otherwise, the server MUST race the auth function against a
     **5000 ms** (`AUTH_TIMEOUT_MS`) timeout. On success, set
     `node.authenticated = true`, attach context, emit
     `ServerEvents.AUTHENTICATION`, and send
     `{ t: "auth", authenticated: true }`. On timeout or rejection,
     emit `{ t: "auth", authenticated: false }`.
5. Server MUST start a ping loop at **25 000 ms** (`PING_INTERVAL_MS`)
   interval. Each tick sends the pre-encoded payload
   `{ t: "ping" }` (see `PING_PAYLOAD` at `ws-shared.ts:22-23`).
6. If a peer fails to respond to ping within the next interval, the
   server SHOULD terminate the socket.

#### 2.2.3 Application-owned handshake authentication

Server transports MAY expose an optional application-owned handshake
authenticator for hosts whose authority is carried by protected request metadata
such as an HttpOnly session cookie rather than a query token. This is an authoring
extension; it does not change the wire envelopes in section 2.2.2.

When configured, the authenticator receives the admitted client node plus a
framework-neutral snapshot containing the request path, normalized headers, and
query parameters. It runs under the same 5000 ms authentication timeout and emits
the same `{ t: "auth", authenticated }` result as token authentication. Its result
takes precedence for the connection: a rejection, timeout, or error MUST fail
closed and MUST NOT fall back to query-token authentication. When the extension is
absent, the token behavior in section 2.2.2 remains unchanged.

Sources: `src/server/transports/ws-shared.ts:17-23,164-197`,
`src/server/transports/websocket-transport.ts:175-185`,
`src/server/transports/bun-ws-transport.ts:140`.

#### 2.2.3 Close codes

TypeFerry does not define custom WebSocket close codes. Standard
RFC 6455 codes apply (1000 normal, 1006 abnormal). Implementations MUST
NOT reuse codes in the RFC reserved range for TypeFerry-specific signals.

### 2.3 Redis pub/sub transport (optional, multi-instance)

Used exclusively for propagating events between TypeFerry server
instances. Clients never see this transport directly.

| Property            | Value                                                        |
|---------------------|--------------------------------------------------------------|
| Redis channel       | `events` (literal — the value of `RedisListeners.EVENTS`)    |
| Subscribe mechanism | `pSubscribe('events', handler)` (pattern subscribe)          |
| Payload encoding    | EJSON-text via `Presentation.encode`                          |

Source: `src/server/transports/redis-transport.ts:54-62,82-91`,
`src/utils/constants.ts:58-62`.

**Payload shape** (after EJSON decode):

```ts
{
  event: string,          // event name
  channel: string,        // channel name; "NO_CHANNEL" when unscoped
  message: string,        // pre-encoded EventMessage JSON (section 5.2.2)
  excludeUuid?: string,   // originator uuid to exclude (optional)
}
```

**Redis keys** (`src/server/transports/redis-transport.ts:96-97,112-118`):

| Key                                   | Type | Purpose                      |
|---------------------------------------|------|------------------------------|
| `typeferry:servers`                     | SET  | active server UUIDs          |
| `typeferry:clients:<server-uuid>`       | SET  | clients per server           |
| `typeferry:users:<server-uuid>`         | SET  | authenticated users per server |

On `close()`, the server MUST delete its `typeferry:clients:<uuid>` key and
`SREM` itself from `typeferry:servers`.

---

## 3. Serialization: Presentation / EJSON

All wire payloads (HTTP bodies, WS frames, Redis messages) are EJSON-text
encoded via the `Presentation` layer.

```ts
Presentation.encode<T>(payload: T): string          // EJSON.stringify
Presentation.decode<T>(payload: string | { data: string }): T   // EJSON.parse
```

Source: `src/utils/presentation.ts:21-31`.

### 3.1 EJSON type extensions

EJSON extends JSON with a set of tagged forms. Any implementation MUST
round-trip every form listed below exactly as the TS implementation does
(`src/ejson/built-in-converters.ts`).

| Native value       | JSON form                                    | Notes |
|--------------------|----------------------------------------------|-------|
| `Date`             | `{"$date": <ms since epoch, integer>}`       | `getTime()` value (`built-in-converters.ts:15-20`) |
| `RegExp`           | `{"$regexp": <source>, "$flags": <flags>}`   | On decode, flags are filtered to `[gimuy]`, deduplicated, capped at 50 chars (`built-in-converters.ts:32-49`) |
| `NaN`              | `{"$InfNaN": 0}`                              | (`built-in-converters.ts:58-71`) |
| `Infinity`         | `{"$InfNaN": 1}`                              | |
| `-Infinity`        | `{"$InfNaN": -1}`                             | |
| `Uint8Array`       | `{"$binary": <base64>}`                       | Standard Base64, MIME alphabet (`built-in-converters.ts:84-89`) |
| Custom typed       | `{"$type": <typeName>, "$value": <toJSONValue result>}` | Requires registration via `EJSON.addType(name, factory)` (`built-in-converters.ts:125-149`) |
| Escape literal     | `{"$escape": <inner>}`                        | Used when a literal object shape matches a tag form, to avoid accidental decode (`built-in-converters.ts:91-122`) |

For tag detection, each converter MUST check **both** that the tag key is
present **and** that the object's key count matches exactly
(`$date` alone → 1 key; `$regexp`+`$flags` → 2 keys; etc.). Implementations
MUST reject decoys whose key counts don't match.

### 3.2 Base64 alphabet

Encoding alphabet (`src/ejson/base64.ts:3-4`):

```
ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
```

Decoder MUST additionally accept URL-safe input (`-` → 62, `_` → 63)
(`src/ejson/base64.ts:17-18`). Inputs whose length is not a multiple of 4
MUST be rejected.

### 3.3 Canonical stable-stringify

EJSON's canonical mode recursively sorts object keys lexicographically
(arrays preserved in order, primitives untouched).

Source: `src/ejson/stable-stringify.ts:1-34`.

This algorithm is normative for any feature that depends on
byte-identical serialization — most importantly the `@Cached` cache-key
algorithm (section 7.3).

### 3.4 Undefined

JSON has no `undefined`. EJSON does not introduce a tag for it.
Implementations MUST either:

- Omit the key entirely (preferred), or
- Replace with `null` at the application boundary.

They MUST NOT invent a new tag form.

---

## 4. `Presentation` payload types

`PayloadType` is an orthogonal enum used inside HTTP/error envelopes
(distinct from WebSocket `MessageType`).

Source: `src/utils/presentation.ts:5-11`.

| Enum member     | String        | Used in                          |
|-----------------|---------------|----------------------------------|
| `METHOD`        | `"method"`    | legacy client framing (reserved) |
| `RESULT`        | `"result"`    | HTTP success envelope             |
| `EVENT`         | `"event"`     | legacy client framing (reserved) |
| `ERROR`         | `"error"`     | HTTP error envelope               |
| `AUTH_RESULT`   | `"auth:result"` | legacy client framing (reserved) |

Only `"result"` and `"error"` are live on the HTTP wire today; the others
are reserved (used in-memory by the client). Implementations MUST
recognize them on decode and MUST NOT emit them on HTTP except as
documented above.

---

## 5. WebSocket message envelopes

All WS frames are text frames carrying EJSON-encoded objects. Every frame
MUST have a `t` discriminator. Source of truth:
`src/utils/protocol.ts:12-141`.

### 5.1 `MessageType` enum

| Constant        | String value | Direction | Section |
|-----------------|--------------|-----------|---------|
| `RPC`           | `"rpc"`      | C → S     | 5.1.1   |
| `RPC_VOID`      | `"rpc:void"` | C → S     | 5.1.2   |
| `RPC_RESPONSE`  | `"rpc:res"`  | S → C     | 5.2.1   |
| `EVENT`         | `"event"`    | S → C     | 5.2.2   |
| `AUTH`          | `"auth"`     | S → C     | 5.2.3   |
| `PING`          | `"ping"`     | S → C     | 5.2.4   |
| `PONG`          | `"pong"`     | C → S     | 5.1.3   |

### 5.1 Client → Server

#### 5.1.1 `rpc` — RPC call

```ts
{
  t: "rpc",
  id: string,           // UUID for response correlation; MUST be unique per call
  method: string,
  params?: unknown,
}
```

The server MUST reply with exactly one `rpc:res` frame whose `id`
matches.

#### 5.1.2 `rpc:void` — fire-and-forget call

```ts
{
  t: "rpc:void",
  method: string,
  params?: unknown,
}
```

The server MUST NOT send any response for this call — not on success,
not on error, not on rate-limit exceeded. Errors are logged and emitted
on the `METHOD_ERROR` server-side event only.
Source: `src/server/transports/ws-shared.ts:60-98`.

#### 5.1.3 `pong` — keep-alive reply

```ts
{ t: "pong" }
```

### 5.2 Server → Client

#### 5.2.1 `rpc:res` — RPC response

Success:

```ts
{ t: "rpc:res", id: string, result: unknown }
```

Error:

```ts
{
  t: "rpc:res",
  id: string,
  error: string,          // from the `Errors` enum or a PublicError message
  errors?: unknown,        // present for SchemaValidationError
}
```

Source: `src/server/transports/ws-shared.ts:100-123,125-154`.

#### 5.2.2 `event` — push event

```ts
{
  t: "event",
  uuid: string,            // per-emission UUID (fresh; NOT the client uuid)
  event: string,
  channel?: string,        // channel the event was emitted on
  params?: unknown,
}
```

Sources: `src/server/event.ts:88-96`,
`src/server/client-node.ts:123-135`.

#### 5.2.3 `auth` — authentication result

```ts
{ t: "auth", authenticated: boolean }
```

Emitted exactly once per connection, after the auth race completes or
times out. Source: `src/server/client-node.ts:155-161`,
`src/server/transports/ws-shared.ts:164-197`.

#### 5.2.4 `ping` — keep-alive probe

```ts
{ t: "ping" }
```

Emitted every 25 000 ms. The pre-encoded payload string
`'{"t":"ping"}'` (the exact `Presentation.encode` output) MAY be reused
across ticks — implementations are NOT required to re-encode per tick.

---

## 6. RPC semantics

### 6.1 Method resolution

Method names are opaque strings. The registered map is keyed by the
literal name passed to `addMethod` / the decorator. The server looks
them up via `server.getMethod(name)` and `server.methods.get(name)`
(`src/server/transports/http-transport.ts:213`,
`src/server/transports/ws-shared.ts:41`).

TypeFerry uses two naming conventions in the current codebase:

- **Default methods** use a colon: `rpc:login`, `rpc:logout`, `rpc:on`,
  `rpc:off`, `list:methods`.
- **User-defined methods** typically use a dot when scoped by
  namespace: `${prefix}.${methodName}` when registered via
  `@Namespace('prefix')`.

Both are just strings on the wire. No separator is reserved or enforced
at the transport layer.

### 6.2 Protected methods

A method may be marked protected via `opts.protected: true`. When the
caller's `ClientNode.authenticated` is false:

- WS: respond with `rpc:res` error `METHOD_FORBIDDEN`
  (`ws-shared.ts:47-49`).
- HTTP: respond with HTTP 200 + error envelope whose `message` is
  `'Method Forbidden'`
  (`http-transport.ts:225-229`, `bun-hono-transport.ts:144-146`).
- Void calls are silently dropped (`ws-shared.ts:78-80`).

### 6.3 Cached methods

When `opts.cache: true` is set, only unauthenticated calls may use the
method-result cache. Every authenticated invocation MUST execute the handler
after the usual validation and middleware. It MUST NOT read or populate cache
entries, including pending results. This rule applies to public and protected
methods and uses the current authentication state on each invocation.

This security correction supersedes the earlier parameter-only caching behavior
for authenticated callers. It preserves wire envelopes and anonymous cache keys.

For an unauthenticated call, `Method` uses `customMemoize`:

```ts
const key = EJSON.stringify(args[0])   // first argument = params
```

If a cached entry exists and `Date.now() - cached.timestamp < maxAge`,
the cached value is returned without invoking the handler.

Anonymous cached handlers MUST be suitable for sharing across anonymous callers.
Applications MUST NOT cache responses that depend on caller-specific request
metadata or authorization performed only inside such a handler.

Source: `typeferry-ts/src/server/method.ts`, `customMemoize`.

**Default `maxAge` is 60 000 ms** (`typeferry-ts/src/server/method.ts`).

Conformance notes:

- Anonymous cache keys MUST be derived from `EJSON.stringify` over the first
  positional argument (the `params` object), not a hash of it. The
  stable-stringify algorithm in section 3.3 is NOT used for cache keys
  in the current TS implementation — `EJSON.stringify` is the default
  (non-canonical) form. Implementations MUST match this exact behavior,
  including key-order non-stability, for cache-hit parity.
- The cache is per-`Method` instance, in-process, unbounded in size,
  and has no eviction except TTL. Multi-instance deployments get
  distinct caches; Redis-based cache sharing is NOT part of this spec.

### 6.4 Schema validation

When `opts.schema` is set (currently a Zod schema in TS), params are
validated via `schema.safeParse(params ?? {})`. On failure,
`SchemaValidationError` is thrown with:

- `message`: `` `Invalid Params: ${issue.path.join('.')}: ${issue.message}` ``
  joined by `, ` across all issues
- `errors`: `string[]` of the same per-issue strings

This propagates to the wire as section 5.2.1 error form with `errors`
populated.

Source: `src/server/method.ts:165-184`, `src/utils/errors.ts:8-16`.

Feature-parity implementations MUST produce identical `errors[]` strings
given the same validation failure (same path delimiter `.`, same
per-issue format `"path: message"`).

### 6.5 Middleware

`opts.middleware: AnyFunction[]` runs in registration order, each taking
and returning the transformed params:

```ts
let buffer = params
for (const step of wrapped) buffer = await step.call(node, buffer)
return buffer
```

Source: `src/server/method.ts:132-147`.

Middleware runs **after** schema validation and **before** the handler.

### 6.6 Execution context

Every method execution is wrapped in `TypeFerryAsyncLocalStorage.run(...)`
with:

```ts
{ executionId: <uuid>, context: node.context }
```

Source: `src/server/method.ts:186-193`,
`src/server/typeferry-async-local-storage.ts`.

Feature-parity implementations MUST expose an equivalent ambient
store (Python `contextvars`, Rust `task_local!`/`tracing`) that survives
nested `await` boundaries inside middleware and handler calls.

### 6.7 Timing emission

On every method execution the server emits a `method:execution`
server-side event:

```ts
{ method, time, params, result }
```

where `time` is `performance.now()` delta in milliseconds. Not on the
wire; observable only to server-side listeners
(`src/server/method.ts:195-202`).

---

## 7. Default methods

### 7.1 `rpc:on`

Params:

```ts
{ events: string[], channel?: string }
```

`channel` defaults to the constant `"NO_CHANNEL"`
(`src/utils/constants.ts:66`). Empty `events` returns `{}`.

For each event name the server:

1. Calls `Server.shouldAllowChannelSubscribe(node, channel)`. If it
   returns false, every event in the batch maps to `false`.
2. Looks up the event. Missing → `false`.
3. If the event is protected and the node is unauthenticated → `false`.
4. Calls `event.shouldSubscribe(node, eventName, channel)`. If false →
   `false`.
5. Joins the room `typeferry:${channel}:${eventName}` via the
   `WebSocketTransport.rooms` registry.

Returns a map `Record<string, boolean>` with per-event success.

Source: `src/server/methods.ts:51-121`.

### 7.2 `rpc:off`

Params: same shape as `rpc:on`.

For each event, leaves the room `typeferry:${channel}:${eventName}`.
Missing event → `false`; everything else → `true`.

Source: `src/server/methods.ts:17-48`.

### 7.3 `rpc:logout`

Params: none.

Clears `node.context`, `node.authenticated`, `node.userId`; emits
`ServerEvents.LOGOUT`; returns `true`.

Marked `protected: true` (`src/server/methods.ts:137`).

### 7.4 `rpc:login`

Registered conditionally. When the application calls
`server.setAuth({ auth, logIn })`
(`src/server/server.ts:256-260`), the `logIn` function is registered
under the literal name `"rpc:login"` (value of `Methods.RPC_LOGIN`,
`src/utils/constants.ts:72`).

It is **not** present in `DefaultMethods`
(`src/server/default-methods.ts:13-19`) — servers without
`setAuth(...)` have no `rpc:login` endpoint at all.

The JS client calls this method during its login flow
(`src/client/client.ts:345`), so feature-parity servers MUST register
under exactly this name when the application opts into auth. The body
of the method is application-defined; the protocol does not constrain
its params or return shape beyond what the JS client accepts.

### 7.5 `list:methods`

**Not auto-registered** as of the current implementation. The constant
`Methods.LIST_METHODS = 'list:methods'` exists in
`src/utils/constants.ts:76` but has no default implementation.
Feature-parity implementations SHOULD register this as a built-in
returning the set of registered method names; the wire contract is
not frozen pending that implementation. Treat `list:methods` as
reserved.

---

## 8. Authentication

### 8.1 Auth function

`Server.auth: (context) => unknown | false` is called per request:

- HTTP: during `requestHandler` / `dispatchRpc`, with `context` equal
  to the request's `context` field plus a `token` field extracted from
  `x-api-key` (Bearer-prefix stripped).
- WebSocket: during `authenticateNode`, with
  `{ token: <query-param token> }`.

If the function returns a truthy value, the node is marked
authenticated and that value becomes `node.context`. Setting
`node.userId` requires the context contain a `user._id` field
(`src/server/client-node.ts:98-113`) — this is a TS-side application
invariant that conformant servers SHOULD match when exposing
user-scoped events.

Sources: `src/server/transports/http-transport.ts:90-106`,
`src/server/transports/bun-hono-transport.ts:223-242`,
`src/server/transports/ws-shared.ts:164-197`.

### 8.2 JWT defaults

When the default session manager is used:

| Property                   | Default value         | Source                                 |
|----------------------------|-----------------------|----------------------------------------|
| Algorithm                  | `HS256`               | `src/auth/server/jwt-utils.ts:17,34`   |
| Access token TTL           | 15 minutes            | `src/auth/server/session-manager.ts:200` |
| Refresh token TTL          | 14 days               | `src/auth/server/session-manager.ts:39`  |
| Rotation grace period      | 15 seconds            | `src/auth/server/session-manager.ts:139` |

Access-token claims used: `userId`, `sessionId`, `iat`, `exp`, optional
`claims` object (`src/auth/types.ts:47-58`).

### 8.3 Cookies

Refresh-token cookie defaults (`src/auth/server/cookie-utils.ts`):

- `HttpOnly`: always set
- `SameSite`: `Lax`
- `Path`: `/`
- `Secure`: `true` iff `NODE_ENV === 'production'`
- `Max-Age`: set from configured TTL in seconds

Conformant servers MUST match these flags byte-for-byte when issuing
the default cookie; differences here silently break the JS client's
refresh flow.

### 8.4 OAuth providers

The current repository ships a Google provider only:

- `src/auth/server/oauth/google.ts` — `GoogleOAuthProvider`.
- Exported via `src/auth/server/oauth/index.ts`.

Feature-parity implementations MUST ship an equivalent Google provider.
Additional providers are a non-goal until the TS side adds them.

### 8.5 Session lifecycle

The TS `SessionManager` handles creation, rotation, revocation, and
family tracking. Sessions have:

- `id` (UUID)
- `userId`
- `familyId` (for rotation lineage)
- `token` (refresh token value)
- `expiration` (Unix seconds)
- `deviceInfo?`
- `isRevoked?`
- `replacedBy?` (next token after rotation)
- `usedAt?` (ms timestamp of last rotation)

Source: `src/auth/types.ts:22-41`.

---

## 9. Error codes

All error messages are plain strings from the `Errors` enum
(`src/utils/errors.ts:18-36`). They MUST be used verbatim on the wire:

| Constant                    | String                    |
|-----------------------------|---------------------------|
| `AUTHENTICATION_FAILED`     | `"Authentication Failed"` |
| `EVENT_FORBIDDEN`           | `"Event Forbidden"`       |
| `EVENT_NOT_FOUND`           | `"Event Not Found"`       |
| `EVENT_NOT_PROVIDED`        | `"Event Not Provided"`    |
| `EVENT_NOT_SUBSCRIBED`      | `"Event Not Subscribed"`  |
| `INTERNAL_ERROR`            | `"Internal Error"`        |
| `INVALID_METHOD_NAME`       | `"Invalid Method Name"`   |
| `INVALID_PARAMS`            | `"Invalid Params"`        |
| `INVALID_REQUEST`           | `"Invalid Request"`       |
| `INVALID_TOKEN`             | `"Invalid Token"`         |
| `METHOD_FORBIDDEN`          | `"Method Forbidden"`      |
| `METHOD_NOT_FOUND`          | `"Method Not Found"`      |
| `METHOD_NOT_SPECIFIED`      | `"Method Not Specified"`  |
| `PARAMS_NOT_FOUND`          | `"Params Not Found"`      |
| `PARSE_ERROR`               | `"Parse Error"`           |
| `SUBSCRIPTION_ERROR`        | `"Subscription Error"`    |
| `RATE_LIMIT_EXCEEDED`       | `"Rate Limit Exceeded"`   |

`PublicError` messages pass through verbatim. All other exceptions are
reported to the client as `INTERNAL_ERROR` and logged server-side
(`src/server/transports/ws-shared.ts:125-154`,
`src/server/transports/http-transport.ts:128-154`).

`SchemaValidationError` passes its `message` and populates the
`errors` field as described in section 6.4.

---

## 10. Events, channels, and rooms

### 10.1 Room name format

`typeferry:${channel}:${eventName}` (`src/server/methods.ts:13-15`).

- `channel` defaults to the literal string `"NO_CHANNEL"` when the
  caller omits it (`src/utils/constants.ts:66`).
- No escaping is applied to channel or event names. Applications that
  use user-controlled channel values MUST sanitize them.

### 10.2 Event options

Source: `src/server/event.ts:6-36,64-81`.

| Option              | Effect                                                                 |
|---------------------|------------------------------------------------------------------------|
| `protected`         | Requires `client.authenticated` to subscribe                           |
| `user`              | Implies `protected: true`; `shouldSubscribe` forces `channel === client.userId` |
| `shouldSubscribe`   | Overrides `user`; async predicate gating subscription                  |
| `cluster`           | Propagates via Redis pub/sub (section 2.3)                             |
| `excludeOriginator` | When true, uses `params.uuid` to identify and exclude the emitter      |

The TypeScript server additionally supports the opt-in authoring option
`revalidateOnDelivery` (default false). It repeats current authentication,
channel authorization and `shouldSubscribe` checks on the receiving instance
before each delivery, including Redis fanout. False results or predicate errors
remove only that event/channel membership. This optional server capability does
not change the wire envelope, subscription acknowledgements, cross-language
defaults or conformance requirements. See the
[TypeScript event guide](docs/typescript/events-and-channels.md#recheck-access-before-delivery)
for asynchronous ordering and revocation limits.

### 10.3 Emission

`Event.handler(channel, params)` encodes:

```ts
{ t: "event", uuid: <fresh>, event: <name>, channel: <channelName>, params }
```

with `Presentation.encode`. If `cluster === true` and Redis is
available, publishes to Redis (section 2.3); otherwise propagates
locally via `channel.propagate(event, payload, excludeUuid)`.

Source: `src/server/event.ts:84-108`.

### 10.4 Originator exclusion

When `excludeOriginator === true`, the server extracts
`params.uuid` and omits any subscribed socket whose uuid matches. The
value is passed as `excludeUuid` through both the local propagation
path and the Redis message.

Conformant servers MUST exclude based on the TypeFerry client uuid
(`ClientNode.uuid`), not the WebSocket peer address or any other
identifier.

---

## 11. Authoring surface (feature-parity only)

Protocol-conformant servers MAY ignore this section. Feature-parity
servers MUST implement equivalents.

### 11.1 Decorators

Sources: `src/server/decorators/*`.

| Decorator                | Kind              | Effect                                                     |
|--------------------------|-------------------|------------------------------------------------------------|
| `@Namespace(prefix)`     | class             | Registers the class; methods are registered as `prefix.methodName`; flushes pending method-level metadata |
| `@Method(name?)`         | method            | Marks method as RPC endpoint; optional wire-name override  |
| `@Protected()`           | class or method   | Sets `protected: true`; method-level overrides class-level |
| `@Public()`              | method            | Overrides class-level `@Protected`                         |
| `@Cached(maxAge?)`       | class or method   | Enables memoization; default 60 000 ms                     |
| `@NoCache()`             | method            | Opts a method out of class-level `@Cached`                 |
| `@Schema(schema)`        | method            | Attaches validation schema                                 |

The metadata model (`src/server/decorators/metadata.ts`) MUST be
reproducible: decorator application MUST produce the same final
`MethodOptions` for equivalent source, regardless of language.

### 11.2 Registration

`register(server, cls)` (`src/server/decorators/register.ts`) walks
declared metadata and calls `server.addMethod` equivalents.
Implementations SHOULD also expose an imperative
`server.addMethod(name, fn, opts)` for callers who do not want
decorators.

### 11.3 Cache-key canonicalization

The TS `customMemoize` (`src/server/method.ts:67-87`) uses
`EJSON.stringify(args[0])` as the cache key. This is **not** canonical
— object key order matches insertion order. Implementations MUST
reproduce this behavior exactly to hit the same keys given the same
inputs. Canonical stable-stringify (section 3.3) is used by EJSON when
`canonical: true` is requested but is NOT used by `@Cached` today.

If a future revision of this spec opts `@Cached` into canonical mode,
this section will be updated and a `PROTOCOL.md` version bump will
follow.

### 11.4 Optional MongoDB live-view extension

`typeferry/mongodb` MAY register a TypeScript-only live-view
extension. It reuses revision-1 `rpc`, `rpc:res`, and `event` envelopes and
does not add a message type, so servers without this optional capability
remain protocol-conformant.

Reserved methods and event:

- `mongo:live:subscribe`
- `mongo:live:resync`
- `mongo:live:unsubscribe`
- `mongo:live:delta`

All three methods are WebSocket-only. Clients MUST call them with HTTP fallback
disabled. The server MUST reject calls from a transient HTTP node and MUST bind
each subscription identifier to the calling WebSocket connection.

Subscribe params:

```ts
{
  subscriptionId: string, // 1–64 chars, [a-zA-Z0-9-]
  publication: string,    // registered server-owned publication
  args: unknown,          // validated by that publication
  capabilities?: string[], // understood optional wire extensions
}
```

Subscribe and resync return a complete snapshot:

```ts
{
  subscriptionId: string,
  generation: string,
  sequence: number,
  ordered?: boolean, // true when array position is authoritative
  documents: Array<{
    _id: string | number | { $objectId: string },
    ...fields
  }>,
}
```

The server sends deltas directly to the owning node using the existing event
envelope with `event: "mongo:live:delta"` and `channel: "NO_CHANNEL"`:

```ts
{
  type: "delta",
  subscriptionId: string,
  generation: string,
  sequence: number,
  operations: Array<
    | { type: "added", document: object }
    | { type: "changed", document: object }
    | {
        type: "removed",
        id: string | number | { $objectId: string }
      }
    | {
        type: "window-splice",
        index: number,
        deleteCount: number,
        documents: object[]
      }
  >,
}
```

`sequence` MUST increase by one for every delivered delta in a generation.
Clients MUST ignore already-applied sequences and request a complete resync
after a gap or generation mismatch. Source discontinuity or transport pressure
uses this control payload:

```ts
{
  type: "resync-required",
  subscriptionId: string,
  staleGeneration: string,
}
```

Resync params are `{ subscriptionId, staleGeneration }`; unsubscribe params
are `{ subscriptionId }`. Logout, disconnect, replacement, and MongoDB
registry shutdown MUST release connection-owned observers.

Publications are protected by default and MAY explicitly permit
unauthenticated access. Clients never provide MongoDB collection names,
selectors, projections, sorts, or pipelines.

A publication MAY define a server-owned ordered window with stable `sort`,
bounded `skip`, and required `limit`. Ordered snapshots set `ordered: true`.
The client MUST advertise `"ordered-window-splice-v1"` in `capabilities`; the
server MUST reject ordered allocation when it is absent. Current clients also
advertise `"typed-object-id-v1"` so ObjectIds materialize as
`{ $objectId: string }`. Without that capability, unordered publications retain
the legacy bare-hex string representation; ordered allocation requires both
capabilities.
The server appends `_id: 1` to the application sort as its unique final
tie-breaker. `window-splice` atomically replaces
`documents[index:index + deleteCount]`; invalid indices or duplicate resulting
identities MUST trigger complete resynchronization. Joins and aggregation
windows are not part of this extension.

---

## 12. Constants reference

| Name                   | Value                       | Source                         |
|------------------------|-----------------------------|--------------------------------|
| HTTP endpoint          | `POST /__h`                 | `http-transport.ts:68`         |
| WS path                | `/typeferry-ws`               | `constants.ts:64`              |
| WS UUID max length     | 64                          | `ws-shared.ts:18`              |
| WS meta max size (B)   | 10 000                      | `ws-shared.ts:19`              |
| Ping interval (ms)     | 25 000                      | `ws-shared.ts:20`              |
| Auth timeout (ms)      | 5 000                       | `ws-shared.ts:17`              |
| Default cache TTL (ms) | 60 000                      | `method.ts:72,116`             |
| Access token TTL       | 15 min                      | `session-manager.ts:200`       |
| Refresh token TTL      | 14 days                     | `session-manager.ts:39`        |
| Rotation grace (s)     | 15                          | `session-manager.ts:139`       |
| HTTP RL default        | 120 req / 60 s              | `http-transport.ts:53`, `bun-hono-transport.ts:85` |
| JWT default algorithm  | `HS256`                     | `jwt-utils.ts:17,34`           |
| Cookie SameSite        | `Lax`                       | `cookie-utils.ts`              |
| No-channel constant    | `"NO_CHANNEL"`              | `constants.ts:66`              |
| Client-id header       | `x-client-id`               | `constants.ts:68`              |
| Token header           | `x-api-key`                 | `constants.ts:69`              |
| Redis channel          | `"events"`                  | `constants.ts:60`, `redis-transport.ts:54,83` |
| Base64 alphabet        | `A-Z` `a-z` `0-9` `+` `/`   | `base64.ts:3-4`                |

---

## 13. Conformance testing

Fixtures live in `docs/conformance/fixtures/` (added by the Python and
Rust plans). Every fixture is versioned with this document. The
following MUST be covered:

- `http/*` — happy path, `METHOD_NOT_FOUND`, `METHOD_FORBIDDEN`,
  `INVALID_REQUEST`, `Invalid Params` with `errors[]`, `x-api-key`
  token handling (with and without `Bearer ` prefix), `x-client-id`
  echo, cookie round-trip, void suppression, rate-limit headers.
- `ws/*` — connect + auth success, connect + auth timeout, connect
  without token (authenticated=false), `rpc` success/error, `rpc:void`
  silence, `rpc:on` + `rpc:off` round-trip, `event` delivery,
  originator exclusion, ping/pong liveness, close handling.
- `ejson/*` — round-trip fixtures for every tag form in section 3.1
  (Date, RegExp, Inf/NaN, Binary, custom, escape); stable-stringify
  output on nested shapes; cache-key fixtures that prove the
  non-canonical form is used.
- `redis/*` — published payload shape, originator-exclusion
  propagation, key-lifecycle on server registration and close.

A new implementation is conformant iff every fixture passes against it
using only the public JS client or raw HTTP/WS bytes.

---

## 14. Versioning

This document is revision **2**. The TS implementation is the source of
truth; spec revisions follow source changes. Any change to:

- wire envelope shapes
- enum string values
- serialization algorithms
- cache-key algorithm
- default methods set
- cookie or JWT defaults

…requires a spec revision and a corresponding conformance-fixture
update in the same commit as the TS change. Alternate implementations
MUST declare which revision they implement.

# TypeFerry Go

The Go server has an approved public API and passes local and remote parity
checks. It has no release tag. `ejson` implements ordered
TypeFerry values, `runtime` handles typed methods and local events, and
`httptransport` and `websocket` mount `POST /__h` and `/typeferry-ws` on an
application-owned `net/http` server. `redistransport` propagates cluster events
through an optional Redis connection. `auth` provides signed access tokens,
rotating in-memory refresh sessions, cookies, device metadata, and Google code
exchange with RS256 ID-token verification. The Redis adapter also maintains
server, client, and user presence sets and exposes aggregate stats.
`authoring.Group` declares namespaced method metadata without reflection.

`examples/server` mounts both transports on an application-owned `net/http`
server, registers a typed method, and closes upgraded WebSocket connections
before shutting down the HTTP host. From `typeferry-go/`, run:

```sh
go run ./examples/server
```

Set the permitted browser origin and host address for your application. The
example binds only to loopback; the library does not open a listener itself.

```go
codec := ejson.NewCodec()
payload := ejson.Object(ejson.Field{Key: "message", Value: ejson.String("hello")})
encoded, err := codec.Stringify(payload, false)
```

Object encoding follows JavaScript property order: array-index keys come first
in numeric order, followed by other keys in insertion order. Pass `true` to
`Stringify` to sort non-index keys by UTF-16 code units. The rule applies
recursively; method-cache keys use ordinary encoding.

Both HTTP and WebSocket `Options.Origins` allow any origin when nil. A non-nil
empty slice denies every named origin. Configured allowlists reject missing
origins unless that handler sets `AllowOriginless: true`. The HTTP and WebSocket
flags are independent, and neither flag admits a mismatching named origin.
Origin rejection precedes authentication, body decoding, and quota consumption.
Enabled HTTP limiters attach `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset` to every admitted response. Reset rounds the remaining window
up to whole seconds; disabled limiters omit those headers.

Authentication follows JavaScript truthiness. Null, false, numeric zero, NaN,
and empty strings reject authentication; empty objects and arrays accept it.
WebSocket metadata is a JSON object, not EJSON: tag-shaped objects stay literal.
The raw metadata input must fit within 10,000 UTF-8 bytes. Invalid metadata
becomes an empty object. Invalid client UUIDs receive fresh identifiers rather
than reusing a sanitized fragment.

Custom types must be registered on a `Codec` before parsing their tag.
`Value.NumberText()` retains the spelling of parsed finite numbers for
application coercion, including integer literals larger than `int64`.
`Value.Number()` still returns a `float64` approximation; ordinary and canonical
wire encoding and method-cache keys retain their existing normalization.
The HTTP and WebSocket adapters pass their shared fixtures and call through
the unchanged TypeScript client. Call `Close` on the WebSocket handler during
shutdown because `net/http.Server.Shutdown` does not own upgraded sockets.
The handler stops admission, cancels connection contexts and joins active RPCs, handshake
callbacks, readers and heartbeat work. Every concurrent closer joins that same
retirement. Methods run concurrently; RPC IDs correlate their completion order.
Frame parsing and rate admission remain in read order. Callbacks must observe
their context and return, and must not call the owning handler's `Close` from
inside their own work. Application admission limits still belong to the host.
Panics become internal failures without exposing their values; cached handler
panics complete the shared result instead of retaining an unfinished entry.
Runtime `Server.Close` stops new calls, authentication, registrations and event
publication, clears client rooms/presence and closes current sockets. Concurrent
closers join the same result; late clients are closed and late subscription
checks cannot restore retired rooms. `runtime.ErrClosed` identifies rejected
work. Already admitted callbacks belong to their transport/caller lifetime:
close and join those owners before releasing application resources. A socket
close callback must not recursively close its owning runtime.
Cluster events use the shared `events` pub/sub envelope. `redistransport.Connect`
waits for subscription readiness; close the returned client on shutdown.

Run `go test ./...`, `go test -race ./...`, and `go vet ./...` in this
directory. See [the parity specification](../specs/2026-09-29-go-server-parity.md)
for the remaining work and acceptance gates.

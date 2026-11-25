# Ruby server runtime

Status: superseded by [the Ruby server retirement](../specs/2026-11-25-ruby-server-retirement.md)

## Context

SolidScript needs a Ruby application server while retaining TypeFerry revision
1 interoperability with the existing TypeScript client. The repository already
has TypeScript, Python, and Rust servers, shared fixtures, and a normative wire
protocol.

## Decision

Maintain `typeferry-rb` as a first-party Ruby server implementation. Its core is
framework-neutral Ruby with explicit Rack HTTP, Puma WebSocket, Redis, JWT, and
Google OAuth entry points. Public contracts use RBS and Steep.

Puma 7 over Rack hijacking is the certified WebSocket host. Redis uses separate
publisher and subscriber connections. The in-memory session manager provides a
thread-safe reference implementation; clustered applications provide shared
session persistence behind the same interface.

TypeScript-to-Ruby interoperability runs through a real Puma process. Protocol
revision 1 and the shared fixtures remain unchanged. The temporary
`typeferry-rb` gem identity is not published; consumers pin a Git revision.

## Rejected alternatives

- Extending the Rust server for Ruby application concerns keeps the server
  lifecycle and application code split across languages.
- Requiring every optional adapter from the core entry point increases startup,
  dependency, and security surface for users who do not need those features.
- Publishing immediately would establish registry identity and compatibility
  promises before a separate release review.

## Consequences

Ruby applications can own their server layer without changing TypeFerry's wire
contract or geometry/engine implementation choices downstream. Puma HTTP/1.1 is
the supported realtime deployment today; another adapter needs its own tests
before claiming HTTP/2 or fiber-native support. Ruby changes now participate in
shared conformance review and dedicated CI.

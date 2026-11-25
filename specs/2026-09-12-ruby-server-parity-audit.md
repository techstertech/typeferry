# Ruby Server Parity Audit

Status: complete

This audit records the server before [its retirement](2026-11-25-ruby-server-retirement.md).

## Problem

SolidScript Studio may replace its Rust HTTP server with a Ruby server while
keeping the Rust modeling engine behind the native Ruby adapter. TypeFerry Ruby
must therefore provide a trustworthy application-server boundary, not only
fixture-level wire compatibility.

## Evidence

The Ruby package already implements core RPC, Rack HTTP, Puma WebSockets,
events and rooms, Redis propagation, JWT and session helpers, Google OAuth,
RBS signatures, shared conformance tests, and package verification.

`mise exec -- bundle exec rake verify` passes with 77 tests and 161 assertions;
three real-service tests are skipped when their external services are absent.

Current parity matrix:

| Surface | Ruby vs protocol/Rust | SolidScript relevance |
|---|---|---|
| EJSON and envelopes | Covered by shared fixtures | Required |
| Methods, schemas, middleware, cache | Implemented | Required |
| HTTP RPC | Implemented; request boundary gaps below | Required |
| WebSocket RPC and heartbeat | Implemented through Puma/Rack hijack | Required |
| Events, rooms, protected subscriptions | Implemented | Required |
| Redis propagation | Implemented; optional for one process | Later scale-out |
| JWT, cookies, sessions | Implemented | Useful, but Studio policy stays application-owned |
| Request metadata | Ruby lacks Rust's headers, remote address, and user agent on `ClientNode` | Required for Studio auth/cookies/audit |
| Configured HTTP origins | Option exists but is not enforced | Required security boundary |
| HTTP default rate limit | Ruby uses 100; protocol requires 120 | Required conformance |
| Server channel facade | Rust has `ServerChannel`; Ruby uses direct events | Ergonomic gap, not a cutover blocker |
| Duplicate WebSocket UUID replacement | Rust replaces the prior socket; Ruby stores both nodes | Needed before cutover |
| Async handler/cancellation lifecycle | Rust is async; Ruby handlers are synchronous threads | Needs load and cancellation design |
| Static Studio assets and non-RPC routes | Application-owned in both designs | Must be built in SolidScript Ruby server |
| PostgreSQL migrations and persistence | Application-owned | Major later migration unit |
| Ruby worker supervision/native engine isolation | Not owned by TypeFerry | Major later migration unit |

## First compatibility unit

Make the Ruby Rack HTTP boundary match the existing protocol and Rust node
metadata shape:

- reject a present disallowed `Origin` with status 403 when origins are configured;
- allow requests with no `Origin`, matching the WebSocket adapter and non-browser clients;
- use the protocol default of 120 requests per 60 seconds;
- expose immutable normalized request headers, remote address, and user agent on `ClientNode`;
- preserve existing `x-client-id`, `x-api-key`, auth context, and response-header behavior;
- update RBS, focused tests, architecture notes, and README examples.

This is additive except for enforcing an already-declared origin policy and
correcting the documented rate-limit default. It does not change the wire
protocol or SolidScript production architecture.

## Risks and recovery

Incorrect header normalization could hide repeated headers or expose mutable
Rack state. Store a new frozen string map rather than the Rack environment.

Origin enforcement can reject a browser deployment with incomplete
configuration. It is opt-in: `origins: nil` remains unrestricted, and requests
without `Origin` remain valid.

Rollback is one TypeFerry commit; SolidScript continues using its Rust server.

## Executable checklist

- [x] Add failing Rack HTTP tests for origin handling, metadata, and defaults.
- [x] Implement the request-boundary contract.
- [x] Update RBS and Ruby architecture/user documentation.
- [x] Run the focused Ruby unit and conformance tests.
- [x] Run `mise exec -- bundle exec rake verify`.
- [x] Commit only the audit and first compatibility unit.

Final verification used the repository Redis harness and completed 81 tests
with 303 assertions, no failures, errors, or skips. Steep, Standard Ruby, gem
build, and package-content verification also passed.

## Later migration gates

Before a SolidScript cutover, close duplicate-client semantics, define Ruby
request cancellation and native-engine supervision, implement application
routes/persistence/static serving, and run the TypeScript client plus
SolidScript black-box HTTP/WebSocket suites against the Ruby server.

## Consumer gate evidence from 2026-09-13

The Ruby server passed the shared HTTP, WebSocket, authentication, origin,
duplicate-client, metadata, limit, event, malformed-input, and lifecycle
fixtures used by SolidScript Studio. The TypeScript client passed its
interoperability suite against Ruby without a client compatibility branch.
SolidScript owned its downstream `studio.*` application-contract suite.

TypeFerry ran these commands at the verified revision.

```sh
(cd typeferry-rb && bundle exec rake test:conformance)
(cd typeferry-ts && npm run test:interop:ruby)
```

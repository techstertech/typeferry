---
status: shipped
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-09-29
updated: 2026-09-30
owner: server runtimes
decision:
supersedes:
superseded-by:
implementation:
  commits:
    - 5391560
    - 17288f4
    - 535c134
    - e9cca82
    - f15ef00
    - 33e965d
    - ace93fa
    - af8912b
    - 83581ae
    - 1375551
    - 212a851
    - 3875145
    - 6958afd
    - 353e6d8
    - 6d1965a
    - ecf4d6a
    - 32480dd
  pull-request:
---

# Go server parity

The comparison set below reflects the original parity review.
See the [Ruby server retirement](2026-11-25-ruby-server-retirement.md) for current support.

## Outcome

Add a first-class Go server implementation of TypeFerry. A TypeScript client
must observe the same protocol behavior against Go as against the maintained
TypeScript, Python, Rust, and Ruby servers. Go applications receive typed,
idiomatic method, event, authentication, and transport APIs. The initial
consumer is [SolidScript Studio](../../solidscript/specs/2026-09-29-go-studio-backend.md),
but the library must contain no SolidScript policy or test-path dependency.

## Current evidence and authority

- `PROTOCOL.md` specifies HTTP, WebSocket, Redis, EJSON, RPC, auth, events, and
  authoring semantics. `docs/conformance/fixtures/` supplies executable wire
  cases. `typeferry-ts/src/test/conformance/` runs real client/server checks.
- `typeferry-rb/lib/typeferry/`, `typeferry-py/src/typeferry/`, and
  `typeferry-rs/crates/` show the maintained server feature set. The initial
  inventory preceded the Go package and conformance server; both now exist
  under `typeferry-go/`.
- Root `AGENTS.md` makes `PROTOCOL.md` authoritative. The former conflicting
  fixture-precedence sentence in `docs/conformance/README.md` was reconciled
  in the first implementation unit. Any future discrepancy still requires
  comparison with the TypeScript reference before changing behavior.
- The existing Ruby server plan excludes the optional TypeScript-only MongoDB
  live-view extension. That extension is outside the shared server-parity
  contract here; adding it later needs its own contract and tests.

## Protocol-to-test matrix

All gates in the matrix below are closed: public API/dependency approval was
granted on 2026-09-30 and upstream CI run 36806767551 passes. The original gate
column is retained as the review checklist; final acceptance is recorded below.

This maps maintained protocol sections to executable Go evidence. "Focused"
means the behavior has a direct test but the complete cross-language feature
surface has not run against the TypeScript client in CI.

| Protocol section | Go implementation and test evidence | Original acceptance gate (now passed) |
|---|---|---|
| 2.1 HTTP envelope, headers, origins, limits | `httptransport/http_test.go` shared fixtures and boundary tests; TypeScript `cross-lang-go-http.integration.spec.ts` | Upstream CI |
| 2.2 WebSocket query, handshake, lifecycle, heartbeat | `websocket/fixtures_test.go`, `handler_test.go`, `handler_lifecycle_test.go`, frame fuzz; TypeScript `cross-lang-go-ws.integration.spec.ts` | Upstream CI |
| 2.3 Redis events | `redistransport/fixtures_test.go` and disposable two-server `client_integration_test.go` | Upstream Redis CI |
| 3–4 EJSON and Presentation values | `ejson/ejson_test.go`, shared fixtures, bounded fuzz | Upstream CI |
| 5 message envelopes and void RPC | WebSocket shared fixtures and real TypeScript calls | Upstream CI |
| 6 methods, protection, cache, validation, middleware, telemetry | `runtime/server_test.go` including concurrent cached calls | Public API review and CI |
| 7 default methods | `runtime/events_test.go` covers subscriptions and `rpc:off`; `runtime/server_test.go` covers protected logout and conditional login; TypeScript Go WebSocket interop calls both. `list:methods` remains reserved by the protocol. | Upstream CI |
| 8 JWT, cookies, OAuth, session lifecycle | `auth/auth_test.go`, `cookies_test.go`, `device_test.go`, `google_test.go` | Public API review and CI |
| 9 public versus internal errors | HTTP and WebSocket shared fixtures, runtime validation tests | Upstream CI |
| 10 rooms, channels, event exclusion | `runtime/events_test.go` and Redis cross-instance test | Upstream CI |
| 11 typed authoring and cache keys | `authoring/group_test.go`, `runtime/server_test.go` | Public API review |

The real TypeScript matrix now covers values, validation/middleware, caching,
public/internal errors, protected and user subscriptions, originator exclusion,
disconnect cleanup and reconnect. Upstream CI and public API/dependency review
have passed. Approval was granted on 2026-09-30. The optional MongoDB live-view extension
is outside the agreed shared server scope.

## Scope and contracts

Go support covers the maintained server-side feature union, including:

- Lossless Presentation/EJSON values, custom types, canonical serialization,
  exact tags and errors, including binary, dates, regex, non-finite values,
  escaping, and cache-key canonicalization.
- HTTP `POST /__h` and WebSocket `/typeferry-ws` envelopes, headers, origin
  policy, token extraction, limits, default methods, method protection,
  middleware, schema validation, cached methods, connection replacement,
  ping/pong, room/channel/user events, and lifecycle cleanup.
- Optional Redis propagation; JWT, cookies, sessions and rotation, device
  metadata, Google OAuth building blocks, and application-owned handshake
  authentication with fail-closed precedence.
- Typed imperative authoring for methods/events and a Go-native declaration
  helper that resolves to the same metadata and runtime path. No macros or
  runtime reflection are required for parity.

The browser client, protocol version, wire paths, error strings, defaults, and
shared fixture formats stay unchanged. A Go client, React adapter, MongoDB
extension, additional OAuth provider, and registry publication are outside
this plan. Decide the public Go import path and API signatures during the
first implementation unit and obtain the required explicit API approval before
merging them; this spec authorizes the scope, not an unreviewed API shape.

## Design boundary

```text
PROTOCOL.md + shared fixtures
             |
       typeferry-go
  EJSON + protocol values
             |
  runtime (methods, context, events, rooms)
       /       |        \
  HTTP/WS    Redis     auth
       \       |        /
      application-owned net/http host
```

Use one `typeferry-go/` module with focused packages and a small facade.
Foundational packages must not import HTTP, WebSocket, Redis, OAuth, or an
application. Adapters implement the public wire surface and attach to an
application-owned `net/http` server; constructing the runtime must not bind a
port. Optional integrations must not be required by core imports. Contexts,
deadlines, shutdown, response headers, and errors cross explicit typed
boundaries. Do not copy a language-specific DSL or make fixtures into special
cases.

Go's [`net/http` server shutdown](https://pkg.go.dev/net/http#Server.Shutdown)
does not wait for upgraded WebSocket connections, so the WebSocket adapter
must own and close its connections explicitly. Database or application
persistence is not a TypeFerry core responsibility. Choose and pin transport
and auth dependencies only during implementation, after API review and
security/version checks.

## Test strategy, designed before implementation

1. Make a Go fixture harness that reads the shared EJSON, HTTP, WebSocket,
   and Redis cases directly. Start with a failing fixture in each category.
   Resolve prose/fixture conflicts against existing implementations, then
   correct the shared authority without changing wire behavior.
2. Add focused tests for Go-specific value ownership, typed registration,
   concurrent clients, reconnect replacement, ordered event delivery, rate
   limits, cancellation, shutdown, validation errors, and auth failure paths.
   Use generated values and local mock OAuth/Redis services where practical.
3. Add a Go conformance server to the existing TypeScript cross-language
   harness. Exercise real HTTP and WebSocket calls, authentication, events,
   reconnect, and error paths with the unchanged TypeScript client.
4. Run the Go race detector and bounded fuzz/property checks for EJSON,
   malformed frames, parser limits, and concurrent lifecycle behavior.
5. Add Go CI for formatting, vet/static checks, race-aware tests, fixtures,
   Redis integration, cross-language tests, and a consumer build. CI must run
   only tests tracked by this repository.

The baseline is the current TypeScript client and existing server behavior.
No claim of parity follows from fixture tests alone: real transport and
feature tests must cover behavior the frozen fixtures do not express.

## Execution units and gates

1. **Contract inventory.** Reconcile protocol/fixture authority; create a
   clause-to-test parity matrix covering the maintained server union. Record
   any actual discrepancies before selecting a Go behavior.
2. **Module and values.** Approve the public Go API/import path. Add module,
   EJSON, protocol values, exact serialization, and focused fixture tests.
3. **Runtime.** Add typed methods, context, middleware, schema, caching,
   default methods, events, rooms, user indexing, and lifecycle tests.
4. **Transports.** Add HTTP and WebSocket adapters and real TypeScript-client
   interoperability. Prove origin limits, void semantics, headers/cookies,
   reconnect, backpressure, and shutdown.
5. **Integrations.** Add optional Redis, auth/session/device/OAuth helpers,
   offline integration tests, and relevant fixture coverage.
6. **Release readiness.** Add examples, architecture and agent guidance, CI,
   package inspection, and a revision-pinned consumer path. Keep publication
   disabled until a separate release decision.

Each unit adds its tests before or alongside behavior and lands as a focused
semantic commit. The Go conformance and client-interoperability gates must be
green before SolidScript replaces its TypeFerry Ruby host.

## Acceptance criteria and verification

| Observable criterion | Planned evidence |
|---|---|
| The unchanged TypeScript client can call, authenticate, subscribe, reconnect, and receive errors from a Go server. | Real cross-language HTTP/WebSocket suite. |
| Go reproduces every applicable shared EJSON, HTTP, WebSocket, and Redis fixture without fixture-name branches. | Go fixture harness and independent TypeScript interop. |
| Maintained server features have Go behavior and typed public entry points. | Clause-to-test parity matrix plus feature/unit/integration suites. |
| Invalid origins, credentials, schemas, frames, and oversized input fail closed. | Focused negative transport/auth tests and fuzz runs. |
| Concurrent clients and server shutdown do not leak or race. | Go race detector, lifecycle tests, and bounded shutdown test. |
| Core imports do not require optional adapters, and package use is documented. | Minimal consumer build and module/package inspection. |

## Risks and recovery

EJSON ordering, WebSocket shutdown, session rotation, and Redis fanout can
appear correct in unit tests while diverging over the wire. Keep the TypeScript
client as the interoperability oracle. If parity is incomplete, leave the Go
package unpublished and keep SolidScript on its current TypeFerry revision.
An implementation-only revert does not require a protocol or data migration.

## Verification results

This initial implementation checkpoint records the gaps at that time. Later
sections and final upstream acceptance below close the listed review/CI gates.

| Contract area | Go evidence | Remaining gate |
|---|---|---|
| EJSON, custom tags, canonical output | 15 shared fixtures, focused codec tests, bounded fuzz/property run | Final full-suite CI |
| HTTP method/auth/error transport | Nine shared fixtures, TypeScript `ClientHttp` calls | Final full-suite CI |
| WebSocket RPC, auth, events, lifecycle | Nine shared fixtures, real TypeScript calls and reconnect, origin/timeout/rate/shutdown tests | Full-suite CI |
| Method metadata, validation, cache, middleware | Runtime and `authoring.Group` tests, including concurrent cache sharing | Final API review |
| Redis cluster fanout and presence | Three shared envelopes, disposable two-server Redis integration | Full-suite CI |
| JWT, sessions, cookies, device, Google OAuth | Focused token/replay and offline Google validation tests | Final API review |

These are implementation checks; none constitutes SolidScript acceptance.

The Go EJSON unit passes all 15 shared fixtures and focused canonical, invalid
tag, and regex tests. The Go HTTP adapter passes all nine shared HTTP fixtures
and two real TypeScript `ClientHttp` interoperability checks. The WebSocket
adapter passes all nine shared frame fixtures, an actual HTTP upgrade and origin
gate, and two unchanged TypeScript client checks for RPC, authentication, and
event delivery. The Redis adapter passes all three shared envelope fixtures
and a two-server delivery test against a disposable Redis 7.4 container.
`go test ./...`, `go test -race ./...`, and `go vet ./...` passed from
`typeferry-go/`. Access-token signing/verification, rotating refresh sessions,
cookies, and device metadata have focused Go checks. Google code exchange and
RS256 ID-token validation pass an offline endpoint/key test, with invalid
audience, issuer, expiry, and signature cases. The implementation follows
[Google's OIDC validation requirements](https://developers.google.com/identity/openid-connect/openid-connect).
Redis server/client/user presence and aggregate stats pass a disposable
Redis cross-instance test under the Go race detector. Full TypeScript-client
lifecycle and complete feature-parity criteria remain unverified. CI has not
run yet.
Bounded Go fuzz runs completed 25,835 EJSON cases and 73,634 WebSocket frame
cases without a panic or round-trip mismatch.
The application-owned `net/http` example compiles under `go test ./...` and
`go test -race ./...`; `go vet ./...` passed. Public API review, a tagged Go
module revision, and upstream CI remain outstanding.
The focused default-method gap is closed locally: a Go runtime test confirms
that logout is protected and clears client identity, login appears only after
`SetAuth`, and reserved `list:methods` stays absent. A real TypeScript client
then called login and logout over the Go WebSocket server and observed protected
access disappear. The four-case cross-language WebSocket file passed.

### Concurrent WebSocket work and joined retirement (2026-09-30)

The actual Go WebSocket adapter ran `Dispatcher.Receive` serially inside its read
loop. A long method therefore prevented a following RPC cancellation/release
and heartbeat response. Closing an upgraded descriptor did not cancel the
request context or join method/authentication work. These gaps were measured
before implementation by failing actual-socket tests. The TypeScript reference
invokes asynchronous RPC work without awaiting it in the message callback;
Go now retains that concurrency with unchanged response IDs and envelopes.

```text
owned reader -> ordered parsing/rate admission -> concurrent RPC tasks
                      |                                |
                 ping/pong                       context cancellation
                      |                                |
close admission -> close all sockets -> join tasks/auth/readers/heartbeat
                                      -> remove clients -> return Close
```

A connection context exists before authentication. Socket closure, peer EOF,
replacement or heartbeat retirement cancels that context. Handler admission
registers before upgrade, so shutdown joins even an upgrade not yet present in
the socket registry. Every concurrent Close joins the same retirement. The
reader has bounded pending input; callbacks run concurrently under the existing
host-configured rate/admission policy. No new quota or method deadline is
invented. Authentication retains its five-second decision deadline; its tracked
callback cleanup is joined when retiring the connection, and late identities
cannot be committed after retirement begins.

The official [HTTP shutdown contract](https://pkg.go.dev/net/http#Server.Shutdown)
excludes hijacked connections; [context cancellation](https://pkg.go.dev/context#CancelFunc)
also does not join work. The adapter owns both joins. Application Go callbacks
must observe context cancellation and return; Go cannot forcibly terminate one.
They must not call the owning Close from inside work that Close must join.
This unit strengthens cleanup of the existing candidate APIs without changing
public signatures, dependencies or wire constants. Final API review remains
required before release/consumer cutover.

Concurrent task panics must remain internal errors, while void calls remain
silent. Authentication panics fail closed. Transport recovery alone exposed a
second root cause: a cached handler panic left its result unfinished, blocking
another caller of the same key. The runtime now converts handler/authenticator
panics to internal errors before completing cache state. The transport also
recovers validation/middleware/telemetry task failures without exposing their
panic values. The new cached-panic test failed before the runtime correction.

Acceptance criteria and executed verification:

- **Concurrent wire behavior:** actual sockets run held RPC and void work,
  respond to ping, then process a release RPC through that same socket. The
  unchanged TypeScript client also releases an in-flight call, with HTTP
  fallback disabled so another transport cannot disguise serial dispatch.
- **Joined retirement:** socket tests hold callback cleanup after cancellation,
  prove two closers remain waiting, release cleanup, then verify both closers
  return and no runtime clients remain. Peer disconnect cancels active RPC and
  authentication. A held actual hijack proves shutdown rejects new admission
  with 503 and waits for the previously admitted upgrade before returning.
- **Failure containment:** RPC/void cached panics, live subsequent calls,
  authentication panics and direct runtime auth authority are checked. Cached
  callers all obtain internal errors from one invocation; the process stays
  alive and void failures emit no response.
- **Gates:** `go test ./... -count=1`, `go test -race ./... -count=1` and
  `go vet ./...` passed with a disposable Redis connection, including cluster
  delivery/presence. After the final direct-auth test, runtime race/vet passed.
  The TypeScript Go HTTP/WebSocket interoperability files passed seven checks;
  package lint/typecheck also passed. The shared helper compiles and directly
  owns each fixture executable, joins exit and removes its build directory.
  Only repository-owned tests are invoked. Temporary Redis and fixture builds
  were cleaned up. The complete npm release/browser/MongoDB/Python/Rust suite
  was not rerun for these Go changes and test-only TypeScript fixture changes.
  Upstream CI, broader parity/API/release review and downstream full acceptance
  remain pending; these checks do not certify the full requested migration.

SCS discovery was complete with no degraded stages/reason; actual sources were
read before editing. Review admission/cancellation/join ownership, ordered frame
admission versus concurrent calls, then runtime cache panic completion and the
actual-socket/TypeScript cases. Reverting this candidate unit restores the
measured serial-dispatch and cleanup gaps; no protocol/data rollback is needed.
No package publication, push or active SolidScript production role changed.

## Parsed numeric spelling for application coercion (2026-09-30)

Application coercion can distinguish an integer JSON literal from an exponent
literal even when both have the same floating-point approximation. The previous
Go parser discarded that spelling after its `int64` conversion failed. Retain
parsed finite-number spelling in the immutable value and expose typed
`NumberText() (string, bool)` access. Constructed values provide an appropriate
numeric spelling; tagged and nonfinite values have no finite-number text.

This additive candidate API does not change `Number()`, `Kind`, wire encoding,
cache keys, numeric normalization or protocol constants. Consumers can apply
language-specific coercion to the original number text without altering the
TypeFerry transport contract. Publication/API review remains pending.

Executed checks: the new test failed at missing access before implementation;
procedurally generated positive/negative integers at five exponents beyond
`int64` retain their complete spelling through array/object cloning. Decimal,
exponent and signed-zero spellings are retained. Constructed integers work;
nonfinite and nonnumeric values report no text. Explicit comparisons confirm
ordinary wire output equals the existing float approximation encoder.
`go test ./...`, `go test -race ./...` and `go vet ./...` passed with a disposable
Redis service, including the shared fixtures and transport/lifecycle suites.
The shared TypeScript client HTTP/WebSocket interoperability gate passed all
seven checks. After retaining integer signed-zero spelling, focused EJSON
race/vet checks passed too. Full release/browser/MongoDB/Python/Rust
checks are not rerun here; full parity and downstream cutover remain pending.
Review the value accessor, parser retention and clone/encoding checks. Reverting
this candidate unit removes the accessor without a protocol/data rollback.


### Runtime retirement and expanded real-client contracts

Four focused regressions initially fail: closed runtimes accept new clients and
callbacks, a pending authorization result recreates rooms after shutdown,
concurrent closers return before socket retirement, and shared presence remains
registered. Runtime close now atomically stops admission under its existing
locks, clears clients/rooms and removes tracker entries before closing sockets
outside those locks. Concurrent closers join the same result and retain socket
errors. Valid new calls/authentication/registration/event publication return the
typed `runtime.ErrClosed`; late clients close immediately. Subscription commits
recheck both lifetime and current connection identity after authorization.

Already admitted method/authentication work remains owned by its transport or
caller. Runtime close does not cancel independent application jobs or join a
callback that could itself be closing the runtime. Application shutdown must
close/join transport owners before retiring backing services, as documented.
Socket close callbacks must not recursively invoke their owning runtime close.

The normal Go conformance server exposes ordinary method declarations for error,
validation/middleware and cached-counter behavior plus protected/user/excluded
events. Tests initially fail at these absent declarations. Both real TypeScript
transports then pass the shared value and method contract, with cache key order
preserved. The WebSocket client additionally verifies current-identity admission,
originator exclusion and room release after disconnect/unsubscribe. The focused
files pass 25 cases; no browser client implementation or protocol changes occur.

Executed verification:

- Full `go test ./...`, `go test -race ./...` and `go vet ./...` pass with a
  disposable Redis service. Runtime close also removes real Redis client/user
  presence before final transport disconnect callbacks. The focused race suite
  reruns after strengthening assertions for the typed closed error.
- TypeScript lint, typecheck, build and package dry-run pass on the exact
  Node 24.19.0/npm 11.17.0 toolchain. All 1,656 unit cases pass. The initial
  full test command stops at unavailable MongoDB setup; a disposable replica
  set then enables all 76 integration and ten browser cases to pass. Three
  opt-in Ruby interoperability cases remain skipped. An initial temporary
  database name is rejected by the existing safety guard; the corrected test
  namespace passes. No application or pre-existing database is modified.
- The 25 focused real-client cases pass. Core dependency inspection includes
  only Go standard packages plus `ejson`, `protocol` and `runtime`; optional
  transport/auth/Redis adapters do not enter core imports.
- Owned Redis/MongoDB containers are removed after verification. Final diff and
  formatting checks pass. Package inspection produces no publication.

Downstream pin verification follows the upstream commit. Upstream CI, public
API/release review and production cutover remain separate acceptance gates;
the Go candidate is unpublished.

### Public API approval

On 2026-09-30 the user explicitly approved proceeding after the handoff named
the public Go API, import path and pinned WebSocket/Redis dependencies as the
remaining acceptance decision. Those contracts are now approved. Remote CI
must still pass before accepted parity is recorded. Registry publication and
release tags remain outside this specification; pushing the approved source
does not publish the unrelated TypeScript package candidate.

### CI audit prerequisite repair

The first approved upstream CI run passed Go (including Redis/race/vet), Ruby
and TypeScript-to-Ruby interoperability. The TypeScript job stopped at its
existing security audit, before any Go interoperability cases ran. Its lockfile
retained newly flagged transitive `brace-expansion` 5.0.9 and `undici` 7.29.0.
Named npm updates within the existing override ranges change only those two
entries to 5.0.12 and 7.30.0. The manifest, Go module, client source and protocol
remain unchanged. The dependencies originate in lint and jsdom tooling.

The exact Node 24.19.0/npm 11.17.0 local gate now passes immutable installation,
zero-vulnerability audit, lint, typecheck, all 1,656 unit cases, build, package
dry-run and archive verification (565 allowed files). Remote TypeScript
integration/browser acceptance still requires a successful replacement CI run.
No new configuration tests or registry publication were added.

Primary patch references: [brace-expansion advisory](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)
and [Undici 7.30.0 release](https://github.com/nodejs/undici/releases/tag/v7.30.0).

### Final upstream acceptance

[CI run 36806767551](https://github.com/leonardoventurini/typeferry/actions/runs/36806767551)
passes on `32480dd`: Go shared fixtures, Redis integration, unit/race/vet;
Ruby verification; TypeScript-to-Ruby compatibility; and the complete
TypeScript audit, lint, typecheck, unit/integration/browser/build/package gate.
The integration job executes the real HTTP/WebSocket Go client journeys.
These results close the earlier API and CI gaps without changing the protocol.

All six acceptance criteria pass: unchanged client behavior, shared fixture
parity, typed server features, negative admission, concurrent lifecycle safety,
and optional adapter boundaries. The application-owned example compiles in the
Go gate. Earlier bounded fuzz evidence remains recorded above. Public Go API,
import path and adapter dependencies are explicitly approved.

The implementation and documentation are committed and pushed. No Go tag or
registry publication is required by this specification. SolidScript production
acceptance remains owned by its separate migration specification.

Remote suite counts are 1,652 unit cases passed with four macOS-native template
cases skipped on Linux; 71 integration cases passed with five opt-in
Python/Rust and three opt-in Ruby cases skipped; and ten browser cases passed.
Both Go client files execute (ten HTTP and fifteen WebSocket cases). The Ruby
interop job separately executes and passes those three Ruby cases. All 1,656
unit cases passed locally on macOS. The unrelated opt-in Python/Rust CI skip
does not establish their acceptance and does not skip any Go parity case.

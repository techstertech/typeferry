# TypeFerry Ruby Server

Status: superseded by [the Ruby server retirement](2026-11-25-ruby-server-retirement.md)

Date: 2026-09-12

Approved scope: complete the identified production-readiness phases, certify
Puma as the initial WebSocket host, and keep the gem unpublished for direct Git
consumption. RubyGems publication remains a separate approval gate.

## Desired outcome

Add a Ruby server implementation that is indistinguishable from the existing
Python and Rust servers at the TypeFerry wire boundary and offers the union of
their maintained server-side features through idiomatic Ruby APIs.

The implementation lives in `typeferry-rb/` and produces a Ruby gem. Its core
runtime is framework-neutral. HTTP is exposed as a Rack application. WebSocket
support uses a narrow socket adapter contract plus a tested Rack-compatible
adapter because Rack does not make WebSocket support portable across every
server.

This specification does not authorize publication, finalize a public registry
identity, change the wire protocol, or add client/UI features.

## Decision summary

Proceed with Ruby support in phases. The repository already has the right
foundation: a normative protocol, implementation-independent fixtures, two
server ports, and black-box TypeScript client checks. Ruby is feasible without
changing revision 1 of the protocol.

Use these boundaries:

```text
                         PROTOCOL.md
                              |
                  shared conformance fixtures
                              |
        +---------------------+---------------------+
        |                                           |
  typeferry-rb core                         optional integrations
  EJSON -> protocol -> runtime      Rack HTTP | WebSocket | Redis | auth
        |                                           |
        +------------------ public facade ----------+
                              |
                     application-owned host
```

Use Ruby 3.3 or newer, RBS signatures checked with Steep, Minitest for unit and
fixture tests, Rack 3 for HTTP, Puma 7.2 as the certified production host, a
pluggable WebSocket boundary with an initial Rack-hijack adapter, and
`redis-client` for Redis. Keep transport, auth, schema, and authoring
dependencies optional.

## Evidence

### Repository evidence

- `PROTOCOL.md` defines revision 1 wire behavior, including HTTP, WebSocket,
  Redis, EJSON, auth, errors, events, and feature-parity authoring behavior.
- `docs/conformance/fixtures/` already contains language-neutral EJSON, HTTP,
  WebSocket, and Redis cases.
- `typeferry-py/` demonstrates a monolithic gem-like package with optional
  integrations and a decorator authoring layer.
- `typeferry-rs/` demonstrates strict dependency direction, a facade, transport
  adapters, compile-time authoring helpers, and a standalone conformance server.
- The TypeScript suite already launches Python and Rust conformance servers.
  Ruby should use the same black-box pattern.
- Python exposes several maintained conveniences that Rust does not currently
  expose completely: channel authorization, server event listeners, user
  disconnection/indexing, rate limiting, Google OAuth, device parsing, and the
  complete class/method authoring metadata model. They are in scope because the
  agreed target is the Python/Rust feature union.
- Rust makes layering and explicit socket/runtime boundaries clearer than the
  Python layout. Ruby should preserve those dependency properties without
  splitting the first release into many gems.

### Current Ruby ecosystem evidence

- Ruby 3.2 reached end of support in April 2026. Ruby 3.3 and newer remain
  documented branches, so `required_ruby_version >= 3.3` avoids beginning on an
  unsupported runtime: <https://docs.ruby-lang.org/en/>.
- Rack 3 defines HTTP request/response behavior, but full connection hijacking
  is optional and works only for HTTP/1. A Rack-compatible core therefore
  cannot promise portable WebSockets on every Rack server:
  <https://rack.github.io/rack/3.2/SPEC_rdoc.html>.
- `websocket-driver` separates RFC 6455 framing from I/O and accepts Rack-style
  environments, which matches the required socket adapter boundary:
  <https://github.com/faye/websocket-driver-ruby>.
- `async-websocket` supports HTTP/1 and HTTP/2 and supplies Rack/Rails examples.
  It is a viable later adapter, not a required core dependency:
  <https://github.com/socketry/async-websocket>.
- RBS plus Steep provides checked signatures without runtime coupling. Steep
  requires explicit signatures, including private state, which makes signature
  work part of implementation rather than a packaging afterthought:
  <https://github.com/soutaro/steep>.
- `redis-client` supplies a pure-Ruby Redis 6+ client and a public middleware
  boundary. It is a smaller fit than binding the runtime to the higher-level
  `redis` facade: <https://github.com/redis-rb/redis-client>.

Dependency versions must be selected and locked during implementation using
current registry metadata and security advisories. In particular, the chosen
WebSocket dependency must include the fix for GHSA-2x63-gw47-w4mm. This spec
intentionally does not freeze versions months ahead of implementation.

## Authority and invariants

The implementation follows this order:

1. `PROTOCOL.md` for normative wire behavior.
2. Shared conformance fixtures for executable examples of that behavior.
3. TypeScript reference behavior where the protocol cites it.
4. Python and Rust public behavior for feature-parity surfaces.
5. Ruby conventions for syntax and internal structure.

The root repository contract makes `PROTOCOL.md` authoritative, while
`docs/conformance/README.md` currently says a fixture wins when the two
disagree. That documentation conflict must be resolved before Ruby
implementation begins. In either interpretation, stop on a disagreement rather
than teaching Ruby a special case. Ruby must never branch on fixture names or
paths.

The following invariants are non-negotiable:

- No new wire envelope, tag, error string, default, or path.
- All wire strings are encoded and decoded through one Presentation/EJSON
  implementation.
- Auth and channel authorization fail closed.
- Application-owned WebSocket handshake authentication takes precedence over
  query-token authentication and never falls back after failure or timeout.
- Runtime behavior does not import Rack, Redis, JWT, OAuth, schema, or WebSocket
  libraries.
- Adapters depend inward on protocol/runtime contracts.
- Public Ruby APIs have RBS signatures. Dynamic DSL helpers delegate to the
  same explicitly typed imperative API.
- Shutdown owns and terminates timers, listener threads/fibers, subscriptions,
  and sockets created by TypeFerry.

## Scope

### Included protocol behavior

- EJSON conversion, escaping, exact tag detection, custom types, canonical
  stringify, binary, dates, regular expressions, and non-finite numbers.
- Presentation encoding and all protocol constants/types.
- HTTP `POST /__h`, exact response envelopes, headers/cookies, CORS options,
  bearer handling, errors, void behavior, and sliding-window rate limiting.
- WebSocket `/typeferry-ws`, query normalization, auth lifecycle, RPC, void RPC,
  events, ping/pong, origin validation, connection cleanup, and close behavior.
- Default `rpc:on`, `rpc:off`, and protected `rpc:logout`; conditional
  `rpc:login`; `list:methods` remains reserved and is not auto-registered while
  the revision 1 protocol says its wire contract is unfrozen.
- Methods, middleware, validation, per-method caching, execution context, and
  server-side execution timing events.
- Events, channels, rooms, user-scoped subscriptions, originator exclusion,
  client indexing, channel authorization, and user disconnection.
- Redis event propagation, server/client/user statistics, and cleanup.
- JWT, cookies, in-memory sessions, refresh rotation/reuse protection, device
  parsing, and Google OAuth code exchange.
- Imperative method/event registration and a Ruby class DSL matching the final
  metadata behavior of Python decorators and Rust macros.

### Excluded

- A Ruby client, Rails engine, Sinatra integration, or UI adapter.
- The optional TypeScript-only MongoDB live-view extension.
- A universal WebSocket promise across Rack servers that do not expose a usable
  hijack or equivalent duplex API.
- Distributed method-result caching. Revision 1 caches are local per method.
- Extra OAuth providers.
- Protocol revision 2 work, including freezing `list:methods`.
- RubyGems publication, credentials, tags, or a permanent gem name.

## Proposed repository and package layout

Use one gem with optional dependencies for the first release. Separate gems
would multiply versioning and release work without improving the dependency
direction inside this repository.

```text
typeferry-rb/
|-- AGENTS.md
|-- README.md
|-- typeferry-rb.gemspec
|-- Gemfile
|-- Gemfile.lock
|-- Rakefile
|-- Steepfile
|-- exe/typeferry-conformance-server
|-- lib/
|   |-- typeferry.rb                 # facade; core only
|   `-- typeferry/
|       |-- version.rb
|       |-- ejson/
|       |-- protocol/
|       |-- runtime/
|       |-- authoring/
|       |-- transports/
|       |   |-- rack_http.rb
|       |   |-- websocket.rb         # adapter-neutral dispatcher
|       |   |-- rack_websocket.rb    # tested hijack adapter
|       |   `-- redis.rb
|       `-- auth/
|-- sig/typeferry/**/*.rbs
`-- test/
    |-- unit/
    |-- conformance/
    |-- integration/
    `-- support/
```

Requiring `typeferry` loads only EJSON, protocol, runtime, and authoring code.
Applications explicitly require integrations such as
`typeferry/transports/rack_http` or `typeferry/auth`.

Use a temporary distribution identity, `typeferry-rb`, consistent with the
Python precedent. Keep publication disabled by repository process until a
separate identity and release decision is approved.

## Public contracts

These names are proposed implementation contracts. Creating them is a public
API change and requires explicit approval at implementation start.

### Runtime

```ruby
server = TypeFerry::Server.new(
  host: "127.0.0.1",
  port: 8003,
  origins: ["https://example.test"]
)

server.add_method("greeting.hello", handler, protected: false)
server.add_event("profile.changed", protected: true, user: true)
server.set_auth(auth: authenticator, log_in: login_handler)
server.set_channel_authorization(channel_authorizer)

http_app = TypeFerry::Transports::RackHTTP.new(server)
ws_app = TypeFerry::Transports::RackWebSocket.new(server)
app = Rack::URLMap.new("/__h" => http_app, "/typeferry-ws" => ws_app)
```

Handlers and middleware receive `(node, params)`. A handler returns an EJSON
value or raises `TypeFerry::PublicError` /
`TypeFerry::SchemaValidationError`. Middleware returns transformed params.
Callables execute in the host's thread/fiber. A Fiber-scheduler host may suspend
inside them; the runtime does not introduce a second event loop.

`Server#close` is idempotent and waits for TypeFerry-owned background work to
stop. Adapter-specific close methods detach routes/listeners without closing
application-owned servers.

### Authoring DSL

Ruby has no direct decorator or attribute-macro equivalent. Offer a thin class
DSL over imperative registration:

```ruby
class GreetingMethods
  extend TypeFerry::Authoring

  namespace "greeting"
  protected_by_default
  cache_by_default max_age_ms: 60_000

  method :hello, public: true, cache: false, schema: HelloSchema do |node, params|
    { "message" => "Hello, #{params.fetch("name")}" }
  end
end

server.register(GreetingMethods.new)
```

The DSL must cover namespace, explicit wire name, protected/public override,
cached/no-cache override, schema, and ordered middleware. Registration resolves
class defaults and method overrides once, then calls `Server#add_method`.

The imperative API is canonical. Metaprogramming must not create a second
execution path or weaken RBS coverage of runtime classes.

### Schema validation

Define `TypeFerry::SchemaValidator#safe_parse(value)` returning a typed result:

```text
success -> { success: true, data: validated_value }
failure -> { success: false, issues: [{ path: [...], message: "..." }] }
```

Ship a dependency-free callable adapter. A dry-schema integration may be an
optional dependency if its error traversal can produce the protocol's exact
`path: message` strings. Do not couple core to one validation gem.

### EJSON Ruby mappings

Use explicit value objects wherever native Ruby values cannot preserve the
wire representation exactly:

| Wire concept | Ruby input/output contract |
|---|---|
| date | `Time` accepted; `TypeFerry::EJSON::DateValue` preserves integer milliseconds exactly |
| regexp | `Regexp` accepted for Ruby-compatible flags; `RegexpValue` preserves `g`, `u`, and `y` |
| binary | binary-encoded `String` and `BinaryValue`; emit standard Base64 and accept URL-safe decode |
| custom type | registry of name to encoder/factory with exact `$type`/`$value` behavior |
| object | string-keyed insertion-ordered `Hash`; do not symbolize untrusted keys |
| non-finite | native `Float` values |

Decode into lossless wrapper values by default. Convenience conversion to
native Ruby types must be explicit when it can lose flags or millisecond
identity. Equality and canonical stringify operate on the lossless model.

### WebSocket adapter boundary

Define a small internal/publicly documented interface:

```text
Socket
  id -> stable transport identity
  uuid -> TypeFerry client identity
  send_text(payload)
  close(code = 1000)
  open? -> boolean

WebSocket host adapter
  handshake snapshot -> path + normalized headers + query
  on_text -> dispatcher
  on_pong -> liveness state
  on_close -> room/client cleanup
  schedule/cancel -> auth timeout and ping lifecycle
```

The first adapter uses Rack 3 hijack plus a maintained RFC 6455 driver and is
tested with Puma. If hijack is missing, it returns a documented unsupported
response before creating a `ClientNode`. HTTP/2 WebSockets require a later
Async/Falcon adapter and are not claimed by the first release.

Application-owned handshake authentication receives an immutable snapshot,
never the mutable Rack environment or raw socket.

## Concurrency and lifecycle

Ruby web servers may use threads, fibers, or both. Runtime collections must be
safe under concurrent HTTP handlers, WebSocket callbacks, Redis listeners, and
shutdown.

- Guard method/event/client/room maps with focused mutexes; never hold a lock
  while invoking application code or sending network data.
- Snapshot broadcast recipients under lock, then send outside the lock.
- Store execution context in a fiber-local scope with guaranteed restoration in
  `ensure`, including nested calls and exceptions.
- Use a monotonic clock for cache TTL, rate-limit windows, auth timeout, ping
  liveness, and timing events. Use wall time only for JWT/cookie/session dates.
- Make every close path idempotent. Socket close removes all rooms and indexes
  exactly once.
- Track background workers explicitly. Do not leave anonymous threads that can
  keep a process alive.
- Preserve insertion order for method caches and EJSON objects where revision 1
  requires non-canonical `EJSON.stringify` cache keys.

## Dependency policy

The target dependency shape is:

| Surface | Runtime dependency | Loading rule |
|---|---|---|
| core/EJSON/runtime/DSL | Ruby standard library | loaded by `require "typeferry"` |
| HTTP | Rack 3 | explicit transport require |
| WebSocket | Rack + audited RFC 6455 driver | explicit transport require |
| Redis | `redis-client` | explicit transport require |
| JWT | maintained JWT gem + OpenSSL | explicit auth require |
| Google OAuth | HTTP client/JWT verification dependencies | explicit OAuth require |
| device parsing | maintained user-agent parser | explicit auth require |
| schema convenience | selected validator adapter | explicit schema require |
| types/tests | RBS, Steep, Minitest and test helpers | development only |

Before adding production dependencies, record exact alternatives, maintenance
status, licenses, transitive graph, security advisories, and supported Ruby
versions. Obtain explicit approval for the final dependency set as required by
repository policy.

Do not use runtime Sorbet signatures: they would add runtime coupling while the
project needs distributable static contracts. RBS is Ruby's signature format,
and Steep can enforce it in development and CI.

## Conformance matrix

Every row requires focused Ruby tests. Rows marked shared must also execute the
existing repository fixture family without copies.

| Area | Required behavior | Verification |
|---|---|---|
| EJSON | all tags, exact detection, escaping, ordering, custom types, malformed input | shared EJSON fixtures + negative unit cases |
| HTTP | path/method/content, envelopes, auth, void, schema, errors, headers | shared HTTP fixtures + Rack mock requests |
| WebSocket | normalized query, auth precedence/timeout, RPC/void, event, ping/pong, cleanup | shared WS sequences + real Puma socket |
| Redis | `events` payload, local routing, exclusion, keys, stats, cleanup | shared Redis fixtures + ephemeral Redis integration |
| methods | protection, cache TTL/key order, schema-before-middleware, middleware order | unit tests + TypeScript client calls |
| context | nested execution, fiber suspension, exceptions, concurrent isolation | deterministic concurrency tests |
| events | rooms, user channel, authorization, cluster/local paths, exclusion | unit + two-server integration |
| auth | HS256 defaults, token claims, cookies, rotation grace/reuse, revocation | shared additions where wire-facing + unit tests |
| OAuth/device | Google exchange/verification and normalized device shape | local mock IdP + procedural UA cases |
| authoring | DSL metadata equals imperative options for every override | table-driven unit tests |
| lifecycle | idempotent close and no surviving workers/sockets | integration teardown assertions |
| packaging | only intended gem files, clean install, core loads without optional gems | built-gem inspection + consumer smoke test |

### Cross-language acceptance

Add `cross-lang-rb.integration.spec.ts` beside the Python and Rust tests. It
starts `exe/typeferry-conformance-server` on a dynamic loopback port, waits for
readiness, uses the TypeScript client against real HTTP and WebSocket routes,
and always terminates the child.

The Ruby process contract should match existing harness conventions where
practical:

- port and dependency endpoints come from explicit environment variables;
- readiness is machine-detectable;
- logs go to stderr and never contain tokens;
- SIGTERM initiates bounded graceful shutdown;
- a nonzero exit reports setup/runtime failure.

Do not run tests from another repository. All Ruby verification and any
TypeScript harness invoked by CI must remain tracked here.

## Test-first delivery plan

Each phase is one reviewable unit. Write or expose the failing acceptance test
before its implementation, run the focused suite, run the accumulated Ruby
gate, update docs, and commit only phase-owned files.

### Phase 0: package and test architecture

- Add `typeferry-rb/AGENTS.md`, gem skeleton, RBS/Steep configuration, test
  helper, fixture path resolver, and packaging allowlist test.
- Add repository routing/architecture documentation for Ruby.
- Add a CI Ruby job triggered by Ruby, protocol, or fixture changes.
- CI covers the minimum supported Ruby and current stable Ruby. Any Forgejo
  workflow uses `runs-on: arm64`; GitHub Actions uses supported hosted labels.
- Prove `require "typeferry"` works without optional integrations installed.

Acceptance: empty package builds, signatures check, tests run, artifact contents
are allowlisted, and fixture discovery is repository-relative rather than
machine-relative.

### Phase 1: EJSON and protocol foundation

- Port shared EJSON fixtures into one generic Ruby fixture runner.
- Add malformed Base64, decoy tag, escape collision, Unicode, precision,
  duplicate regexp flag, and custom registry isolation tests.
- Implement lossless values, converters, equality, canonical stringify,
  Presentation, constants, envelopes, and errors.

Acceptance: every shared EJSON fixture passes byte-for-byte; protocol constants
and public errors match revision 1; core remains stdlib-only.

### Phase 2: runtime and authoring

- Test method resolution, protected calls, schema ordering/error strings,
  middleware transformation, key-order-sensitive cache behavior, nested context,
  timing events, registration conflicts, and all DSL override combinations.
- Implement client node, method, server, channels, events, rooms, context,
  validator contract, imperative registration, and class DSL.
- Add deterministic tests for concurrent room mutation and context isolation.

Acceptance: the runtime feature matrix passes without loading Rack or Redis;
the DSL resolves to exactly the same `MethodOptions` as imperative registration.

### Phase 3: Rack HTTP

- Run every shared HTTP fixture through `Rack::MockRequest` before adding
  transport behavior.
- Add negative tests for wrong path/method/content, invalid EJSON, bearer
  stripping, duplicate response headers, CORS, proxy/IP policy, and limiter
  headers/windows.
- Implement the Rack application and sliding-window limiter.

Acceptance: shared HTTP fixtures pass exactly, protected/auth/schema failures
match the protocol, and `Set-Cookie` survives as a non-collapsed response
header.

### Phase 4: WebSocket

- Build the adapter-neutral dispatcher against a procedural fake socket and
  virtual clock.
- Run shared WS sequences against the fake adapter, then against a real Puma
  Rack-hijack server.
- Test origin rejection, UUID sanitization, metadata size/parse failure,
  handshake-auth precedence, the 5000 ms boundary, ping at 25000 ms, stale-peer
  termination, binary-frame rejection, concurrent sends, and cleanup races.
- Implement the socket interface, dispatcher, lifecycle scheduler, and initial
  Rack WebSocket adapter.

Acceptance: shared sequences pass; the TypeScript client connects and performs
RPC/subscription flows; unsupported Rack servers fail explicitly; no custom
reserved close code is used.

### Phase 5: Redis and multi-instance events

- Run shared Redis fixtures without a server by testing envelope construction
  and routing.
- Add an ephemeral Redis integration with two Ruby servers for propagation,
  originator exclusion, reconnect, stats, and cleanup.
- Implement publish/subscribe and registration keys behind an explicit require.

Acceptance: all Redis fixtures pass byte-for-byte, two-instance delivery occurs
once, exclusions work by TypeFerry UUID, and shutdown removes owned keys.

### Phase 6: auth feature union

- Add generated JWT vectors for Ruby-issued and externally issued tokens.
- Add procedural cookie option matrices and session state-machine tests covering
  rotation grace, reuse, family revocation, cleanup, and concurrent refresh.
- Add a local mock Google token/code endpoint; never call a live provider in
  tests.
- Add procedural device/header cases rather than a large frozen corpus.
- Implement JWT, cookies, session types/manager, device parsing, and Google OAuth
  behind optional requires.

Acceptance: defaults match `PROTOCOL.md`, tokens interoperate with TypeScript,
cookie strings match required flags, reuse fails safely, and OAuth tests are
network-independent.

### Phase 7: black-box interoperability and documentation

- Add the Ruby conformance executable and TypeScript cross-language test.
- Exercise HTTP, WebSocket auth, RPC, subscription/event delivery, and graceful
  shutdown through the TypeScript client.
- Update root routing, architecture overview, conformance README, protocol
  runbook commands, release status, and Ruby README.
- Add an example Rack application that uses only public APIs.

Acceptance: the complete Ruby gate and TypeScript-to-Ruby black-box suite pass;
documentation makes unsupported WebSocket hosts and unpublished status clear.

### Phase 8: release readiness, separately approved

- Select permanent RubyGems identity and version policy.
- Audit licenses/advisories, inspect the built gem, install it in a clean
  consumer, and document supported Ruby/server combinations.
- Add publication automation only under a separately approved release spec and
  decision.

Acceptance: no upload occurs as part of parity implementation. Publication
remains impossible until identity, credentials, and rollout are approved.

## Verification commands

Final command names may be adjusted during Phase 0, but one aggregate gate must
remain stable. Expected commands from `typeferry-rb/`:

```sh
bundle exec rake test:unit
bundle exec rake test:conformance
bundle exec rake test:integration
bundle exec steep check
bundle exec rubocop
bundle exec rake build
bundle exec rake verify:package
bundle exec rake verify
```

Cross-language verification from `typeferry-ts/`:

```sh
npm run test:integration -- src/test/conformance/cross-lang-rb.integration.spec.ts
```

Protocol changes later must run all affected TypeScript, Python, Rust, and Ruby
fixture suites. Ruby should be added to `docs/runbooks/protocol-changes.md` only
when its conformance runner exists; documentation must not claim an unavailable
gate.

## CI design

Prefer a dedicated Ruby job instead of extending the already long TypeScript
job. The Ruby job installs Bundler from the lockfile policy, caches gems, runs
the aggregate Ruby gate, starts ephemeral Redis only for integration tests, and
builds/inspects the gem.

The cross-language Ruby job installs the repository's locked TypeScript and
Ruby dependencies, starts the Ruby conformance server, and runs only the Ruby
target test. It must not make Python or Rust availability a prerequisite.

Trigger Ruby jobs on:

- `typeferry-rb/**`
- `docs/conformance/**`
- `PROTOCOL.md`
- the workflow itself
- shared scripts directly used by the job

Pin action/toolchain versions consistently with repository policy. A future
Forgejo workflow must use the required `arm64` runner label.

## Risks and mitigations

### Rack WebSocket portability

Risk: Rack hijack is optional and HTTP/1-only, while server behavior varies.

Mitigation: keep framing/I/O behind the socket contract, certify an explicit
Puma version range, test unsupported behavior, and add Async/Falcon separately
for HTTP/2 or fiber-native deployments.

### Thread and fiber model differences

Risk: a callback safe under one Ruby server may race or leak context under
another.

Mitigation: no lock across user/network calls, deterministic concurrency tests,
fiber-local scoped context, monotonic clocks, and explicit lifecycle ownership.

### Ruby-to-JavaScript value mismatch

Risk: Ruby `Regexp`, `Time`, binary strings, symbols, integers, and Hash keys do
not map perfectly to JavaScript EJSON.

Mitigation: lossless wrapper values, string-only decoded keys, byte fixtures,
negative tag tests, and explicit lossy convenience conversion.

### Dynamic authoring versus type safety

Risk: a rich DSL can hide misspelled options and defeat static checking.

Mitigation: keep imperative APIs canonical, accept a fixed keyword vocabulary,
reject unknown options at registration, publish RBS interfaces, and test every
metadata override combination.

### Dependency and security drift

Risk: WebSocket, JWT, OAuth, and user-agent gems process hostile input and their
status changes over time.

Mitigation: optional loading, current advisory review before selection, locked
development graph, automated audit, malformed-input tests, payload limits, and
no live OAuth calls in CI.

### False feature-parity claims

Risk: shared fixtures currently cover less than the full normative and
authoring surface.

Mitigation: maintain this matrix, add shared fixtures when behavior is truly
cross-language and representable, use Ruby unit tests for authoring behavior,
and require TypeScript-client black-box checks before declaring parity.

### Release identity

Risk: the `typeferry` RubyGems name may be unavailable or inappropriate.

Mitigation: use `typeferry-rb` only as a local temporary identity and keep
publication out of scope until registry research and approval.

## Recovery and rollback

Every phase is additive and should be committed separately. Before publication,
rollback is removal or revert of `typeferry-rb/` plus its routing, CI, and
cross-language harness references.

If a Ruby implementation cannot satisfy an existing fixture, do not loosen the
fixture or protocol solely for Ruby. Isolate the failing phase, document the
language mismatch, and keep Ruby marked experimental or incomplete.

If the initial Rack WebSocket adapter proves unreliable, retain the tested core,
EJSON, runtime, and HTTP layers; remove the adapter and parity claim together.
Do not silently substitute a server-specific implementation behind the same
compatibility promise.

No persisted application data migration is introduced. Redis keys follow the
existing ephemeral runtime contract and cleanup rules.

## Uncertainty and implementation approval gates

The following must be resolved with evidence immediately before their phase:

- exact gem versions and permanent dependency choices;
- the certified Puma/Rack/WebSocket version matrix;
- JWT and Google verification libraries;
- whether a schema convenience adapter earns a production dependency;
- permanent RubyGems identity and publication workflow.

Explicit user approval is required before implementation establishes the public
API, adds production dependencies, or enables publication. None of these gates
blocks accepting this implementation plan.

## Executable completion checklist

- [x] Approve proposed public APIs and the Rack, Puma, WebSocket, Redis, and JWT production dependencies.
- [x] Complete Phase 0 package/test architecture and commit it.
- [x] Complete Phase 1 EJSON/protocol with all shared fixtures and commit it.
- [x] Complete Phase 2 runtime/DSL with concurrency tests and commit it.
- [x] Complete Phase 3 Rack HTTP with all shared fixtures and commit it.
- [x] Complete Phase 4 WebSocket with fake and real-server tests and commit it.
- [x] Complete Phase 5 Redis with two-instance verification and commit it.
- [x] Complete Phase 6 auth union with offline tests and commit it.
- [x] Complete Phase 7 cross-language/docs and commit it.
- [x] Run and report the complete Ruby verification gate.
- [x] Run and report TypeScript-to-Ruby black-box verification.
- [x] Confirm no `PROTOCOL.md` or fixture change was needed.
- [x] Record the [Ruby server runtime decision](../decisions/2026-09-12-ruby-server-runtime.md).
- Drop Phase 8 publication because the server is retired.

## Observable final acceptance criteria

1. A TypeScript client uses Ruby HTTP and WebSocket transports without
   client-side branching.
2. Ruby passes every shared EJSON, HTTP, WebSocket, and Redis fixture directly
   from `docs/conformance/fixtures/`.
3. Exact paths, envelopes, errors, constants, defaults, cache-key ordering,
   cookies, auth precedence/timeouts, and room names match protocol revision 1.
4. The complete Python/Rust server feature union listed in Scope has an
   imperative Ruby API; authoring metadata also has an idiomatic class DSL.
5. RBS covers public/core contracts and Steep passes without broad `untyped`
   escapes at protocol, runtime, or adapter boundaries.
6. Core loads and operates without optional transport/auth/schema gems.
7. Concurrency tests demonstrate isolated context, safe room/client mutation,
   single cleanup, and bounded shutdown.
8. The Rack HTTP adapter works on Rack 3; the initial WebSocket adapter works on
   its documented Puma matrix and rejects unsupported hosts explicitly.
9. Redis two-instance, auth/session, and offline Google OAuth integration tests
   pass.
10. CI and documentation expose the real Ruby support level without claiming
    publication or universal Rack WebSocket compatibility.

---
status: verified
created: 2026-11-25
updated: 2026-11-25
owner: security-hardening
decision: ../decisions/2026-11-25-room-isolation-logout-and-context-boundaries.md
---

# Monorepo P0 + P1 Security Hardening

## Outcome and approval

Remediate the validated P0 and P1 security defects across `PROTOCOL.md`,
`typeferry-ts`, `typeferry-go`, `typeferry-py`, and `typeferry-rs`. The user
approved the P0 + P1 cross-runtime scope, length-prefixed internal room keys,
full room eviction on `rpc:logout`, strict `allowedContextKeys` enforcement on
HTTP `transport.context`, and non-evicting WebSocket UUID collision handling on
2026-11-25.

## Validated evidence

- **Cross-language (`PROTOCOL.md`, TS, Go, Python, Rust):**
  - `rpc:logout` cleared auth fields without leaving subscribed WebSocket rooms,
    allowing post-logout delivery of protected and user-scoped events.
  - Internal room keys used unescaped `typeferry:<channel>:<event>`
    concatenation, allowing `:` in client-supplied `channel` values to collide
    with protected/user-scoped colon-namespaced events.
  - Unauthenticated WebSocket handshakes with a colliding `?uuid=` overwrote
    live client registry entries (and in Go, closed the existing socket), while
    `deleteClient` deleted without checking node ownership.
  - Anonymous method caches, `rpc:on` room joins, `Server.channels`, and
    `InMemorySessionManager` lacked entry bounds or expired-entry pruning.
  - `InMemorySessionManager` grace-period reuse failed to reject superseded
    (`replacedBy`) or expired replacement sessions and relied on wall-clock
    timestamps in TS, Python, and Rust.
- **TypeScript (`typeferry-ts`):**
  - `EJSON.clone` `isArguments()` matched plain JSON objects with `callee`,
    triggering OOM `Array.from()` allocations pre-auth.
  - `WebSocketTransport` `upgrade` called `new URL(...)` without `try/catch`,
    allowing an invalid request target to crash Node.js.
  - `EJSON.clone`, `escapeConverter`, `adjustTypesFromJSONValue`,
    `stableStringify`, `lodash.merge`, and `minimongo` (`path.ts`, `modifier.ts`)
    allowed `__proto__` / prototype overrides (`Object.prototype` pollution in
    Minimongo, `instanceof` type confusion in `$escape`); `$bits*` allowed
    256 MiB bitmask allocations.
  - Authenticated HTTP `ClientNode`s leaked permanently in `Server.clientsByUserId`.
  - HTTP `POST /__h` forwarded unfiltered `transport.context` into `server.auth`
    despite `allowedContextKeys`.
  - `Presentation.uuid()` used non-CSPRNG `@lukeed/uuid`; `customMemoize`
    cached rejected promises and `isServer` calls; `Client.fetch()` attached
    `x-api-key` and `credentials: 'include'` to cross-origin URLs; `client.logout()`
    dropped local cleanup on error; `GoogleOAuthProvider` omitted `audience`;
    `MongoLiveEngine.resync()` returned cached snapshots without rechecking
    `protected`.
- **Go (`typeferry-go`):**
  - Blocking `connectionSocket.SendText` without per-write timeouts deadlocked
    `pingLoop`, room `deliver`, and `redistransport` event fanout on stalled peers.
  - `ejson` had O(N²) duplicate-key scanning, O(D²) recursive cloning /
    `$binary` heap amplification, and no depth bound (`ejson` and WS `meta`).
  - HTTP rate limiter lacked expired-key eviction; WS rate limiting defaulted to
    disabled, spawned unbounded RPC goroutines, and skipped rate limiting on C→S
    `ping`; `presenceMu` blocked across 2s Redis I/O; anonymous method cache
    cached `context.Canceled`/errors; WS RPC leaked wrapped outer error text;
    HTTP dropped `ResponseHeaders()` on error responses, truncated multi-value
    headers, used `io.LimitReader` instead of `http.MaxBytesReader`, and omitted
    `X-Client-Id` validation; `auth.ParseDeviceInfo` trusted `X-Forwarded-For`.
- **Python (`typeferry-py`):**
  - WebSocket lacked per-connection rate limiting and frame size limits,
    crashed `_receive_loop` on malformed `rpc`/`rpc:void` frames, and failed to
    set `remote_address` from `ws.client.host` while `ClientNode` and
    `parse_device_info` trusted `X-Forwarded-For`.
  - WebSocket `authenticate_node` installed context and emitted `AUTHENTICATION`
    outside `try/except`, violating fail-closed rollback (`PROTOCOL.md §8.1`).
  - EJSON lacked recursion depth bounds, accepted bare `NaN`/`Infinity`, crashed
    on non-ASCII/unhashable inputs, and had Base64 padding corruption bugs.
  - HTTP crashed with 500 on non-dict `payload`; `SlidingWindowLimiter` lacked
    `max <= 0` validation and bucket caps; `Server.call()` poisoned `@cached`
    anonymous entries; `call_method_on_node()` skipped `protected` checks;
    Redis `_listen` crashed on non-string `channel`; `ServerChannel.propagate`
    awaited sockets sequentially; `jwt_utils` accepted weak/non-string claims.
- **Rust (`typeferry-rs`):**
  - `Server` omitted `shouldAllowChannelSubscribe` (`PROTOCOL.md §7.1`),
    `rpc:logout` retained rooms, `AxumSocket` held a Tokio mutex across `.await`
    causing `close()` deadlocks, and WS upgrades lacked frame/message caps.
  - `delete_client` did not verify node identity; `set_authenticated(false)`
    left stale context/`user_id`; WS auth did not update `clients_by_user_id`.
  - `jsonwebtoken` verification kept the 60s default expiry leeway and omitted
    `maxAge` (`iat`) and empty-secret checks.
  - `InMemorySessionManager` lacked cleanup and revocation methods; HTTP lacked
    a route-scoped `DefaultBodyLimit`, auth timeout, `strip_prefix("Bearer ")`,
    and duplicate `Origin` rejection; `MethodCache` was unbounded and lacked
    post-execution auth recheck; `Presentation::uuid()` was deterministic
    wall-clock time rather than UUID v4.

## Contracts and explicit exclusions

- Internal room keys use `typeferry:<utf8-byte-length(channel)>:<channel>:<eventName>`
  across all four runtimes.
- `rpc:logout` leaves all WebSocket rooms across all four runtimes.
- TS HTTP `transport.context` is filtered by `server.allowedContextKeys`
  (empty default yields `{}` plus `x-api-key` → `token`).
- Unauthenticated WS handshakes colliding on an active client `uuid` receive a
  fresh CSPRNG UUID; `deleteClient` deletes only the matching node instance.
- **Explicit P2 exclusions (deferred to follow-up):** Rust HTTP/WS rate limiters
  and `WebSocketHandshakeAuthenticator`, Python `revalidateOnDelivery` and
  `MethodOptions.sensitive`, Redis inbound frame validation/HMAC across
  clusters, and CI workflow expansion for Python/Rust/template.

## Acceptance criteria and verification

| ID | Observable outcome | Verification |
| --- | --- | --- |
| A1 | `rpc:logout` evicts all WS rooms; length-prefixed room keys prevent `:` injection | Unit/integration tests across TS, Go, Python, Rust |
| A2 | TS EJSON `callee`/prototype/depth, Minimongo prototype/`$bits*`, WS `upgrade` URL, HTTP leak, `allowedContextKeys`, `Client.fetch`/`logout`, OAuth `audience`, and live `resync` are fixed | Focused unit/integration tests + full TS suite |
| A3 | Go non-blocking WS writes, EJSON linear keys/no amplification/depth limit, WS rate limit/concurrency/error unwrapping, cache error eviction, HTTP `MaxBytesReader`/error cookies/limiter eviction, and Redis non-blocking presence pass under `-race` | `go test -race -count=1 ./...` and `go vet ./...` |
| A4 | Python WS rate limit/frame cap/`ws.client.host`/fail-closed auth, EJSON depth/NaN/base64, HTTP `payload` guard, limiter cap, `Server.call` cache isolation, and JWT/session fixes pass | `pytest`, `ruff check .`, `mypy` |
| A5 | Rust `should_allow_channel_subscribe`, lock-free bounded `AxumSocket`, WS size caps, JWT `leeway=0`/`maxAge`, `InMemorySessionManager` APIs, HTTP body/auth bounds, and `Presentation::uuid()` pass | `cargo fmt --check`, `cargo clippy`, `cargo test --workspace --all-features` |
| A6 | Cross-language conformance fixtures pass across all four backends | `just verify-shared-fixtures` + TS↔Go integration |

## Execution checklist

- [x] Stage 1: Write spec, decision record, and update `PROTOCOL.md`.
- [x] Stage 2: TypeScript regressions and fixes (`typeferry-ts`).
- [x] Stage 3: Go regressions and fixes (`typeferry-go`).
- [x] Stage 4: Python regressions and fixes (`typeferry-py`).
- [x] Stage 5: Rust regressions and fixes (`typeferry-rs`).
- [x] Stage 6: Run full cross-runtime verification and record results.

## Verification record

### Initial P0 + P1 hardening commits
- Commits: `206f612` (`docs(protocol)`), `54b5899` (`fix(ts-ejson)`), `4a55780` (`fix(ts-minimongo)`), `01532cc` (`fix(ts-server)`), `f3e641d` (`fix(ts-auth)`), `5b2da58` (`fix(go)`), `b8546bf` (`fix(py)`), `20467cc` (`fix(rs)`).

### Post-review remediation and final verification
- Commits: `2e0dabf` (`docs(protocol)`), `fd08da8` (`fix(ts-minimongo)`), `d4048fb` (`fix(ts-ejson)`), `050c9bb` (`fix(ts-server)`), `eb600a7` (`fix(go)`), `2dacc35` (`fix(py)`), `bd33670` (`fix(rs)`).
- **`typeferry-ts`:**
  - Minimongo unit suite (`src/minimongo`): 3 files / 23 tests passed.
  - EJSON unit & conformance fixtures (`src/ejson`, `ejson-fixtures.unit.spec.ts`): 14 files / 292 tests passed.
  - Post-Unit-4 targeted suites (`method.unit.spec.ts` 23/23, `client.unit.spec.ts` 58/58, `methods.unit.spec.ts` 23/23, `protocol-boundaries.unit.spec.ts` 43/43, plus `ws-fixtures`, `http-fixtures`, `caching.unit.spec.ts`): passed (141/142 full-unit files + 1853/1854 tests passed prior to final async-cache promise-return fix in `method.ts`, followed by full pass of `method.unit.spec.ts`, `client.unit.spec.ts`, `caching.unit.spec.ts`, `ws-fixtures`, and `http-fixtures`).
  - Cross-language conformance (`cross-lang-rs` 6/6, `cross-lang-go-ws` 16/16, `cross-lang` Py 5/5, `cross-lang-go-http` 11/11): 4 files / 38 tests passed.
  - Typecheck, lint, and build (`tsc --noEmit`, `eslint src/`, `tsc -p tsconfig.build.json && node scripts/prepare-dist.mjs`): all exited 0 (`npm` wrapper not invoked due to `devEngines` Node 24.22.0 vs pinned 24.19.0; browser/live-MongoDB/live-Redis integration suites not run).
- **`typeferry-go`:**
  - `go test -race -count=1 ./...` (Go 1.27): all 7 tested packages (`auth`, `authoring`, `ejson`, `httptransport`, `redistransport`, `runtime`, `websocket`) passed (`TestRedisCrossInstanceDelivery` skipped with `TYPEFERRY_TEST_REDIS_URL` unset).
  - `go vet ./...` and `gofmt -l .`: exited 0 with empty diff.
- **`typeferry-py`:**
  - `.venv/bin/python -m pytest`: 346/346 passed (including shared EJSON/HTTP/Redis/WS conformance fixtures).
  - `.venv/bin/python -m ruff check .` and `.venv/bin/python -m mypy`: exited 0 (53 source files).
- **`typeferry-rs`:**
  - `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`, and `cargo test --workspace --all-features`: all exited 0 across all workspace crates (1 pre-existing ignored doctest in `typeferry-macros`; Redis live lifecycle test requires external Redis if configured). `typeferry-rs/target` (3.4 GiB) cleaned afterward with `cargo clean`.
- **Formatting:** `git diff --check` exited 0.

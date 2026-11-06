# TypeScript Runtime Architecture

Status: informative. Follow [`typeferry-ts/AGENTS.md`](../../typeferry-ts/AGENTS.md) for operational requirements.

## Ownership map

| Area | Primary path | Responsibility |
|---|---|---|
| Application tooling | `typeferry-ts/src/application/` | Validated config, web/server and optional iOS builds, native scaffolding and simulator CLI |
| Optional native bridge | `typeferry-ts/src/native/` | Capacitor adapter, iOS permission/session/lifecycle/file templates |
| Client core | `typeferry-ts/src/client/` | HTTP/WebSocket clients, calls, channels, local state |
| Server core | `typeferry-ts/src/server/` | Method dispatch, client nodes, events, rooms, middleware |
| Transports | `typeferry-ts/src/server/transports/` | Hono/Node HTTP and `ws` integration |
| Auth | `typeferry-ts/src/auth/` | Client refresh/session flow and server JWT/OAuth/cookies |
| Serialization | `typeferry-ts/src/ejson/` | EJSON conversion, equality, cloning, custom models |
| In-memory data | `typeferry-ts/src/minimongo/` | Immutable local documents, Mongo-style queries and mutations, and typed collection/cursor events |
| Shared utilities | `typeferry-ts/src/utils/` | Protocol shapes, constants, throttling, helpers |
| React adapter | `typeferry-ts/src/react/` | Hooks and provider over the core client |
| MongoDB extension | `typeferry-ts/src/mongodb/` | Typed collections and live invalidation over the native driver |
| Test infrastructure | `typeferry-ts/src/test/` | Shared harnesses and conformance integration |

## Runtime lifecycle

`Server` and its registered method/event primitives define application behavior. `NodeHonoTransport` owns the Hono application and Node HTTP listener. `WebSocketTransport` attaches upgrade handling to the same listener before startup. Connected peers become `ClientNode` instances used by dispatch, auth, rooms, and event routing.

Client-side `Client`, `ClientHttp`, and `ClientSocket` coordinate calls and connection state. The React surface observes or invokes that core; it must not reimplement transport, server method caching, or auth behavior. Other UI frameworks integrate through the framework-agnostic client instead of package-owned adapters.

`Client.href()` owns its query encoder in `src/client/href-query.ts`. The encoder
preserves sorted keys, repeated array keys, bare null keys, and strict percent
encoding. The React `useCaller()` hook owns only its existing RPC promise cache:
equivalent EJSON arguments share pending calls, failures allow retries, and
successful calls expire from fulfillment. Server method caching remains separate.

Immediate connection replacement retires the active socket through
`ClientSocket` before opening its successor. Retirement rejects pending RPCs
and emits `WEBSOCKET_CLOSED` exactly once so connection-owned consumers can
discard stale work before the next authenticated `INITIALIZED` boundary.

Automatic browser wake recovery owns a cancellable lifecycle through the real
`INITIALIZED` event, including subscription restoration. Hidden timer gaps are
remembered until visibility returns. After the bounded refresh hook, an open,
initialized socket has up to 30 seconds to deliver existing server traffic
(the wire heartbeat interval is 25 seconds). Delivered traffic preserves the
socket and pending RPCs; silence, transport failure or a changed token requires
recovery. Existing backoff and competing connections are joined rather than
replaced, provided their handshake uses the current token. This passive check
can observe buffered traffic and does not change RPC acknowledgement timeouts.
Close/destroy cancels recovery waits and prevents late asynchronous replacement.
See [the browser wake recovery contract](../../specs/2026-10-02-browser-wake-recovery.md).

## Contract surfaces

- `src/` may use internal organization suited to implementation.
- `dist/` and `package.json` exports are the package contract.
- ESM imports and generated declarations must resolve without consumer aliases.
- Browser consumers import compiled exports, never `node_modules/typeferry/src`.

## Compiler contract

`typeferry-ts/tsconfig.json` is the single typechecking authority for all
package source and tests. It enables the strict compiler family, implicit-any
checking, unchecked-index checking, exact optional-property checking, and
unknown catch variables. `tsconfig.build.json` extends that contract and only
changes emission and production-file selection; it must not weaken type safety.

The standalone `template/` remains independently compilable and owns its own
application configuration.

## Testing architecture

- Unit runner: pure/local behavior and EJSON fixture coverage.
- Integration runner: server/client transports, cross-language checks, and React real-server integration.
- Browser runner: Playwright-backed browser behavior.
- `src/test/test-utility.ts`: shared high-level server/client setup.

Use focused tests near the changed runtime boundary, then run the split suites and release-surface checks required by the scoped instructions.

Optional packaged clients use explicit backend origins and native HTTP session
transport. See [iOS applications](../typescript/ios-applications.md) and
[native authentication](../typescript/native-authentication.md). Product identity,
endpoints, signing, authorization policy, and grant storage remain application-owned.

## Simulator tooling boundary

The application CLI exposes `native devices`, `doctor`, `run`, `logs` and
`screenshot` for iOS. `native-devices.ts` validates `simctl` JSON and performs
explicit, deterministic device selection; ambiguity is an error.
`native-simulator-settings.ts` resolves app-owned Xcode settings and identifies
the simulator application product by bundle identifier. `native-command.ts`
executes argument arrays without a shell, propagates failures and cancellation,
and bounds captured diagnostics. The doctor checks local prerequisites without
repairing the environment or validating distribution credentials.

The run workflow owns rebuilding the iOS client, syncing the conventional
Capacitor scaffold, booting the selected simulator, ad-hoc signing, installing
and launching. It opens Simulator.app unless `--headless` is supplied; the
existing `native open ios` remains the Xcode-opening workflow. Logs and
screenshots require a booted selected device. Screenshots use a unique path
under DerivedData by default and never overwrite existing output files.

Typed `client.targets.ios.xcode` fields select a project or workspace, scheme,
configuration and DerivedData directory; `simulator.device` supplies an optional
default selector overridden by `--device`. These settings configure the build
container, not the location of the generated `ios/App` scaffold. Product
identity, native signing settings, entitlements and app data remain app-owned.
There is no automatic distribution or publication path. See the
[iOS simulator workflow](../typescript/ios-applications.md#simulator-workflow)
for commands, defaults and machine-readable output options.

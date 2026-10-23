---
status: proposed
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-10-22
updated: 2026-10-22
owner: typescript-client
implementation:
  commits: []
---

# Opt-in client request admission

## Outcome and approval boundary

An application can hold unsent RPCs during its existing authentication recovery,
cancel obsolete work, and dispatch once with current credentials within the
caller's timeout. TypeFerry provides the send boundary; application auth remains
the policy owner. This public API proposal requires approval before implementation
or release. It does not block independent consumer lifecycle fixes.

## Demonstrated gap

`typeferry-ts/src/client/client.ts` has no awaited pre-dispatch extension.
`OUTBOUND_MESSAGE` is a synchronous notification whose return values are ignored.
`httpFetch` covers only HTTP, after headers and serialized context are captured.
`call()` checks initialization, not authenticated readiness; `void()` bypasses
initialization. Initialization waiting does not consume the acknowledgement
budget, and an initialization waiter survives logout. `Client.fetch()` bypasses
both paths. Existing auth policy cannot safely cover these through supported
configuration alone.

Temporary focused tests against production `Client` with existing mocked socket
infrastructure demonstrated four missing behaviors: unauthenticated initialized
calls dispatch immediately; void sends before initialization; a pending call
sends after logout and subsequent initialization; a 900ms initialization wait
still passes the full 2000ms timeout to the socket. All four diagnostic assertions
failed while the existing 50 tests passed. The probes were removed afterwards.

## Proposed public surface

Names and semantics below are proposed, not implemented:

```typescript
export type DispatchRequest = {
  readonly method: string
  readonly kind: 'call' | 'void'
  readonly deadline: number
  readonly signal: AbortSignal
}

export type DispatchAdmission = {
  readonly signal?: AbortSignal
}

// Additional optional ClientOptions property:
beforeDispatch?: (
  request: DispatchRequest,
) => DispatchAdmission | void | Promise<DispatchAdmission | void>

// Additional optional CallOptions property:
signal?: AbortSignal
```

`deadline` is an absolute `Date.now()` timestamp established at call entry.
The request signal is aborted by caller cancellation, timeout, or client close.
The optional returned signal binds dispatch and completion to an application
session: the hook captures that session before waiting and returns its existing
invalidation signal. This prevents a resolved admission from sending after an
account transition, including transitions between hook completion and dispatch.
The application owns releasing its wait listeners and rejecting pending admission
when its captured session ends. No framework session generation is introduced.

## Dispatch contract

- Opt-in only: clients without the hook retain current behavior. `signal` is
  additive. Configuring admission opts into one total timeout budget across
  admission, initialization, dispatch, and response, including HTTP fallback.
- Invoke once per logical request before payload/context capture. A hook must
  return immediately for bootstrap, refresh, login, logout, and subscription
  control requests that recovery itself needs; it must also admit public calls.
  TypeFerry does not classify application methods or infer auth requirements.
- Abort/deadline checks occur after every asynchronous wait and immediately
  before send. Return fresh credentials from current client context at send.
  Reject unsent work on cancellation; a late hook resolution cannot dispatch it.
- Check both the caller and admitted session signals before delivering results.
  Cancelling a sent request rejects local completion and never resends it. The
  server may already have performed the operation; cancellation is not rollback.
- Admission errors never enter the transport retry loop. Default zero RPC retries
  remains unchanged. The consumer removes unsafe explicit retry settings where
  required; TypeFerry does not infer idempotency or silently replay writes.
- `Client.fetch()` has a distinct URL/RequestInit contract. Do not pretend the RPC
  hook covers it. Add admission for this path only after demonstrating an
  affected consumer and reviewing a URL-aware extension separately. This proposal
  covers HTTP RPC fallback through `call()` and `void()`.

## Acceptance and focused checks

1. A held call and void request each send once after release with current context;
   public/control requests continue and recovery does not deadlock.
2. Caller abort, session abort, close, and timeout reject held work; releasing
   admission afterwards produces zero sends. Session abort between admission
   resolution and send also produces zero sends.
3. Admission and initialization consume the original budget. HTTP fallback and
   socket acknowledgement cannot extend it; cancelled HTTP work is aborted.
4. An already sent write rejected on connection loss is not replayed with default
   options. Replies from an invalidated session cannot settle as successful.
5. An unconfigured client preserves existing public/initialization behavior.

Use controlled clocks and existing client/socket/HTTP suites. Add the four
regressions first, then race and compatibility checks above. Run affected split
suites, lint, typecheck, build and package verification before publication, plus
repository-required release checks. No server protocol, cookies, stored formats,
new dependencies, auth policy, request outbox, or general retry system changes.

## Verification status and rollback

Executed in `typeferry-ts/` with Node 24.19.0 and npm 11.17.0:
`npm run test:unit -- src/client/client.unit.spec.ts src/client/client-socket.unit.spec.ts src/client/client-http.unit.spec.ts`:
76 tests passed after removing diagnostics. Proposed acceptance checks remain
unimplemented. No product API, package version, release, or production behavior
has changed. Removing the optional hook restores prior behavior; published
consumers can revert their package upgrade without a data migration.

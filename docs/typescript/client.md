# TypeScript Client

The core client works independently of React and can use WebSocket or HTTP calls against a TypeFerry server.

```ts
// client/typeferry.ts
import { Client } from 'typeferry/client'

export const client = new Client({
  host: window.location.hostname,
  port: 8002,
  httpPort: 8002,
  secure: window.location.protocol === 'https:',
  initialContext: { token: 'development-only-token' },
})
```

Only context keys allowed by the server are accepted. Never place long-lived credentials in source code or a WebSocket URL; the token above illustrates local development only.

## Call a method

```ts
interface GreetingInput {
  name: string
}

interface GreetingResult {
  message: string
}

const result = await client.call<GreetingInput, GreetingResult>(
  'greeting.hello',
  { name: 'Ada' },
)
```

Use `client.void(...)` when no result is needed. Call options can select HTTP behavior, caching, and other per-call controls; keep transport selection at the application boundary instead of duplicating method names.

## Optional request admission

`ClientOptions.beforeDispatch` lets the application await its existing recovery
operation before an RPC captures credentials or chooses a transport. The hook
receives `{ client, method, kind, deadline, signal }`; `kind` is `call` or `void`,
`deadline` is an absolute `Date.now()` timestamp, and `signal` is cancelled by the
request timeout, caller cancellation, or client close. Return
`{ signal: sessionSignal }` to bind dispatch and result delivery to the captured
application session. Reject pending admission when that session ends.

Admit public and recovery control methods immediately so they cannot wait on
recovery that needs those same methods. TypeFerry does not infer application auth
policy. Admission may run again if credentials change while it waits, or before
an explicitly configured transport retry. Rechecks keep the original deadline
and session cancellation boundaries; they do not send or replay requests.

With the hook configured, admission, initialization, HTTP fallback, and response
waiting share the caller's `timeout` budget (20 seconds by default). The optional
`CallOptions.signal` also enables bounded cancellation for an individual call
without configuring a hook. Aborted unsent work never dispatches later. Cancelling
a sent request only rejects local completion; it cannot undo server effects.
Default RPC retries remain zero; request retries only when the method is safe to
repeat. Arbitrary `Client.fetch()` and direct application HTTP calls are outside
this RPC admission boundary.

Admission and native HTTP cancellation use abort events and tolerate older
WebViews without `AbortSignal.reason` or `throwIfAborted`; newer static
`AbortSignal.any` and `AbortSignal.timeout` helpers are not required.

Clients without admission or a caller signal retain their existing lifecycle.
Token refresh also refuses to publish credentials or clear a newer session when
the client context changes while its refresh response is outstanding.

## Lifecycle

Create one client per browser application unless isolation is intentional. Observe its connection state, handle rejected promises, and close application-owned clients during teardown. For React UI state, prefer the [React hooks](react.md), which reuse this client rather than replacing it. Other UI frameworks can integrate directly with the framework-agnostic client lifecycle.

For live updates, see [events and channels](events-and-channels.md). For identity context and reconnection behavior, see [authentication](authentication.md).

<p align="center">
  <img
    src="docs/assets/typeferry-banner.webp"
    alt="TypeFerry carries typed real-time data from a server across a bridge to web, component, and mobile clients"
  >
</p>

# TypeFerry

Build a full-stack TypeScript application from one server contract.

Define a method on the server, validate its input at runtime, and call it from
the client with its path, parameters, and result inferred by TypeScript. The
same client handles HTTP, WebSockets, authenticated events, and live data;
React hooks turn those operations into application state.

TypeFerry also owns the development loop around that contract. One package
runs the client and server, configures their proxy, splits tests by runtime,
and builds both sides for production. There is no generated client to keep in
sync and no separate Vite or Vitest setup to assemble.

```sh
npm install typeferry
```

## Where TypeFerry shines

TypeFerry is designed for full-stack TypeScript teams that want to build a
feature once and carry its contract all the way to the interface.

### Ship a feature without building the plumbing first

A typical feature stays in one connected workflow:

```text
server method + Zod schema
            |
            v
inferred client path, input, and result
            |
            v
React loading, error, and result state
            |
            v
event invalidation or a live publication
```

There is no schema compiler or generated client artifact between those steps.
Rename a method, change its input, or change its result and TypeScript reports
affected client calls during development.

### Add real-time behavior without adding a second application model

RPC and real-time updates use the same server, client context, authentication
state, and serialization rules. A mutation can emit a private event after an
acknowledged write; React can then refresh the authoritative query. When a
screen needs finer-grained updates, an authorized MongoDB publication can send
an initial snapshot and apply changes over the same WebSocket connection.

That makes TypeFerry particularly useful for collaborative interfaces,
dashboards, inboxes, operational tools, and mobile companions where ordinary
request/response features gradually become live.

### Keep the application workflow as cohesive as the runtime

The package supplies the development server, client/server builds, proxying,
and unit, integration, and browser test projects. A conventional application
can start with three commands and no TypeFerry, Vite, or Vitest configuration:

```sh
typeferry develop
typeferry test
typeferry build
```

Configuration remains available when the defaults stop fitting. Production
startup, infrastructure, secrets, authorization policy, and database access
remain application-owned rather than hidden behind the framework.

### Grow beyond a browser-only TypeScript service

The framework-independent client works in browsers and Node.js, while React is
an adapter over that client rather than a separate runtime. The same React
application can also be packaged for iOS through the optional Capacitor tools.

For services that cross language boundaries, Python, Rust, and Go server
implementations target the same documented wire protocol and shared
conformance fixtures. TypeScript remains the reference and only currently
published package.

The [Go server candidate](typeferry-go/README.md) provides EJSON, typed RPC and
events, HTTP/WebSocket attachment, Redis propagation and authentication helpers
for an application-owned `net/http` host. It passes local shared-fixture,
race and real TypeScript-client checks locally and in CI. Its public API is
approved. [Go release tags remain uncreated](RELEASING.md#go-candidate-review).

### When it is a good fit

TypeFerry is strongest when your application has a Node.js and TypeScript
center of gravity, uses React or a framework-independent TypeScript client,
and benefits from typed RPC plus authenticated real-time updates. It is less
opinionated about deployment and persistence: use the production platform you
already trust, and use the optional MongoDB extension only when its
native-driver-first model fits the service.

## From a server method to a typed client call

Define a namespace, validate its network input with Zod, and infer the client
contract from the implementation:

```ts
// server/greeting.ts
import { Server, type ClientNode } from 'typeferry/server'
import {
  type InferNamespace,
  Method,
  Namespace,
  registerNamespace,
  Schema,
} from 'typeferry/server/decorators'
import { z } from 'zod'

const greetingSchema = z.object({
  name: z.string().trim().min(1),
})

type GreetingInput = z.infer<typeof greetingSchema>

@Namespace('greeting')
export class GreetingMethods {
  @Method()
  @Schema(greetingSchema)
  async hello(
    _client: ClientNode,
    input: GreetingInput,
  ): Promise<string> {
    return `Hello, ${input.name}!`
  }
}

export type GreetingApi = InferNamespace<GreetingMethods, 'greeting'>

const server = new Server({ host: '127.0.0.1', port: 8002 })

registerNamespace(GreetingMethods)
await server.isReady()
```

Parameterize the client with that exported type. The method path, input, and
result are now checked by TypeScript:

```ts
// client/greeting.ts
import { Client } from 'typeferry/client'
import type { GreetingApi } from '../server/greeting'

const client = new Client<GreetingApi>({
  host: '127.0.0.1',
  port: 8002,
})

const greeting = await client.m.greeting.hello({ name: 'Ada' })
//    ^? string
```

Decorators can also attach middleware, authentication requirements, caching,
and schemas to a namespace or method; application code retains authorization
decisions. Read the [server and RPC guide](docs/typescript/server-rpc.md) and
[client guide](docs/typescript/client.md) for the complete lifecycle.

## One framework from transport to UI

```text
Decorated Node.js methods
          │
          ├── HTTP RPC ───────────────┐
          ├── WebSocket RPC           │
          └── events and channels     │
                                      ▼
                         Typed TypeScript client
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                 React state hooks       framework-agnostic code
                         │
                         ▼
              browser or Capacitor iOS

MongoDB change streams ──► authorized live publications ──► React/client state
```

### Server and transport

- Namespaced RPC methods with Zod validation, middleware, protection, caching,
  rate limiting, and structured errors.
- HTTP and persistent WebSocket transports backed by one Node.js server.
- Server-to-client events, named channels, rooms, origin exclusion, and
  optional Redis propagation across server processes.
- EJSON serialization for dates, binary data, regular expressions,
  non-finite numbers, and application-defined types.

### Client and React

- A framework-independent TypeScript client for browsers and Node.js.
- Automatic connection lifecycle, retry and HTTP fallback controls, context,
  authentication state, logging, and channel subscriptions.
- React hooks for RPC state, lazy calls, debouncing, cache controls,
  event-driven refresh, subscriptions, reconnection state, and token refresh.

### Authentication and data

- JWT, sessions, secure-cookie helpers, token refresh, cross-tab synchronization,
  device metadata, and Google OAuth building blocks.
- A native-driver-first MongoDB extension with typed collections, indexes,
  Zod-to-BSON schema enforcement, timestamps, and change-stream events.
- Authorized live MongoDB publications that deliver an initial snapshot and
  apply added, changed, and removed operations over WebSocket, including
  bounded ordered windows and automatic resynchronization.

## Develop, test, and build an application

Applications can use conventional root-level `client/`, `common/`, `server/`,
and `test/` directories with no TypeFerry, Vite, or Vitest configuration:

```json
{
  "scripts": {
    "develop": "typeferry develop",
    "build": "typeferry build",
    "test": "typeferry test"
  }
}
```

- `typeferry develop` runs the Vite client and watched Node.js server with the
  development proxy configured for RPC traffic.
- `typeferry test unit`, `integration`, or `browser` selects the corresponding
  Vitest project; browser tests run through Playwright.
- `typeferry build` produces the Vite client and a bundled Node.js server for
  deployment.
- An optional typed `typeferry.config.ts` exposes supported ports, proxy routes,
  test configuration, build extensions, server externals, and application
  targets without handing ownership of the toolchain back to the application.

See the [application framework guide](docs/typescript/application-framework.md)
for conventions, configuration, migration, deployment boundaries, and
troubleshooting.

## Take the same client to iOS

The optional iOS target bundles an existing React client with Capacitor.
Ordinary web applications do not import Capacitor or pay for the native path.

```sh
npm exec -- typeferry build --target ios
npm exec -- typeferry native add ios
npm exec -- typeferry native doctor ios
npm exec -- typeferry native run ios
```

TypeFerry can generate and safely synchronize the conventional native bridge,
inspect available simulators, diagnose the local toolchain, build and launch an
app, stream its logs, and capture screenshots. Product identity, signing,
entitlements, native assets, physical-device testing, and distribution remain
application-owned. Read the [iOS application guide](docs/typescript/ios-applications.md)
and [native authentication guide](docs/typescript/native-authentication.md).

## Run the reference application

The repository includes a React, Node.js, and MongoDB application that shows a
protected mutation, an acknowledged database write, a private real-time event,
and authoritative UI refresh.

Prerequisites are Git, [Mise](https://mise.jdx.dev/), and Docker with Compose:

```sh
git clone https://github.com/leonardoventurini/typeferry.git
cd typeferry/template
mise install
mise exec -- npm ci
cp .env.server.example .env.server
docker compose up -d mongodb
mise exec -- npm run develop
```

Follow the [quickstart](docs/getting-started.md) to trace the request from React
through the typed server method, MongoDB, and the real-time invalidation path.

## One protocol, multiple server runtimes

TypeScript is the reference and only currently published package.
Python, Rust, and Go implement the same normative wire protocol.

| Implementation | Server | Client | UI adapter | Status |
|---|---:|---:|---|---|
| [TypeScript](typeferry-ts/README.md) | Node.js | Browser and Node.js | React | Published as `typeferry` |
| [Python](typeferry-py/README.md) | Yes | — | — | Publication disabled |
| [Rust](typeferry-rs/README.md) | Yes | — | — | Publication disabled |
| [Go](typeferry-go/README.md) | Yes | — | — | Approved API, no release tag |

All implementations share the normative [wire protocol](PROTOCOL.md),
[conformance fixtures](docs/conformance/README.md), and interoperability tests.
See [release status](RELEASING.md) for current publication details.

## Documentation

- [Quickstart](docs/getting-started.md)
- [TypeScript application framework](docs/typescript/application-framework.md)
- [Server and RPC](docs/typescript/server-rpc.md)
- [Client](docs/typescript/client.md)
- [React integration](docs/typescript/react.md)
- [Authentication](docs/typescript/authentication.md)
- [Events and channels](docs/typescript/events-and-channels.md)
- [MongoDB extension](docs/typescript/mongodb.md)
- [EJSON](docs/typescript/ejson.md)
- [Local document collections](docs/typescript/minimongo.md)
- [iOS applications](docs/typescript/ios-applications.md)
- [Native authentication](docs/typescript/native-authentication.md)
- [Deployment](docs/typescript/deployment.md)
- [Documentation home](docs/README.md)
- [AI agent application guide](docs/agents/application-development.md)
- [LLM documentation index](llms.txt)

## Repository layout

```text
typeferry-ts/   TypeScript application framework, client, and Node.js server
typeferry-py/   Python server implementation
typeferry-rs/   Rust server workspace
typeferry-go/   Go server module
template/       React, Node.js, and MongoDB reference application
docs/           User guides, architecture, protocol, and conformance docs
PROTOCOL.md     Normative wire protocol
```

## Contributing

Start with [the agent and contributor router](docs/agents/README.md), then read
the nearest `AGENTS.md` for the package you are changing. Protocol-visible
changes must update `PROTOCOL.md`, affected implementations, and shared fixtures
together.

TypeFerry is licensed under the [MIT License](LICENSE).

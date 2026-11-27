# Getting Started

This quickstart runs the TypeScript application template against TypeFerry's
current application framework.

## Prerequisites

- Git
- [Mise](https://mise.jdx.dev/)
- Docker with Compose support

The template pins its runtime in `template/.mise.toml` and uses its own npm project. Run all commands in this guide from `template/` unless stated otherwise.

## 1. Clone and install

```sh
git clone https://github.com/leonardoventurini/typeferry.git
cd typeferry/template
mise install
mise exec -- npm ci
```

The template installs the verified `typeferry` release tarball from GitHub Releases. Its lockfile
pins the `v0.17.0` release archive (`typeferry-0.17.0.tgz`) and its integrity digest.

## 2. Start MongoDB

```sh
docker compose up -d mongodb
```

The local database is a single-node replica set so change streams and transactions work like the production APIs they exercise.

## 3. Configure development values

```sh
cp .env.server.example .env.server
```

The included sample bearer token is a development seam only. Do not deploy it or treat it as an identity system.

## 4. Run the application

```sh
mise exec -- npm run develop
```

The development process starts the Node.js server and client development server. The server exposes:

- TypeFerry HTTP RPC at `/__h`.
- TypeFerry WebSocket transport at `/typeferry-ws`.
- Health status at `/healthz`.

Use the ports printed by the development process. The zero-config defaults are
owned by the installed TypeFerry package.
See the [application framework guide](typescript/application-framework.md) for
the complete command contract and optional configuration.

## 5. Trace one RPC call

The example flow is:

1. `client/app.tsx` calls `useMethod({ method: 'messages.list' })`.
2. `server/methods/messages.ts` registers `MessagesMethods` under the `messages` namespace.
3. TypeFerry dispatches `messages.list` with an authenticated `ClientNode`.
4. The method returns EJSON-compatible data to the hook.
5. Mutations emit `messages:changed`; the hook refreshes authoritative state.

Read [server and RPC](typescript/server-rpc.md) and [React integration](typescript/react.md) to build the same flow in your application.

## 6. Verify the template

```sh
mise exec -- npm run format:check
mise exec -- npm run lint
mise exec -- npm run typecheck
mise exec -- npm test
mise exec -- npm run build
```

Browser tests require Playwright's Chromium dependencies. MongoDB integration tests require the local replica set.

## Next steps

- [Understand the application framework](typescript/application-framework.md)
- [Configure the TypeScript client](typescript/client.md)
- [Define RPC methods](typescript/server-rpc.md)
- [Replace sample authentication](typescript/authentication.md)
- [Understand event invalidation](typescript/events-and-channels.md)
- [Prepare deployment](typescript/deployment.md)

For Python or Rust servers, continue with the [Python guide](../typeferry-py/README.md) or [Rust guide](../typeferry-rs/README.md).

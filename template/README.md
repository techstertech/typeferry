# TypeFerry React + MongoDB template

A production-minded starter for a typed TypeFerry application. It includes a
React and Tailwind client, package-managed development server, Node/TypeFerry backend,
official MongoDB driver, protected RPC methods, owner-scoped real-time events,
ordered migrations, structured logs, and split Vitest coverage.

## Requirements

- [Mise](https://mise.jdx.dev/)
- Docker with Compose

The project pins Node 26.5.1 through `.mise.toml` and uses its bundled npm
11.17.0. MongoDB is published only on `127.0.0.1:27018` to avoid remote access
and collisions with a conventional local MongoDB on 27017. The commands below assume Mise's shell
activation is enabled; in non-interactive automation, prefix them with
`mise exec --`.

## Start the template

```sh
mise install
npm ci
cp .env.server.example .env.server
docker compose up -d mongodb
npm run develop
```

Open <http://localhost:8000>. TypeFerry serves the React client and proxies TypeFerry
HTTP traffic to the backend on port 8002. WebSocket traffic connects directly
to port 8002 during development.

The Compose service initializes a single-node `rs0` replica set. The example
connection uses `directConnection=true`, enabling change streams and
transactions while keeping local member discovery stable.

The local database has no authentication. Keep its published port on loopback.
Configure authentication before allowing remote database access.

## Sample architecture

Application code is intentionally flat beneath the project root: React lives
in `client/`, portable contracts in `common/`, Node-only code in `server/`, and
shared test setup in `test/`. The `@/` alias resolves to the project root, so
layer-qualified imports such as `@/common/messages` remain explicit without an
intermediate `src/` directory.

The `messages` namespace demonstrates the intended flow:

1. The TypeFerry server authenticates the development token and exposes protected
   `messages.list` and `messages.create` methods.
2. `messages.create` inserts through the official MongoDB driver.
3. After the acknowledged write, the server emits `messages:changed` on the
   authenticated owner's private channel.
4. React receives the event through `useRemoteEvent` and refetches the
   authoritative list instead of treating the event payload as durable state.

The committed token is intentionally limited to local template development.
Replace this seam with the application's real authentication provider before
shipping.

## Commands

The core workflow is available through `just`:

```sh
just install
just develop
just test
just lint
just typecheck
just build
just docker-build
just docker-run
```

The recipes delegate to the same npm and Docker commands shown below, so either
interface remains suitable for automation.

```sh
npm run develop          # Vite + watched Node backend
npm run test:unit        # pure/config tests
npm run test:integration # replica-set MongoDB tests
npm run test:browser     # Chromium React tests
npm run typecheck
npm run lint
npm run format:check
npm run build
npm audit --audit-level=low
```

Integration tests use an isolated in-memory replica set and do not modify the
Compose database. Browser tests run in a real headless Chromium environment,
not jsdom.

TypeFerry owns the Vite and Vitest configuration behind these commands. Add an
optional `typeferry.config.ts` only when overriding supported framework
defaults.

## Environment

Server configuration is validated at startup:

- `CLIENT_ORIGIN`: allowed browser origin.
- `DATABASE_URL`: MongoDB replica-set connection string.
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`.
- `NODE_ENV`: `development`, `test`, or `production`.
- `PORT`: TypeFerry HTTP/WebSocket port.
- `SAMPLE_AUTH_TOKEN`: development authentication token, at least 16 characters.

The client uses `VITE_SERVER_PORT` and `VITE_SAMPLE_AUTH_TOKEN` when provided;
their development defaults match `.env.server.example`.

## Production build

`npm run build` writes the Vite client to `dist/client` and bundles the Node
entry and its runtime dependencies to `dist/server/index.cjs`. Bundling keeps
CommonJS-only transitive packages interoperable with the Node server while the
application source remains ESM. Run the server with:

```sh
npm start
```

`npm start` serves `dist/client` and TypeFerry from the same Node process. Keep
`.env.server` and all real credentials out of version control.

## Production container

The multi-stage Docker image builds the React client and bundled Node server,
then copies only `dist` into a non-root runtime image. TypeFerry's Hono app serves
the Vite assets, SPA routes, `/healthz`, RPC, and WebSocket traffic on one port.

```sh
docker build -t typeferry-template .
MONGODB_NETWORK=$(docker inspect \
  --format '{{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}' \
  "$(docker compose ps --quiet mongodb)")
docker run --rm \
  --network "$MONGODB_NETWORK" \
  --env-file .env.server \
  --env CLIENT_ORIGIN=http://localhost:8002 \
  --env 'DATABASE_URL=mongodb://mongodb:27017/typeferry-template?replicaSet=rs0&directConnection=true' \
  --publish 8002:8002 \
  typeferry-template
```

Container environments should inject configuration through Docker or the
deployment platform; `.env.server` is not copied into the image. `/healthz`
checks the live MongoDB connection and drives the image health check.
Start the Compose database before this command. The application container joins
its existing network and uses the `mongodb` service name. The host port remains
available only on loopback for applications running outside Docker.

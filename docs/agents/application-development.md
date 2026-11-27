# Build TypeFerry applications with an AI coding agent

Use this guide when an AI coding agent is creating or changing a consumer
application built with the published TypeScript package. For work on the
TypeFerry repository itself, use the separate
[maintainer task router](README.md).

## Start with the supported path

Prefer the [application template](../../template/README.md) when starting a
React and MongoDB application. It is executable reference code, not framework
source to import. For an existing application, install the verified release tarball:

```sh
npm install https://github.com/techstertech/typeferry/releases/download/v0.17.0/typeferry-0.17.0.tgz
```

Before editing, inspect the application's `package.json`, nearest `AGENTS.md`,
runtime manager, existing directory layout, environment contract, and tests.
Preserve application-owned choices unless the user asks to replace them.

Do not import TypeFerry's repository source, copy files from `dist/`, or invent
exports. Use only paths declared by the installed package:

| Concern                    | Public import                 |
| -------------------------- | ----------------------------- |
| Framework-agnostic client  | `typeferry/client`            |
| Node.js server             | `typeferry/server`            |
| RPC decorators             | `typeferry/server/decorators` |
| Transport adapters         | `typeferry/server/transports` |
| React integration          | `typeferry/react`             |
| Authentication             | `typeferry/auth`              |
| EJSON                      | `typeferry/ejson`             |
| MongoDB extension          | `typeferry/mongodb`           |
| Application configuration  | `typeferry/config`            |
| Vitest-compatible test API | `typeferry/test`              |

Consult the installed `typeferry/package.json` when validating an import not
listed here. Internal file paths are not public contracts.

## Conventional application contract

The canonical [application framework guide](../typescript/application-framework.md)
documents the complete CLI, configuration, migration, and troubleshooting
contract. The essentials for agent execution follow.

The package-owned commands understand this root-level structure:

```text
client/              browser and React code
  index.html          required client entry
common/              portable types, constants, and schemas
server/              Node-only code
  index.ts            required server entry
test/                optional shared test setup
dist/                 generated build output
```

The `@/` alias resolves to the application root. Keep portable contracts in
`common/`; browser code must not import Node-only `server/` modules. TypeFerry
does not currently scaffold these files or own the application's TypeScript,
ESLint, Prettier, runtime-manager, environment, Docker, or Compose setup.

Use these scripts unless the application already has equivalent wrappers:

```json
{
  "scripts": {
    "develop": "typeferry develop",
    "build": "typeferry build",
    "test": "typeferry test",
    "test:unit": "typeferry test unit",
    "test:integration": "typeferry test integration",
    "test:browser": "typeferry test browser"
  }
}
```

`typeferry develop` runs the browser application and watched Node server.
Arguments following `--` go to the server. `typeferry build` writes the client
to `dist/client/` and the server bundle to `dist/server/index.cjs`; production
startup remains application-owned.

## Configure only when necessary

Do not create `typeferry.config.ts` for a conventional application. When a
supported default must change, use only the typed high-level fields below:

```ts
import { defineConfig } from 'typeferry/config'

export default defineConfig({
  development: {
    clientPort: 8000,
    serverPort: 8002,
    serverEnvironmentFile: '.env.server',
  },
  build: {
    target: 'es2023',
    sourceMaps: true,
  },
  test: {
    integration: { timeout: 30_000 },
    browser: { browser: 'chromium' },
  },
})
```

The browser may be `chromium`, `firefox`, or `webkit`. Unknown keys fail
validation. Do not add raw Vite or Vitest configuration alongside the
framework commands; first verify that the requested behavior is supported by
`TypeFerryConfig`.

Configure Tailwind v4 in the client stylesheet. Keep `@import "tailwindcss"`
and add CSS-first `@theme`, `@source`, or `@plugin` directives there. If a
legacy root `tailwind.config.js` is unavoidable, load it explicitly from
`client/styles.css` with `@config "../tailwind.config.js"`. Do not add Tailwind
options to `typeferry.config.ts` or attempt to pass a configuration object to
the Tailwind Vite plugin.

## Implement one vertical slice

For a new RPC feature, keep one end-to-end contract visible:

1. Define portable input, result, event names, and runtime schemas in
   `common/`.
2. Implement and register a namespace under `server/` using public decorators.
3. Validate every network input at runtime; TypeScript types are not runtime
   validation.
4. Configure authentication centrally, then enforce resource authorization
   inside protected methods.
5. Export the inferred namespace API type for typed consumers.
6. Call it through `typeferry/client` or `typeferry/react` and handle loading,
   error, reconnecting, and empty states.
7. Test the smallest behavior first, then expand to the affected project.

Use server events as invalidations when durable data has another source of
truth. Emit only after a successful write, scope protected events to the
authorized identity or room, and refetch authoritative state in the client.

Detailed contracts and examples:

- [Server and RPC](../typescript/server-rpc.md)
- [Client](../typescript/client.md)
- [React](../typescript/react.md)
- [Authentication](../typescript/authentication.md)
- [Events and channels](../typescript/events-and-channels.md)
- [MongoDB](../typescript/mongodb.md)
- [EJSON](../typescript/ejson.md)
- [Deployment](../typescript/deployment.md)

## Test by project

Name tests according to the environment they require:

| Test kind                    | Filename                   | Command                      |
| ---------------------------- | -------------------------- | ---------------------------- |
| Pure or non-DOM              | `*.unit.spec.ts(x)`        | `typeferry test unit`        |
| Database/service integration | `*.integration.spec.ts(x)` | `typeferry test integration` |
| Real browser and React       | `*.browser.spec.tsx`       | `typeferry test browser`     |

Optional setup files are `test/setup-unit.ts`, `test/setup-integration.ts`, and
`test/setup-browser.ts`. Import test APIs from `typeferry/test`. Browser tests
also have Vitest globals because browser mocking cannot be reliably mirrored
through a re-export; use the global `vi` there.

Do not replace integration tests with mocks when the behavior depends on a
database, transaction, change stream, transport, or process lifecycle. Do not
use a DOM shim in place of the real browser project.

## Security and production boundaries

- Never copy sample tokens, secrets, origins, or database credentials into a
  production configuration.
- `@Protected()` requires authentication but does not prove authorization for
  a requested resource.
- Allow only necessary context keys and origins.
- Keep secrets in runtime environment injection, not browser source or image
  layers.
- Provide readiness for critical dependencies and graceful shutdown for the
  server and application-owned resources.
- Verify WebSocket upgrades as well as HTTP routes behind a production proxy.
- Use shared event propagation when clients on different replicas must observe
  the same events.

## Agent completion contract

Before claiming completion, report which checks actually ran and any skipped
checks or environmental limitations. For a normal application change, run the
narrowest relevant test first and then, when the application defines them:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:browser
npm run build
npm audit --audit-level=low
```

Confirm that `dist/client/` and `dist/server/index.cjs` exist after a successful
build. For deployment changes, also start the production artifact, check its
readiness endpoint, exercise an RPC request and WebSocket connection, and
confirm the process runs with the intended identity and injected environment.

Stop and ask for direction before changing authentication architecture,
persisted data formats, production dependencies, deployment topology, or a
public contract. Do not silently broaden a feature request into framework or
infrastructure replacement.

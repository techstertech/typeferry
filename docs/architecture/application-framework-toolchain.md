# TypeFerry application framework architecture

Status: implemented in `typeferry@0.8.0` under the
[package-owned application commands decision](../../decisions/2026-09-03-package-owned-application-commands.md).
This document is informative and does not supersede package contracts or the
wire protocol. Application developers should use the
[public framework guide](../typescript/application-framework.md).

## Summary

TypeFerry simplifies application setup by keeping its established
development, production-build, and test conventions into the distributed
`typeferry` release package.

A conventional application does not need a TypeFerry configuration file.
The framework understands the root-level `client/`, `common/`, `server/`,
and `test/` directories automatically. Applications create an optional
`typeferry.config.ts` only when they need supported customization.

The normal application scripts become:

```json
{
  "scripts": {
    "develop": "typeferry develop",
    "build": "typeferry build",
    "test": "typeferry test"
  }
}
```

## Desired outcome

Application authors can install TypeFerry, create the standard
source directories, and run development, builds, and tests without copying
TypeFerry-specific Vite, Vitest, proxy, or process-orchestration files.

An upgrade to `typeferry` carries compatible Vite, Vitest, build, and
development behavior without requiring applications to synchronize copied
configuration.

## Scope

TypeFerry owns:

- `typeferry develop`.
- `typeferry build`.
- `typeferry test` and its unit, integration, and browser projects.
- Vite development and client-build configuration.
- Server bundling and development watch behavior.
- The TypeFerry HTTP development proxy.
- Development process lifecycle and signal handling.
- Test discovery and required framework test setup.
- An optional typed `typeferry.config.ts` contract.
- A supported test API exported from `typeferry/test`.

Applications continue to own:

- TypeScript configuration and type-checking commands.
- ESLint and Prettier configuration and commands.
- Runtime selection through Mise.
- npm policy and the package lock.
- Production Docker configuration.
- The MongoDB Compose service and other application infrastructure.
- Application environment files and secrets.
- Application-specific test setup.

## Explicitly deferred

This proposal does not include:

- A bundled Node.js runtime, native launcher, or installer.
- TypeScript, ESLint, or Prettier presets.
- Managed dotfiles, synchronization, or configuration migrations.
- Dockerfile or Compose generation.
- Container lifecycle commands.
- A development Docker image or Compose development service.
- Scaffolding or automatic dependency installation.

These concerns may be evaluated independently after the smaller framework
surface is stable. They must not shape the initial APIs speculatively.

## Conventional project structure

The framework recognizes these paths relative to the application root:

| Concern | Default path |
|---|---|
| Browser application | `client/` |
| Portable contracts | `common/` |
| Node.js application | `server/` |
| Shared test support | `test/` |
| Client HTML entry | `client/index.html` |
| Server entry | `server/index.ts` |
| Build output | `dist/` |

The root alias `@/` resolves to the application root so imports retain their
explicit architectural layer names.

The CLI must resolve the application root deliberately rather than assuming
that every invocation starts in the current working directory. Missing or
ambiguous roots must produce actionable diagnostics.

## Optional configuration

No `typeferry.config.ts` is required for the defaults. If the file exists, the
CLI loads and validates it before starting any tool.

An illustrative customized application is:

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
    integration: {
      timeout: 30_000,
    },
    browser: {
      browser: 'chromium',
    },
  },
})
```

The configuration contains typed, high-level TypeFerry concepts. It must not
expose raw Vite or Vitest configuration objects. This boundary lets TypeFerry
update its underlying tools without inheriting their complete public
configuration surfaces.

The initial public configuration should remain intentionally small. New fields
should be added only for demonstrated application needs.

## Package architecture

The TypeScript package contains internally isolated application and CLI modules:

```text
typeferry
├── runtime
│   ├── client
│   ├── server
│   ├── react
│   └── mongodb
├── application
│   ├── config
│   ├── paths
│   ├── develop
│   ├── build
│   └── test
└── cli
```

Runtime exports must never import application-tooling modules. Command modules
load Vite, Vitest, esbuild, and plugins only when invoked. Browser and server
consumers must not execute or bundle CLI implementation.

The package adds a binary and explicit public exports:

```json
{
  "bin": {
    "typeferry": "./dist/cli/index.js"
  },
  "exports": {
    "./config": "...",
    "./test": "..."
  }
}
```

`defineConfig`, its configuration types, the test export, CLI commands,
default paths, test naming conventions, and build output become public package
contracts. Implementation requires the normal approval and compatibility care
for public API changes.

## Development command

`typeferry develop` replaces `develop.ts`, `vite.config.ts`, and the
application-owned development proxy.

It owns:

- Vite startup with automatic `vite.config.*` discovery disabled.
- React and Tailwind Vite plugins.
- The `@/` root alias and React singleton resolution.
- The TypeFerry HTTP development proxy.
- Client host, port, HMR, and watch defaults.
- Initial server compilation and subsequent watch builds.
- The bundled CommonJS server output used by the current template.
- Backend child-process startup and restart behavior.
- Tagged server output and the development log.
- Graceful shutdown and process-tree cleanup.

Arguments after `typeferry develop --` are forwarded to the server entry
consistently with the existing development script.

The implementation preserves the current defaults unless a focused change is
approved:

- Client port `8000`.
- Server port `8002`, supplied through the server environment.
- Client root `client/`.
- Server entry `server/index.ts`.
- Server development output `dist/server/index.cjs`.
- Server environment file `.env.server`.

## Production build command

`typeferry build` replaces direct Vite and esbuild scripts while preserving
the current artifacts:

```text
validate conventional inputs
    ↓
clean framework-owned dist output
    ↓
build client into dist/client
    ↓
bundle server into dist/server/index.cjs
    ↓
validate the client manifest and server entry
```

The client build retains React and Tailwind processing,
`client/index.html` as its entry, the root alias, an asset manifest, and the
current ECMAScript target.

The server build retains bundling, CommonJS output, source maps, Node platform
semantics, and the decorator compatibility setting required by the template.

Production startup remains application-owned. The existing
`node dist/server/index.cjs` script and production Dockerfile continue to
consume the stable build artifacts.

## Test command and API

`typeferry test` replaces the three application-owned Vitest configuration
files with package-owned named projects:

```sh
typeferry test
typeferry test unit
typeferry test integration
typeferry test browser
typeferry test unit --watch
```

The projects preserve the established conventions:

- `*.unit.spec.ts(x)` runs in the unit project.
- `*.integration.spec.ts(x)` runs serially with integration setup, decorator
  transformation, and current timeouts.
- `*.browser.spec.ts(x)` runs in headless Playwright Chromium with React and
  Tailwind processing.
- Discovery covers `client/`, `common/`, `server/`, and `test/`.
- Application setup modules augment mandatory framework behavior.

Applications must not rely on npm hoisting to import TypeFerry's transitive
Vitest installation. TypeFerry exports the supported authoring API:

```ts
import { describe, expect, it } from 'typeferry/test'
```

The export mirrors the installed Vitest API so tests do not depend on npm
hoisting. Individual mirrored exports follow Vitest and do not carry an
independent TypeFerry compatibility guarantee. Browser and component-testing
libraries outside Vitest remain explicit application dependencies.

## Development Docker removal

The application template removes:

- `Dockerfile.development`.
- The Compose `development` service.
- The development `node_modules` volume.

Local development runs through `typeferry develop` under the Mise-selected
Node runtime. Compose remains for MongoDB and retains its single-node replica
set, persistent data volume, health check, and host port.

The production Dockerfile remains application-owned and runs
`typeferry build` through the package script during its build stage. It then
copies the stable `dist/` output into the non-root runtime stage.

## Dependency and upgrade policy

Vite, Vitest, esbuild, React and Tailwind Vite plugins, the Playwright Vitest
provider, decorator transformation support, and process-management helpers are
TypeFerry implementation dependencies when needed solely by these commands.

Dependencies imported by application source remain application dependencies.
This includes React, React DOM, MongoDB, Zod, Testing Library, and Playwright
when applications use their APIs directly.

The one-package choice increases installation weight for runtime-only
consumers. The initial implementation accepts that tradeoff for simpler setup,
while release inspection enforces separation between runtime and tooling code.

The intended upgrade installs the target GitHub Release tarball:

```sh
npm install https://github.com/techstertech/typeferry/releases/download/v<version>/typeferry-<version>.tgz
npm test
npm run build
```

The lockfile records the resolved framework and toolchain graph. Minor releases
may update internal tools only while observable command and artifact contracts
remain compatible. Breaking configuration, command, test, or output changes
require an appropriate TypeFerry version boundary and migration documentation.

## Test strategy

Tests should use a procedurally created consumer application, not only the
repository's installed package tree.

Verification layers are:

1. Unit tests for root discovery, defaults, configuration validation, command
   parsing, and process lifecycle.
2. Command integration tests for development orchestration and named test
   projects.
3. Build integration tests asserting client manifest and server artifacts.
4. Template tests confirming obsolete configs, scripts, proxy, and development
   container files are absent.
5. Packed-package tests installing `npm pack` output into a temporary consumer
   and running development, builds, and all test projects.
6. Package inspection proving runtime entries contain no application tooling.

Development verification must cover clean signal shutdown, backend failure
propagation, initial compiler errors, proxy routing, and watch rebuilds.

## Delivery sequence

Implementation should proceed through three independently verifiable units:

1. Configuration resolution, CLI routing, `develop`, and `build` with
   consumer fixtures.
2. Named Vitest projects and the `typeferry/test` authoring API.
3. Template migration, development Docker removal, documentation, and complete
   packed-consumer verification.

Each unit requires a specification before implementation and a decision record
when its final public contracts are accepted.

## Acceptance criteria

- A conventional application needs no `typeferry.config.ts`.
- `typeferry develop`, `typeferry build`, and `typeferry test` work from a
  packed package installed in a standalone consumer fixture.
- Applications can add a typed `typeferry.config.ts` for high-level overrides.
- The template no longer contains `develop.ts`, `vite.config.ts`, split
  Vitest configs, or the development proxy.
- The template no longer contains a development Dockerfile or Compose
  development service.
- Unit, integration, and browser test behavior remains equivalent.
- Tests import supported runner APIs from `typeferry/test` without a direct
  Vitest dependency.
- TypeScript, ESLint, Prettier, Mise, npm policy, production Docker, and MongoDB
  Compose behavior remain application-owned.
- Development shutdown, backend failure, proxy, and watch behavior remain
  observable and tested.
- Production artifacts remain compatible with the existing startup script and
  Dockerfile.
- Runtime exports and bundles contain no application-tooling implementation.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tool dependencies increase installation size. | Keep scope narrow, lazy-load tools, and inspect runtime bundles. |
| Tool options become accidental public APIs. | Expose typed TypeFerry concepts, not raw configurations. |
| Test re-exports lag behind Vitest use cases. | Start with an explicit supported inventory and expand deliberately. |
| CLI behavior differs from the existing template. | Capture process, proxy, watch, test, and artifact behavior first. |
| Zero-config discovery becomes surprising. | Keep one convention and provide actionable validation errors. |
| Production Docker drifts from build output. | Treat output paths as contracts and retain a container smoke test. |

## Architectural principle

The governing principle is:

> TypeFerry owns only the application machinery currently copied for
> development, production builds, and tests. Applications retain control of
> general code quality, runtime selection, and deployment infrastructure.

This boundary removes the highest-value boilerplate without turning TypeFerry
into a Node.js distribution, general-purpose toolchain manager, or container
platform.

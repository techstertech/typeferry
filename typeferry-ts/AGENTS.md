# TypeScript Package Agent Instructions

These instructions apply under `typeferry-ts/` and extend the repository root instructions.

## Toolchain and commands

- Use exact Node.js `24.19.0` and npm `11.17.0`.
- For nested launchers, prepend the pinned Node and npm directories to `PATH`.
  Invoke npm through the pinned Node with `mise exec -- node "$(mise which npm)"`.
- Run every npm command with `typeferry-ts/` as the working directory.
- Treat `package-lock.json` as authoritative. Use `npm ci` for immutable installs and npm commands for dependency changes so the manifest and lockfile remain synchronized.
- Use the split runners: `npm run test:unit`, `npm run test:integration`, and `npm run test:browser`. `npm test` runs all three.
- Release-surface verification is `npm run build` followed by `npm pack --dry-run`.

## Architecture

- `src/client/` and `src/server/` contain the core runtime. Keep the React adapter thin and transport-agnostic. Other UI frameworks integrate through the core client rather than package-owned adapters.
- `src/utils/` and `src/ejson/` own shared protocol helpers and serialization.
- `src/auth/client/` and `src/auth/server/` form a separate auth slice; avoid coupling auth policy to transport internals.
- `src/server/decorators/` owns registration metadata, method/event modules own RPC primitives, and `src/server/transports/` owns Node.js transports.
- The server is Node.js-only. `NodeHonoTransport` owns the Hono app and HTTP listener; `WebSocketTransport` attaches upgrades to that listener before it accepts traffic.
- `src/mongodb/` is an optional extension over the official MongoDB driver. Do not turn it into an ORM or hide native driver behavior.
- `src/` is implementation; built ESM and declarations in `dist/` are the consumer contract. Consumers must never require aliases into package source.

Read [docs/architecture/typescript-runtime.md](../docs/architecture/typescript-runtime.md) before changing ownership boundaries or transport lifecycle.

## Type and quality contracts

- Preserve strict TypeScript and ESM-safe imports. Avoid `any`, unchecked casts, runtime detection, and alternate server-framework ambient types.
- Put `*.browser.spec.ts(x)` only in the Playwright-backed browser runner.
- Keep `*.integration.spec.ts` and `src/react/index.test.tsx` in the integration runner.
- Real-server React integration tests use the Node `ws` implementation while hooks run in jsdom.
- Reuse `src/test/test-utility.ts` for higher-level server/client tests.
- Preserve monotonic change tokens for `useObject`; millisecond timestamps alone are insufficient.
- Preserve `useConnectionState.isReconnecting` and the local throttle contract where `leading: false` still schedules a trailing call.
- Keep `.github/workflows/ci.yml` aligned when browser dependencies or split-suite behavior changes.

## Verification

Run the affected split suite first. Before handing off a substantive package change, run:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Disclose any suite skipped because its external MongoDB, Redis, browser, Python, or Rust prerequisites were unavailable.

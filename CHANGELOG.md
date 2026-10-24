# Changelog

## 2026-10-24

- security(server): bypass method caching for authenticated calls
- security(deps): update zod and undici to patched releases
- test(server): reproduce cached method authorization gaps

## 2026-10-22

- feat(client): add opt-in bounded RPC admission and cancellation
- fix(client): support cancellation on older native WebViews
- fix(auth): prevent obsolete refresh results from replacing a newer session

## 2026-10-21

- feat(server): revalidate event permissions before delivery
- security(deps): patch vitest and refresh safe hono and vite resolutions

## 2026-10-02

- feat(http): add host-aware development proxy and route body ceilings
- fix(client): preserve live sockets and deduplicate browser wake recovery

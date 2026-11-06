# Changelog

## 2026-11-05

- security(auth): generate independent cryptographic session credentials
- security(python): use peer identity and expire inactive quota buckets
- security(python): bound HTTP request bodies before decoding
- security(typescript): use connection peers for quotas and request metadata
- security(template): restrict MongoDB publication to loopback
- security(rust): upgrade JWT claim validation to a patched release
- security(ruby): keep singleton process commands literal
- security(ci): pin actions and images and disable checkout credentials

## 2026-11-04

- fix(go): enforce protocol admission and serialization contracts
- fix(go): reject explicitly empty origin headers
- fix(python): enforce protocol boundaries and complete EJSON parity
- fix(python): retire stale principals on authentication changes
- fix(ruby): align authentication, metadata, and quota semantics
- fix(rust): enforce protocol boundaries and full EJSON date support
- fix(rust): preserve default HTTP origin behavior
- fix(typescript): enforce fail-closed protocol boundaries
- fix(typescript): preserve identities and retire stale principals
- test(release): remove stale version and source assumptions
- test(protocol): add shared fixture verification gate
- test(protocol): force fresh Go fixture replay

## 2026-10-28

- fix(auth): preserve token age and serialize browser refresh recovery

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

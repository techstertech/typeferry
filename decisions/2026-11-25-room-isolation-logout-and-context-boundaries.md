---
status: accepted
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-11-25
updated: 2026-11-25
related-specs:
  - ../specs/2026-11-25-monorepo-security-hardening.md
---

# Room isolation, logout room eviction, and HTTP/WS identity boundaries

## Context

The monorepo security review identified four cross-language contract ambiguities
affecting authorization and session integrity across `typeferry-ts`,
`typeferry-go`, `typeferry-py`, and `typeferry-rs`:

1. Internal room keys used `typeferry:<channel>:<event>`, allowing `:` in
   client-supplied `channel` values to collide with colon-namespaced protected
   or user-scoped events.
2. `rpc:logout` cleared authentication context without removing the WebSocket
   from subscribed rooms, allowing post-logout push-event delivery when
   `revalidateOnDelivery` is off or unimplemented.
3. TypeScript `ServerOptions.allowedContextKeys` was stored but unenforced on
   `POST /__h`, forwarding arbitrary attacker-supplied `transport.context` fields
   into `server.auth`.
4. Unauthenticated WebSocket handshakes supplying an active client's `uuid`
   overwrote `allClients` (and in Go closed the victim's socket), while
   `deleteClient` removed entries without verifying node identity.

## Decision

The user approved the following contracts on 2026-11-25:

1. **Length-prefixed internal room keys:** Format internal room names as
   `typeferry:<utf8-byte-length(channel)>:<channel>:<eventName>` across all
   four servers so colon characters remain valid in channels and event names
   without delimiter ambiguity.
2. **Full room eviction on `rpc:logout`:** `rpc:logout` must leave all
   subscribed WebSocket rooms on the calling socket in addition to clearing
   `context`, `authenticated`, and `userId`.
3. **Strict HTTP `allowedContextKeys` filtering:** Filter HTTP
   `transport.context` by `server.allowedContextKeys` (defaulting empty `[]` to
   `{}` before attaching header-derived `token`), matching WebSocket's
   `{ token }` boundary by default while allowing explicit opt-in keys.
4. **Non-evicting WebSocket UUID collisions:** When an unauthenticated
   WebSocket handshake supplies a `uuid` already registered to an active client,
   assign a fresh CSPRNG UUID instead of overwriting or closing the live client,
   and verify node identity before removing entries in `deleteClient`.

## Consequences

- Wire envelopes (`rpc:on`, `rpc:off`, `rpc:logout`, `event`, HTTP `POST /__h`)
  and `x-api-key` authentication remain backward-compatible.
- Applications calling `getRoomName` / `room_name` in internal tests observe the
  length-prefixed room string.
- Applications relying on custom non-`token` fields in HTTP `transport.context`
  must list those field names explicitly in `ServerOptions.allowedContextKeys`.

---
status: accepted
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-10-24
updated: 2026-10-24
related-specs:
  - ../specs/2026-10-24-authenticated-method-cache-bypass.md
---

# Limit method result caching to anonymous calls

## Context

Shared method-result caches can return another user's data and skip inline
authorization. Adding a user ID to the key prevents cross-user hits but cannot
recheck permissions revoked after the result was cached.

## Decision

Authenticated calls bypass method-result caching on every invocation in all
server implementations. They neither read nor populate anonymous cache entries.
The existing cache API continues to apply only to anonymous invocations.
The user approved this policy on 2026-10-24.

## Alternatives

- Identity-scoped keys leave inline authorization revocation unresolved.
- Removing all caching also removes valid anonymous caching without a requirement.
- A new cache authorization API expands the public contract beyond this fix.

## Consequences

Authenticated handlers may run more application work. Anonymous handlers remain
responsible for returning results safe to share across anonymous callers.
Wire envelopes, anonymous cache keys, and persisted data remain unchanged.
A future private-cache design requires an explicit authorization contract.

---
status: accepted
created: 2026-11-05
updated: 2026-11-05
related-specs:
  - ../specs/2026-11-05-security-review-remediation.md
---

# Peer identity and bounded Python HTTP bodies

## Context

The TypeScript and Python HTTP adapters currently trust arbitrary forwarding
headers for quota identity. Python retains inactive limiter buckets and reads
unbounded bodies. The user approved direct-peer defaults and a configurable
4 MiB Python body ceiling after reviewing the security findings.

## Decision

Use the Node connection peer or ASGI-provided client address for HTTP metadata
and quota identity. Do not interpret forwarding headers inside TypeFerry.
Trusted proxy address rewriting belongs to the host, consistent with the
existing [Ruby security policy](2026-09-13-ruby-rack-security-policy.md).

Add `HttpTransport(..., max_body_bytes=4 * 1024 * 1024)` as a positive integer
keyword option. Count actual bytes while consuming the request stream and
return HTTP 413 before decoding or dispatch when the ceiling is exceeded.
Preserve origin and quota admission order. Keep TypeScript's existing limits.

Expire inactive Python rate-limit buckets within the existing limiter owner.
Do not add an independent cleanup service or evict active buckets to make room.

## Alternatives and consequences

Implicit forwarding-header trust permits quota bypass. A second proxy-chain
parser duplicates host ownership without a demonstrated need. Unlimited request
bodies leave directly exposed adapters vulnerable even when proxies usually cap
uploads. A cross-language default-size migration is unnecessary for this fix.

Hosts behind a proxy must configure trusted client-address handling explicitly.
Python callers sending larger bodies must configure a suitable finite ceiling.
Existing request envelopes, successful responses, and authentication APIs remain
unchanged. The Python constructor gains one additive public option.

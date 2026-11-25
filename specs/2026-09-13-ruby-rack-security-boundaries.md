# Ruby Rack security boundaries

Status: superseded by [the Ruby server retirement](2026-11-25-ruby-server-retirement.md)

## Problem

The Ruby Rack transports treat an omitted origin as allowed, read request bodies
without a transport-level byte limit, and let Rack infer client addresses without
an explicit trusted-proxy policy. Downstream applications cannot build a
fail-closed browser boundary from these defaults.

## Evidence

- `RackHTTP#origin_allowed?` and `RackWebSocket#origin_allowed?` allow every
  origin when no allowlist is configured and allow a missing `Origin` even when
  one is configured.
- `RackHTTP#dispatch` reads the complete body before decoding it.
- The HTTP limiter keys directly on `Rack::Request#ip`.

## Scope and contracts

This is a backward-compatible API expansion with secure configurable behavior.

- Add a reusable Rack request-boundary policy for exact browser origins,
  bounded request bodies, and trusted-proxy-aware client addresses.
- Preserve originless non-browser HTTP clients only through an explicit policy;
  WebSocket browser transports fail closed when origins are configured.
- Reject oversized HTTP requests before parsing and return `413`.
- Make client-address resolution explicit and deterministic.
- Keep the wire envelopes unchanged and document the transport security policy
  in `PROTOCOL.md`.

## Test strategy and acceptance

- Unit-test allowed, rejected, and missing origins.
- Unit-test declared and streamed bodies over the limit.
- Unit-test spoofed forwarding headers from untrusted peers and trusted proxy
  chains.
- Exercise the HTTP and WebSocket conformance suites.
- Run `cd typeferry-rb && bundle exec rake verify`.

## Risks and recovery

Fail-closed defaults can reject an incorrectly configured deployment. Preserve a
named compatibility option, document it, and revert the policy/API and fixtures
together if cross-language conformance changes unexpectedly.

## Checklist

- [x] Add failing boundary-policy tests.
- [x] Implement the shared Rack security policy and RBS surface.
- [x] Integrate HTTP and WebSocket transports.
- [x] Update protocol and Ruby documentation.
- [x] Run TypeScript/Ruby interoperability and Ruby verification.
- [x] Record the security-default decision.

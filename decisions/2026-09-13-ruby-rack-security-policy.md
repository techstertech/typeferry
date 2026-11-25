# Ruby Rack security policy

Status: superseded by [the Ruby server retirement](../specs/2026-11-25-ruby-server-retirement.md)

## Context

Rack HTTP bodies were unbounded, configured origin allowlists accepted missing
origins, and downstream servers had no explicit client-address resolver seam.

## Decision

The Ruby adapters share `RackSecurityPolicy`. Configured allowlists reject a
missing origin unless a host explicitly enables originless trusted clients.
HTTP bodies default to a finite 4 MiB ceiling, and applications may inject the
only client-address resolver used for metadata and rate limiting.

## Rejected alternatives

- Trust forwarding headers inside TypeFerry. Proxy topology belongs to the host.
- Leave body limits entirely to reverse proxies. Direct Rack deployments still
  require an application boundary.
- Always reject originless requests. Unconfigured protocol conformance and
  trusted non-browser clients remain valid.

## Consequences

Configured browser deployments fail closed. Downstream hosts must opt into any
originless compatibility and define trusted proxy behavior explicitly.


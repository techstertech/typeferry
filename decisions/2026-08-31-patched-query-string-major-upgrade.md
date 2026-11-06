# Patched Query String Major Upgrade

The dependency-retention choice is superseded by the
[TypeScript dependency reduction](../specs/2026-11-05-typescript-dependency-reduction.md).
The original security release and URL compatibility requirements remain valid.

## Context

TypeFerry uses `query-string` solely in `Client.href()` to serialize a final
plain-object argument. Version `7.1.3` depended on a vulnerable release of
`decode-uri-component`; GHSA-vcc3-ghjq-m6fr identifies `0.5.0` as the patched
decoder. The first `query-string` release consuming that patch is `9.5.0`.

The dependency upgrade crosses two major versions, but TypeFerry already targets
Node 24 and publishes ESM, satisfying the new package's Node 18+ and ESM
requirements. A compatibility test passed unchanged before and after the
upgrade for strings, arrays, nulls, booleans, and percent encoding.

## Decision

Upgrade TypeFerry's production dependency from `query-string@^7.1.3` to
`query-string@^9.5.0` and publish the result as TypeFerry `0.4.2`.

Retain `query-string` rather than rewriting `Client.href()` in this security
release. The public API and URL serialization contract remain unchanged.

## Rejected Alternatives

- Pinning or overriding only `decode-uri-component` would bypass
  `query-string`'s declared compatibility range and leave unsupported package
  composition.
- Replacing serialization with `URLSearchParams` could alter array, null, and
  filtering semantics and would expand a dependency remediation into a public
  behavior change.
- Ignoring the moderate advisory conflicts with the repository's security
  policy and leaves remotely supplied decoding input able to consume excessive
  CPU.

## Rationale

The upstream package has released an explicit dependency update for the
advisory. Consuming that release is the narrowest supported remediation, while
the compatibility regression protects TypeFerry's observable behavior across
the major-version jump.

## Consequences

- TypeFerry consumers receive `decode-uri-component@0.5.0` through the supported
  dependency graph.
- The TypeFerry dependency tree audits clean after frozen installation.
- Consumers must upgrade to TypeFerry `0.4.2` or later to receive the fix.
- Future replacement with native URL primitives remains possible but should be
  evaluated as a separate behavior change.

# Published Template Dependency

> **Superseded**: This decision is superseded by [`decisions/2026-11-26-github-release-tarball-distribution.md`](2026-11-26-github-release-tarball-distribution.md). The template now consumes the verified `typeferry` tarball from GitHub Releases instead of the public npm registry.

## Context

The application template originally used `file:../typeferry-ts` so it could be
verified before TypeFerry's first npm publication. That made the template
dependent on the monorepo layout and exercised local source rather than the
artifact users actually install.

## Decision

Use the published npm package as the template's only TypeFerry dependency
source, beginning with compatible range `^0.6.1`. Keep the npm lockfile so fresh
template installs resolve an exact artifact and integrity digest. Current-facing
documentation presents registry installation as the default and does not retain
an alternate local-file workflow.

## Rejected Alternatives

- Retaining the local file dependency for repository contributors was rejected
  because it would not validate the published consumer artifact.
- Documenting both local and registry workflows was rejected because the
  template should remain portable outside this monorepo.
- Disabling npm engine checks was rejected; package engine compatibility is
  represented accurately by the `0.6.1` release instead.

## Consequences

- The template can be copied or used independently of the package source tree.
- Template verification covers the published package's exports, metadata, and
  dependency graph on Node.js 26.
- Fresh installs require npm registry access, while `npm ci` remains
  deterministic through the committed lockfile.
- Testing uncommitted TypeFerry source changes requires an explicit developer
  override outside the documented template contract.

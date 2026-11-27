# npm Package and Publication

> **Superseded**: This decision is superseded by [`decisions/2026-11-26-github-release-tarball-distribution.md`](2026-11-26-github-release-tarball-distribution.md). TypeFerry no longer publishes to the public npm registry and distributes `typeferry-<version>.tgz` tarballs via GitHub Releases instead.

## Context

The TypeScript implementation used temporary private package identity `typeferry-ts` while the TypeFerry rebrand and registry choices were unresolved. The package is now ready for an operator-controlled public npm release. An exact public-registry check found no package document for `typeferry` on 2026-09-01, but that observation neither reserves the name nor guarantees future publishability.

## Decision

Use unscoped npm identity `typeferry` with initial public version `0.6.0`. The pre-1.0 minor bump represents the breaking removal of the Lit adapter and the clean change from the temporary import name.

Publication is a manual, local operator action through root recipe `just publish-npm`. The recipe requires a clean `main` checkout, exact Node/npm versions, authenticated public-registry identity, an unpublished exact version, the full test/build gate, npm publish dry-run, and an exact-content artifact validation before `npm publish --access public`.

CI runs the same non-uploading artifact validator. It does not receive npm credentials and cannot publish. Python and Rust remain non-publishable.

## Rejected Alternatives

- `typeferry-ts` was rejected because the final brand does not need a language suffix and package exports already distinguish TypeScript surfaces.
- A scoped package was rejected because an unscoped primary brand has simpler imports and does not depend on scope ownership.
- Version `1.0.0` was rejected because the framework remains in pre-1.0 API development.
- Patch version `0.5.1` was rejected because the import rename and Lit removal are breaking.
- Automated publish-on-push and tag-triggered publication were rejected to keep registry credentials and irreversible release mutations outside CI.
- A minimal `npm publish` wrapper was rejected because it would not prove the packed artifact or release state.

## Consequences

- Consumers import `typeferry/*`; `typeferry-ts/*` has no compatibility alias.
- The implementation directory remains `typeferry-ts/` and is not a registry identity.
- Every release requires an explicit version change and clean committed state before the operator command can succeed.
- Artifact policy permits only the package README, manifest, compiled JavaScript, declarations, and JavaScript source maps.
- If `typeferry` becomes unavailable before the first upload, publication fails closed and a new identity decision is required.

## 2026-09-03 amendment

The shared artifact validator uses `npm pack --dry-run --json`, not
`npm publish --dry-run`, so CI can validate the current package version both
before and after publication. The operator-only publish-state gate separately
checks that the exact candidate version is absent from the public registry,
then the publish recipe performs the real upload after the complete repeatable
gate. This preserves fail-closed publication without making ordinary CI depend
on version availability.

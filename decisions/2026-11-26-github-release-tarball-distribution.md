# GitHub Release Tarball Distribution

Status: accepted  
Date: 2026-11-26  
Supersedes:
- [`decisions/2026-09-01-npm-package-and-publication.md`](2026-09-01-npm-package-and-publication.md)
- [`decisions/2026-09-01-published-template-dependency.md`](2026-09-01-published-template-dependency.md)

## Context

TypeFerry previously published `typeferry` to the public npm registry (`registry.npmjs.org`) via manual operator runs of `just publish-npm`, and the reference `template/` application consumed `typeferry` from the npm registry. The repository now lives at `techstertech/typeferry` on GitHub, and TypeScript releases should be distributed directly as verified `npm pack` tarballs attached to versioned GitHub Releases rather than published to npm.

## Decision

1. **Retire npm registry publication**:
   - Mark `typeferry-ts/package.json` with `"private": true` and remove `publishConfig`.
   - Remove `publish-npm`, `assert-npm-publish-state`, and `registry.npmjs.org` checks from `justfile` and release scripts.
   - Retain `typeferry` as the package name so `npm pack` produces `typeferry-<version>.tgz` and consumers import `typeferry/*`.
2. **Publish verified tarballs via GitHub Actions on `v*` tags**:
   - `.github/workflows/release.yml` runs on `push` to tags matching `v*`.
   - The workflow verifies `GITHUB_REF_NAME == v<version>` against `typeferry-ts/package.json`, runs the complete verification gate (`npm ci`, `npm audit --audit-level=low`, `lint`, `typecheck`, split `unit` / Docker-backed `integration` / Playwright `browser` tests, `build`, `verify:consumer`, and `scripts/verify-release-package.mjs`), packs `typeferry-<version>.tgz`, computes `typeferry-<version>.tgz.sha256`, and creates the GitHub Release using `GH_TOKEN` scoped strictly to the final `gh release create` step.
   - `just verify-release` executes the same local non-uploading verification gate.
3. **Consume the GitHub Release tarball in `template/` and consumer applications**:
   - Consumer applications install `typeferry` via its versioned GitHub Release tarball URL (`https://github.com/techstertech/typeferry/releases/download/v<version>/typeferry-<version>.tgz`), allowing npm to record the exact archive URL and SHA-512 integrity digest in `package-lock.json` without an upstream build step.
   - Direct Git dependencies without a prebuilt `dist/` remain unsupported.

## Rejected Alternatives

- **Continuing public npm registry publication**: rejected by maintainer direction to stop all npm registry releases.
- **Direct `git+https://` package dependencies**: rejected because `typeferry-ts/` excludes built `dist/` from Git and does not run a build during consumer `npm install`.
- **Manual-only tarball uploads in the GitHub UI**: rejected in favor of an automated, tag-triggered workflow that guarantees every released tarball passes the complete CI verification gate.

## Consequences

- `npm publish` fails closed locally and in CI because `typeferry-ts/package.json` sets `"private": true`.
- `npm pack` continues to produce valid tarballs installable by URL in consumer `package.json` and `package-lock.json` manifests.
- Every release requires updating `typeferry-ts/package.json` and `typeferry-ts/package-lock.json`, verifying locally or on `main`, and pushing a matching annotated `v<version>` tag.
- Previously published versions (`0.6.0` through `0.16.0`) on `registry.npmjs.org` remain historical npm artifacts outside this distribution channel.

---
status: implementing
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-11-05
updated: 2026-11-05
owner: typescript-runtime
implementation:
  commits: []
---

# TypeScript dependency reduction

## Outcome and scope

Remove the unused `@types/json-stable-stringify` and `@types/ua-parser-js`
declarations. Replace the only `memoizee` and `query-string` call sites with
local code, then remove those packages and `@types/memoizee` through npm.
The user approved these three dependency reductions after reviewing the ranked
dependency matrix.

This continues the URL compatibility contract established by the
[query-string security upgrade](2026-08-31-query-string-security-upgrade.md).
The earlier release retained the package to keep security remediation narrow.
This task separately authorizes its replacement and supersedes the
[earlier package-retention decision](../decisions/2026-08-31-patched-query-string-major-upgrade.md).

## Contracts and ownership

- `Client.href()` preserves its broad object input acceptance and generated
  URLs: sorted keys, repeated array keys, bare null keys, omitted undefined
  values and empty arrays, existing coercion, and strict percent encoding.
- `useCaller()` preserves EJSON argument keys, pending-promise identity and
  deduplication, rejection eviction, and expiry measured from fulfillment.
  Zero maximum age disables expiry. Changing the client or cache settings
  creates the same fresh caller boundary as before.
- Local code stays with the owning client and React implementations. Do not
  introduce shared cache infrastructure or change server method caching.
- Public TypeFerry signatures remain compatible. Generated declarations must
  not reference removed packages.
- Dependency versions outside the removed graph remain unchanged. Retained
  registry integrity digests must survive npm lockfile regeneration.
- Authentication, authorization, wire messages, persisted data, browser support,
  and security boundaries remain unchanged. There is no deployment or release.

## Acceptance and planned verification

1. Existing and added URL characterization tests pass before and after the
   replacement, including typed interface input and encoding edge cases.
2. Existing and added hook tests pass before and after the replacement,
   including pending calls, rejected calls, fulfillment TTL, and cache resets.
3. Removed declarations and runtime packages disappear from the manifest,
   resolved lock graph, production imports, and generated declarations.
4. Retained locked packages keep their versions and integrity digests. An
   immutable install and low-threshold npm audit succeed.
5. Lint, strict typecheck, all three test suites, build, package inspection,
   and the existing generic packed-consumer verification succeed.

Characterize behavior before implementation. Run each affected suite first.
Use the existing temporary MongoDB and Redis wrappers for integration tests;
keep unrelated services and data intact. Measure dependency savings from the
before/after lock graph rather than claiming bundle-size savings.

## Risks and recovery

Encoding or promise timing differences can change application behavior.
Focused compatibility tests and the full package gate address those risks.
Revert each replacement together with its manifest and lockfile change if
recovery is needed. No data migration or production operation is required.

## Execution checklist

- [x] Remove unused type declarations and verify type resolution.
- [x] Characterize and replace URL query serialization.
- [ ] Characterize and replace React caller memoization.
- [ ] Remove obsolete dependencies and inspect the retained graph.
- [ ] Complete package verification and record acceptance results.

## Verification results

The unused declaration removal passed `mise exec -- npm run typecheck` from
`typeferry-ts/`. npm removed 23 lock entries and changed no retained package
metadata. Remaining checks are pending.

URL serialization passed all 56 client tests before and after replacement.
The focused command was `mise exec -- npm run test:unit --
src/client/client.unit.spec.ts`. A generated 152-case comparison matched the
installed `query-string` implementation. After npm removed its four lock
entries, the client tests and strict typecheck passed again. Scoped ESLint and
independent source review found no material issues. Remaining checks are pending.

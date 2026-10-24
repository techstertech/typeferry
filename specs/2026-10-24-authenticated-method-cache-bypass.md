---
status: shipped
release-status: published
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-10-24
updated: 2026-10-24
implementation:
  commits:
    - 5c9bbc5
---

# Authenticated method cache bypass

## Outcome and approval

Authenticated method calls execute their handlers on every invocation in all
five server implementations. Anonymous calls retain existing result caching.
The user approved this policy and cross-language scope on 2026-10-24.
Prepare the TypeScript npm candidate for manual publication. Do not publish,
push, tag, upgrade downstream applications, or enable other language releases.
The durable choice is recorded in the
[cache decision](../decisions/2026-10-24-anonymous-only-method-result-caching.md).

## Problem and evidence

Method-result caches use serialized parameters without caller identity. A cache
hit skips handler authorization. The TypeScript audit tests reproduce both
cross-user result disclosure and stale inline permission checks. Partitioning
keys by identity alone cannot fix permission revocation inside a handler.
Existing protocol section 6.3 documents the unsafe shared-cache behavior.

## Contract

- Before cache lookup, an authenticated caller bypasses method-result caching.
- Authenticated calls neither read nor populate cached results or pending work.
- Authentication state is evaluated for each invocation, including state changes
  on an existing connection. Public and protected methods follow the same rule.
- Schema validation, middleware, telemetry, error handling, and transport
  protection remain with their existing owners.
- Anonymous caching retains its parameter key, TTL, and concurrency behavior.
- No new public API, production dependency, persisted format, or wire envelope
  is introduced. Authenticated cached methods may perform more application work.
- Anonymous cached handlers must return results independent of caller context.
  Applications remain responsible for selecting suitable anonymous cache use.

```text
validate -> middleware -> authenticated?
                           yes -> handler
                           no  -> existing anonymous cache -> handler on miss
```

## Acceptance criteria and test strategy

1. Two authenticated callers with identical parameters receive their own result.
2. Repeated authenticated calls run inline authorization after access is revoked.
3. Anonymous cache entries cannot satisfy authenticated calls; authenticated
   results cannot populate the anonymous cache, including connection transitions.
4. Repeated anonymous calls still share a result and expire under existing TTL.
5. All five implementations follow the same policy. Existing fixtures remain
   valid; add shared executable acceptance cases where the fixture model permits.
6. The TypeScript package passes the non-uploading release gate, audit, build,
   and packed-artifact inspection. Other servers pass relevant full verification.

Write or convert focused regression tests and demonstrate their failures before
changing implementations. Run focused tests first, then package checks and
cross-language verification. Record executed results separately from intentions.

## Scope and recovery

Fix method-result caching and its contract, tests, and release records.
Do not add private-cache policies, authorization callbacks, unrelated cache
eviction work, or application fixes. Reverting this change restores the known
authorization risk. No data migration is required. Publication stays manual.

Release verification found existing Zod and Undici security advisories. The
candidate raises the production Zod minimum from `^4.4.3` to `^4.6.7` and updates
the development Undici lock resolution from `7.30.0` to `7.30.1`. This bounded
scope addition prevents publishing an affected dependency graph. No dependency
is added; full release verification must run against the updated lockfile.
Zod emits the equivalent nullable BSON type union directly. The existing
compiler test expectation was updated; validator implementation is unchanged.
See the [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
and [Undici advisory](https://github.com/advisories/GHSA-4qv8-2p9j-2685).

## Execution checklist

- [x] Add failing tests, then implement all five servers.
- [x] Update protocol, shared acceptance evidence, and cache documentation.
- [x] Verify server suites and the TypeScript release artifact.
- [x] Commit the candidate and record operator publication instructions.

## Verification results

Acceptance criteria 1-6 passed. Each implementation first demonstrated failures
for caller isolation, inline revocation, and authentication transitions. Its
focused regressions then passed. Anonymous cache and TTL controls stayed green.

Executed checks:

- TypeScript `just verify-npm-release`: immutable install, lint, typecheck,
  1,734 unit tests, 95 integration tests, 10 browser tests, build, generic packed
  consumer, and archive validation all passed. All Ruby interoperability cases
  ran; none were skipped. Shared HTTP/WS fixtures and Python/Rust/Ruby/Go client
  interoperability passed as part of this gate.
- TypeScript `npm audit --audit-level=low`: zero vulnerabilities.
- TypeScript archive: 574 allowed files, 301,863 packed bytes. Inspected the
  emitted cache guard and confirmed the tarball's method implementation matches
  the built file byte for byte.
- Python `.venv/bin/python -m pytest`: 241 passed. Ruff and strict mypy passed
  across 51 source files. Python 3.13.15 was used; the repository has no Python pin.
- Ruby `bundle exec rake verify`: 100 tests and 360 assertions passed with no
  skips, plus Steep, StandardRB, gem build, and package validation. Used Ruby
  3.3.12 and the existing local Redis service.
- Rust `cargo fmt --all -- --check`, strict all-target/all-feature Clippy, and
  `cargo test --workspace --all-features` passed. Replayed the new real-WS
  fixtures after creation. One existing macro doctest remains ignored.
- Go `go test ./...`, `go test -race ./...`, and `go vet ./...` passed. Shared WS
  fixtures and 27 TypeScript HTTP/WS client tests passed. A clean module cache
  passed `go mod verify`.
- `git diff --check` and local documentation-link checks passed.

The release gate used pinned Node 24.19.0/npm 11.17.0, existing local MongoDB
and Redis, and a guarded dedicated MongoDB test database. That database was
removed afterward. No services or user sessions were stopped. Removed generated
Rust incremental build files after verification; retained the existing build cache.

Earlier gate attempts exposed two resolved issues: system Ruby selection and an
existing compiler assertion tied to Zod's previous nullable-schema shape.
The final complete gate ran after both corrections. Existing warnings remain:
the deprecated `@types/json-stable-stringify` stub, Python TestClient deprecation,
and short JWT keys used only by tests.

## Publication handoff

The operator published `typeferry@0.15.2` on 2026-10-24. The public registry
confirms `latest` is `0.15.2` and records `gitHead`
`5c9bbc5e12779ce54da12f7d423d4d2e9b7ed665`. The downloaded registry tarball is
byte-identical to the verified archive below. The agent performed verification
only; it did not publish, push, or tag this release.

Verified archive:
`/Users/leonardo/.cache/typeferry/releases/0.15.2/typeferry-0.15.2.tgz`.

- SHA-1: `2c722718258a662efffd78560c50d469a08b524b`
- SHA-256: `c78299abc57ed6d7d45a316f7c7cac116dc88282f14f2d9cc3daa764ca66bfa1`
- Integrity: `sha512-ARiwEC0MIGw+uVVcRDDqrDxJeR73gixJHubOds4aPwxlsmyNZTjc6+kGJOWA3q3fJ+jC7dhabWiDTJIOYcZtRg==`

The default local Go module cache has modified module directories. Verification
used a separate verified cache, retained beside the archive for publication.
This avoids repairing or trusting unrelated local cache state. The preparation
command below is historical: publication succeeded and its immutable-version
guard now refuses another upload of `0.15.2`. Mise used the existing
command-scoped Go root override:

```sh
cd /Users/leonardo/Repositories/typeferry
env -u GOROOT MISE_GO_SET_GOROOT=false \
  GOMODCACHE=/Users/leonardo/.cache/typeferry/releases/0.15.2/go-modcache \
  just publish-npm
```

The operator must have npm registry authentication. The existing recipe reruns
the release gate before uploading. Publication guards are unchanged. The optional
Ruby interoperability tests were explicitly enabled for this preparation using
the absolute pinned Ruby executable; the default publish recipe can retain its
existing opt-in behavior.

Review the decision and protocol first, then the five small runtime guards,
regression tests, and the bounded dependency changes. Authenticated handlers now
run more often, so applications must size their own work accordingly. Anonymous
cache selection remains application-owned. No private-cache API was introduced.
No migration is needed. Reverting restores the demonstrated authorization risk.
Downstream upgrades and compatibility checks remain outside this task.

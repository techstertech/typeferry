---
status: shipped
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-11-25
updated: 2026-11-25
owner: server runtimes
supersedes:
  - 2026-09-12-typeferry-ruby-server.md
  - 2026-09-12-ruby-connection-and-process-supervision.md
  - 2026-09-13-ruby-rack-security-boundaries.md
  - ../decisions/2026-09-12-ruby-server-runtime.md
  - ../decisions/2026-09-13-ruby-rack-security-policy.md
---

# Retire the Ruby server

TypeFerry maintains four server implementations after this retirement.
TypeScript, Python, Rust, and Go continue to use the same wire protocol
and shared fixtures.

## Acceptance criteria

1. The source tree contains no Ruby server package, gem build, or TypeScript
   test that starts a Ruby server.
2. Local verification exercises all four remaining servers. The existing
   continuous integration jobs run without a Ruby toolchain.
3. Current documentation lists the four implementations. Dated release
   evidence and the [Ruby parity audit](2026-09-12-ruby-server-parity-audit.md)
   remain available as historical records.

Consumers that pin the unpublished gem through Git can resolve it from their
existing revision. Revert the retirement commit to restore the server and its
verification paths together.

## Verification results

1. Passed. Tracked-path and reference checks found no Ruby package, gem build,
   or active interoperability entry point.
2. Passed locally. `typeferry-py/.venv/bin/python -m pytest scripts -q` passed
   21 repository tooling tests. `just verify-npm-release` passed lint,
   type checking, 1,824 unit tests, 96 integration tests, 25 browser tests,
   the build, the packed consumer, and inspection of all 580 package files.
   `scripts/run-with-redis.sh just verify-shared-fixtures` passed for all four
   servers. `go test -count=1 ./...` passed from `typeferry-go/` with
   `TYPEFERRY_TEST_REDIS_URL` set to temporary Redis. Hosted CI was skipped.
3. Passed. Current documentation and conformance list the four servers.
   The Ruby records mark their historical status. The protocol and fixture
   diff was empty.

The packed consumer reported the `node-domexception` deprecation and pending
`esbuild` install-script approval. Python reported a Starlette deprecation for
`httpx` with its test client.

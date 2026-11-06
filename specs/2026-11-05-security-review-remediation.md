---
status: implementing
created: 2026-11-05
updated: 2026-11-05
owner: authentication and transport maintainers
decision: ../decisions/2026-11-05-request-peer-and-body-security.md
implementation:
  commits: []
---

# Security review remediation

## Outcome and authorization

Remove the confirmed credential, request-boundary, database-publication, and
dependency weaknesses from the repository security review. The user approved
the proposed fixes, direct-peer request identity, and a configurable 4 MiB Python
HTTP body limit on 2026-11-05.

## Evidence and existing authority

- The TypeScript session manager uses the non-secure UUID entrypoint for bearer
  credentials and adjacent public session IDs.
- TypeScript and Python HTTP limiters trust arbitrary forwarding headers.
  Python also retains expired limiter keys and buffers complete request bodies.
- The template publishes unauthenticated MongoDB on all host interfaces.
- Rust locks an affected `jsonwebtoken` release. The current typed verification
  helper does not establish exploitation of the advisory.
- Ruby's process supervisor accepts a singleton string through `Kernel.spawn`,
  despite its existing argv-only contract.
- CI references mutable actions and images; npm locks have incomplete provenance.

The existing [Ruby request-security decision](../decisions/2026-09-13-ruby-rack-security-policy.md)
already assigns proxy topology to the host. The existing [process-supervision
contract](2026-09-12-ruby-connection-and-process-supervision.md) requires argv-only
execution. This work extends the request-security policy to the affected
adapters and repairs that process contract without replacing either record.

## Contracts and scope

- Generate all TypeScript session-manager UUIDs with Node's cryptographic UUID
  generator. Preserve UUID shape, token-pair APIs, expiry, rotation, and revocation.
- Ignore forwarding headers inside the affected TypeFerry HTTP adapters. Use the
  Node connection peer and the ASGI-provided client address. Explicitly trusted
  proxy rewriting remains host-owned; introduce no speculative proxy parser.
- Reuse each transport's resolved identity for HTTP metadata and quotas.
- Expire inactive Python limiter buckets without resetting active quotas or
  adding a background task.
- Add a positive integer `max_body_bytes` Python HTTP option, defaulting to
  4 MiB. Enforce the actual streamed byte count before decoding or dispatch.
  Preserve origin admission, quota admission, then body-limit ordering and
  existing rate headers. Oversized requests return HTTP 413.
- Keep TypeScript's existing body ceiling and route-specific streaming policy.
- Publish the template MongoDB port only on IPv4 loopback. Preserve its data
  volume, replica-set behavior, and application connection string.
- Upgrade the Rust JWT dependency to a patched compatible API release with
  explicit supported crypto features. Preserve allowed algorithms and typed
  claim validation. Do not suppress advisories.
- Preserve Ruby's `command: Array[String]` API while forcing literal executable
  and argument handling, including singleton arrays.
- Pin CI actions and container images to verified immutable references. Preserve
  GitHub runner selection, job behavior, and minimal permissions.
- Review npm provenance using each package's pinned toolchain. Regenerate only
  project-owned lock metadata when necessary. Do not edit nested dependency
  documentation locks merely to remove scanner matches.

There is no deployment, publication, live-session revocation, persisted-data
migration, production-service restart, or unrelated dependency upgrade in scope.
Document operator steps for invalidating affected refresh sessions after rollout.

## Acceptance and planned verification

| Criterion | Observable result | Planned verification |
| --- | --- | --- |
| A1 | Session creation and rotation do not use `Math.random`; UUID and session behavior remain valid | Extend existing session-manager regressions before implementation |
| A2 | Forwarding-header changes cannot obtain a fresh peer quota; distinct peers retain independent quotas | Adapter regressions using explicit peer addresses; existing header and lifecycle tests |
| A3 | Inactive Python buckets expire without dropping active quotas | Existing monotonic-clock test pattern, without sleeps |
| A4 | Over-limit declared and chunked bodies receive 413 before auth or handlers; bounded bodies work | Boundary and unfinished-stream regressions, plus rate-header preservation |
| A5 | Template MongoDB publishes only on loopback and remains usable locally | Resolved Compose configuration and isolated connectivity validation; no new configuration tests |
| A6 | Rust no longer resolves the affected JWT version; auth behavior remains intact | Focused auth tests, workspace fmt/Clippy/tests, and dependency advisory scan |
| A7 | Ruby singleton commands and metacharacter arguments remain literal | Generated executable fixtures and existing lifecycle tests, then package verification |
| A8 | CI action/image references are immutable and checkout credential persistence is disabled | Reviewed reference receipts, existing workflow checks, Zizmor and Checkov; no new workflow tests |
| A9 | Project npm locks retain exact versions and contain available registry integrity metadata | Pinned package-manager inspection and immutable install/audit; disclose unsupported bundled metadata |
| A10 | Existing wire envelopes and conformance remain valid | Shared fixture command and relevant cross-language suites |

## Risks and recovery

Proxy deployments may share a quota until their host supplies a trusted client
address. Document the changed trust policy before release. Python requests above
the new default require an explicit larger finite limit. Neither change requires
a wire-envelope migration.

Reverting credential generation or an advisory fix restores the known weakness;
prefer a corrective follow-up. Revert other units independently with their tests
and documentation. Changing the template publication does not require deleting
its volume. Deployment owners must invalidate affected refresh sessions when
installing the fixed release; this repository task does not access those sessions.

## Execution checklist

- [x] Repair cryptographic session identifiers.
- [x] Restrict template MongoDB publication.
- [x] Repair peer identity and Python limiter retention.
- [x] Bound Python HTTP request bodies.
- [x] Upgrade the Rust JWT dependency.
- [x] Enforce Ruby literal process execution.
- [ ] Pin CI references and review npm provenance.
- [ ] Complete package checks, shared conformance, and scanner verification.

## Verification results

- A1: the new regression failed against the previous UUID generator, then all
  42 session-manager tests passed after the fix.
- A2, TypeScript: seven peer-identity regressions failed before implementation.
  The combined credential/peer focused run passed (120 tests), as did lint and
  typecheck. Full suites passed: 1,805 unit, 99 integration, and 24 browser tests.
  Independent source review found no consequential identity or API regression.
- A2/A3, Python: four new regressions failed before implementation. The focused
  HTTP/limiter tests then passed (40), followed by full pytest (322), Ruff, and
  mypy (53 files). Fifteen existing weak-test-key warnings remain.
- A4: thirteen new body-limit regressions failed before implementation. Focused
  tests then passed (53), followed by full pytest (335), Ruff, and mypy. The
  existing weak-test-key warnings remain. Independent source review found no
  ordering, quota-retention, or streaming-boundary regression.
- A5: resolved Compose configuration publishes only `127.0.0.1:27018`.
  Isolated host and container-network MongoDB pings passed; owned Compose
  resources were removed. Template format, lint, typecheck, both build outputs,
  and audit passed. Existing unit/integration/browser suites passed (9/2/1).
- A6: Cargo resolves `jsonwebtoken` 10.3.0 with the explicit AWS-LC backend
  and no unused PEM features. Focused auth tests passed (15), as did workspace
  formatting, strict Clippy, and all-feature tests. Two existing tests remain
  ignored: disposable Redis lifecycle and the macro doctest. Advisory recheck
  remains pending. Independent source review approved API and claim behavior.
- A7: generated singleton-path and shell-syntax regressions failed before the
  fix. Process tests then passed (9 tests, 25 assertions). Isolated Redis-backed
  verification passed (121 tests, 449 assertions, no skips), Steep, StandardRB,
  gem build, and artifact checks. The RBS addition supplies the missing tuple
  overload without weakening existing signatures. Independent review approved.
- Other acceptance criteria remain pending. Planned verification is not an
  executed result.

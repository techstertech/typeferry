---
status: shipped
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-11-04
updated: 2026-11-04
implementation:
  commits:
    - de4fd3a
    - ae7a320
    - 57d1c7c
    - 16322ee
    - 9c0c1a3
    - 00eefcf
    - 704d9af
    - 32e82b1
    - 8179582
---

# Protocol compliance defect corrections

## Outcome

The five backends enforce the documented protocol at the boundaries exposed by
the compliance audit. Regression checks must fail on the original defects and
verify the corrected observable behavior. Existing TypeScript serialization
bytes remain the compatibility oracle for EJSON ordering.

## Evidence and existing authority

The audit passed existing fixtures but found gaps in origin admission,
authentication truthiness, WebSocket handshake validation, EJSON decoding,
rate-limit headers, Redis cleanup, and negative fixture assertions. Three
release-tool tests also depend on obsolete versions or source formatting.

`PROTOCOL.md` remains the wire authority. This record continues the relevant
contracts in the [Go parity spec](2026-09-29-go-server-parity.md) and
[Ruby boundary spec](2026-09-13-ruby-rack-security-boundaries.md), without
reopening their completed implementation work. The
[accepted compatibility decision](../decisions/2026-11-04-protocol-boundary-and-ejson-compatibility.md)
records the user's explicit public API and compatibility selections.

## Scope and constraints

- Correct all reported defects and missing fixture coverage across the five
  implementations, including the adjacent Rust date and base64 panic paths.
- Repair the three stale release-tool checks using behavior or current metadata.
- Reuse transport, codec, authentication, limiter, and lifecycle owners.
- Preserve publication guards, existing services, credentials, and persisted data.
- No deployment, publication, dependency redesign, or new presence subsystem.
- Keep dependency security remediation enabled and finish with fresh audits.

## Contracts

### Origin admission

An omitted allowlist permits any origin. An explicitly empty allowlist permits
no named origins. A nonempty allowlist uses exact matching. Configured allowlists
reject missing or mismatching `Origin` before authentication, method dispatch,
body decoding, and rate consumption. Each transport exposes an explicit
originless opt-in, defaulting to false; it only admits an absent header and
never permits a mismatching named origin. HTTP and WebSocket opt-ins are
independent. Existing authoring APIs remain usable; additive options implement
this approved policy where no option exists.

### Authentication and handshake

Authentication follows JavaScript truthiness: null, false, numeric zero,
negative zero, NaN, and empty strings fail. Empty arrays and objects succeed.
An unsuccessful result does not retain authenticated context. Application-owned
handshake authentication retains precedence and never falls back to token auth.
WebSocket authentication finishes within the existing 5000 ms timeout, emits
one result, and cannot authenticate later after a timeout. Missing tokens do
not invoke token authentication.

UUIDs containing characters outside `[a-zA-Z0-9-]`, or with lengths outside
1–64, receive a fresh UUID. Valid UUIDs remain unchanged. Metadata uses raw
JSON object decoding, preserves tag-shaped objects literally, and has a
10,000-byte UTF-8 input limit. Invalid, non-object, and oversized metadata
becomes `{}`.

### EJSON

Ordinary objects emit JavaScript array-index keys (`0` through `4294967294`)
first, numerically, followed by other keys in insertion order. Canonical mode
keeps the same index ordering and sorts remaining keys by UTF-16 code units.
The rule applies recursively and preserves existing TypeScript output.
Anonymous cache keys continue to use ordinary EJSON bytes.

Rust represents the full valid JavaScript date interval, inclusive of
`-8640000000000000` and `8640000000000000` milliseconds. Approved date API changes
must be documented, with explicit conversion behavior for chrono consumers.
Python retains `datetime` for representable values and uses an internal
epoch-millisecond value for wider dates. Public Python function signatures and
constructors remain unchanged; documentation must describe the opaque fallback.
Untrusted date and base64 inputs cannot panic or trigger allocation underflow.
Invalid date behavior must follow the TypeScript encoder/decoder oracle rather
than silently inventing epoch dates. Base64 keeps MIME and URL-safe decoding
with required length and padding validation.

### Rate-limit responses

When enabled, each admitted HTTP request consumes the limiter once. Responses
include `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`, including
RPC errors, successful void calls, suppressed void errors, and HTTP 429.
Remaining quota never becomes negative. Reset is a nonnegative relative number
of seconds, rounded up from the current limiter window. Requests rejected
before admission do not consume quota. Disabled limiters emit no quota headers.
Response cookies and existing envelope/status semantics remain intact.

### Redis and tests

Rust close deletes only its own `typeferry:clients:<uuid>` key and removes its
own membership from `typeferry:servers`; repeated close is safe. Preserve the
existing close signature and report cleanup errors through existing logging.
No new connect-time presence registration is required by this correction.
Python and Rust replay the existing shared Redis envelopes. Live cleanup tests
use an owned disposable Redis instance and preserve unrelated keys.

Negative WebSocket fixture operations must assert that no frame arrives during
the specified interval. Test harnesses must demonstrably reject an unexpected
frame. Release checks must not encode a past release version or depend on quote
style in implementation source.

## Acceptance criteria and planned verification

| ID | Observable outcome | Planned verification |
|---|---|---|
| A1 | Origin policy and independent opt-ins behave consistently. | Allowed, missing, mismatching, empty-list, and opt-in HTTP/WS tests; denied requests never call auth or handlers. |
| A2 | Falsey authentication fails and timed-out auth cannot succeed later. | HTTP/WS scalar and container identity tests; pending callback timeout and no-fallback tests. |
| A3 | UUIDs and metadata meet their input contracts. | Real handshake tests, UTF-8 bounds, literal EJSON-tag-shaped metadata. |
| A4 | Ordinary and canonical EJSON bytes match TypeScript. | Shared ordered-entry fixtures and focused nested/cache tests across all five languages. |
| A5 | Date range and Rust base64 decoding are safe and compatible. | Shared boundary dates against TypeScript, Python datetime edge precision, generated binary round trips, malformed input regressions. |
| A6 | Admitted limited responses expose correct quota headers. | Success/error/void/429, disabled limiters, reset rounding, cookie preservation. |
| A7 | Redis fixtures run and close preserves other server state. | Python/Rust fixture consumers; disposable Redis cleanup test. |
| A8 | Negative assertions and release checks detect real regressions. | Deliberately unexpected-frame test and repository release-tool tests. |
| A9 | All corrected backends interoperate with the JS client. | Full relevant language suites, strict static checks, JS client tests, current dependency audits. |

## Risks and recovery

Strict origin admission rejects previously admitted originless callers when an
allowlist is configured. Hosts must explicitly opt in where needed. Explicitly
empty allowlists now fail closed. Rust date authoring changes require documented
migration. Revert a correction together with its fixtures and contract changes;
do not roll back dependency security fixes without a safe replacement.

## Execution checklist

- [x] Extend shared fixtures and clarify the protocol.
- [x] Correct TypeScript boundaries and stale release checks.
- [x] Correct Python and Ruby boundaries and fixture coverage.
- [x] Correct Go authentication, metadata, origins, headers, and encoding.
- [x] Correct Rust runtime, transports, codec, and fixture coverage.
- [x] Run cross-language verification and fresh dependency audits.
- [x] Complete the post-work review and commit task-owned changes.

## Verification results

All acceptance criteria passed for the delivered correction set. This record
does not claim that finite fixture coverage proves every possible protocol input.

| ID | Result and executed evidence |
|---|---|
| A1 | Passed: native HTTP/WS regressions cover omitted/empty allowlists, missing/empty/matching/mismatching headers, independent opt-ins, and rejection before callbacks or quota. |
| A2 | Passed: falsey scalar/container checks, pending and cancellation-resistant callbacks, no late authentication, and protected-call rejection. A real TypeScript regression additionally proved and corrected authorization retained after context installation or an authentication listener threw. |
| A3 | Passed: invalid UUID replacement, literal tag-shaped metadata, raw UTF-8 bounds, and compact number spellings whose normalized output exceeds the raw budget. |
| A4 | Passed: shared ordinary/canonical fixtures replay across all five languages, including numeric index boundaries, UTF-16 ordering, nested values, and cache-key checks. |
| A5 | Passed: shared full-range date fixture, real JS client/Rust date echo, checked chrono conversion, Python datetime precision/equality, generated short binary round trips, malformed base64, and invalid date coercion. |
| A6 | Passed for configurable limiters: normal/error/void/429 responses, reset ceiling/window behavior, cookie preservation, disabled limits, and oversized TypeScript RPC quota consumption. Rust retains its existing host-owned limiter model. |
| A7 | Passed: Python/Rust shared Redis replay and live Rust own-key cleanup with repeated close and unrelated state preservation. Go and Ruby live Redis checks also passed. |
| A8 | Passed: Python/Go/Rust harness regressions deliberately inject unexpected frames. All 21 repository script tests pass, including the real package validator with generated valid and invalid reports. |
| A9 | Passed: complete relevant backend checks, 99 JS integration cases with Ruby explicitly enabled, browser checks, packed-consumer checks, and current dependency audits. |

Executed package checks:

- TypeScript: `npm run lint`, `npm run typecheck`,
  `npm run test:unit -- --no-file-parallelism` (1792 tests),
  `npm run test:integration` (99), `npm run test:browser` (24),
  `npm run build`, `npm pack --dry-run`, `node ../scripts/verify-npm-package.mjs`
  (577 allowed files), and `npm run verify:consumer` (build, test, runtime imports).
- Python: `python -m pytest` (312), `ruff check .`, and `python -m mypy`
  (53 source files).
- Ruby: `bundle exec rake verify` with an owned Redis instance (118 tests,
  440 assertions, no skips), Steep, Standard, gem build, and package inspection.
- Rust: `cargo fmt --all -- --check`,
  `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`,
  and `cargo test --workspace --all-features --locked` (122 passed, two explicit
  ignores). The ignored Redis lifecycle test passed separately against an owned
  Redis instance; the pre-existing macro documentation example remains ignored.
- Go: `go test -count=1 ./...`, `go test -race -count=1 ./...`, `go vet ./...`,
  and live Redis integration under the race detector.
- Root: `python -m pytest scripts -q` (21) and `git diff --check`.
- Post-work automation: `just verify-shared-fixtures` ran every native consumer;
  TypeScript replayed 38 EJSON checks plus 23 HTTP/WS cases, Python passed 64,
  Rust replayed all families and handshake checks, Ruby passed 45, and all four
  Go fixture packages passed. The updated mastery guidance passed its validator.

Fresh `npm audit` checks for both independent npm graphs, `pip-audit`, updated
`bundler-audit`, `cargo audit`, and source/module `govulncheck` scans reported no
advisories. RustSec also reported no warnings. The task introduced no production
dependencies; Rust's existing Redis crate was added only to conformance tests.

## Compatibility, environment, and residual limits

- Strict configured origin admission and empty-list behavior are deliberate
  security corrections. Originless callers must use the explicit transport opt-in.
- Rust date construction changes from `EjsonValue::Date(date_time)` to
  `EjsonValue::Date(date_time.into())`; `to_chrono()` is checked. Python wide dates
  are opaque round-trip values; ordinary dates remain `datetime` objects.
- An inherited/corrupt global Go cache required an isolated cache and the existing
  command-scoped Mise Go environment override. No global tool settings changed.
  Ruby interoperability used explicit pinned executable paths for nested commands.
- Python retains existing Starlette TestClient deprecation and short test-HMAC
  warnings. The packed consumer reports existing install-script policy and
  deprecation warnings; its build, test, and runtime checks still pass.
- Rust's limiter remains application-owned. The fixture command does not replace
  complete suites, live lifecycle checks, or uncovered requirement review.
- No package publication, deployment, release tag, or persisted-data migration ran.
  Publication requires a separately selected version and the normal guarded gate.

The post-work review added the shared fixture recipe, corrected conflicting
fixture-sufficiency guidance, and recorded the negative-harness lesson globally.
Broader CI restructuring was deferred because it is outside this correction set.

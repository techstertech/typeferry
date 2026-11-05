---
status: accepted
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-11-04
updated: 2026-11-04
implementation:
  commits: []
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
| A5 | Rust date range and base64 decoding are safe and compatible. | Boundary dates against TypeScript, generated binary round trips, malformed input regressions. |
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

- [ ] Extend shared fixtures and clarify the protocol.
- [ ] Correct TypeScript boundaries and stale release checks.
- [ ] Correct Python and Ruby boundaries and fixture coverage.
- [ ] Correct Go authentication, metadata, origins, headers, and encoding.
- [ ] Correct Rust runtime, transports, codec, and fixture coverage.
- [ ] Run cross-language verification and fresh dependency audits.
- [ ] Complete the post-work review and commit task-owned changes.

## Verification results

No implementation checks have run for this correction yet. The previous audit's
passing suites do not establish acceptance of these new regressions.

---
status: validating
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-10-28
updated: 2026-10-28
owner: typescript-auth
implementation:
  commits: []
---

# Preserve token age through browser sleep

## Outcome and evidence

A delayed cross-tab token update cannot make an expired access token appear
fresh or replace a newer credential. Browser tabs coordinate demonstrated
overlapping refresh work without weakening server replay detection.

The current receiver stamps `_tokenReceivedAt` with its receipt time. A queued
update issued one day earlier with a 15-minute TTL therefore passes the local
expiry check. Current refresh single-flight ownership applies only to one
client instance, although tabs share the refresh cookie.

## Contracts and scope

Keep the existing auth slice as owner. Preserve public function signatures,
server wire messages, dependency ranges, cookie policy, and persisted context
shape. Cross-tab message metadata is internal and must remain compatible with
older senders. Use origin receipt time where available; legacy messages must
not gain a new lifetime merely because delivery was delayed.

Ignore stale or duplicate generations before changing context. Token updates
cannot revive a locally retired session. Preserve legitimate timely sync and
clock-skew handling. Add only the small internal mechanism needed for a
reproduced refresh race; browsers without an available coordination API retain
the existing single-client fallback.

Serialize cookie rotation through each HTTP response. A newer context cancels
obsolete queued work; an unchanged explicit renewal can still run after the
previous renewal finishes. Guarantee ordering rather than inventing persistent
cross-tab state to require exactly one HTTP request. Acquisition and HTTP share
the existing request timeout, so a frozen lock holder cannot block recovery
indefinitely. Cancellation, logout, account replacement, terminal auth failure,
and client cleanup must prevent late credential publication.

This extends the auth correctness contracts beside
[browser wake recovery](2026-10-02-browser-wake-recovery.md) and
[request admission](2026-10-22-client-request-admission.md).
It does not change transport liveness or retry uncertain application writes.
Lost HTTP refresh responses remain a protocol limitation.

## Acceptance criteria and planned verification

| ID | Observable behavior | Planned verification |
| --- | --- | --- |
| T1 | A delayed update preserves original token age; expired updates never appear fresh. | Controlled-clock cross-tab tests, including legacy metadata. |
| T2 | Older and duplicate updates cannot replace newer credentials or revive a retired session. | Existing cross-tab suite extended with ordering and logout cases. |
| T3 | Timely updates remain usable with client/server clock skew. | Cross-tab and token-expiry compatibility cases. |
| T4 | Simultaneous tab renewals never overlap their HTTP responses; waiting uses the existing deadline, and retired work never dispatches or publishes later. | Focused auth regressions and real-browser coordination where supported. |
| T5 | Compiled ESM, declarations, and archive contain the verified correction. | Full repository npm release gate, audit, and package inspection. |

## Release and rollback

The user owns npm publication, pushes, and tags. Prepare a new patch version
only after verifying that the version is absent from the registry. Run the
existing guarded release verification without uploading. Record the signed
source commit and candidate checksums before handoff.

Consumers own downstream compatibility checks. Producer tooling must not invoke
consumer repositories. Rollback selects the prior published package; no data
migration is needed. Published versions are immutable.

## Execution and verification status

- [x] Add failing regressions before changing runtime behavior.
- [x] Implement and review the smallest auth-slice correction.
- [x] Complete focused checks and the existing release gate.
- [ ] Prepare a signed patch release and report archive identity.

All five local acceptance criteria passed. The source is ready for its signed
implementation commit. Publication remains with the user.

| Criterion | Executed evidence |
| --- | --- |
| T1-T3 | Cross-tab ordering, original age, legacy metadata, clock skew, duplicate and post-logout cases; exact JWT-expiry boundary checks. |
| T4 | Real Chromium Web Locks and BroadcastChannel cases, including another document holding the lock, bounded waiting, remaining HTTP budget, cancellation, no late dispatch, and convergence. |
| T5 | Frozen install, lint, strict typecheck, all split suites, build, generic packed-consumer smoke, archive validation, and security audit. |

Executed from the repository root:

```sh
MISE_GO_SET_GOROOT=false just verify-npm-release
```

Additional commands ran from `typeferry-ts/` under the pinned Mise toolchain:

```sh
MISE_GO_SET_GOROOT=false mise exec -- npm audit --audit-level=low
MISE_GO_SET_GOROOT=false mise exec -- npm run test:unit -- src/auth/client/cross-tab-sync.unit.spec.ts src/auth/client/token-refresh.unit.spec.ts src/client/context-manager.unit.spec.ts src/test/node/token-refresh.unit.spec.ts
MISE_GO_SET_GOROOT=false mise exec -- npm run test:browser -- src/auth/client/token-refresh.browser.spec.ts
```

Passed: 1,747 unit cases, 92 integration cases, and 24 Chromium cases.
Three opt-in Ruby integration cases were skipped. The affected unit run passed
95 cases; the affected Chromium file passed 14 cases. After the complete gate,
only the convergence test changed: it now verifies the actual broadcast's
receipt timestamp instead of assuming two `Date.now()` calls are equal.
Its 14 cases, scoped lint, strict typecheck, and diff checks passed again.

The audit reported zero vulnerabilities. Registry verification confirmed
`0.15.3` was available, while `0.15.2` remained latest. Existing warnings cover
deprecated stub packages and unapproved scripts in the disposable generic
consumer. No script approvals or publication guards changed. Temporary
MongoDB, Redis, and generic-consumer resources were removed; existing services
were preserved. Independent source review found no blocking correctness issues.

## Candidate identity

The compiled archive contains 574 allowed files and is 303,825 bytes.
Public function signatures, production dependency ranges, and wire behavior
remain unchanged. The version bump is `0.15.2` to `0.15.3`.

- SHA-1: `c8d5ea79a574d53d393fa0e1c65feee301cdbf4e`
- SHA-256: `ad0baa8933d06bbd631072fd95a681979376f4c27ddcbc210a29abb1367bb406`
- npm integrity: `sha512-CjdNqKDAE0orJfd95flKsFhcSBOPIlpXmFL2/ir8eJTYTkbX2UIvtgWSwHqkVEmaP+N/o89aHyDLyPbXi5vcnA==`

Physical overnight suspension and production deployment are outside local
release verification. Old or unsupported clients without Web Locks retain the
previous concurrency limitation. A lost response after server rotation remains
ambiguous; this patch does not weaken reuse detection or recover revoked grants.

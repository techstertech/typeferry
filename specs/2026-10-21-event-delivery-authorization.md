---
status: validating
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-10-21
updated: 2026-10-21
owner: typescript-runtime
implementation:
  commits: []
---

# Opt-in event delivery authorization and security release

## Outcome and approved scope

Applications can stop delivering resource events after permission revocation,
without closing a client's other subscriptions. The user approved implementing
this additive TypeScript server feature and updating vulnerable Vitest pins.
Publication remains operator-owned: report verified readiness, do not publish.

## Contract

Add `EventOptions.revalidateOnDelivery?: boolean`, default false. For enabled
events, the receiving instance checks current authentication for protected
events, channel authorization, and `shouldSubscribe` before every socket send.
The same path handles local and Redis propagation. False results or errors deny
delivery and remove only that event/channel subscription. No authorization
result is cached. Application predicates must query current authoritative access.

Checks begun after a committed revocation must deny delivery; checks already
authorized before revocation cannot retract a frame. Unsubscribe, disconnect,
and leave/rejoin while awaiting a predicate invalidate that pending delivery.
Logout during a predicate also denies protected delivery. Preserve FIFO order
within an opted-in subscription, and allow independent recipients to progress.
Excluded originators are neither sent the event nor unnecessarily rechecked.

Keep `propagate()`/`emit()` synchronous public signatures; asynchronous delivery
is internally supervised. Preserve default events, wire envelopes, Redis
messages, subscription acknowledgement shapes and client behavior. This is an
optional TypeScript authoring capability, not a new cross-language default or
claim that other servers support this option. Document that distinction beside
the protocol's existing authoring options and in the TypeScript event guide.

Use the existing socket lifecycle to maintain efficient socket-to-node lookup.
Never scan all connected clients for each event recipient. An authorization
failure diagnostic may name the event, but must omit predicate errors, payloads
and customer identity. Do not add dependencies for this feature.

## Security dependency change

Upgrade the Vitest family coherently to a current compatible patched version
(advisory floor 4.1.12), including runtime tooling and coverage. Use npm to update
manifest/lock and audit the result; never suppress advisories or downgrade the
framework. Select a new minor package version for the additive event API.

Candidate: `0.15.0`, with Vitest/browser/coverage `4.1.12`. The execution audit
also found Hono and Vite advisories in existing resolutions. Their lock entries
are updated within existing declared ranges; no new dependency or range change
is introduced. The current safe installed versions and audit result are recorded
with release evidence. Optional proxy client-address work remains separate:
trusted peer/topology configuration must be established by the application
before forwarding headers can safely become an authorization/rate-limit input.

## Acceptance and planned checks

| ID  | Observable behavior                                                                     | Verification                                                                        |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A1  | Revoked users lose only the affected subscription; allowed peers still receive          | Real socket integration plus room tests                                             |
| A2  | False/error channel and event decisions deny delivery, including logout                 | Focused authorization tests                                                         |
| A3  | Redis receiving instances independently enforce current access and originator exclusion | Two-server Redis integration                                                        |
| A4  | Unsubscribe/rejoin/disconnect invalidate pending sends; FIFO is preserved               | Deferred-predicate room regressions and reconnect integration                       |
| A5  | Legacy events and public signatures remain compatible                                   | Existing event/channel suites and emitted declarations                              |
| A6  | Patched dependency graph and built package are consumable                               | Audit, exact-toolchain release gate, generic packed consumer and archive validation |

Design and run regression tests before runtime implementation. Run focused
suites first, then required full TypeScript suites, lint, typecheck, build,
package dry-run and repository release gate with disposable MongoDB/Redis.
Do not run consumer-repository tests from producer tooling. Keep publication
guards unchanged and record candidate checksums and environmental limitations.

## Recovery and limits

Reverting the API requires removing its use in consumers. Reverting dependency
patches reopens advisories; prefer fix-forward. Slow permission stores delay
delivery and queue subsequent events in that subscription; applications should
keep checks bounded. Multi-instance correctness depends on a shared,
authoritative permission store. No external deployment or production guarantee
is established by local tests.

## Execution and evidence

- [x] Regression tests reproduce absent delivery authorization.
- [x] Implement and document opt-in API and lifecycle safeguards.
- [x] Upgrade dependencies and select candidate version.
- [x] Verify complete package and record evidence.
- [ ] Commit verified source and notify operator of publication readiness.

The pre-implementation integration run reproduced six failures for absent live
authorization (with the reconnect baseline already passing), and all six new
room tests failed for the missing authorized-broadcast operation. After the
implementation, 73 focused unit checks and 13 focused integration checks passed,
including existing Redis regressions. Strict typecheck passed. The full release
gate passed with the command-scoped Go correction described below.

The first complete gate passed all 1,709 unit cases, then failed to compile Go
interoperability fixtures because the inherited Mise Go root was 1.25.4 while
the child executable was Go 1.27.2. The Go module requires 1.27. The retry uses
`MISE_GO_SET_GOROOT=false just verify-npm-release` so Go selects its matching
root; Node/npm remain pinned. This is a command-scoped environment adjustment,
not a global configuration or release guard change. The first attempt's owned
MongoDB/Redis containers were automatically removed.

The complete corrected release gate passed on Node `24.19.0` / npm `11.17.0`:

```sh
MISE_GO_SET_GOROOT=false just verify-npm-release
cd typeferry-ts
mise exec -- npm audit --audit-level=low
```

Results: immutable install, lint, strict typecheck, 1,709 unit tests, 88
integration tests, 10 browser tests, build, packed application consumer
(typecheck, client/server builds and runtime imports), and archive validation
all passed. The archive contains 568 allowed files. Three existing opt-in Ruby
interoperability cases were skipped; no newly added test was skipped. Audit
reports zero vulnerabilities. Installed Hono is `4.13.13`, Vite is `8.3.5`, and
the Vitest family is `4.1.12`. The existing deprecated stub
`@types/json-stable-stringify` install warning is non-blocking.

| Criterion | Executed evidence                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1        | Passed: actual sockets retain allowed peer/unrelated delivery and evict revoked membership                                                            |
| A2        | Passed: channel denial/errors, event errors, logout and identity changes fail closed; diagnostics omit private error text                             |
| A3        | Passed: two Redis-connected servers independently authorize and retain originator exclusion                                                           |
| A4        | Passed: six focused room cases cover FIFO, independent recipients, queued denial, leave/rejoin, disconnect and close; reconnect requires access again |
| A5        | Passed: existing suites, generic packed consumer and emitted declarations preserve default behavior and expose the additive option                    |
| A6        | Passed locally: complete release gate, registry version-availability check and clean audit; actual publication remains operator-owned                 |

Event removal during an awaiting predicate also denies delivery. Production
topology/load and other language implementations' optional feature parity were
not exercised or claimed. No wire/default change requires new shared fixtures.
The candidate remains `validating` until operator publication is recorded; this
does not leave any failed local release check unresolved.

References:

- [Vitest manual mock injection advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)
  and [Windows path advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp).
- [Hono static path advisory](https://github.com/honojs/hono/security/advisories/GHSA-5r4p-p66f-jhc7)
  and [Vite middleware advisory](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw).
- [Mise Go root configuration](https://mise.jdx.dev/lang/go.html#go-set-goroot).

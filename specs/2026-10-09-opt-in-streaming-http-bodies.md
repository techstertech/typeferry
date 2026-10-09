---
status: shipped
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-10-09
updated: 2026-10-09
owner: node-http-transport
related-specs:
  - 2026-10-02-host-aware-proxy-and-http-body-ceilings.md
implementation:
  commits:
    - 8bbb7cae68dc4fd4f10f54b97405fe00722c3f43
---

# Opt-in streaming HTTP request bodies

## Outcome and authority

A Node/Hono upload route can authenticate and consume bounded chunks before the
client finishes uploading, without retaining the entire body in transport memory.
The user approved the additive TypeFerry API and downstream dependency upgrade;
the user will publish manually because registry authentication is operator-owned.
Prepare and verify the release but do not publish or change publication guards.

## Evidence and scope

The installed Hono body-limit buffers requests without Content-Length before
application middleware. The shipped body-ceiling contract deliberately preserves
pre-handler overflow rejection. Streaming is therefore opt-in; this specification
extends that contract only for explicitly opted-in paths. No RPC envelopes,
cross-language protocol, authorization policy, declared dependency ranges or
data formats change. A release-audit remediation is recorded below.

## Contracts

`RequestBodySizeLimit.bodyMode?: 'buffered' | 'streaming'` defaults to buffered.
All matching route rules must opt in to select streaming; a matching buffered
rule wins. Existing segment-scoped decoded paths and minimum global/route ceiling
remain authoritative. Malformed encodings select the minimum cap and buffered
mode. Invalid modes reject construction before the listener starts.

Streaming rejects excessive Content-Length before handlers, counts actual bytes
as read (including requests with Content-Length), and applies backpressure without
collecting the whole body. A read overflow must produce HTTP 413 even if a handler
catches the read error. Cancellation reaches the authoritative input and does not
crash header-only observers. Authentication can reject an unfinished request;
streaming handlers must validate EOF before committing irreversible effects or
reporting a successful upload. Routes own admission, disk spooling and deadlines.

```text
Node input -> selected byte-limited stream -> auth/admission -> bounded consumer
                                                       -> verified EOF -> commit
```

## Acceptance criteria and verification

1. Native chunked bytes reach a streaming route before EOF; unauthorized stalled
   requests receive immediate rejection. Test direct and observed Node transports.
2. Streaming overflow returns 413 before EOF, including a handler that catches the
   read failure; known Content-Length overflow never reaches the handler.
3. Bounded chunks and downstream cancellation preserve backpressure and cleanup.
   Test procedural sources and native interrupted requests without storing fixtures.
4. Defaults, overlapping buffered rules, decoded paths, malformed encodings and
   global minimum remain compatible. Retain existing buffered transport regressions.
5. Built ESM/declarations expose the strongly typed opt-in; release checks pass and
   the downstream consumer validates its own compiled packed artifact. No source
   aliases, publication, credentials or consumer checkout paths enter producer tools.

## Recovery and release

Remove the opt-in in consumers before downgrading TypeFerry. This API requires no
migration. Incomplete files and durable writer reconciliation remain consumer-owned.
Run focused tests first, then lint/typecheck/all split suites/build/packed consumer
and package archive validation. Prepare an immutable minor-version candidate and
signed commits; the operator runs the existing guarded publication recipe manually.

## Verification status

Released: `typeferry@0.14.0`, manually published by the user. Public registry
metadata reports this version as latest and `gitHead` matches implementation
commit `8bbb7cae68dc4fd4f10f54b97405fe00722c3f43`. Package SHA-1 is
`7a71bf2c1e745b8be2aa2722a4750031d07bcea0`; both SHA-1 and SHA-512 integrity
match the tested compiled candidate. No package, tag, push or deployment was
published by the agent.

- Acceptance 1: passed. Native unfinished requests reach handlers and can reject
  before EOF, both directly and with an optional request observer.
- Acceptance 2: passed. Actual overflow receives immediate 413 even when the
  handler catches it; excessive Content-Length never invokes the handler. The
  client socket closes after the overflow response without waiting for client EOF.
- Acceptance 3: passed. A paused 4 MiB procedural upload keeps observed transport
  input below 1 MiB, then delivers its exact byte count. In-memory input pulls only
  on consumer demand and forwards cancellation. Native disconnect before and
  after body reading reaches the request signal and cleanup without unhandled
  errors. The pre-read disconnect test found an observer mirror error before its
  fix; both modes now pass.
- Acceptance 4: passed. Existing buffered transport regressions remain green;
  defaults, buffered overlaps, malformed encodings, decoded prefix equivalents,
  sibling paths and global ceilings are covered. Initial new tests had nine
  failures against the previous buffering implementation. All 32 focused native
  transport checks pass.
- Acceptance 5: local compiled-artifact validation passed. The complete producer
  gate passed 1,703 unit, 77 integration and 10 browser cases; three explicitly
  opt-in Ruby interoperability cases were skipped because no wire behavior changed.
  Lint, strict types, immutable install, build, generic packed consumer smoke and
  archive validation passed (568 allowed files). Downstream acceptance is owned
  and recorded by the consumer, never invoked from producer scripts. Manual
  publication was performed by the user; registry artifact equivalence is
  verified. The downstream consumer adopts the registry release in its manifest
  and lock, with 89 integration and 47 unit checks, full and strict types, scoped
  lint and build passing. Consumer evidence stays in the consumer checkout.

The separate audit detected a pre-existing high-severity source-map-js issue:
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
The targeted npm lock update selects patched `1.2.2` within the existing allowed
transitive range and removes four redundant nested peer entries. No other
package version or declared dependency changes. Audit now reports zero
vulnerabilities; the complete release gate passed again against this final lock.
This is a disclosed release-preparation deviation from the original unchanged
lock assumption. Existing install warnings concern deprecated stub types and a
DOMException package in the generic consumer fixture.

Executed producer checks (repository root unless specified):

```sh
just verify-npm-release
cd typeferry-ts
mise exec -- npm run test:unit -- src/server/transports/node-hono-streaming.unit.spec.ts src/server/transports/node-hono-transport.unit.spec.ts
mise exec -- npm audit --audit-level=low
mise exec -- npm pack --json --pack-destination "$candidate_dir"
```

Review public policy/defaults -> byte/backpressure/cancellation lifecycle ->
observer disconnect -> native compatibility cases -> release package/lock.
Registry publication, artifact equivalence and downstream manifest adoption
are verified. Keep publication guards and authentication intact.

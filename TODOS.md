# TypeFerry TODOs

`PROTOCOL.md` is the normative wire authority. The TypeScript, Python, Rust,
and Go servers must agree with it and with the shared conformance fixtures.
No language implementation may become an undocumented second protocol.

## Bidirectional server parity

- [ ] Build one generated coverage matrix mapping every normative protocol clause and fixture to TypeScript, Python, Rust, and Go tests.
- [ ] Require wire changes to update `PROTOCOL.md`, shared fixtures, and every affected server in the same change.
- [ ] Run TypeScript client interoperability tests against Python and Rust in continuous integration.
- [ ] Add negative fixtures for malformed envelopes, protected methods, authorization failures, origin rejection, and boundary limits.
- [ ] Keep HTTP, WebSocket, Redis, EJSON, auth defaults, errors, events, rooms, cache keys, and lifecycle behavior in the matrix.
- [ ] Prevent a server from claiming conformance when a required fixture is skipped or special-cased.
- [ ] Record intentional feature-parity gaps separately from wire-protocol failures.

## Known parity work

- [ ] Align duplicate client UUID replacement semantics in every server and shared lifecycle tests.
- [ ] Align request metadata exposed to application handlers without changing wire envelopes.
- [ ] Align Rust WebSocket `meta` parsing with the protocol and TypeScript behavior.
- [ ] Verify configured HTTP origin enforcement and the 120-request default limiter across server adapters.
- [ ] Exercise Redis reconnect, cleanup, and originator exclusion across mixed-language server pairs.

## Release gate

- [ ] Make cross-language conformance and interoperability mandatory before enabling Python or Rust publication.
- [ ] Publish a machine-readable conformance report with each server release candidate.
- [ ] Reject releases when normative prose, fixtures, server behavior, or documented support status disagree.

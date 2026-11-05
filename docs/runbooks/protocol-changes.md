# Protocol Change Runbook

Use this runbook for any change visible across HTTP, WebSocket, Redis, EJSON, authentication defaults, RPC resolution, cache keys, error codes, or events.

## Preconditions

- Read [`PROTOCOL.md`](../../PROTOCOL.md), the relevant fixture documentation, and each affected package's `AGENTS.md`.
- Identify whether the change is backward-compatible, additive, or breaking.
- Obtain explicit approval before changing a public API, persisted format, security boundary, or protocol default.
- Create or update the task specification before implementation.

## Procedure

1. Write the acceptance examples as shared fixtures under `docs/conformance/fixtures/` when the fixture model supports the behavior.
2. Update `PROTOCOL.md` with the normative envelope, default, error, or lifecycle semantics.
3. Implement the TypeScript behavior and its focused tests.
4. Update Python, Rust, Ruby, and Go in the same change when they implement the affected surface. If parity cannot land together, document the explicit gap and prevent fixtures from claiming unsupported conformance.
5. Update fixture documentation when a schema or case convention changes.
6. Run focused fixture tests, then each affected implementation's full relevant suites.
7. Record a decision when the choice changes future compatibility, security, or architecture.

## Focused fixture commands

From `typeferry-ts/`:

```sh
npm run test:unit -- src/test/conformance/ejson-fixtures.unit.spec.ts
npm run test:integration -- src/test/conformance/http-fixtures.integration.spec.ts src/test/conformance/ws-fixtures.integration.spec.ts
```

From `typeferry-py/`:

```sh
python -m pytest tests/conformance
```

From `typeferry-rs/`:

```sh
cargo test -p typeferry-conformance
```

From `typeferry-rb/`:

```sh
bundle exec rake test:conformance
```

From `typeferry-go/`:

```sh
go test ./ejson ./httptransport ./websocket ./redistransport
```

Run cross-language integration from `typeferry-ts/` when the affected servers are available:

```sh
TYPEFERRY_RUBY_INTEGRATION=1 npm run test:integration -- src/test/conformance/cross-lang.integration.spec.ts src/test/conformance/cross-lang-rs.integration.spec.ts src/test/conformance/cross-lang-rb.integration.spec.ts src/test/conformance/cross-lang-go-http.integration.spec.ts src/test/conformance/cross-lang-go-ws.integration.spec.ts
```

Ruby interoperability is opt-in and otherwise skips silently. If nested commands
select another Ruby runtime, set `TYPEFERRY_RUBY_EXECUTABLE` to the pinned
`bundle` executable. Set `TYPEFERRY_RUBY_EXECUTABLE_ARGS` to a JSON array containing
`"exec"` and the pinned `ruby` executable path.

Fixture success does not establish coverage of every requirement in protocol
sections 2–10. Review uncovered requirements and verify negative assertions,
including void-call silence, authentication timeouts, and origin admission.

## Acceptance criteria

- Normative prose and fixtures agree.
- Every implemented language produces and accepts the intended representation.
- Negative cases define rejection behavior, not only happy paths.
- Auth or authorization changes fail closed.
- No implementation passes by special-casing a fixture filename.
- Relevant package-wide verification passes.

## Recovery

If parity or compatibility cannot be demonstrated, revert the protocol, fixture, and implementation changes together. Do not leave a normative document describing behavior no released implementation supports.

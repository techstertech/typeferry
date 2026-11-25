# TypeFerry Agent Instructions

TypeFerry is a multi-language monorepo implementing one wire protocol. Start with [docs/agents/README.md](docs/agents/README.md) to route the task to the correct authority, architecture page, runbook, and verification surface.

## Repository map

- `PROTOCOL.md` — normative cross-language wire protocol.
- `docs/conformance/` — normative fixture formats and shared executable examples.
- `typeferry-ts/` — TypeScript client, Node.js server, auth, React adapter, EJSON, and MongoDB extension. Follow `typeferry-ts/AGENTS.md`.
- `typeferry-py/` — Python server implementation. Follow `typeferry-py/AGENTS.md`.
- `typeferry-rs/` — Rust server workspace. Follow `typeferry-rs/AGENTS.md`.
- `typeferry-go/` — Approved Go server with local and remote parity gates passed; no release tag. Follow `typeferry-go/AGENTS.md`.
- `template/` — standalone TypeScript application template. Follow `template/AGENTS.md`.
- `specs/` — task specifications and executable implementation checklists.
- `decisions/` — durable architectural and workflow decisions.
- `docs/plans/` — historical, non-normative implementation plans.
- `RELEASING.md` — current release and publication status.

## Repository-wide contracts

- Treat `PROTOCOL.md` as authoritative for message envelopes, transports, EJSON tags, default methods, cache keys, authentication defaults, error codes, and event semantics.
- Update `PROTOCOL.md`, affected implementations, and shared conformance fixtures in the same change whenever wire behavior changes.
- Keep language implementations behaviorally aligned. A language-specific convenience API must not silently change the shared wire contract.
- Read the nearest `AGENTS.md` before modifying files under a package or template.
- Design tests before implementation and run the narrowest relevant suite first. Expand verification in proportion to the affected contract.
- Keep public APIs strongly typed. Do not weaken TypeScript or Python strictness, and preserve explicit Rust types and error boundaries.
- React is the only maintained UI-framework adapter. Other UI frameworks integrate through the core TypeScript client unless a future architecture decision explicitly expands the supported adapter surface.
- Use semantic comments for non-obvious invariants and multiline API documentation for public or complex contracts.
- Keep documentation links and commands current when paths, scripts, exports, or behavior change.
- Use semantic commits with path-limited staging. Never bypass Git hooks unless the user explicitly requests it.
- Repository test and release commands may execute only test suites tracked by
  this repository. Never copy, discover, invoke, or encode a path to another
  repository's tests or checkout.
- Downstream compatibility validation belongs to the downstream repository. A
  consumer may install a packed TypeFerry artifact and run its own tests, but
  TypeFerry release tooling must remain consumer-agnostic.

## Change routing

- Protocol or cross-language behavior: follow `docs/runbooks/protocol-changes.md`.
- Conformance failure: follow `docs/runbooks/diagnose-conformance-failure.md`.
- Dependency update: follow `docs/runbooks/update-dependency.md`.
- Release verification: follow `docs/runbooks/release-verification.md`.

Historical plans explain how the repository arrived at its current design. They do not override source, tests, `PROTOCOL.md`, scoped `AGENTS.md` files, or accepted decisions.

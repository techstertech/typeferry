# TypeFerry Architecture Overview

Status: informative description of the current repository. [`PROTOCOL.md`](../../PROTOCOL.md) remains normative for wire behavior.

## System shape

TypeFerry implements one RPC, event, authentication, and serialization protocol across four languages.

```text
                       PROTOCOL.md
                            |
                  shared conformance fixtures
                            |
       +-------------+------+------+-------------+
       |             |             |             |
 typeferry-ts  typeferry-py  typeferry-rs  typeferry-go
client + server    server        server        server
```

The TypeScript package is the only client implementation. Python, Rust,
and Go target server-side feature parity. Shared fixtures make behavior
observable without requiring identical internal APIs.

Go has an approved public API and passed local and remote parity checks. It has
no release tag. Its core EJSON, protocol, and runtime packages stay independent
of optional transport, Redis, and authentication adapters. Applications own HTTP
listeners.

The proposed batteries-included TypeScript application workflow is described
in the [application framework and toolchain proposal](application-framework-toolchain.md).

## Authority boundaries

- Protocol envelopes, defaults, serialization tags, error codes, and transport semantics belong in [`PROTOCOL.md`](../../PROTOCOL.md).
- Fixture schema and shared examples belong in [`docs/conformance/`](../conformance/README.md).
- Language ergonomics and internal composition belong to each implementation, provided they preserve the protocol.
- Release enablement and registry identities belong in [`RELEASING.md`](../../RELEASING.md) and accepted decisions.
- The standalone `template/` consumes the TypeScript package through its export surface and must not become a second implementation of TypeFerry internals.

## Dependency direction

Serialization and protocol definitions sit below runtime primitives. Methods, events, auth, and transports build on those foundations. Framework adapters and application templates build on public runtime surfaces. Dependencies should point inward toward the shared semantics, not from core runtime into UI adapters or application policy.

## Cross-language change boundary

A change is protocol-governed when it affects anything a peer can observe on HTTP, WebSocket, or Redis; EJSON representation; authentication defaults; method resolution; event routing; or canonical keys. Such changes require the [protocol-change runbook](../runbooks/protocol-changes.md).

A language-only change may remain local when it affects implementation structure, typing ergonomics, diagnostics, or an adapter API without changing observable wire behavior. It still requires the scoped package verification.

## Verification layers

1. Focused unit tests establish local logic.
2. Language integration tests establish runtime and transport behavior.
3. Shared fixtures establish cross-language agreement.
4. Cross-language server tests establish interoperability where implemented.
5. Builds and package inspection establish consumer-facing release integrity.

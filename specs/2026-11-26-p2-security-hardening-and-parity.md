---
status: in-progress
created: 2026-11-26
updated: 2026-11-26
owner: security-hardening
supersedes: 2026-11-25-monorepo-security-hardening.md
---

# P2 Security Hardening and Cross-Language Parity

## Outcome and approval

Address all remaining P2 security items and cross-language parity gaps across
`PROTOCOL.md`, `typeferry-ts`, `typeferry-go`, `typeferry-py`, `typeferry-rs`, and
`.github/workflows/ci.yml`. Related prior work lives in
[2026-11-25-monorepo-security-hardening.md](2026-11-25-monorepo-security-hardening.md).

The user approved the following choices (`1a; 2a; 3a`) on 2026-11-26:

- **1a — Protocol defaults & query-token opt-out:** Keep existing defaults (`?token=`
  allowed and omitted `origins` allows all), add an explicit `allowQueryToken: false`
  / `DisableQueryToken` opt-out across all four runtimes, emit a startup warning when
  `origins` is omitted in production, and add `WebSocketHandshakeAuthenticator` to Rust.
- **2a — Redis integrity & EJSON RegExp bound:** Add optional HMAC-SHA256 signing
  (`signingSecret`) plus strict inbound envelope validation and bounded channel
  handling across all four Redis adapters without changing unsigned wire bytes, and cap
  TypeScript EJSON `$regexp` pattern length at 1024 characters.
- **3a — CI & Rust transport options:** Extend `.github/workflows/ci.yml` (`ubuntu-24.04`)
  with Python, Rust, and `template/` jobs, and expand Rust `HttpOptions` and
  `WebSocketOptions` into structs (preserving `OriginPolicy` conversion) to add default
  HTTP/WS sliding-window rate limits (`120 req / 60 s`) and handshake authentication.

## Scope & shared contracts

1. **Redis optional HMAC-SHA256 signing (`signingSecret`):**
   - Unset/empty: omit `"sig"` on publish and accept unsigned frames on receive
     (backward compatible with `docs/conformance/fixtures/redis/*.case.json`).
   - Non-empty: compute lowercase hex `HMAC-SHA256` over length-prefixed UTF-8 byte
     lengths `"{byteLen(event)}:{event}|{byteLen(channel)}:{channel}|{byteLen(message)}:{message}|{byteLen(excludeUuid)}:{excludeUuid}"`
     (with normalized `channel`, empty normalized to `"NO_CHANNEL"`, and empty string
     for omitted `excludeUuid`), verify with constant-time comparison, and drop
     missing/invalid/non-string signatures.
   - Always validate inbound fields (`event` and `message` non-empty strings; optional
     `channel` and `excludeUuid` string or null/omitted) and avoid unbounded
     `server.channels` growth on unknown channels.
2. **HTTP authentication timeouts:** Add 5s default auth timeout failing closed in TS
   and Python (matching Go and Rust).
3. **TS WebSocket resource caps:** Add per-connection RPC concurrency cap (default `64`),
   outbound `bufferedAmount` backpressure cutoff (default `4 MiB`), and tighten default
   `maxPayload` from `16 MiB` to `1 MiB` (retaining `maxPayload` override).
4. **Cross-runtime `revalidateOnDelivery` and `MethodOptions.sensitive` parity:** Add
   `revalidateOnDelivery` to Go, Python, and Rust; add `MethodOptions.sensitive`
   telemetry/error redaction to Python and Rust.
5. **TS JWT edge checks:** Reject empty `config.secret` and future `iat` claims beyond
   `+5 s` clock skew in `jwt-utils.ts`.
6. **Rust EJSON bounds:** Reject non-zero trailing Base64 padding bits in
   `base64::decode`; enforce explicit depth bound (`128`) in `stable_stringify`.

## Acceptance criteria

| ID | Observable outcome | Planned verification |
| --- | --- | --- |
| A1 | Redis adapters across TS, Go, Python, and Rust validate inbound types, use bounded channel routing, produce identical HMAC `sig` values, and reject tampered/missing signatures when `signingSecret` is set | Unit tests + cross-language HMAC vector check across all 4 runtimes + existing Redis fixtures |
| A2 | `allowQueryToken` opt-out blocks `?token=` while retaining `handshakeAuthenticator` across TS, Go, Python, and Rust; omitted `origins` logs a production warning; Rust HTTP/WS enforce 120/60s rate limits | Unit/integration tests in TS, Go, Python, Rust |
| A3 | TS HTTP auth timeout fails closed; TS WS enforces concurrency/backpressure caps and `1 MiB` default payload; TS EJSON rejects `$regexp > 1024`; TS JWT rejects empty secret & future `iat` | TS unit tests (`vitest`), `tsc --noEmit`, `eslint src/` |
| A4 | `revalidateOnDelivery` re-checks auth/channel/`shouldSubscribe` and evicts unauthorized members across TS, Go, Python, and Rust; `MethodOptions.sensitive` redacts logs/telemetry | Unit tests in Go (`-race`), Python (`pytest`), Rust (`cargo test`) |
| A5 | Rust EJSON rejects non-zero Base64 padding bits and bounds `stable_stringify` at depth 128 | Rust `typeferry-ejson` tests (`cargo test`, `clippy -D warnings`) |
| A6 | `.github/workflows/ci.yml` includes `ci-py`, `ci-rs`, and `ci-template` with pinned actions and valid YAML; all 4 cross-language suites pass | YAML parse check + `cross-lang-*` suites |

## Execution checklist

- [x] Unit 1: Create spec and update `PROTOCOL.md`.
- [ ] Unit 2: TypeScript P2 hardening & unit tests (`typeferry-ts`).
- [ ] Unit 3: Go P2 hardening/parity & race tests (`typeferry-go`).
- [ ] Unit 4: Python P2 hardening/parity & pytest/ruff/mypy (`typeferry-py`).
- [ ] Unit 5: Rust P2 hardening/parity & cargo workspace checks (`typeferry-rs`).
- [ ] Unit 6: CI workflow expansion (`.github/workflows/ci.yml`).
- [ ] Unit 7: Cross-language verification, Rust `target/` cleanup, spec completion.

## Verification record

*Pending execution.*

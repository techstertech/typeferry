# Ruby Package Agent Instructions

- `lib/typeferry/ejson.rb` owns serialization, `protocol.rb` owns wire constants,
  `runtime.rb` owns server behavior, `transports/` owns external adapters, and
  `auth/` owns JWTs, cookies, sessions, device information, and OAuth.
- Core code must not eagerly require Rack, WebSocket, Redis, or auth gems.
- Public APIs require matching RBS signatures under `sig/`.
- Tests live under `test/unit`, `test/conformance`, and `test/integration`.
- Run `bundle exec rake verify` from this directory before substantive commits.
- From the repository root, `just verify-ruby` pins Ruby for nested tools and
  supplies an isolated Redis instance unless `REDIS_URL` already names a test
  service. Use only a disposable test URL.
- Protocol-facing changes also follow `docs/runbooks/protocol-changes.md`.

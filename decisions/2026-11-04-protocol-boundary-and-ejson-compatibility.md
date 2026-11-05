---
status: accepted
project: typeferry
project-root: /Users/leonardo/Repositories/typeferry
created: 2026-11-04
updated: 2026-11-04
related-specs:
  - ../specs/2026-11-04-protocol-compliance-defects.md
---

# Protocol boundary and EJSON compatibility corrections

## Decision

The user explicitly selected strict origin defaults with separate HTTP and
WebSocket originless opt-ins, full JavaScript date-range support in Rust with
necessary public date API changes, and preservation of existing TypeScript
EJSON bytes with a clarified cross-language ordering contract.

Omitted origin allowlists remain unrestricted. Explicitly empty allowlists
reject named origins. Originless opt-ins admit only missing headers. They do
not bypass a mismatch against an allowed browser origin.

## Rationale and consequences

Strict origin admission enforces the protocol's existing browser boundary.
Explicit opt-ins preserve trusted non-browser integrations without silently
permitting absent headers. Hosts using empty lists or originless clients must
review their configuration.

Chrono's date domain cannot represent every valid JavaScript date. Rust must
store the complete wire domain and expose checked chrono conversions. The
implementation must document changes to existing date constructors and matches.

Changing TypeScript encoding would change existing wire bytes and anonymous
cache identities. Preserve JavaScript array-index enumeration and UTF-16 sorting
for other canonical keys. Reject a new strict lexical byte order and deferral
of canonical parity because both leave avoidable compatibility gaps.

The [implementation spec](../specs/2026-11-04-protocol-compliance-defects.md)
defines observable acceptance and verification. It does not authorize deployment
or publication.

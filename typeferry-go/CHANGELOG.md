# TypeFerry Go changelog

The Go server remains an unpublished candidate pending API and release review.

## 2026-11-04

- Enforce JavaScript auth truthiness, literal JSON metadata, and fresh UUIDs for
  invalid handshake inputs. Distinguish nil and empty origin allowlists; retain
  independent HTTP and WebSocket originless opt-ins.
- Match JavaScript EJSON property order, including numeric index keys and
  canonical UTF-16 sorting. Report HTTP quota headers on every admitted response
  with a rounded-up reset, and observe negative fixture intervals.

## 2026-09-30

- fix(go): freeze runtime admission during joined shutdown
  Runtime retirement clears presence and rooms, closes late clients, rejects
  new work and preserves concurrent close results. Both real client transports
  now cover values, validation, caching and errors; WebSockets also cover
  protected/user events, exclusion and disconnected subscription cleanup.

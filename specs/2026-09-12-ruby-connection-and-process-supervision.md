# Ruby Connection and Process Supervision

Status: superseded by [the Ruby server retirement](2026-11-25-ruby-server-retirement.md)

## Problem

Ruby currently retains multiple WebSocket nodes with the same client UUID.
Reconnects can therefore receive duplicate events, and a stale close callback
can remove cluster membership belonging to the replacement.

SolidScript also needs a reusable Ruby child-process mechanism before its Ruby
server layer can own cancellable native-engine jobs. TypeFerry will own only the
generic lifecycle mechanism; job identifiers, endpoints, and cancellation
policy remain application-owned.

## Contracts

- `Server#add_client` atomically installs one node per UUID and closes a displaced node outside the registry lock.
- `Server#delete_client` removes registry and Redis membership only when the exact node is still current.
- Room cleanup remains safe for stale connections.
- `ProcessSupervisor` starts argv-only child processes in their own process group.
- A job has one stable ID and terminal result: exited, canceled, timed out, or spawn failed.
- Cancellation and timeout terminate the whole process group, reap the child, and are idempotent.
- Shutdown cancels and joins every active job.
- No TypeFerry wire message or protocol behavior is added.

## Risks and recovery

Process-group signaling is Unix-specific. The initial implementation supports
the Ruby package's current Unix/Puma deployment target and fails explicitly on
unsupported process control rather than silently leaking descendants.

Closing a displaced socket can synchronously invoke its stale deletion path.
Identity checks must protect the replacement before the old socket is closed.

Rollback is split into separate semantic commits for connection replacement
and process supervision.

## Verification

- [x] Duplicate UUID runtime tests, including stale deletion and Redis ownership.
- [x] Real Puma reconnect test proves the old socket closes and only the replacement receives events.
- [x] Process supervisor tests cover success, cancel, timeout, descendant termination, duplicate IDs, and shutdown.
- [x] RBS, README, architecture, and package inventory updated.
- [x] Redis-backed `bundle exec rake verify` passes without skips.

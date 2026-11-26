"""Room / subscription registry — port of ``typeferry-ts/src/server/room-registry.ts``.

Bidirectional in-memory index: room → sockets and socket → rooms.
Powers event broadcast and originator-exclusion semantics.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from typeferry.server.socket import SocketState, TypeFerrySocket

Sender = Callable[[TypeFerrySocket, str], Awaitable[None] | None]
DeliveryAuthorizer = Callable[[TypeFerrySocket], Awaitable[bool]]

_log = logging.getLogger(__name__)


class _Membership:
    __slots__ = ("pending",)

    def __init__(self) -> None:
        self.pending: asyncio.Future[None] | None = None


class RoomRegistry:
    """O(1) join/leave/broadcast over WebSocket subscriptions."""

    def __init__(self) -> None:
        self._rooms: dict[str, set[TypeFerrySocket]] = {}
        self._socket_rooms: dict[int, tuple[TypeFerrySocket, set[str]]] = {}
        self._memberships: dict[tuple[str, int], _Membership] = {}

    # ``TypeFerrySocket`` is a Protocol; concrete implementations may not be
    # hashable. We key the reverse index on ``id(socket)`` to avoid that
    # constraint. Membership in ``self._rooms`` sets still uses object
    # identity via Python's default hash (id-based for objects without
    # ``__hash__``), which is sufficient because we only ever compare the
    # same socket reference.

    def join(self, ws: TypeFerrySocket, room: str) -> None:
        """Add ``ws`` to ``room``. Idempotent."""

        members = self._rooms.setdefault(room, set())
        if ws not in members:
            members.add(ws)
            self._memberships[(room, id(ws))] = _Membership()

        entry = self._socket_rooms.get(id(ws))
        if entry is None:
            joined: set[str] = set()
            self._socket_rooms[id(ws)] = (ws, joined)
        else:
            _, joined = entry
        joined.add(room)

    def leave(self, ws: TypeFerrySocket, room: str) -> None:
        """Remove ``ws`` from ``room``. Prunes empty rooms and reverse index."""

        members = self._rooms.get(room)
        if members is not None:
            members.discard(ws)
            if not members:
                self._rooms.pop(room, None)
        self._memberships.pop((room, id(ws)), None)

        entry = self._socket_rooms.get(id(ws))
        if entry is not None:
            _, joined = entry
            joined.discard(room)
            if not joined:
                self._socket_rooms.pop(id(ws), None)

    def leave_all(self, ws: TypeFerrySocket) -> None:
        """Remove ``ws`` from every room it's joined. Called on disconnect."""

        entry = self._socket_rooms.pop(id(ws), None)
        if entry is None:
            return
        _, joined = entry
        for room in joined:
            members = self._rooms.get(room)
            if members is not None:
                members.discard(ws)
                if not members:
                    self._rooms.pop(room, None)
            self._memberships.pop((room, id(ws)), None)

    def broadcast(
        self,
        room: str,
        data: str,
        exclude: TypeFerrySocket | None = None,
        *,
        send: Sender | None = None,
    ) -> list[Any]:
        """Send ``data`` to every socket in ``room``.

        ``send`` defaults to ``ws.send(data)``. Return values from
        ``send`` (including coroutines) are collected so async callers
        can ``await asyncio.gather(*results)``.
        """

        members = self._rooms.get(room)
        if not members:
            return []

        results: list[Any] = []
        for ws in list(members):
            if ws is exclude:
                continue
            if getattr(ws, "readyState", SocketState.CLOSED) != SocketState.OPEN:
                continue
            result = (send or _default_send)(ws, data)
            if result is not None:
                results.append(result)
        return results

    async def broadcast_authorized(
        self,
        room: str,
        data: str,
        authorize: DeliveryAuthorizer,
        exclude: TypeFerrySocket | None = None,
    ) -> None:
        """Authorize each subscriber immediately before sending in per-membership FIFO order."""

        members = self._rooms.get(room)
        if not members:
            return

        loop = asyncio.get_running_loop()
        deliveries: list[asyncio.Task[None]] = []
        for ws in list(members):
            if ws is exclude:
                continue
            membership = self._memberships.get((room, id(ws)))
            if membership is None:
                continue
            prior = membership.pending

            def _is_current(
                socket: TypeFerrySocket = ws, token: _Membership = membership
            ) -> bool:
                return (
                    self._memberships.get((room, id(socket))) is token
                    and getattr(socket, "readyState", SocketState.CLOSED) == SocketState.OPEN
                )

            async def _deliver(
                socket: TypeFerrySocket = ws,
                wait_for: asyncio.Future[None] | None = prior,
                check: Callable[[], bool] = _is_current,
            ) -> None:
                if wait_for is not None:
                    with contextlib.suppress(Exception):
                        await wait_for
                if not check():
                    return
                allowed = False
                try:
                    allowed = bool(await authorize(socket))
                except Exception:
                    _log.warning("TypeFerry event delivery authorization failed")
                if not check():
                    return
                if not allowed:
                    self.leave(socket, room)
                    return
                outcome = socket.send(data)
                if inspect.isawaitable(outcome):
                    await outcome

            task = loop.create_task(_deliver())
            membership.pending = task
            deliveries.append(task)

        if deliveries:
            await asyncio.gather(*deliveries, return_exceptions=True)

    def has(self, ws: TypeFerrySocket, room: str) -> bool:
        members = self._rooms.get(room)
        return ws in members if members is not None else False

    def get_room_size(self, room: str) -> int:
        members = self._rooms.get(room)
        return len(members) if members is not None else 0


def _default_send(ws: TypeFerrySocket, data: str) -> Any:
    return ws.send(data)

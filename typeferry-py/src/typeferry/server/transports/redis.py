"""Redis multi-instance transport — port of
``typeferry-ts/src/server/transports/redis-transport.ts``.

Propagates events across TypeFerry server instances via Redis pub/sub.
See PROTOCOL.md §2.3.

Wire format:

* Channel name: literal ``"events"`` (``RedisListeners.EVENTS``)
* Payload: EJSON-encoded ``{event, channel, message, excludeUuid?}``
  where ``message`` is the already-encoded wire frame from
  :meth:`typeferry.server.event.Event.handler`.

Keys maintained:

* ``typeferry:servers`` — SET of active server UUIDs
* ``typeferry:clients:<server-uuid>`` — SET of clients per server
* ``typeferry:users:<server-uuid>`` — SET of active users per server
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING, Any, cast

import redis.asyncio as aioredis

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import NO_CHANNEL, RedisListeners, ServerEvents

if TYPE_CHECKING:
    from typeferry.server.server import Server


_log = logging.getLogger(__name__)

_REDIS_URL_DEFAULT = "redis://localhost:6379"


class RedisTransport:
    """Redis pub/sub transport that mirrors the TS runtime byte-for-byte."""

    server: Server
    url: str
    _pub: aioredis.Redis | None
    _sub: aioredis.Redis | None
    _listener_task: asyncio.Task[None] | None

    def __init__(self, server: Server, url: str | None = None) -> None:
        self.server = server
        self.url = url or _REDIS_URL_DEFAULT
        self._pub = None
        self._sub = None
        self._listener_task = None
        self._ready_event: asyncio.Event = asyncio.Event()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Open publisher and subscriber connections; begin listening."""

        self._pub = aioredis.from_url(self.url, decode_responses=True)
        # Dedicated subscriber client — redis-py requires a separate
        # connection for pub/sub.
        self._sub = aioredis.from_url(self.url, decode_responses=True)
        await cast(Any, self._pub.ping())

        pubsub = self._sub.pubsub()
        await pubsub.subscribe(RedisListeners.EVENTS.value)

        self._listener_task = asyncio.create_task(self._listen(pubsub))
        self._ready_event.set()
        self.server.emit_server_event(ServerEvents.REDIS_CONNECT)

    async def wait_ready(self, timeout: float = 5.0) -> None:
        await asyncio.wait_for(self._ready_event.wait(), timeout=timeout)

    async def close(self) -> None:
        if self._listener_task is not None:
            self._listener_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._listener_task
            self._listener_task = None

        if self._pub is not None:
            with contextlib.suppress(Exception):
                await cast(Any, self._pub.delete(f"typeferry:clients:{self.server.uuid}"))
                await cast(
                    Any, self._pub.srem("typeferry:servers", self.server.uuid)
                )
            await self._pub.aclose()
            self._pub = None

        if self._sub is not None:
            await self._sub.aclose()
            self._sub = None

    # ------------------------------------------------------------------
    # Publish
    # ------------------------------------------------------------------

    async def publish(
        self,
        event: str,
        channel: str,
        message: str,
        exclude_uuid: str | None = None,
    ) -> None:
        """Publish a pre-encoded event frame to the cluster."""

        if self._pub is None:
            return

        payload: dict[str, Any] = {
            "event": event,
            "channel": channel or NO_CHANNEL,
            "message": message,
        }
        if exclude_uuid is not None:
            payload["excludeUuid"] = exclude_uuid

        await self._pub.publish(
            RedisListeners.EVENTS.value, Presentation.encode(payload)
        )

    # ------------------------------------------------------------------
    # Stats
    # ------------------------------------------------------------------

    async def get_stats(self) -> dict[str, Any]:
        """Return aggregate client/user counts across the cluster."""

        if self._pub is None:
            return {"clientCount": 0, "userCount": 0, "users": []}

        client_count = 0
        user_count = 0
        users: set[str] = set()

        servers = await cast(Any, self._pub.smembers("typeferry:servers"))
        for server_uuid in servers:
            client_count += int(
                await cast(Any, self._pub.scard(f"typeferry:clients:{server_uuid}"))
            )
            user_count += int(
                await cast(Any, self._pub.scard(f"typeferry:users:{server_uuid}"))
            )
            members = await cast(
                Any, self._pub.smembers(f"typeferry:users:{server_uuid}")
            )
            for member in members:
                users.add(member)

        return {
            "clientCount": client_count,
            "userCount": user_count,
            "users": sorted(users),
        }

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _listen(self, pubsub: Any) -> None:
        async for raw in pubsub.listen():
            if raw.get("type") != "message":
                continue
            data = raw.get("data")
            if not isinstance(data, (str, bytes)):
                continue
            try:
                text = data if isinstance(data, str) else data.decode("utf-8")
                decoded = Presentation.decode(text)
            except Exception:
                _log.exception("Malformed TypeFerry Redis message")
                continue
            if not isinstance(decoded, dict):
                continue
            event = decoded.get("event")
            raw_channel = decoded.get("channel")
            message = decoded.get("message")
            exclude_uuid = decoded.get("excludeUuid")

            if raw_channel is None:
                channel = NO_CHANNEL
            elif isinstance(raw_channel, str):
                channel = raw_channel or NO_CHANNEL
            else:
                continue

            if not isinstance(event, str) or not isinstance(message, str):
                continue

            target = self.server.lookup_channel(channel)
            if target is None:
                # Propagate using a transient ServerChannel so inbound Redis
                # messages never grow Server.channels unboundedly.
                from typeferry.server.server_channel import ServerChannel

                target = ServerChannel(channel)
                target.set_server(self.server)

            try:
                await target.propagate(
                    event,
                    message,
                    exclude_uuid if isinstance(exclude_uuid, str) else None,
                )
            except Exception:
                _log.exception("Failed propagating Redis event %s", event)

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
import hashlib
import hmac
import logging
from typing import TYPE_CHECKING, Any, cast

import redis.asyncio as aioredis

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import NO_CHANNEL, RedisListeners, ServerEvents

if TYPE_CHECKING:
    from typeferry.server.server import Server


_log = logging.getLogger(__name__)

_REDIS_URL_DEFAULT = "redis://localhost:6379"


def format_redis_signing_input(
    event: str, channel: str, message: str, exclude_uuid: str | None = None
) -> str:
    """Format canonical length-prefixed UTF-8 byte-length input (PROTOCOL.md §2.3)."""

    norm_channel = channel or NO_CHANNEL
    norm_exclude = exclude_uuid or ""
    parts = (event, norm_channel, message, norm_exclude)
    return "|".join(f"{len(part.encode('utf-8'))}:{part}" for part in parts)


def sign_redis_envelope(
    event: str,
    channel: str,
    message: str,
    exclude_uuid: str | None,
    signing_secret: str,
) -> str:
    """Return lowercase hex HMAC-SHA256 for the normalized Redis envelope."""

    signing_input = format_redis_signing_input(event, channel, message, exclude_uuid)
    return hmac.new(
        signing_secret.encode("utf-8"),
        signing_input.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def build_redis_envelope(
    event: str,
    channel: str,
    message: str,
    exclude_uuid: str | None = None,
    *,
    signing_secret: str | None = None,
) -> str:
    """Encode an EJSON Redis publish frame, attaching ``sig`` when signed."""

    norm_channel = channel or NO_CHANNEL
    payload: dict[str, Any] = {
        "event": event,
        "channel": norm_channel,
        "message": message,
    }
    if exclude_uuid is not None:
        payload["excludeUuid"] = exclude_uuid
    if signing_secret:
        payload["sig"] = sign_redis_envelope(
            event, norm_channel, message, exclude_uuid, signing_secret
        )
    return Presentation.encode(payload)


def parse_redis_envelope(
    raw: str, *, signing_secret: str | None = None
) -> tuple[str, str, str, str | None] | None:
    """Strictly validate an inbound Redis frame and verify HMAC ``sig`` when configured."""

    try:
        decoded = Presentation.decode(raw)
    except Exception:
        return None
    if not isinstance(decoded, dict):
        return None

    event = decoded.get("event")
    raw_channel = decoded.get("channel")
    message = decoded.get("message")
    raw_exclude = decoded.get("excludeUuid")

    if not isinstance(event, str) or not event or not isinstance(message, str) or not message:
        return None

    if raw_channel is None:
        channel = NO_CHANNEL
    elif isinstance(raw_channel, str):
        channel = raw_channel or NO_CHANNEL
    else:
        return None

    if raw_exclude is None:
        exclude_uuid: str | None = None
    elif isinstance(raw_exclude, str):
        exclude_uuid = raw_exclude
    else:
        return None

    if signing_secret:
        raw_sig = decoded.get("sig")
        if not isinstance(raw_sig, str):
            return None
        expected_sig = sign_redis_envelope(
            event, channel, message, exclude_uuid, signing_secret
        )
        if not hmac.compare_digest(raw_sig, expected_sig):
            return None

    return event, channel, message, exclude_uuid


class RedisTransport:
    """Redis pub/sub transport that mirrors the TS runtime byte-for-byte."""

    server: Server
    url: str
    signing_secret: str | None
    _pub: aioredis.Redis | None
    _sub: aioredis.Redis | None
    _listener_task: asyncio.Task[None] | None

    def __init__(
        self,
        server: Server,
        url: str | None = None,
        *,
        signing_secret: str | None = None,
    ) -> None:
        self.server = server
        self.url = url or _REDIS_URL_DEFAULT
        self.signing_secret = signing_secret or None
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

        encoded = build_redis_envelope(
            event, channel, message, exclude_uuid, signing_secret=self.signing_secret
        )
        await self._pub.publish(RedisListeners.EVENTS.value, encoded)

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
            except Exception:
                _log.exception("Malformed TypeFerry Redis message")
                continue
            parsed = parse_redis_envelope(text, signing_secret=self.signing_secret)
            if parsed is None:
                continue
            event, channel, message, exclude_uuid = parsed

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
                    exclude_uuid,
                )
            except Exception:
                _log.exception("Failed propagating Redis event %s", event)

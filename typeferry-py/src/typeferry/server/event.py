"""Event primitive — port of ``typeferry-ts/src/server/event.ts``.

An :class:`Event` represents a declared subscription channel topic.
When emitted, it encodes the wire envelope (``t: "event"``) and routes
either to the local :class:`RoomRegistry` or through Redis for
multi-instance deployments.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.messages import MessageType

if TYPE_CHECKING:
    from typeferry.server.client_node import ClientNode
    from typeferry.server.server import Server
    from typeferry.server.server_channel import ServerChannel


ShouldSubscribe = Callable[
    ["ClientNode", str, str], bool | Awaitable[bool]
]


@dataclass(slots=True)
class EventOptions:
    protected: bool = False
    """Require authentication to subscribe."""

    user: bool = False
    """Implies ``protected``; only allow a user to subscribe on their own channel."""

    should_subscribe: ShouldSubscribe | None = None
    """Custom async predicate gating subscription. Overrides ``user``."""

    cluster: bool = False
    """Propagate via Redis to other instances."""

    exclude_originator: bool = False
    """When True, uses ``params['uuid']`` to identify and skip the originator."""

    revalidate_on_delivery: bool = False
    """Recheck auth, channel access, and should_subscribe before each delivery."""


async def _always_true(_client: Any, _event: str, _channel: str) -> bool:
    return True


class Event:
    """Declared event with subscription policy.

    Subscription policy is evaluated in this order (matches TS):

    1. explicit ``should_subscribe`` if provided (wins over ``user``)
    2. ``user`` flag — channel MUST equal ``client.user_id``
    3. default → always allow (authorization handled by ``is_protected``)
    """

    uuid: str
    name: str
    server: Server
    channel: ServerChannel
    is_protected: bool
    cluster: bool
    exclude_originator: bool
    revalidate_on_delivery: bool
    should_subscribe: ShouldSubscribe

    def __init__(
        self,
        name: str,
        server: Server,
        channel: ServerChannel,
        opts: EventOptions | None = None,
    ) -> None:
        opts = opts or EventOptions()
        self.uuid = Presentation.uuid()
        self.name = name
        self.server = server
        self.channel = channel
        self.is_protected = opts.protected

        self.should_subscribe = _always_true

        if opts.user:
            self.is_protected = True
            self.should_subscribe = _user_scoped_subscribe

        if opts.should_subscribe is not None:
            self.should_subscribe = opts.should_subscribe

        self.cluster = bool(opts.cluster)
        self.exclude_originator = bool(opts.exclude_originator)
        self.revalidate_on_delivery = bool(opts.revalidate_on_delivery)

    async def handler(
        self, channel: ServerChannel, params: Any
    ) -> Awaitable[None] | None:
        """Encode the event and dispatch locally or via Redis."""

        payload = Presentation.encode(
            {
                "t": MessageType.EVENT.value,
                "uuid": Presentation.uuid(),
                "event": self.name,
                "channel": channel.channel_name,
                "params": params,
            }
        )

        exclude_uuid: str | None = None
        if self.exclude_originator and isinstance(params, dict):
            raw = params.get("uuid")
            if isinstance(raw, str):
                exclude_uuid = raw

        if self.cluster and self.server.redis_transport is not None:
            await self.server.redis_transport.publish(
                self.name, channel.channel_name, payload, exclude_uuid
            )
            return None

        await channel.propagate(self.name, payload, exclude_uuid)
        return None

    async def evaluate_should_subscribe(
        self, client: ClientNode, event: str, channel: str
    ) -> bool:
        result = self.should_subscribe(client, event, channel)
        awaited = await result if inspect.isawaitable(result) else result
        return bool(awaited)


async def _user_scoped_subscribe(
    client: ClientNode, _event: str, channel: str
) -> bool:
    if not client.user_id:
        return False
    return str(client.user_id) == channel

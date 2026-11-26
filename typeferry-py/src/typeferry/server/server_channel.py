"""Server channel — port of ``typeferry-ts/src/server/server-channel.ts``.

Channels own:

* a registry of events routable on that channel
* :meth:`propagate` — broadcast a pre-encoded event payload to
  subscribed sockets in the corresponding room
* :meth:`emit` — trigger an event's ``handler`` which re-enters this
  channel via ``propagate`` (or Redis, for clustered events)

The TS implementation extends ``EventEmitter2`` with an ``onAny``
interceptor that routes every emit through the registered event's
``handler``. Python doesn't need that pattern — we expose a direct
:meth:`emit` that awaits the handler.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from typeferry.server.event import Event, EventOptions
from typeferry.server.room_name import get_room_name

if TYPE_CHECKING:
    from typeferry.server.client_node import ClientNode
    from typeferry.server.server import Server


class ServerChannel:
    channel_name: str
    server: Server

    def __init__(self, channel_name: str) -> None:
        self.channel_name = channel_name

    def set_server(self, server: Server) -> None:
        self.server = server

    # ------------------------------------------------------------------
    # Emission
    # ------------------------------------------------------------------

    async def emit(self, event: str, params: Any = None) -> None:
        """Trigger the declared event's handler for this channel.

        If the event isn't registered, emit is a no-op with a log line
        (matching the TS behavior).
        """

        event_obj = self.server.events.get(event)
        if event_obj is None:
            return
        await event_obj.handler(self, params)

    async def propagate(
        self, event: str, payload: str, exclude_uuid: str | None = None
    ) -> None:
        """Broadcast a pre-encoded payload to the event's room.

        ``payload`` is the EJSON-encoded ``{t:"event", ...}`` wire frame
        built by :meth:`typeferry.server.event.Event.handler`.
        """

        if self.server.events.get(event) is None:
            return

        transport = self.server.websocket_transport
        if transport is None:
            return

        rooms = transport.rooms
        room_name = get_room_name(self.channel_name, event)

        exclude_socket = None
        if exclude_uuid:
            node = self.server.all_clients.get(exclude_uuid)
            if node is not None:
                exclude_socket = node.socket

        awaitables = [a for a in rooms.broadcast(room_name, payload, exclude_socket) if a is not None]
        if awaitables:
            await asyncio.gather(*awaitables, return_exceptions=True)

    # ------------------------------------------------------------------
    # Event registry (delegates to the shared server map)
    # ------------------------------------------------------------------

    def add_event(self, name: str, opts: EventOptions | None = None) -> Event:
        """Declare a new event on this channel. Replaces an existing one."""

        event = Event(name, self.server, self, opts)
        self.server.events[name] = event
        return event

    @property
    def list(self) -> list[str]:
        return list(self.server.events.keys())

    @property
    def length(self) -> int:
        return len(self.server.events)

    def get(self, event: str) -> Event | None:
        return self.server.events.get(event)

    def has(self, event: str) -> bool:
        return event in self.server.events

    def delete(self, event: str) -> bool:
        return self.server.events.pop(event, None) is not None

    def is_subscribed(self, client: ClientNode, event: Event) -> bool:
        if client.socket is None:
            return False
        transport = self.server.websocket_transport
        if transport is None:
            return False
        room_name = get_room_name(self.channel_name, event.name)
        return bool(transport.rooms.has(client.socket, room_name))

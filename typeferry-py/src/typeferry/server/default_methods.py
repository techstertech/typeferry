"""Default RPC methods auto-registered on every server.

Mirrors ``typeferry-ts/src/server/methods.ts`` and
``typeferry-ts/src/server/default-methods.ts``:

* ``rpc:on``  — subscribe to events on an optional channel
* ``rpc:off`` — unsubscribe
* ``rpc:logout`` — clear auth state on the node

``rpc:login`` and ``list:methods`` are NOT auto-registered (see
PROTOCOL.md §7.4, §7.5).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from typeferry.protocol.constants import NO_CHANNEL, Methods, ServerEvents
from typeferry.server.method import Method, MethodOptions
from typeferry.server.room_name import get_room_name
from typeferry.server.socket import SocketState

if TYPE_CHECKING:
    from typeferry.server.client_node import ClientNode
    from typeferry.server.server import Server


MAX_EVENTS_PER_SUBSCRIPTION_CALL = 256
MAX_CHANNEL_LENGTH = 256
MAX_ROOMS_PER_CLIENT = 1024


def _validate_subscription_params(params: Any) -> tuple[list[str], str] | None:
    if not isinstance(params, dict):
        return None
    raw_channel = params.get("channel")
    if raw_channel is not None and (
        not isinstance(raw_channel, str)
        or len(raw_channel.encode("utf-8")) > MAX_CHANNEL_LENGTH
    ):
        return None
    channel = raw_channel if isinstance(raw_channel, str) and raw_channel else NO_CHANNEL
    raw_events = params.get("events")
    if isinstance(raw_events, list) and len(raw_events) > MAX_EVENTS_PER_SUBSCRIPTION_CALL:
        return None
    events = [e for e in raw_events if isinstance(e, str)] if isinstance(raw_events, list) else []
    return events, channel


async def _rpc_on(server: Server, node: ClientNode | None, params: Any) -> dict[str, bool]:
    if node is None or node.socket is None or node.socket.readyState != SocketState.OPEN:
        return {}

    validated = _validate_subscription_params(params)
    if validated is None:
        return {}
    events, channel = validated
    if not events:
        return {}

    channel_allowed = await _resolve_channel_permission(server, node, channel)

    result: dict[str, bool] = {}
    for event_name in events:
        if (
            not channel_allowed
            or node.socket is None
            or node.socket.readyState != SocketState.OPEN
        ):
            result[event_name] = False
            continue
        result[event_name] = await _can_subscribe(server, node, event_name, channel)
    return result


async def _rpc_off(server: Server, node: ClientNode | None, params: Any) -> dict[str, bool]:
    if node is None or node.socket is None or node.socket.readyState != SocketState.OPEN:
        return {}

    transport = server.websocket_transport
    if transport is None:
        return {}

    validated = _validate_subscription_params(params)
    if validated is None:
        return {}
    events, channel = validated

    result: dict[str, bool] = {}
    for event_name in events:
        event = server.events.get(event_name)
        if event is None:
            result[event_name] = False
            continue
        transport.rooms.leave(node.socket, get_room_name(channel, event_name))
        result[event_name] = True
    return result


async def _rpc_logout(server: Server, node: ClientNode | None, _params: Any) -> bool:
    if node is None:
        return False
    if node.socket is not None and server.websocket_transport is not None:
        server.websocket_transport.rooms.leave_all(node.socket)
    node.authenticated = False
    node.set_context(None)
    server.emit_server_event(ServerEvents.LOGOUT, node)
    return True


async def _can_subscribe(
    server: Server, node: ClientNode, event_name: str, channel: str
) -> bool:
    event = server.events.get(event_name)
    if event is None:
        return False
    if event.is_protected and not node.authenticated:
        return False

    allowed = await event.evaluate_should_subscribe(node, event_name, channel)
    if not allowed:
        return False

    # Re-check after awaiting in case authentication was revoked mid-flight.
    if event.is_protected and not node.authenticated:
        return False

    if node.socket is None or node.socket.readyState != SocketState.OPEN:
        return False

    transport = server.websocket_transport
    if transport is None:
        return False

    room_name = get_room_name(channel, event_name)
    if not transport.rooms.has(node.socket, room_name):
        entry = transport.rooms._socket_rooms.get(id(node.socket))
        if entry is not None and len(entry[1]) >= MAX_ROOMS_PER_CLIENT:
            return False

    transport.rooms.join(node.socket, room_name)
    return True


async def _resolve_channel_permission(
    server: Server, node: ClientNode, channel: str
) -> bool:
    import inspect as _inspect

    result = server.should_allow_channel_subscribe(node, channel)
    if _inspect.isawaitable(result):
        result = await result
    return bool(result)


def build_default_methods(server: Server) -> dict[str, Method]:
    """Return the auto-registered method set for a fresh server."""

    return {
        Methods.RPC_ON.value: Method(
            server,
            Methods.RPC_ON.value,
            lambda node, params: _rpc_on(server, node, params),
            MethodOptions(protected=False),
        ),
        Methods.RPC_OFF.value: Method(
            server,
            Methods.RPC_OFF.value,
            lambda node, params: _rpc_off(server, node, params),
            MethodOptions(protected=False),
        ),
        Methods.RPC_LOGOUT.value: Method(
            server,
            Methods.RPC_LOGOUT.value,
            lambda node, params: _rpc_logout(server, node, params),
            MethodOptions(protected=True),
        ),
    }

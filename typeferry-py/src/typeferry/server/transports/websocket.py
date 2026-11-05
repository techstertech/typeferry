"""WebSocket transport — port of
``typeferry-ts/src/server/transports/websocket-transport.ts``.

Implements PROTOCOL.md §2.2 on top of Starlette's ``WebSocketRoute``:

* ``/typeferry-ws`` upgrade with query params ``uuid``/``token``/``meta``
* origin validation
* auth race with 5-second timeout; emits ``{t:"auth", authenticated}``
* 25-second application-level ping loop (``{t:"ping"}``)
* application-level ``{t:"pong"}`` tracking; terminates peer if a
  ping interval elapses without a pong
* RPC / RPC-void dispatch via :mod:`typeferry.server.transports.ws_shared`
* disconnect handling: leave rooms, close the :class:`ClientNode`,
  deregister from the server index
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING, Any

from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import TYPEFERRY_WS_PATH, ServerEvents
from typeferry.server.client_node import ClientNode
from typeferry.server.room_registry import RoomRegistry
from typeferry.server.socket import SocketState
from typeferry.server.transports._origins import origin_allowed
from typeferry.server.transports.ws_shared import (
    PING_INTERVAL_MS,
    PING_PAYLOAD,
    WebSocketHandshake,
    WebSocketHandshakeAuthenticator,
    authenticate_node,
    handle_rpc,
    handle_rpc_void,
    parse_meta,
    validate_uuid,
)

if TYPE_CHECKING:
    from typeferry.server.server import Server


_log = logging.getLogger(__name__)


class StarletteSocket:
    """Adapter that gives a Starlette :class:`WebSocket` the
    :class:`TypeFerrySocket` interface (``readyState``/``send``/``close``
    + stable identity).
    """

    __slots__ = ("_ws", "readyState")

    def __init__(self, ws: WebSocket) -> None:
        self._ws = ws
        self.readyState: int = SocketState.OPEN

    def _update_ready_state(self) -> None:
        client_state = self._ws.client_state
        app_state = self._ws.application_state
        if (
            client_state is WebSocketState.DISCONNECTED
            or app_state is WebSocketState.DISCONNECTED
        ):
            self.readyState = SocketState.CLOSED

    async def send(self, data: str) -> None:
        self._update_ready_state()
        if self.readyState != SocketState.OPEN:
            return
        try:
            await self._ws.send_text(data)
        except Exception:
            self.readyState = SocketState.CLOSED

    async def close(self, code: int = 1000) -> None:
        if self.readyState == SocketState.CLOSED:
            return
        self.readyState = SocketState.CLOSED
        with contextlib.suppress(Exception):
            await self._ws.close(code=code)


class WebSocketTransport:
    """Starlette-backed WebSocket transport bound to a :class:`Server`.

    A configured allowlist rejects absent origins unless ``allow_originless``
    is explicitly enabled. An empty list denies all named origins. HTTP
    originless admission is a separate transport option.
    """

    server: Server
    rooms: RoomRegistry
    path: str
    origins: set[str] | None
    accept_connections: bool
    route: WebSocketRoute

    def __init__(
        self,
        server: Server,
        origins: list[str] | None = None,
        path: str = TYPEFERRY_WS_PATH,
        handshake_authenticator: WebSocketHandshakeAuthenticator | None = None,
        *,
        allow_originless: bool = False,
    ) -> None:
        self.server = server
        self.rooms = RoomRegistry()
        self.path = path
        self.origins = None if origins is None else set(origins)
        self.allow_originless = allow_originless
        self.accept_connections = True
        self.handshake_authenticator = handshake_authenticator
        self.route = WebSocketRoute(path, self._endpoint)
        self._ping_tasks: dict[int, asyncio.Task[None]] = {}
        self._pong_received: dict[int, bool] = {}

    def routes(self) -> list[WebSocketRoute]:
        """Return Starlette routes the caller can pass to ``Starlette(routes=...)``."""

        return [self.route]

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def _endpoint(self, ws: WebSocket) -> None:
        if not self.accept_connections:
            await ws.close(code=1013)
            return

        origin = ws.headers.get("origin")
        if not origin_allowed(origin, self.origins, allow_originless=self.allow_originless):
            await ws.close(code=4403)
            return

        uuid = validate_uuid(ws.query_params.get("uuid"))
        token = ws.query_params.get("token")
        meta = parse_meta(ws.query_params.get("meta"))

        await ws.accept()

        socket = StarletteSocket(ws)
        headers = {k.lower(): v for k, v in ws.headers.items()}
        node = ClientNode(self.server, socket=socket, headers=headers)
        node.set_id(uuid)
        node.meta = meta

        self.server.add_client(node)
        self.server.emit_server_event(ServerEvents.CONNECTION, node)

        ping_task = asyncio.create_task(self._ping_loop(socket))
        self._ping_tasks[id(socket)] = ping_task
        self._pong_received[id(socket)] = True

        try:
            await authenticate_node(
                self.server,
                node,
                token,
                self.handshake_authenticator,
                WebSocketHandshake(
                    path=ws.url.path,
                    headers={name.lower(): value for name, value in ws.headers.items()},
                    query={name: value for name, value in ws.query_params.items()},
                ),
            )
            await self._receive_loop(node, ws, socket)
        except WebSocketDisconnect:
            pass
        except Exception:
            _log.exception("TypeFerry WS connection raised")
            self.server.emit_server_event(ServerEvents.SOCKET_ERROR, node)
        finally:
            ping_task.cancel()
            self._ping_tasks.pop(id(socket), None)
            self._pong_received.pop(id(socket), None)
            self.rooms.leave_all(socket)
            await node.close()
            self.server.delete_client(node)

    async def _receive_loop(
        self, node: ClientNode, ws: WebSocket, socket: StarletteSocket
    ) -> None:
        while True:
            raw = await ws.receive_text()
            try:
                msg = Presentation.decode(raw)
            except Exception:
                # Malformed frame; ignore per TS behavior.
                continue

            if not isinstance(msg, dict):
                continue

            envelope: dict[str, Any] = msg
            msg_type = envelope.get("t")

            if msg_type == "rpc":
                await handle_rpc(
                    self.server,
                    node,
                    envelope["id"],
                    envelope["method"],
                    envelope.get("params"),
                )
            elif msg_type == "rpc:void":
                await handle_rpc_void(
                    self.server,
                    node,
                    envelope["method"],
                    envelope.get("params"),
                )
            elif msg_type == "pong":
                self._pong_received[id(socket)] = True
            elif msg_type == "ping":
                # Clients don't send pings today, but echo a pong if they do.
                from typeferry.protocol.messages import MessageType

                payload = Presentation.encode({"t": MessageType.PONG.value})
                await socket.send(payload)

    # ------------------------------------------------------------------
    # Keep-alive
    # ------------------------------------------------------------------

    async def _ping_loop(self, socket: StarletteSocket) -> None:
        interval_s = PING_INTERVAL_MS / 1000
        try:
            while True:
                await asyncio.sleep(interval_s)
                if not self._pong_received.get(id(socket), False):
                    await socket.close(code=1001)
                    return
                self._pong_received[id(socket)] = False
                if socket.readyState == SocketState.OPEN:
                    await socket.send(PING_PAYLOAD)
        except asyncio.CancelledError:
            pass

    async def close(self) -> None:
        for task in list(self._ping_tasks.values()):
            task.cancel()
        self._ping_tasks.clear()
        self._pong_received.clear()

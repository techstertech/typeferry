"""Per-connection state — port of ``typeferry-ts/src/server/client-node.ts``.

A :class:`ClientNode` represents a single connected client (HTTP call
or WebSocket session). It carries authentication state, the socket
(when WS), rate limiter, request metadata, and helper methods for
emitting wire-protocol frames.
"""

from __future__ import annotations

import inspect
from typing import TYPE_CHECKING, Any

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import ServerEvents
from typeferry.protocol.messages import MessageType
from typeferry.server.socket import SocketState, TypeFerrySocket

if TYPE_CHECKING:
    from typeferry.server.server import Server


ClientNodeContext = dict[str, Any]


class ClientNode:
    """Per-connection state shared by HTTP and WebSocket transports."""

    uuid: str
    server: Server
    socket: TypeFerrySocket | None
    is_authenticated: bool
    context: ClientNodeContext
    user_id: str | None
    user: dict[str, Any] | None
    meta: dict[str, Any]
    headers: dict[str, str]
    remote_address: str
    user_agent: str
    is_server: bool
    _closed: bool

    def __init__(
        self,
        server: Server,
        socket: TypeFerrySocket | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.uuid = Presentation.uuid()
        self.server = server
        self.socket = socket
        self.is_authenticated = False
        self.context = {}
        self.user_id = None
        self.user = None
        self.meta = {}
        self.headers = headers or {}
        self.remote_address = ""
        self.user_agent = ""
        self.is_server = False
        self._closed = False

        if headers:
            self.user_agent = headers.get("user-agent", "")
            self.remote_address = (
                headers.get("x-forwarded-for", "") or ""
            )

    # ------------------------------------------------------------------
    # Auth / context
    # ------------------------------------------------------------------

    @property
    def authenticated(self) -> bool:
        return self.is_authenticated

    @authenticated.setter
    def authenticated(self, value: bool) -> None:
        self.is_authenticated = value
        if not value:
            self.set_context(None)

    def set_id(self, uuid: str) -> None:
        self.uuid = uuid

    def set_context(self, context: ClientNodeContext | None) -> None:
        """Install authenticated context and update the server's user index.

        Mirrors TS ``ClientNode.setContext`` / ``setUserId`` — a truthy
        ``context.user._id`` is required for the user-level reverse
        index to take effect.
        """

        self.context = context if (self.authenticated and context) else {}
        self._refresh_user_id()

    def _refresh_user_id(self) -> None:
        # The index owner reads user_id, so retire the old membership before
        # clearing or replacing principal fields.
        self.server._remove_client_from_user_index(self)
        self.user_id = None
        self.user = None

        if not self.authenticated:
            return
        user = None
        if isinstance(self.context, dict):
            user = self.context.get("user")
        user_id = None
        if isinstance(user, dict):
            user_id = user.get("_id") or user.get("id")
        if user_id is None:
            return
        self.user_id = str(user_id)
        self.user = user if isinstance(user, dict) else None
        self.server._index_client_by_user_id(self)

    # ------------------------------------------------------------------
    # WebSocket emitters
    # ------------------------------------------------------------------

    async def emit_typeferry_event(
        self, event: str, channel: str | None = None, params: Any = None
    ) -> None:
        if self.socket is None or self.socket.readyState != SocketState.OPEN:
            return
        payload = Presentation.encode(
            {
                "t": MessageType.EVENT.value,
                "uuid": Presentation.uuid(),
                "event": event,
                "channel": channel,
                "params": params,
            }
        )
        await _send(self.socket, payload)

    async def emit_auth_result(self, authenticated: bool) -> None:
        if self.socket is None or self.socket.readyState != SocketState.OPEN:
            return
        payload = Presentation.encode(
            {"t": MessageType.AUTH.value, "authenticated": authenticated}
        )
        await _send(self.socket, payload)

    async def emit_error(
        self,
        message: str,
        uuid: str | None = None,
        method: str | None = None,
        errors: Any = None,
    ) -> None:
        """Send a plain-error envelope (used by the HTTP-via-WS legacy path)."""

        if self.socket is None or self.socket.readyState != SocketState.OPEN:
            return
        body: dict[str, Any] = {"message": message}
        if uuid is not None:
            body["uuid"] = uuid
        if method is not None:
            body["method"] = method
        if errors is not None:
            body["errors"] = errors
        await _send(self.socket, Presentation.encode(body))

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def close(self) -> None:
        """Close the socket and signal disconnection. Idempotent."""

        if self._closed:
            return
        self._closed = True

        if self.socket is not None:
            close = self.socket.close()
            if inspect.isawaitable(close):
                await close

        self.server.emit_server_event(ServerEvents.DISCONNECTION, self)


async def _send(socket: TypeFerrySocket, payload: str) -> None:
    result = socket.send(payload)
    if inspect.isawaitable(result):
        await result

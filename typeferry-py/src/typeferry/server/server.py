"""Top-level :class:`Server` — port of ``typeferry-ts/src/server/server.ts``.

The Python port is transport-agnostic: :class:`Server` owns the method
registry, channel map, event registry, client index, and auth
configuration. Transports (HTTP, WebSocket, Redis) attach themselves by
assigning to the matching attributes and invoking
:meth:`Server.handle_rpc`, :meth:`Server.register_client`, etc.

Authoring ergonomics (decorators, OAuth) layer on top of this surface.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import NO_CHANNEL, ServerEvents, TypeFerryEvents
from typeferry.server.client_node import ClientNode
from typeferry.server.default_methods import build_default_methods
from typeferry.server.event import Event, EventOptions
from typeferry.server.method import Method, MethodFunction, MethodOptions
from typeferry.server.server_channel import ServerChannel

if TYPE_CHECKING:
    pass


AuthFunction = Callable[[ClientNode, dict[str, Any]], Any]
ChannelChecker = Callable[[ClientNode, str], bool | Awaitable[bool]]
ServerEventHandler = Callable[[Any], Awaitable[None] | None]


@dataclass(slots=True)
class AuthSetup:
    """Auth configuration registered via :meth:`Server.set_auth`."""

    auth: AuthFunction
    log_in: MethodFunction


@dataclass(slots=True)
class ServerOptions:
    host: str = "localhost"
    port: int = 80
    debug: bool = False
    origins: list[str] | None = None
    redis: Any = None
    allowed_context_keys: list[str] = field(default_factory=list)


class Server(ServerChannel):
    """Transport-agnostic TypeFerry server core.

    Concrete transports (HTTP, WebSocket, Redis) attach by assigning to
    ``http_transport``, ``websocket_transport``, ``redis_transport``.
    Binding is loose so alternate implementations can plug in without
    coupling the runtime to a specific ASGI framework.
    """

    uuid: str
    host: str
    port: int
    debug: bool

    methods: dict[str, Method]
    all_clients: dict[str, ClientNode]
    channels: dict[str, ServerChannel]
    events: dict[str, Event]
    allowed_context_keys: list[str]

    is_auth_enabled: bool
    auth: AuthFunction | None

    http_transport: Any
    websocket_transport: Any
    redis_transport: Any

    ready: bool

    should_allow_channel_subscribe: ChannelChecker

    def __init__(self, options: ServerOptions | None = None) -> None:
        options = options or ServerOptions()
        super().__init__(NO_CHANNEL)
        self.set_server(self)

        self.uuid = Presentation.uuid()
        self.host = options.host
        self.port = options.port
        self.debug = options.debug
        self.allowed_context_keys = list(options.allowed_context_keys)

        self.methods = {}
        self.all_clients = {}
        self._clients_by_user_id: dict[str, set[ClientNode]] = {}
        self.channels = {}
        self.events = {}

        self.is_auth_enabled = False
        self.auth = None
        self._log_in: MethodFunction | None = None

        self.http_transport = None
        self.websocket_transport = None
        self.redis_transport = None

        self.ready = False
        self._server_event_listeners: dict[str, list[ServerEventHandler]] = {}

        self.should_allow_channel_subscribe = _default_channel_checker

        # Auto-register default methods and the METHOD_REFRESH event.
        self.methods.update(build_default_methods(self))
        self.add_event(TypeFerryEvents.METHOD_REFRESH.value)
        self.channels[NO_CHANNEL] = self

    # ------------------------------------------------------------------
    # Auth configuration
    # ------------------------------------------------------------------

    def set_auth(self, setup: AuthSetup) -> None:
        """Enable auth and register ``rpc:login`` (PROTOCOL.md §7.4)."""

        from typeferry.protocol.constants import Methods

        self.is_auth_enabled = True
        self.auth = setup.auth
        self._log_in = setup.log_in
        self.add_method(Methods.RPC_LOGIN.value, setup.log_in)

    def set_channel_authorization(self, checker: ChannelChecker) -> None:
        self.should_allow_channel_subscribe = checker

    # ------------------------------------------------------------------
    # Method registry
    # ------------------------------------------------------------------

    def add_method(
        self,
        name: str,
        fn: MethodFunction,
        opts: MethodOptions | None = None,
    ) -> Method:
        method = Method(self, name, fn, opts)
        self.methods[name] = method
        return method

    def get_method(self, name: str) -> Method | None:
        return self.methods.get(name)

    async def call(self, method: str, params: Any = None) -> Any:
        """Invoke a registered method as the server (bypasses auth gating).

        Mirrors TS ``Server.call``: constructs an internal ClientNode
        with ``is_server = True`` so handlers see a server-origin caller.
        """

        instance = self.methods.get(method)
        if instance is None:
            raise ValueError(f"Method not registered: {method}")

        node = ClientNode(self)
        node.is_server = True
        return await instance.exec(params, node)

    async def call_method_on_node(
        self, method: str, params: Any, node: ClientNode
    ) -> Any:
        """Invoke a registered method as a specific client node.

        Used by transports after they've authenticated / constructed a
        :class:`ClientNode`. Raises :class:`KeyError` if the method
        isn't registered; callers (transports) must map that to the
        wire-level ``Method Not Found`` error envelope.
        """

        instance = self.methods.get(method)
        if instance is None:
            raise KeyError(method)
        if instance.is_protected and not node.authenticated:
            from typeferry.utils.errors import Errors, PublicError

            raise PublicError(Errors.METHOD_FORBIDDEN.value)
        return await instance.exec(params, node)

    # ------------------------------------------------------------------
    # Channel map
    # ------------------------------------------------------------------

    def channel(self, name: str = NO_CHANNEL) -> ServerChannel:
        """Return (or lazily create) the channel with the given name."""

        if not name or name == NO_CHANNEL:
            return self

        existing = self.channels.get(name)
        if existing is not None:
            return existing

        new_channel = ServerChannel(name)
        new_channel.set_server(self)
        self.channels[name] = new_channel
        return new_channel

    # ------------------------------------------------------------------
    # Client index
    # ------------------------------------------------------------------

    def add_client(self, node: ClientNode) -> None:
        self.all_clients[node.uuid] = node

    def add_ws_client(self, node: ClientNode) -> None:
        """Register a WS handshake node, assigning a fresh UUID on active collision."""

        while node.uuid in self.all_clients and self.all_clients[node.uuid] is not node:
            node.set_id(Presentation.uuid())
        self.all_clients[node.uuid] = node

    def delete_client(self, node: ClientNode) -> None:
        if self.all_clients.get(node.uuid) is node:
            self.all_clients.pop(node.uuid, None)
        self._remove_client_from_user_index(node)
        if node.socket is not None and self.websocket_transport is not None:
            self.websocket_transport.rooms.leave_all(node.socket)

    def _index_client_by_user_id(self, node: ClientNode) -> None:
        if not node.user_id:
            return
        nodes = self._clients_by_user_id.setdefault(node.user_id, set())
        nodes.add(node)

    def _remove_client_from_user_index(self, node: ClientNode) -> None:
        if not node.user_id:
            return
        nodes = self._clients_by_user_id.get(node.user_id)
        if nodes is None:
            return
        nodes.discard(node)
        if not nodes:
            self._clients_by_user_id.pop(node.user_id, None)

    def get_clients_by_user_id(self, user_id: str) -> frozenset[ClientNode]:
        nodes = self._clients_by_user_id.get(user_id)
        return frozenset(nodes) if nodes else frozenset()

    async def disconnect_user(
        self, user_id: str, except_node_uuid: str | None = None
    ) -> int:
        """Close every socket for ``user_id`` (used during session revocation).

        Returns the number of clients disconnected; fires
        ``ServerEvents.USER_DISCONNECTED`` with ``{user_id, count}``.
        """

        nodes = self._clients_by_user_id.get(user_id)
        if not nodes:
            return 0
        snapshot = list(nodes)
        count = 0
        for node in snapshot:
            if node.uuid == except_node_uuid:
                continue
            await node.close()
            count += 1
        self.emit_server_event(
            ServerEvents.USER_DISCONNECTED, {"user_id": user_id, "count": count}
        )
        return count

    # ------------------------------------------------------------------
    # Server-side event bus (distinct from wire events)
    # ------------------------------------------------------------------

    def on_server_event(
        self, name: str | ServerEvents, listener: ServerEventHandler
    ) -> None:
        """Register a listener for a :class:`ServerEvents` name."""

        key = name.value if isinstance(name, ServerEvents) else name
        self._server_event_listeners.setdefault(key, []).append(listener)

    def emit_server_event(
        self,
        name: str | ServerEvents,
        payload: Any = None,
        *,
        raise_on_error: bool = False,
    ) -> None:
        """Synchronously fire server-side event listeners.

        Async listeners' coroutines are scheduled on the running event
        loop when one exists; otherwise their coroutines are discarded
        (mirroring the TS fire-and-forget semantics).
        """

        key = name.value if isinstance(name, ServerEvents) else name
        listeners = self._server_event_listeners.get(key)
        if not listeners:
            return
        for listener in listeners:
            try:
                result = listener(payload)
            except Exception:
                if raise_on_error:
                    raise
                import logging

                logging.getLogger(__name__).exception(
                    "Server event listener for %s failed", key
                )
                continue
            if inspect.isawaitable(result):
                _schedule(result)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def close(self) -> bool:
        for node in list(self.all_clients.values()):
            await node.close()
        self.all_clients.clear()
        self._clients_by_user_id.clear()
        self.methods.clear()
        self.channels.clear()

        if self.redis_transport is not None:
            await self.redis_transport.close()
        if self.websocket_transport is not None:
            close = self.websocket_transport.close()
            if inspect.isawaitable(close):
                await close
        if self.http_transport is not None:
            close = self.http_transport.close()
            if inspect.isawaitable(close):
                await close

        self.emit_server_event(ServerEvents.CLOSED)
        return True


async def _default_channel_checker(_node: ClientNode, _channel: str) -> bool:
    return True


def _schedule(coro: Awaitable[Any]) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No running loop; drop the coroutine to match TS fire-and-forget.
        import logging

        logging.getLogger(__name__).debug(
            "emit_server_event dropped coroutine outside running loop"
        )
        # Close the coroutine to silence the "coroutine was never awaited" warning.
        if inspect.iscoroutine(coro):
            coro.close()
        return
    task: asyncio.Task[Any] = loop.create_task(coro)  # type: ignore[arg-type]
    # Attach an empty done-callback so the task isn't prematurely GC'd.
    task.add_done_callback(lambda _t: None)


def create_server(options: ServerOptions | None = None) -> Server:
    return Server(options)


# Re-export for ``from typeferry.server import EventOptions``
__all__ = [
    "AuthSetup",
    "EventOptions",
    "Server",
    "ServerOptions",
    "create_server",
]

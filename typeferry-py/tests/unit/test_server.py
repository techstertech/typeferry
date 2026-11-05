"""Server surface: method registration, channels, user index, default methods."""

from __future__ import annotations

from typing import Any

import pytest

from typeferry.protocol.constants import NO_CHANNEL, Methods, TypeFerryEvents
from typeferry.server.client_node import ClientNode
from typeferry.server.method import MethodOptions
from typeferry.server.room_registry import RoomRegistry
from typeferry.server.server import AuthSetup, Server, ServerOptions


def _server() -> Server:
    return Server(ServerOptions(host="localhost", port=0))


class _FakeWsTransport:
    def __init__(self) -> None:
        self.rooms = RoomRegistry()


def test_default_methods_are_registered() -> None:
    server = _server()
    assert Methods.RPC_ON.value in server.methods
    assert Methods.RPC_OFF.value in server.methods
    assert Methods.RPC_LOGOUT.value in server.methods
    # rpc:login and list:methods are NOT auto-registered per PROTOCOL.md §7.4/§7.5.
    assert Methods.RPC_LOGIN.value not in server.methods
    assert Methods.LIST_METHODS.value not in server.methods


def test_method_refresh_event_auto_registered() -> None:
    server = _server()
    assert TypeFerryEvents.METHOD_REFRESH.value in server.events


def test_no_channel_key_points_to_server() -> None:
    server = _server()
    assert server.channels[NO_CHANNEL] is server


def test_channel_creates_lazily_and_memoizes() -> None:
    server = _server()
    channel_a = server.channel("chat")
    channel_b = server.channel("chat")
    assert channel_a is channel_b
    assert server.channels["chat"] is channel_a


def test_channel_default_returns_server() -> None:
    server = _server()
    assert server.channel() is server
    assert server.channel(NO_CHANNEL) is server


def test_add_and_get_method() -> None:
    server = _server()

    async def handler(_node: Any, _params: Any) -> str:
        return "ok"

    server.add_method("ping", handler, MethodOptions(protected=False))
    assert server.get_method("ping") is not None


@pytest.mark.asyncio
async def test_call_invokes_registered_method() -> None:
    server = _server()

    async def handler(_node: Any, params: dict[str, int]) -> int:
        return params["n"]

    server.add_method("ident", handler)
    result = await server.call("ident", {"n": 42})
    assert result == 42


def test_set_auth_registers_rpc_login() -> None:
    server = _server()

    async def auth(_node: Any, _ctx: Any) -> dict[str, Any]:
        return {"user": {"_id": "u1"}}

    async def log_in(_node: Any, _params: Any) -> dict[str, str]:
        return {"token": "tok"}

    server.set_auth(AuthSetup(auth=auth, log_in=log_in))
    assert server.is_auth_enabled
    assert server.auth is auth
    assert server.get_method(Methods.RPC_LOGIN.value) is not None


def test_client_user_index_add_and_remove() -> None:
    server = _server()
    node = ClientNode(server)
    node.authenticated = True
    node.context = {"user": {"_id": "u1"}}
    node._refresh_user_id()

    server.add_client(node)
    assert server.get_clients_by_user_id("u1") == frozenset({node})

    server.delete_client(node)
    assert server.get_clients_by_user_id("u1") == frozenset()


@pytest.mark.parametrize("context", [None, {}, {"role": "reader"}, {"user": {"name": "No ID"}}])
def test_replacing_context_without_a_user_retires_the_previous_principal(
    context: dict[str, Any] | None,
) -> None:
    server = _server()
    node = ClientNode(server)
    node.authenticated = True
    node.set_context({"user": {"_id": "previous"}})
    server.add_client(node)

    node.set_context(context)

    assert node.authenticated
    assert node.context == (context if context is not None else {})
    assert node.user_id is None
    assert node.user is None
    assert server.get_clients_by_user_id("previous") == frozenset()


def test_changing_user_retires_only_the_replaced_node_from_the_old_index() -> None:
    server = _server()
    replaced = ClientNode(server)
    remaining = ClientNode(server)
    for node in (replaced, remaining):
        node.authenticated = True
        node.set_context({"user": {"_id": "previous"}})
        server.add_client(node)

    replacement_user = {"_id": "next", "name": "Next user"}
    replaced.set_context({"user": replacement_user})

    assert replaced.user_id == "next"
    assert replaced.user == replacement_user
    assert server.get_clients_by_user_id("previous") == frozenset({remaining})
    assert server.get_clients_by_user_id("next") == frozenset({replaced})


def test_deauthentication_retires_context_and_principal_before_replacement() -> None:
    server = _server()
    node = ClientNode(server)
    node.authenticated = True
    node.set_context({"user": {"_id": "previous"}})
    server.add_client(node)

    node.authenticated = False
    node.set_context({"user": {"_id": "next"}})

    assert node.context == {}
    assert node.user_id is None
    assert node.user is None
    assert server.get_clients_by_user_id("previous") == frozenset()
    assert server.get_clients_by_user_id("next") == frozenset()


@pytest.mark.asyncio
async def test_disconnect_user_closes_all_sockets() -> None:
    server = _server()

    class Socket:
        def __init__(self) -> None:
            from typeferry.server.socket import SocketState

            self.readyState = SocketState.OPEN
            self.closed = False

        def close(self) -> None:
            self.closed = True

        def send(self, _: str) -> None:
            pass

    def _build_node() -> ClientNode:
        n = ClientNode(server)
        n.authenticated = True
        n.context = {"user": {"_id": "u-x"}}
        n.socket = Socket()
        n._refresh_user_id()
        server.add_client(n)
        return n

    a = _build_node()
    b = _build_node()
    count = await server.disconnect_user("u-x")
    assert count == 2
    assert a.socket.closed  # type: ignore[union-attr]
    assert b.socket.closed  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_rpc_on_off_subscribe_and_unsubscribe() -> None:
    server = _server()
    server.websocket_transport = _FakeWsTransport()
    server.add_event("chat:message")

    class Socket:
        from typeferry.server.socket import SocketState as _S

        readyState = _S.OPEN

        def send(self, _: str) -> None: ...
        def close(self) -> None: ...

    node = ClientNode(server)
    node.authenticated = True
    node.socket = Socket()
    server.add_client(node)

    on_result = await server.call_method_on_node(
        Methods.RPC_ON.value, {"events": ["chat:message"], "channel": "room-1"}, node
    )
    assert on_result == {"chat:message": True}
    assert server.websocket_transport.rooms.has(
        node.socket, "typeferry:room-1:chat:message"
    )

    off_result = await server.call_method_on_node(
        Methods.RPC_OFF.value, {"events": ["chat:message"], "channel": "room-1"}, node
    )
    assert off_result == {"chat:message": True}
    assert not server.websocket_transport.rooms.has(
        node.socket, "typeferry:room-1:chat:message"
    )


@pytest.mark.asyncio
async def test_rpc_logout_clears_auth_state() -> None:
    server = _server()

    node = ClientNode(server)
    node.authenticated = True
    node.context = {"user": {"_id": "u1"}}
    node._refresh_user_id()
    server.add_client(node)

    result = await server.call_method_on_node(
        Methods.RPC_LOGOUT.value, None, node
    )
    assert result is True
    assert node.authenticated is False
    assert node.user_id is None
    assert node.context == {}
    assert node.user is None
    assert server.get_clients_by_user_id("u1") == frozenset()

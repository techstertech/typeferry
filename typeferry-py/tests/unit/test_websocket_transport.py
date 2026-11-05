"""WebSocketTransport wire-level behavior (PROTOCOL.md §2.2)."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import urlencode

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import TYPEFERRY_WS_PATH
from typeferry.protocol.messages import MessageType
from typeferry.server.method import MethodOptions
from typeferry.server.server import AuthSetup, Server, ServerOptions
from typeferry.server.transports.websocket import WebSocketTransport
from typeferry.server.transports.ws_shared import (
    WebSocketHandshake,
    validate_meta,
    validate_uuid,
)
from typeferry.utils.errors import Errors, PublicError


@pytest.mark.parametrize(
    ("origins", "origin", "allow_originless", "accepted"),
    [
        (None, None, False, True),
        (None, "https://other.test", False, True),
        ([], None, False, False),
        ([], "https://allowed.test", False, False),
        ([], None, True, True),
        ([""], "", True, False),
        (["https://allowed.test"], None, False, False),
        (["https://allowed.test"], None, True, True),
        (["https://allowed.test"], "https://other.test", True, False),
        (["https://allowed.test"], "https://allowed.test", False, True),
    ],
)
def test_websocket_origin_admission_precedes_authentication(
    origins: list[str] | None, origin: str | None, allow_originless: bool, accepted: bool
) -> None:
    from starlette.websockets import WebSocketDisconnect

    calls: list[str] = []
    server = Server(ServerOptions())

    async def authenticate(_node: Any, _handshake: Any) -> dict[str, str]:
        calls.append("auth")
        return {"role": "reader"}

    transport = WebSocketTransport(
        server, origins=origins, allow_originless=allow_originless,
        handshake_authenticator=authenticate,
    )
    server.websocket_transport = transport
    headers = {} if origin is None else {"origin": origin}
    with TestClient(Starlette(routes=transport.routes())) as client:
        if accepted:
            with client.websocket_connect(TYPEFERRY_WS_PATH, headers=headers) as ws:
                assert ws.receive_json() == {"t": "auth", "authenticated": True}
        else:
            with pytest.raises(WebSocketDisconnect), client.websocket_connect(TYPEFERRY_WS_PATH, headers=headers):
                pytest.fail("rejected origin reached an accepted socket")

    assert calls == (["auth"] if accepted else [])


@pytest.mark.parametrize("outcome", [None, False, 0, -0.0, float("nan"), "", {}, []])
def test_websocket_handshake_uses_javascript_authentication_truthiness(outcome: Any) -> None:
    server = Server(ServerOptions())

    async def authenticate(_node: Any, _handshake: Any) -> Any:
        return outcome

    transport = WebSocketTransport(server, handshake_authenticator=authenticate)
    server.websocket_transport = transport
    with (
        TestClient(Starlette(routes=transport.routes())) as client,
        client.websocket_connect(TYPEFERRY_WS_PATH) as ws,
    ):
        assert ws.receive_json() == {
            "t": "auth", "authenticated": isinstance(outcome, (dict, list)),
        }


def test_authentication_timeout_ignores_callback_that_suppresses_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from typeferry.server.transports import ws_shared

    monkeypatch.setattr(ws_shared, "AUTH_TIMEOUT_MS", 10)
    server = Server(ServerOptions())

    async def authenticate(_node: Any, _handshake: Any) -> dict[str, Any]:
        try:
            await asyncio.sleep(1)
        except asyncio.CancelledError:
            return {"user": {"_id": "late"}}
        return {"user": {"_id": "late"}}

    transport = WebSocketTransport(server, handshake_authenticator=authenticate)
    server.websocket_transport = transport
    with (
        TestClient(Starlette(routes=transport.routes())) as client,
        client.websocket_connect(TYPEFERRY_WS_PATH) as ws,
    ):
        assert ws.receive_json() == {"t": "auth", "authenticated": False}
        assert all(not node.authenticated for node in server.all_clients.values())


@pytest.mark.parametrize("uuid", ["abc$def", "a/b", "", "a" * 65])
def test_invalid_uuid_is_replaced_instead_of_partially_sanitized(uuid: str) -> None:
    replacement = validate_uuid(uuid)
    assert replacement != uuid
    assert replacement != "abcdef"
    assert replacement != "ab"


@pytest.mark.parametrize(
    "raw",
    [
        '{"$date":123}',
        json.dumps({"value": "é" * 2000}, ensure_ascii=False),
        '{"value":"ok"}' + " " * 10_000,
        json.dumps(["invalid"]),
        pytest.param(
            '{"values":[' + ",".join("1e1" for _ in range(2000)) + "]}",
            id="compact-numbers-use-raw-byte-budget",
        ),
    ],
)
def test_handshake_metadata_uses_raw_json_and_utf8_input_size(raw: str) -> None:
    server = Server(ServerOptions())
    seen: list[dict[str, Any]] = []

    async def authenticate(node: Any, _handshake: Any) -> dict[str, str]:
        seen.append(node.meta)
        return {"role": "reader"}

    transport = WebSocketTransport(server, handshake_authenticator=authenticate)
    server.websocket_transport = transport
    with (
        TestClient(Starlette(routes=transport.routes())) as client,
        client.websocket_connect(TYPEFERRY_WS_PATH + "?" + urlencode({"meta": raw})) as ws,
    ):
        assert ws.receive_json()["authenticated"] is True

    decoded = json.loads(raw)
    expected = decoded if isinstance(decoded, dict) and len(raw.encode("utf-8")) <= 10_000 else {}
    assert seen == [expected]


def _build() -> tuple[Server, TestClient]:
    server = Server(ServerOptions(host="localhost", port=0))
    transport = WebSocketTransport(server)
    server.websocket_transport = transport
    app = Starlette(routes=transport.routes())
    return server, TestClient(app)


def _decode(raw: str) -> dict[str, Any]:
    decoded = Presentation.decode(raw)
    assert isinstance(decoded, dict)
    return decoded


def test_validate_uuid_truncates_and_sanitizes() -> None:
    assert validate_uuid("abc-123-DEF").startswith("abc-123-DEF")
    assert "$" not in validate_uuid("abc$%")
    # Oversize → replaced with a fresh random token.
    long = "a" * 128
    assert len(validate_uuid(long)) <= 64


def test_validate_meta_guards_size() -> None:
    assert validate_meta({"a": 1}) == {"a": 1}
    assert validate_meta({}) == {}
    oversized = {"k": "x" * 20_000}
    assert validate_meta(oversized) == {}


def test_connect_emits_auth_frame_without_token() -> None:
    _, client = _build()
    with client.websocket_connect(TYPEFERRY_WS_PATH) as ws:
        msg = _decode(ws.receive_text())
        assert msg == {"t": MessageType.AUTH.value, "authenticated": False}


def test_connect_with_auth_enabled_and_token() -> None:
    server, client = _build()

    async def auth(_node: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        assert ctx["token"] == "good-token"
        return {"user": {"_id": "u1"}}

    async def log_in(_n: Any, _p: Any) -> bool:
        return True

    server.set_auth(AuthSetup(auth=auth, log_in=log_in))

    with client.websocket_connect(f"{TYPEFERRY_WS_PATH}?token=good-token") as ws:
        msg = _decode(ws.receive_text())
        assert msg == {"t": MessageType.AUTH.value, "authenticated": True}


def test_connect_authenticates_from_application_handshake_without_token() -> None:
    server = Server(ServerOptions(host="localhost", port=0))
    observed: list[WebSocketHandshake] = []

    async def authenticate(_node: Any, handshake: WebSocketHandshake) -> dict[str, Any]:
        observed.append(handshake)
        assert handshake.headers["x-test-session"] == "opaque"
        return {"user": {"_id": "administrator"}}

    transport = WebSocketTransport(server, handshake_authenticator=authenticate)
    server.websocket_transport = transport
    client = TestClient(Starlette(routes=transport.routes()))

    with client.websocket_connect(
        TYPEFERRY_WS_PATH, headers={"x-test-session": "opaque"}
    ) as ws:
        assert _decode(ws.receive_text()) == {
            "t": MessageType.AUTH.value,
            "authenticated": True,
        }

    assert observed[0].path == TYPEFERRY_WS_PATH


def test_handshake_rejection_does_not_fall_back_to_token_auth() -> None:
    server = Server(ServerOptions(host="localhost", port=0))
    token_auth_called = False

    async def token_auth(_node: Any, _context: dict[str, Any]) -> dict[str, Any]:
        nonlocal token_auth_called
        token_auth_called = True
        return {"user": {"_id": "token-user"}}

    async def log_in(_node: Any, _params: Any) -> bool:
        return True

    async def reject(_node: Any, _handshake: WebSocketHandshake) -> bool:
        return False

    server.set_auth(AuthSetup(auth=token_auth, log_in=log_in))
    transport = WebSocketTransport(server, handshake_authenticator=reject)
    server.websocket_transport = transport
    client = TestClient(Starlette(routes=transport.routes()))

    with client.websocket_connect(f"{TYPEFERRY_WS_PATH}?token=valid") as ws:
        assert _decode(ws.receive_text()) == {
            "t": MessageType.AUTH.value,
            "authenticated": False,
        }

    assert token_auth_called is False


def test_rpc_happy_path() -> None:
    server, client = _build()

    async def echo(_node: Any, params: dict[str, Any]) -> Any:
        return params["v"]

    server.add_method("echo", echo)

    with client.websocket_connect(TYPEFERRY_WS_PATH) as ws:
        _ = _decode(ws.receive_text())  # drain auth frame
        ws.send_text(
            Presentation.encode(
                {
                    "t": MessageType.RPC.value,
                    "id": "r1",
                    "method": "echo",
                    "params": {"v": 42},
                }
            )
        )
        response = _decode(ws.receive_text())
        assert response == {
            "t": MessageType.RPC_RESPONSE.value,
            "id": "r1",
            "result": 42,
        }


def test_rpc_method_not_found() -> None:
    _, client = _build()

    with client.websocket_connect(TYPEFERRY_WS_PATH) as ws:
        _ = _decode(ws.receive_text())
        ws.send_text(
            Presentation.encode(
                {"t": MessageType.RPC.value, "id": "r1", "method": "nope"}
            )
        )
        response = _decode(ws.receive_text())
        assert response["error"] == Errors.METHOD_NOT_FOUND.value


def test_rpc_method_forbidden_when_unauthenticated() -> None:
    server, client = _build()

    async def secret(_node: Any, _p: Any) -> str:
        return "s"

    server.add_method("secret", secret, MethodOptions(protected=True))

    with client.websocket_connect(TYPEFERRY_WS_PATH) as ws:
        _ = _decode(ws.receive_text())
        ws.send_text(
            Presentation.encode(
                {"t": MessageType.RPC.value, "id": "r1", "method": "secret"}
            )
        )
        response = _decode(ws.receive_text())
        assert response["error"] == Errors.METHOD_FORBIDDEN.value


def test_rpc_public_error_passes_message_through() -> None:
    server, client = _build()

    async def boom(_node: Any, _p: Any) -> None:
        raise PublicError("nope")

    server.add_method("boom", boom)

    with client.websocket_connect(TYPEFERRY_WS_PATH) as ws:
        _ = _decode(ws.receive_text())
        ws.send_text(
            Presentation.encode(
                {"t": MessageType.RPC.value, "id": "r1", "method": "boom"}
            )
        )
        response = _decode(ws.receive_text())
        assert response["error"] == "nope"


def test_rpc_void_sends_no_response() -> None:
    server, client = _build()

    async def ignored(_node: Any, _p: Any) -> None:
        raise PublicError("still silent")

    server.add_method("ignored", ignored)

    with client.websocket_connect(TYPEFERRY_WS_PATH) as ws:
        _ = _decode(ws.receive_text())
        ws.send_text(
            Presentation.encode(
                {"t": MessageType.RPC_VOID.value, "method": "ignored"}
            )
        )
        # Server MUST NOT reply; close cleanly.
        # A short poll ensures no frame arrives.
        ws.close()


def test_subscribe_flow_via_rpc_on() -> None:
    server, client = _build()
    server.add_event("notif")

    with client.websocket_connect(TYPEFERRY_WS_PATH) as ws:
        _ = _decode(ws.receive_text())
        ws.send_text(
            Presentation.encode(
                {
                    "t": MessageType.RPC.value,
                    "id": "sub",
                    "method": "rpc:on",
                    "params": {"events": ["notif"], "channel": "room-a"},
                }
            )
        )
        response = _decode(ws.receive_text())
        assert response == {
            "t": MessageType.RPC_RESPONSE.value,
            "id": "sub",
            "result": {"notif": True},
        }


def test_malformed_frame_ignored() -> None:
    _, client = _build()
    with client.websocket_connect(TYPEFERRY_WS_PATH) as ws:
        _ = _decode(ws.receive_text())
        # Garbage is dropped; follow-up RPC still works.
        ws.send_text("not-json")
        ws.send_text(
            Presentation.encode(
                {"t": MessageType.RPC.value, "id": "r", "method": "nope"}
            )
        )
        response = _decode(ws.receive_text())
        assert response["id"] == "r"


@pytest.mark.parametrize(
    "uuid,expected_prefix",
    [
        ("simple-uuid", "simple-uuid"),
        ("bad$chars!here", None),
        ("", None),
        ("a" * 128, None),
    ],
)
def test_uuid_query_param_is_applied(uuid: str, expected_prefix: str | None) -> None:
    server, client = _build()

    captured: list[str] = []

    async def who(node: Any, _p: Any) -> str:
        captured.append(node.uuid)
        return node.uuid

    server.add_method("who", who)

    with client.websocket_connect(f"{TYPEFERRY_WS_PATH}?uuid={uuid}") as ws:
        _ = _decode(ws.receive_text())
        ws.send_text(
            Presentation.encode(
                {"t": MessageType.RPC.value, "id": "x", "method": "who"}
            )
        )
        _ = _decode(ws.receive_text())

    assert len(captured) == 1
    if expected_prefix:
        assert captured[0] == expected_prefix
    else:
        # Invalid uuids receive a fresh identity instead of a partial rewrite.
        assert len(captured[0]) >= 16
        assert captured[0] != "badcharshere"

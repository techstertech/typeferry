"""Security regression tests for Stage 4 Python hardening."""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

import httpx
import jwt as pyjwt
import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from typeferry.auth import (
    AuthConfig,
    InMemorySessionManager,
    parse_device_info,
    sign_access_token,
    verify_access_token,
)
from typeferry.auth.types import AccessTokenPayload
from typeferry.ejson.base64 import decode_base64
from typeferry.ejson.converters import _CUSTOM_CONVERTER, _DATE_CONVERTER, _INFNAN_CONVERTER
from typeferry.ejson.parse_stringify import parse
from typeferry.protocol.constants import TYPEFERRY_WS_PATH, ServerEvents
from typeferry.server.client_node import ClientNode
from typeferry.server.event import EventOptions
from typeferry.server.method import MethodOptions
from typeferry.server.room_name import get_room_name
from typeferry.server.server import Server, ServerOptions
from typeferry.server.socket import SocketState
from typeferry.server.transports.http import HttpTransport
from typeferry.server.transports.rate_limit import RateLimit, SlidingWindowLimiter
from typeferry.server.transports.websocket import WebSocketTransport
from typeferry.server.transports.ws_shared import authenticate_node
from typeferry.utils.errors import Errors, PublicError


def test_room_name_length_prefixed_utf8() -> None:
    assert get_room_name("user:42", "alert") != get_room_name("user", "42:alert")
    assert get_room_name("user:42", "alert") == "typeferry:7:user:42:alert"
    assert get_room_name("é", "ev") == "typeferry:2:é:ev"


@pytest.mark.asyncio
async def test_rpc_logout_evicts_ws_rooms_and_channel_caps() -> None:
    server = Server(ServerOptions())
    transport = WebSocketTransport(server)
    server.websocket_transport = transport
    server.add_event("secret", EventOptions(protected=True))
    for i in range(1030):
        server.add_event(f"e-{i}")

    sent: list[str] = []

    class DummySocket:
        readyState = SocketState.OPEN

        async def send(self, data: str) -> None:
            sent.append(data)

        async def close(self, code: int = 1000) -> None:
            self.readyState = SocketState.CLOSED

    node = ClientNode(server, socket=DummySocket())
    node.authenticated = True
    server.add_client(node)

    # Protected room subscribe & logout cleanup
    res = await server.call_method_on_node("rpc:on", {"events": ["secret"], "channel": "vip"}, node)
    assert res == {"secret": True}
    assert transport.rooms.get_room_size(get_room_name("vip", "secret")) == 1

    await server.call_method_on_node("rpc:logout", None, node)
    assert transport.rooms.get_room_size(get_room_name("vip", "secret")) == 0
    await server.channel("vip").emit("secret", {"x": 1})
    assert sent == []

    # Bounds on rpc:on
    too_many = await server.call_method_on_node(
        "rpc:on", {"events": [f"e-{i}" for i in range(257)]}, node
    )
    assert too_many == {}

    too_long_channel = await server.call_method_on_node(
        "rpc:on", {"events": ["e-0"], "channel": "a" * 257}, node
    )
    assert too_long_channel == {}

    for batch in range(11):
        events = [f"e-{batch * 100 + j}" for j in range(100) if batch * 100 + j < 1030]
        await server.call_method_on_node("rpc:on", {"events": events}, node)
    joined_rooms = transport.rooms._socket_rooms.get(id(node.socket), (None, set()))[1]
    assert len(joined_rooms) <= 1024

    # Post-await auth recheck
    async def revoke_mid_await(c: ClientNode, _ev: str, _ch: str) -> bool:
        c.authenticated = False
        return True

    node2 = ClientNode(server, socket=DummySocket())
    node2.authenticated = True
    server.add_client(node2)
    server.add_event("race-priv", EventOptions(protected=True, should_subscribe=revoke_mid_await))
    race_res = await server.call_method_on_node("rpc:on", {"events": ["race-priv"]}, node2)
    assert race_res == {"race-priv": False}


def test_ws_limits_malformed_envelopes_collision_and_ip() -> None:
    server = Server(ServerOptions())
    seen_ip: list[str] = []

    async def inspect(node: ClientNode, _params: Any) -> dict[str, Any]:
        seen_ip.append(node.remote_address)
        return {"uuid": node.uuid}

    server.add_method("inspect", inspect)

    async def auth(_node: ClientNode, h: Any) -> Any:
        if h.query.get("token") == "victim-secret":
            return {"user": {"_id": "u1"}}
        return False

    transport = WebSocketTransport(server, handshake_authenticator=auth)
    server.websocket_transport = transport

    with TestClient(Starlette(routes=transport.routes())) as client:
        # 1) Spoofed x-forwarded-for ignored + malformed frames don't kill connection
        with client.websocket_connect(
            f"{TYPEFERRY_WS_PATH}?uuid=victim-1&token=victim-secret",
            headers={"x-forwarded-for": "1.2.3.4"},
        ) as victim_ws:
            assert victim_ws.receive_json() == {"t": "auth", "authenticated": True}
            victim_ws.send_text('{"t":"rpc"}')
            victim_ws.send_text('{"t":"rpc","id":123,"method":"inspect"}')
            victim_ws.send_text('{"t":"rpc:void","method":123}')
            victim_ws.send_text('{"t":"rpc","id":"ok1","method":"inspect"}')
            res = victim_ws.receive_json()
            assert res["id"] == "ok1"
            assert seen_ip[-1] != "1.2.3.4"

            # 2) UUID collision assigns fresh UUID to incoming client without evicting victim
            with client.websocket_connect(f"{TYPEFERRY_WS_PATH}?uuid=victim-1") as attacker_ws:
                assert attacker_ws.receive_json() == {"t": "auth", "authenticated": False}
                attacker_ws.send_text('{"t":"rpc","id":"a1","method":"inspect"}')
                a_res = attacker_ws.receive_json()
                assert a_res["result"]["uuid"] != "victim-1"

            assert server.all_clients["victim-1"].authenticated is True

            # 3) Oversized message closes with 1009
            victim_ws.send_text("x" * (1024 * 1024 + 128))
            with pytest.raises(WebSocketDisconnect) as exc:
                victim_ws.receive_text()
            assert exc.value.code == 1009

        # 4) Default WS rate limit 120/60s
        with client.websocket_connect(TYPEFERRY_WS_PATH) as rl_ws:
            assert rl_ws.receive_json() == {"t": "auth", "authenticated": False}
            hit_limit = False
            for i in range(125):
                rl_ws.send_text(json.dumps({"t": "rpc", "id": f"r{i}", "method": "inspect"}))
                frame = rl_ws.receive_json()
                if frame.get("error") == Errors.RATE_LIMIT_EXCEEDED.value:
                    hit_limit = True
                    break
            assert hit_limit is True


@pytest.mark.asyncio
async def test_ws_auth_fail_closed_on_listener_error_and_delete_identity() -> None:
    server = Server(ServerOptions())
    server.is_auth_enabled = True

    def bad_listener(_node: ClientNode) -> None:
        raise RuntimeError("boom")

    server.on_server_event(ServerEvents.AUTHENTICATION, bad_listener)
    sent: list[str] = []

    class DummySocket:
        readyState = SocketState.OPEN

        async def send(self, data: str) -> None:
            sent.append(data)

        async def close(self, code: int = 1000) -> None:
            self.readyState = SocketState.CLOSED

    node = ClientNode(server, socket=DummySocket())
    await authenticate_node(
        server, node, "tok", handshake_authenticator=lambda _n, _h: {"user": {"_id": "u1"}}
    )
    assert node.authenticated is False
    assert node.context == {}
    assert json.loads(sent[-1]) == {"t": "auth", "authenticated": False}

    # delete_client checks object identity
    a = ClientNode(server)
    b = ClientNode(server)
    a.set_id("dup")
    b.set_id("dup")
    server.add_client(a)
    server.add_client(b)
    server.delete_client(a)
    assert server.all_clients.get("dup") is b


@pytest.mark.asyncio
async def test_client_node_protected_method_server_call_and_cache() -> None:
    server = Server(ServerOptions())
    node = ClientNode(server, headers={"x-forwarded-for": "10.0.0.1", "user-agent": "ua"})
    assert node.remote_address == ""

    node.authenticated = True
    node.set_context({"user": {"_id": True}})
    assert node.user_id is None

    server.add_method("priv", lambda _n, _p: "secret", MethodOptions(protected=True))
    with pytest.raises(PublicError) as err:
        await server.call_method_on_node("priv", None, ClientNode(server))
    assert err.value.message == Errors.METHOD_FORBIDDEN.value

    calls = 0
    should_fail = True

    async def cached(n: ClientNode, p: Any) -> Any:
        nonlocal calls
        calls += 1
        if n.is_server:
            return "srv"
        if should_fail:
            raise PublicError("fail")
        return f"ok-{calls}-{p}"

    server.add_method("c", cached, MethodOptions(cache=True))
    assert await server.call("c", 1) == "srv"
    assert await server.call("c", 1) == "srv"
    assert calls == 2

    anon = ClientNode(server)
    with pytest.raises(PublicError):
        await server.call_method_on_node("c", 1, anon)
    should_fail = False
    assert await server.call_method_on_node("c", 1, anon) == "ok-4-1"

    # Cap anonymous cache at 1000 entries
    bounded_calls = 0

    async def bounded(_n: ClientNode, p: int) -> int:
        nonlocal bounded_calls
        bounded_calls += 1
        return p

    server.add_method("bounded", bounded, MethodOptions(cache=True))
    for i in range(1005):
        await server.call_method_on_node("bounded", i, anon)
    await server.call_method_on_node("bounded", 0, anon)
    assert bounded_calls == 1006


@pytest.mark.asyncio
async def test_http_payload_validation_context_allowlist_and_client_id() -> None:
    server = Server(ServerOptions(allowed_context_keys=["allowed"]))
    captured: dict[str, Any] = {}

    async def check(node: ClientNode, _p: Any) -> dict[str, Any]:
        captured["id"] = node.uuid
        captured["ctx"] = dict(node.context)
        return {"ok": True}

    from typeferry.server.server import AuthSetup

    server.set_auth(AuthSetup(auth=lambda _n, c: c, log_in=lambda _n, _p: True))
    server.add_method("check", check)
    transport = HttpTransport(server, rate_limit=False)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(transport.app), base_url="http://test"
    ) as client:
        bad_payload = await client.post("/__h", content=json.dumps({"payload": ["not-dict"]}))
        assert bad_payload.status_code == 200
        assert bad_payload.json()["message"] == Errors.INVALID_REQUEST.value

        ok = await client.post(
            "/__h",
            content=json.dumps({"context": {"allowed": 1, "secret": "injected"}, "payload": {"method": "check"}}),
            headers={"x-client-id": "bad/id!"},
        )
        assert ok.status_code == 200
        assert re.match(r"^[a-zA-Z0-9-]{1,64}$", captured["id"])
        assert captured["id"] != "bad/id!"
        assert captured["ctx"].get("allowed") == 1
        assert "secret" not in captured["ctx"]


def test_limiter_validation_and_bound() -> None:
    with pytest.raises(ValueError):
        RateLimit(max=0, interval_ms=1000)
    limiter = SlidingWindowLimiter(RateLimit(max=2, interval_ms=60_000))
    for i in range(100_050):
        limiter.try_consume(f"ip-{i}")
    assert len(limiter._buckets) <= 100_000


def test_ejson_depth_constants_base64_and_converters() -> None:
    with pytest.raises(ValueError):
        parse("[" * 130 + "1" + "]" * 130)
    with pytest.raises(ValueError):
        parse("NaN")
    with pytest.raises(ValueError):
        decode_base64("éééé")
    with pytest.raises(ValueError):
        decode_base64("AA==AA==")
    with pytest.raises(ValueError):
        _DATE_CONVERTER.from_json_value({"$date": True})
    with pytest.raises(ValueError):
        _INFNAN_CONVERTER.from_json_value({"$InfNaN": True})
    with pytest.raises(ValueError):
        _CUSTOM_CONVERTER.from_json_value({"$type": 123, "$value": 1})


@pytest.mark.asyncio
async def test_session_and_jwt_hardening(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = AuthConfig(secret="super-secret-key", access_token_expiry_minutes=15, rotation_grace_period_seconds=15)
    mgr = InMemorySessionManager(cfg)
    first = await mgr.create_session("u1")
    second = await mgr.refresh_session(first.refresh_token)
    assert second is not None
    third = await mgr.refresh_session(second.refresh_token)
    assert third is not None
    # Multi-hop grace reuse on first after second was superseded must fail!
    assert await mgr.refresh_session(first.refresh_token) is None

    # Empty secret & future iat rejected
    empty_cfg = AuthConfig(secret="")
    with pytest.raises(ValueError):
        sign_access_token(
            AccessTokenPayload(user_id="u", session_id="s", iat=int(time.time()), exp=int(time.time()) + 60),
            empty_cfg,
        )
    assert verify_access_token("Bearer abc", empty_cfg) is None

    future_tok = sign_access_token(
        AccessTokenPayload(
            user_id="u",
            session_id="s",
            iat=int(time.time()) + 600,
            exp=int(time.time()) + 1200,
        ),
        cfg,
    )
    assert verify_access_token(future_tok, cfg) is None

    bad_bool_tok = pyjwt.encode(
        {"userId": 123, "sessionId": "s", "iat": True, "exp": int(time.time()) + 60},
        cfg.secret,
        algorithm="HS256",
    )
    assert verify_access_token(bad_bool_tok, cfg) is None

    info = parse_device_info({"user-agent": "A" * 2000, "x-forwarded-for": "1.2.3.4"}, remote_address="198.51.100.9")
    assert info.ip == "198.51.100.9"
    assert info.user_agent is not None and len(info.user_agent) <= 512


@pytest.mark.asyncio
async def test_redis_channel_type_validation_and_parallel_propagate() -> None:
    from typeferry.server.transports.redis import RedisTransport

    server = Server(ServerOptions())
    transport = WebSocketTransport(server)
    server.websocket_transport = transport
    server.add_event("ping")
    redis_t = RedisTransport(server)

    class BadSocket:
        readyState = SocketState.OPEN

        async def send(self, _data: str) -> None:
            raise RuntimeError("broken pipe")

        async def close(self, code: int = 1000) -> None:
            self.readyState = SocketState.CLOSED

    delivered: list[str] = []

    class GoodSocket:
        readyState = SocketState.OPEN

        async def send(self, data: str) -> None:
            delivered.append(data)

        async def close(self, code: int = 1000) -> None:
            self.readyState = SocketState.CLOSED

    bad = BadSocket()
    good = GoodSocket()
    room = get_room_name("__no_channel__", "ping")
    transport.rooms.join(bad, room)
    transport.rooms.join(good, room)

    class FakePubSub:
        async def listen(self) -> Any:
            yield {
                "type": "message",
                "data": json.dumps({"event": "ping", "channel": ["bad"], "message": "{}"}),
            }
            yield {
                "type": "message",
                "data": json.dumps({"event": "ping", "channel": "__no_channel__", "message": '{"t":"event"}'}),
            }

    await redis_t._listen(FakePubSub())
    assert delivered == ['{"t":"event"}']


@pytest.mark.asyncio
async def test_python_post_review_hardening_regressions() -> None:
    # 1) Async AUTHENTICATION listener errors must fail closed on authenticate_node
    server = Server(ServerOptions())
    server.is_auth_enabled = True

    async def async_bad_listener(_node: ClientNode) -> None:
        await asyncio.sleep(0)
        raise RuntimeError("async auth listener failure")

    server.on_server_event(ServerEvents.AUTHENTICATION, async_bad_listener)

    class Sock:
        readyState = SocketState.OPEN

        def __init__(self) -> None:
            self.sent: list[str] = []

        async def send(self, data: str) -> None:
            self.sent.append(data)

        async def close(self, code: int = 1000) -> None:
            self.readyState = SocketState.CLOSED

    node = ClientNode(server, socket=Sock())
    await authenticate_node(
        server,
        node,
        "tok",
        handshake_authenticator=lambda _n, _h: {"user": {"_id": "u-async"}},
    )
    assert node.authenticated is False
    assert node.context == {}

    # 2) rpc:off bounds + non-string channel + closed socket guard
    ws_t = WebSocketTransport(server)
    server.websocket_transport = ws_t
    server.add_event("ev")
    s_open = Sock()
    sub_node = ClientNode(server, socket=s_open)
    assert await server.call_method_on_node(
        "rpc:off", {"events": ["ev" for _ in range(257)]}, sub_node
    ) == {}
    assert await server.call_method_on_node(
        "rpc:off", {"events": ["ev"], "channel": "é" * 200}, sub_node
    ) == {}
    assert await server.call_method_on_node(
        "rpc:off", {"events": ["ev"], "channel": ["bad"]}, sub_node
    ) == {}
    s_open.readyState = SocketState.CLOSED
    assert await server.call_method_on_node("rpc:on", {"events": ["ev"]}, sub_node) == {}

    # 3) HTTP cleanup in finally, client-id trailing newline rejected, non-string method not echoed, Set-Cookie kept on void error
    http_srv = Server(ServerOptions())

    async def cookie_auth(n: ClientNode, _c: dict[str, Any]) -> dict[str, Any]:
        pending = n.__dict__.get("_pending_response_headers")
        assert isinstance(pending, list)
        pending.append(("set-cookie", "a=1"))
        return {"user": {"_id": "u-http"}}

    from typeferry.server.server import AuthSetup

    http_srv.set_auth(AuthSetup(auth=cookie_auth, log_in=lambda _n, _p: True))

    async def inspect_id_and_fail(n: ClientNode, _p: Any) -> None:
        assert n.uuid != "good-id\n"
        raise PublicError("boom")

    http_srv.add_method("failme", inspect_id_and_fail)
    http_t = HttpTransport(http_srv, rate_limit=False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(http_t.app), base_url="http://test"
    ) as client:
        r_void = await client.post(
            "/__h",
            content=json.dumps({"payload": {"method": "failme", "void": True}}),
            headers={"x-client-id": "good-id\n"},
        )
        assert r_void.status_code == 200
        assert r_void.headers.get("set-cookie") == "a=1"
        assert http_srv.get_clients_by_user_id("u-http") == frozenset()

        r_bad_method = await client.post(
            "/__h",
            content=json.dumps({"payload": {"method": ["bad"]}}),
        )
        assert "method" not in r_bad_method.json()

    # 4) WS invalid request consumes rate limit and binary frame doesn't kill loop
    rl_srv = Server(ServerOptions())
    rl_srv.add_method("ok", lambda _n, _p: True)
    rl_ws_t = WebSocketTransport(rl_srv, rate_limit=RateLimit(max=2, interval_ms=60_000))
    rl_srv.websocket_transport = rl_ws_t
    with (
        TestClient(Starlette(routes=rl_ws_t.routes())) as tc,
        tc.websocket_connect(TYPEFERRY_WS_PATH) as ws,
    ):
            assert ws.receive_json() == {"t": "auth", "authenticated": False}
            ws.send_bytes(b"\x00\x01\x02")
            ws.send_text(json.dumps({"t": "rpc", "id": "b1", "method": 123}))
            assert ws.receive_json()["error"] == Errors.INVALID_REQUEST.value
            ws.send_text(json.dumps({"t": "rpc", "id": "b2", "method": 123}))
            assert ws.receive_json()["error"] == Errors.INVALID_REQUEST.value
            ws.send_text(json.dumps({"t": "rpc", "id": "b3", "method": 123}))
            assert ws.receive_json()["error"] == Errors.RATE_LIMIT_EXCEEDED.value

    # 5) Rate limiter max_buckets <= 0 rejected
    with pytest.raises(ValueError):
        SlidingWindowLimiter(RateLimit(), max_buckets=0)

    # 6) Redis _listen ignores unknown channel without allocating Server.channels entry and falsy bad channel
    r_srv = Server(ServerOptions())
    r_srv.add_event("ping")
    from typeferry.server.transports.redis import RedisTransport

    rt = RedisTransport(r_srv)

    class OnlyZeroChannel:
        async def listen(self) -> Any:
            yield {
                "type": "message",
                "data": json.dumps({"event": "ping", "channel": [], "message": "{}"}),
            }
            yield {
                "type": "message",
                "data": json.dumps({"event": "ping", "channel": "unsubscribed-flood", "message": "{}"}),
            }

    await rt._listen(OnlyZeroChannel())
    assert "unsubscribed-flood" not in r_srv.channels

    # 7) Session grace=0 rejected strictly, public used_at is Unix ms, JWT inf/nan rejected
    cfg_zero = AuthConfig(secret="super-secret-key", rotation_grace_period_seconds=0)
    mgr_zero = InMemorySessionManager(cfg_zero)
    s_a = await mgr_zero.create_session("u1")
    s_b = await mgr_zero.refresh_session(s_a.refresh_token)
    assert s_b is not None
    stored_a = mgr_zero._sessions[s_a.refresh_token]
    assert stored_a.used_at is not None and stored_a.used_at > 1_000_000_000_000
    assert await mgr_zero.refresh_session(s_a.refresh_token) is None

    nan_tok = pyjwt.encode({"userId": "u", "sessionId": "s", "iat": 1e400, "exp": 1e400}, "super-secret-key", algorithm="HS256")
    assert verify_access_token(nan_tok, cfg_zero) is None

    # 8) EJSON base64 non-zero unused bits rejected + nested $escape depth 128 rejected + RecursionError wrapped as ValueError
    with pytest.raises(ValueError):
        decode_base64("AB==")
    with pytest.raises(ValueError):
        nested = {"$date": 0}
        for _ in range(129):
            nested = {"$escape": nested}
        from typeferry.ejson.parse_stringify import stringify
        stringify(nested)
    with pytest.raises(ValueError):
        deep_eq_a: Any = 1
        deep_eq_b: Any = 1
        for _ in range(1200):
            deep_eq_a = [deep_eq_a]
            deep_eq_b = [deep_eq_b]
        from typeferry.ejson.equals import equals
        equals(deep_eq_a, deep_eq_b)

    # 9) Async method memoize timestamp recorded after await
    m_srv = Server(ServerOptions())
    slow_calls = 0

    async def slow_cached(_n: ClientNode, _p: Any) -> str:
        nonlocal slow_calls
        slow_calls += 1
        await asyncio.sleep(0.06)
        return "fresh"

    m_srv.add_method("slow_c", slow_cached, MethodOptions(cache=True, max_age=80))
    anon = ClientNode(m_srv)
    assert await m_srv.call_method_on_node("slow_c", 1, anon) == "fresh"
    await asyncio.sleep(0.04)  # elapsed from entry ~100ms (>80ms), from settlement ~40ms (<80ms)
    assert await m_srv.call_method_on_node("slow_c", 1, anon) == "fresh"
    assert slow_calls == 1

    # 10) ClientNode unhashable dict user._id ignored cleanly
    cn = ClientNode(m_srv)
    cn.authenticated = True
    cn.set_context({"user": {"_id": {"nested": 1}}})
    assert cn.user_id is None


@pytest.mark.asyncio
async def test_p2_security_hardening_and_parity(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    from typeferry.server.server import AuthSetup
    from typeferry.server.transports.redis import (
        RedisTransport,
        build_redis_envelope,
        format_redis_signing_input,
        parse_redis_envelope,
    )
    from typeferry.server.transports.ws_shared import WebSocketHandshake

    # 1) Production omitted-origins warning on HTTP & WS
    monkeypatch.setenv("TYPEFERRY_ENV", "production")
    caplog.set_level(logging.WARNING)
    warn_srv = Server(ServerOptions())
    HttpTransport(warn_srv)
    WebSocketTransport(warn_srv)
    assert caplog.text.count("without an origins allowlist in production") >= 2
    monkeypatch.delenv("TYPEFERRY_ENV", raising=False)

    # 2) HTTP auth timeout fails closed
    slow_srv = Server(ServerOptions())

    async def slow_auth(_node: ClientNode, _ctx: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(0.25)
        return {"user": {"_id": "late"}}

    slow_srv.set_auth(AuthSetup(auth=slow_auth, log_in=lambda _n, _p: True))
    slow_srv.add_method("secret", lambda _n, _p: "ok", MethodOptions(protected=True))
    http_t = HttpTransport(slow_srv, auth_timeout_ms=40)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=http_t.app), base_url="http://testserver"
    ) as client:
        res = await client.post(
            "/__h",
            headers={"x-api-key": "slow"},
            content=json.dumps({"payload": {"method": "secret"}}),
        )
        assert res.json()["message"] == Errors.METHOD_FORBIDDEN.value

    # 3) WS allow_query_token=False blocks ?token= while handshake_authenticator still works
    ws_srv = Server(ServerOptions())
    ws_srv.set_auth(
        AuthSetup(
            auth=lambda _n, ctx: {"user": {"_id": "q"}} if ctx.get("token") == "secret" else False,
            log_in=lambda _n, _p: True,
        )
    )
    ws_t = WebSocketTransport(ws_srv, allow_query_token=False)
    ws_srv.websocket_transport = ws_t
    with (
        TestClient(Starlette(routes=ws_t.routes())) as tc,
        tc.websocket_connect(f"{TYPEFERRY_WS_PATH}?token=secret") as ws,
    ):
        assert ws.receive_json() == {"t": "auth", "authenticated": False}

    def cookie_auth(_node: ClientNode, hs: WebSocketHandshake) -> Any:
        return {"user": {"_id": "c1"}} if hs.headers.get("cookie") == "sid=ok" else False

    ws_t_hs = WebSocketTransport(
        ws_srv, handshake_authenticator=cookie_auth, allow_query_token=False
    )
    with (
        TestClient(Starlette(routes=ws_t_hs.routes())) as tc,
        tc.websocket_connect(
            f"{TYPEFERRY_WS_PATH}?token=secret", headers={"cookie": "sid=ok"}
        ) as ws,
    ):
        assert ws.receive_json() == {"t": "auth", "authenticated": True}

    # 4) revalidate_on_delivery re-checks auth/predicate and evicts revoked subscriber
    rev_srv = Server(ServerOptions())
    allow_flag = True
    ev_ws_t = WebSocketTransport(rev_srv)
    rev_srv.websocket_transport = ev_ws_t
    rev_srv.add_event(
        "live.feed",
        EventOptions(
            protected=True,
            revalidate_on_delivery=True,
            should_subscribe=lambda c, _e, _ch: allow_flag and c.authenticated,
        ),
    )

    class MemSocket:
        def __init__(self) -> None:
            self.readyState = SocketState.OPEN
            self.sent: list[str] = []

        def send(self, data: str) -> None:
            self.sent.append(data)

        def close(self) -> None:
            self.readyState = SocketState.CLOSED

    s_ok = MemSocket()
    n_ok = ClientNode(rev_srv, socket=s_ok)
    n_ok.authenticated = True
    rev_srv.add_ws_client(n_ok)
    await rev_srv.call_method_on_node(
        "rpc:on", {"events": ["live.feed"], "channel": "room-1"}, n_ok
    )
    await rev_srv.channel("room-1").emit("live.feed", {"n": 1})
    assert len(s_ok.sent) == 1

    allow_flag = False
    await rev_srv.channel("room-1").emit("live.feed", {"n": 2})
    assert len(s_ok.sent) == 1
    assert ev_ws_t.rooms.get_room_size("typeferry:6:room-1:live.feed") == 0

    # 5) MethodOptions(sensitive=True) redacts telemetry on execution & errors
    sens_srv = Server(ServerOptions())
    executions: list[dict[str, Any]] = []
    errors_seen: list[dict[str, Any]] = []
    sens_srv.on_server_event(ServerEvents.METHOD_EXECUTION, executions.append)
    sens_srv.on_server_event(ServerEvents.METHOD_ERROR, errors_seen.append)
    sens_srv.add_method(
        "login.secret",
        lambda _n, _p: {"token": "jwt-secret"},
        MethodOptions(sensitive=True),
    )

    def fail_secret(_n: ClientNode, _p: Any) -> Any:
        raise RuntimeError("db-password-leak")

    sens_srv.add_method("fail.secret", fail_secret, MethodOptions(sensitive=True))
    sens_ws_t = WebSocketTransport(sens_srv)
    sens_srv.websocket_transport = sens_ws_t
    await sens_srv.call("login.secret", {"password": "hunter2"})
    assert executions[-1]["params"] == "[REDACTED]"
    assert executions[-1]["result"] == "[REDACTED]"

    caplog.clear()
    with (
        TestClient(Starlette(routes=sens_ws_t.routes())) as tc,
        tc.websocket_connect(TYPEFERRY_WS_PATH) as ws,
    ):
        assert ws.receive_json() == {"t": "auth", "authenticated": False}
        ws.send_text(
            json.dumps(
                {"t": "rpc", "id": "s1", "method": "fail.secret", "params": {"pw": "s"}}
            )
        )
        assert ws.receive_json()["error"] == Errors.INTERNAL_ERROR.value
        ws.send_text(
            json.dumps(
                {"t": "rpc:void", "method": "fail.secret", "params": {"pw": "v"}}
            )
        )
    assert len(errors_seen) >= 2
    for ev in errors_seen[-2:]:
        assert ev["params"] == "[REDACTED]"
        assert ev["error"] == "[REDACTED]"
    assert "db-password-leak" not in caplog.text

    # 6) Redis HMAC-SHA256 signing & strict field validation
    assert (
        format_redis_signing_input("chat.message", "room-a", '{"t":"event"}', "orig-1")
        == '12:chat.message|6:room-a|13:{"t":"event"}|6:orig-1'
    )
    signed = build_redis_envelope(
        "chat.message", "room-a", '{"t":"event"}', "orig-1", signing_secret="test-secret"
    )
    assert (
        json.loads(signed)["sig"]
        == "2fe864725cc91a1de99652933920ffbd5bd716753b3b4a155584e49ea0d4fed0"
    )
    assert parse_redis_envelope(signed, signing_secret="test-secret") == (
        "chat.message",
        "room-a",
        '{"t":"event"}',
        "orig-1",
    )
    assert (
        parse_redis_envelope(
            signed.replace("chat.message", "chat.bad"), signing_secret="test-secret"
        )
        is None
    )
    assert (
        parse_redis_envelope(
            json.dumps({"event": "chat.message", "channel": "room-a", "message": "{}"}),
            signing_secret="test-secret",
        )
        is None
    )
    assert (
        parse_redis_envelope(
            json.dumps(
                {
                    "event": "chat.message",
                    "channel": "room-a",
                    "message": "{}",
                    "excludeUuid": 99,
                }
            )
        )
        is None
    )
    rt_signed = RedisTransport(rev_srv, signing_secret="test-secret")

    class TamperedFeed:
        async def listen(self) -> Any:
            yield {
                "type": "message",
                "data": json.dumps({"event": "live.feed", "channel": "room-1", "message": "{}"}),
            }

    await rt_signed._listen(TamperedFeed())

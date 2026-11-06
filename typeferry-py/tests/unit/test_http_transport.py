"""HttpTransport wire-level behavior (PROTOCOL.md §2.1)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any, cast

import httpx
import pytest

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import (
    CLIENT_ID_HEADER_KEY,
    HTTP_ENDPOINT_PATH,
    TOKEN_HEADER_KEY,
)
from typeferry.protocol.messages import PayloadType
from typeferry.server.client_node import ClientNode
from typeferry.server.method import MethodOptions
from typeferry.server.server import AuthSetup, Server, ServerOptions
from typeferry.server.transports.http import HttpTransport
from typeferry.server.transports.rate_limit import RateLimit
from typeferry.utils.errors import Errors, PublicError


async def _post(
    client: httpx.AsyncClient, body: dict[str, Any], headers: dict[str, str] | None = None
) -> httpx.Response:
    return await client.post(
        HTTP_ENDPOINT_PATH,
        content=Presentation.encode(body),
        headers={"content-type": "text/plain", **(headers or {})},
    )


def _build(rate_limit: RateLimit | bool | None = False) -> tuple[Server, httpx.AsyncClient]:
    server = Server(ServerOptions(host="localhost", port=0))
    transport = HttpTransport(server, rate_limit=rate_limit)
    server.http_transport = transport
    return server, httpx.AsyncClient(transport=httpx.ASGITransport(transport.app), base_url="http://test")


@pytest.mark.asyncio
async def test_happy_path() -> None:
    server, client = _build()

    async def add(_node: Any, params: dict[str, int]) -> int:
        return params["a"] + params["b"]

    server.add_method("add", add)

    response = await _post(
        client,
        {"context": {}, "payload": {"method": "add", "params": {"a": 2, "b": 3}, "uuid": "call-1"}},
    )
    assert response.status_code == 200
    decoded = Presentation.decode(response.text)
    assert decoded == {
        "type": PayloadType.RESULT.value,
        "uuid": "call-1",
        "method": "add",
        "result": 5,
    }


@pytest.mark.asyncio
async def test_missing_payload_returns_invalid_request() -> None:
    _, client = _build()
    response = await _post(client, {"context": {}})
    assert response.status_code == 200
    decoded = Presentation.decode(response.text)
    assert decoded == {
        "type": PayloadType.ERROR.value,
        "message": Errors.INVALID_REQUEST.value,
    }


@pytest.mark.asyncio
async def test_method_not_found() -> None:
    _, client = _build()
    response = await _post(
        client, {"context": {}, "payload": {"method": "nope", "uuid": "u1"}}
    )
    decoded = Presentation.decode(response.text)
    assert decoded["type"] == PayloadType.ERROR.value
    assert decoded["message"] == Errors.METHOD_NOT_FOUND.value
    # METHOD_NOT_FOUND echoes the requested method, no uuid (TS parity).
    assert decoded["method"] == "nope"
    assert "uuid" not in decoded


@pytest.mark.asyncio
async def test_protected_method_without_auth_returns_method_forbidden() -> None:
    server, client = _build()

    async def secret(_node: Any, _params: Any) -> str:
        return "secret"

    server.add_method("secret", secret, MethodOptions(protected=True))

    response = await _post(
        client, {"context": {}, "payload": {"method": "secret"}}
    )
    decoded = Presentation.decode(response.text)
    assert decoded["message"] == Errors.METHOD_FORBIDDEN.value


@pytest.mark.asyncio
async def test_x_api_key_bearer_prefix_is_stripped() -> None:
    server, client = _build()

    captured: dict[str, str] = {}

    async def auth(_node: Any, context: dict[str, Any]) -> dict[str, Any]:
        captured["token"] = context["token"]
        return {"user": {"_id": "u1"}}

    async def log_in(_node: Any, _params: Any) -> bool:
        return True

    server.set_auth(AuthSetup(auth=auth, log_in=log_in))

    async def who(node: Any, _params: Any) -> str:
        return node.user_id or "anon"

    server.add_method("who", who, MethodOptions(protected=True))

    response = await _post(
        client,
        {"context": {}, "payload": {"method": "who"}},
        headers={TOKEN_HEADER_KEY: "Bearer tok-123"},
    )
    decoded = Presentation.decode(response.text)
    assert decoded["result"] == "u1"
    assert captured["token"] == "tok-123"


@pytest.mark.asyncio
async def test_x_client_id_sets_node_uuid() -> None:
    server, client = _build()

    seen: dict[str, str] = {}

    async def ident(node: Any, _params: Any) -> str:
        seen["uuid"] = node.uuid
        return node.uuid

    server.add_method("ident", ident)

    response = await _post(
        client,
        {"context": {}, "payload": {"method": "ident"}},
        headers={CLIENT_ID_HEADER_KEY: "client-abc"},
    )
    decoded = Presentation.decode(response.text)
    assert decoded["result"] == "client-abc"
    assert seen["uuid"] == "client-abc"


@pytest.mark.asyncio
async def test_public_error_passes_through() -> None:
    server, client = _build()

    async def boom(_node: Any, _params: Any) -> None:
        raise PublicError("intentional")

    server.add_method("boom", boom)

    response = await _post(
        client, {"context": {}, "payload": {"method": "boom", "uuid": "u"}}
    )
    decoded = Presentation.decode(response.text)
    assert decoded["message"] == "intentional"
    assert decoded["uuid"] == "u"


@pytest.mark.asyncio
async def test_unknown_exception_normalizes_to_internal_error() -> None:
    server, client = _build()

    async def crash(_node: Any, _params: Any) -> None:
        raise RuntimeError("never leaked")

    server.add_method("crash", crash)

    response = await _post(
        client, {"context": {}, "payload": {"method": "crash"}}
    )
    decoded = Presentation.decode(response.text)
    assert decoded["message"] == Errors.INTERNAL_ERROR.value


@pytest.mark.asyncio
async def test_schema_validation_envelopes_errors_field() -> None:
    server, client = _build()

    from typeferry.server.schema import (
        SchemaValidator,
        ValidationIssue,
        ValidationResult,
    )

    class Failing:
        def safe_parse(self, _value: Any) -> ValidationResult:
            return ValidationResult(
                success=False,
                issues=[
                    ValidationIssue(path=["a"], message="required"),
                    ValidationIssue(path=["b", "c"], message="too short"),
                ],
            )

    validator: SchemaValidator = Failing()

    async def handler(_node: Any, _params: Any) -> None:
        raise AssertionError("should not run")

    server.add_method("v", handler, MethodOptions(schema=validator))

    response = await _post(client, {"context": {}, "payload": {"method": "v"}})
    decoded = Presentation.decode(response.text)
    assert decoded["message"].startswith(Errors.INVALID_PARAMS.value)
    assert decoded["errors"] == ["a: required", "b.c: too short"]


@pytest.mark.asyncio
async def test_void_suppresses_error_response() -> None:
    server, client = _build()

    async def boom(_node: Any, _params: Any) -> None:
        raise PublicError("should not surface")

    server.add_method("boom", boom)

    response = await _post(
        client, {"context": {}, "payload": {"method": "boom", "void": True}}
    )
    assert response.status_code == 200
    assert response.text == ""


@pytest.mark.asyncio
async def test_void_does_not_suppress_success_body() -> None:
    """Per PROTOCOL.md / TS parity: void on HTTP suppresses error
    responses only — success bodies still return. Full silence is a
    WebSocket-only guarantee (rpc:void frame)."""

    server, client = _build()

    async def ok(_node: Any, _params: Any) -> str:
        return "ignored-by-caller"

    server.add_method("ok", ok)

    response = await _post(
        client, {"context": {}, "payload": {"method": "ok", "void": True}}
    )
    decoded = Presentation.decode(response.text)
    assert decoded["type"] == PayloadType.RESULT.value
    assert decoded["result"] == "ignored-by-caller"


@pytest.mark.asyncio
async def test_rate_limit_returns_429() -> None:
    server, client = _build(rate_limit=RateLimit(max=2, interval_ms=60_000))

    async def ping(_node: Any, _params: Any) -> str:
        return "pong"

    server.add_method("ping", ping)

    for _ in range(2):
        r = await _post(client, {"context": {}, "payload": {"method": "ping"}})
        assert r.status_code == 200

    blocked = await _post(client, {"context": {}, "payload": {"method": "ping"}})
    assert blocked.status_code == 429
    assert blocked.headers.get("RateLimit-Limit") == "2"
    assert blocked.headers.get("RateLimit-Remaining") == "0"


@pytest.mark.asyncio
async def test_forwarding_headers_cannot_change_peer_quota_or_metadata() -> None:
    server = Server(ServerOptions())
    transport = HttpTransport(server, rate_limit=RateLimit(max=2))
    peer = "203.0.113.7"
    authenticated_peers: list[str] = []

    async def auth(node: ClientNode, _context: Any) -> bool:
        authenticated_peers.append(node.remote_address)
        return True

    async def identify(node: ClientNode, _params: Any) -> str:
        return node.remote_address

    server.set_auth(AuthSetup(auth=auth, log_in=identify))
    server.add_method("identify", identify)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(transport.app, client=(peer, 1234)),
        base_url="http://test",
    ) as client:
        for suffix in range(2):
            response = await _post(
                client, {"payload": {"method": "identify"}},
                headers={"x-forwarded-for": f"198.51.100.{suffix}"},
            )
            assert response.status_code == 200
            assert response.json()["result"] == peer

        blocked = await _post(
            client, {"payload": {"method": "identify"}},
            headers={"x-forwarded-for": "198.51.100.99"},
        )

    assert blocked.status_code == 429
    assert authenticated_peers == [peer, peer]


@pytest.mark.asyncio
async def test_distinct_asgi_peers_keep_separate_quotas() -> None:
    server = Server(ServerOptions())
    transport = HttpTransport(server, rate_limit=RateLimit(max=1))

    async def identify(node: ClientNode, _params: Any) -> str:
        return node.remote_address

    server.add_method("identify", identify)

    for suffix in range(1, 3):
        peer = f"203.0.113.{suffix}"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(transport.app, client=(peer, 1234)),
            base_url="http://test",
        ) as client:
            response = await _post(
                client, {"payload": {"method": "identify"}},
                headers={"x-forwarded-for": "198.51.100.1"},
            )
            assert response.status_code == 200
            assert response.json()["result"] == peer

            blocked = await _post(client, {"payload": {"method": "identify"}})
            assert blocked.status_code == 429


@pytest.mark.asyncio
async def test_binary_round_trip_on_wire() -> None:
    server, client = _build()

    async def echo(_node: Any, params: dict[str, bytes]) -> dict[str, bytes]:
        return {"out": params["in"]}

    server.add_method("echo", echo)

    response = await _post(
        client,
        {
            "context": {},
            "payload": {"method": "echo", "params": {"in": b"\x01\x02\x03"}},
        },
    )
    decoded = Presentation.decode(response.text)
    assert decoded["result"] == {"out": b"\x01\x02\x03"}


@pytest.mark.parametrize(
    ("origins", "origin", "allow_originless", "status"),
    [
        (None, None, False, 200),
        (None, "https://other.test", False, 200),
        ([], None, False, 403),
        ([], "https://allowed.test", False, 403),
        ([], None, True, 200),
        ([""], "", True, 403),
        (["https://allowed.test"], None, False, 403),
        (["https://allowed.test"], None, True, 200),
        (["https://allowed.test"], "https://other.test", True, 403),
        (["https://allowed.test"], "https://allowed.test", False, 200),
    ],
)
@pytest.mark.asyncio
async def test_origin_admission_precedes_auth_and_rate_consumption(
    origins: list[str] | None, origin: str | None, allow_originless: bool, status: int
) -> None:
    server = Server(ServerOptions())
    calls: list[str] = []

    async def auth(_node: Any, _context: Any) -> dict[str, str]:
        calls.append("auth")
        return {"role": "reader"}

    async def handler(_node: Any, _params: Any) -> bool:
        calls.append("handler")
        return True

    server.set_auth(AuthSetup(auth=auth, log_in=handler))
    server.add_method("probe", handler)
    transport = HttpTransport(
        server, origins=origins, allow_originless=allow_originless,
        rate_limit=RateLimit(max=1),
    )
    headers = {} if origin is None else {"origin": origin}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(transport.app), base_url="http://test"
    ) as client:
        response = await _post(client, {"payload": {"method": "probe"}}, headers)

    assert response.status_code == status
    assert calls == (["auth", "handler"] if status == 200 else [])
    if status == 403:
        assert not any(name.startswith("ratelimit") for name in response.headers)
        assert transport.limiter is not None
        assert transport.limiter.try_consume("127.0.0.1")[0]


@pytest.mark.parametrize("outcome", [None, False, 0, -0.0, float("nan"), "", {}, []])
@pytest.mark.asyncio
async def test_http_authentication_uses_javascript_truthiness(outcome: Any) -> None:
    server, client = _build()

    async def auth(_node: Any, _context: Any) -> Any:
        return outcome

    async def handler(node: Any, _params: Any) -> bool:
        return node.authenticated

    server.set_auth(AuthSetup(auth=auth, log_in=handler))
    server.add_method("probe", handler)

    response = await _post(client, {"payload": {"method": "probe"}})

    assert response.json()["result"] is isinstance(outcome, (dict, list))
    await client.aclose()


@pytest.mark.parametrize("method,is_void", [("ok", False), ("missing", False), ("ok", True), ("missing", True)])
@pytest.mark.asyncio
async def test_rate_headers_cover_admitted_responses_and_preserve_cookies(
    method: str, is_void: bool, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "typeferry.server.transports.rate_limit.time", SimpleNamespace(monotonic=lambda: 0.0)
    )
    server, client = _build(rate_limit=RateLimit(max=2, interval_ms=1001))

    async def handler(node: Any, _params: Any) -> bool:
        node._pending_response_headers.append(("set-cookie", "first=1"))
        node._pending_response_headers.append(("set-cookie", "second=2"))
        return True

    server.add_method("ok", handler)
    body = {"payload": {"method": method, "void": is_void}}

    async with client:
        response = await _post(client, body)
        assert response.headers["RateLimit-Limit"] == "2"
        assert response.headers["RateLimit-Remaining"] == "1"
        assert response.headers["RateLimit-Reset"] == "2"
        if method == "ok":
            assert response.headers.get_list("set-cookie") == ["first=1", "second=2"]

        await _post(client, body)
        blocked = await _post(client, body)

    assert blocked.status_code == 429
    assert blocked.headers["RateLimit-Remaining"] == "0"
    assert blocked.headers["RateLimit-Reset"] == "2"


@pytest.mark.asyncio
async def test_disabled_limiter_emits_no_rate_headers() -> None:
    _, client = _build(rate_limit=False)
    async with client:
        response = await _post(client, {"payload": {"method": "missing"}})
    assert not any(name.startswith("ratelimit") for name in response.headers)


def _build_body_probe() -> tuple[Server, list[str]]:
    server = Server(ServerOptions())
    calls: list[str] = []

    async def auth(_node: ClientNode, _context: Any) -> bool:
        calls.append("auth")
        return True

    async def handler(_node: ClientNode, _params: Any) -> bool:
        calls.append("handler")
        return True

    server.set_auth(AuthSetup(auth=auth, log_in=handler))
    server.add_method("probe", handler)
    return server, calls


@pytest.mark.parametrize("configured_limit", [None, 256])
@pytest.mark.asyncio
async def test_body_limit_accepts_its_boundary_and_rejects_one_more_byte(
    configured_limit: int | None,
) -> None:
    server, calls = _build_body_probe()
    if configured_limit is None:
        transport = HttpTransport(server, rate_limit=False)
        limit = 4 * 1024 * 1024
    else:
        transport = HttpTransport(server, rate_limit=False, max_body_bytes=configured_limit)
        limit = configured_limit

    body = {"payload": {"method": "probe", "params": ""}}
    overhead = len(Presentation.encode(body).encode())

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(transport.app), base_url="http://test",
    ) as client:
        for extra, status in [(0, 200), (1, 413)]:
            body["payload"]["params"] = "x" * (limit - overhead + extra)
            encoded = Presentation.encode(body).encode()

            assert len(encoded) == limit + extra
            response = await client.post(HTTP_ENDPOINT_PATH, content=encoded)
            assert response.status_code == status

    assert calls == ["auth", "handler"]


@pytest.mark.parametrize("limit", [0, -1, True, False, 1.5, "4096", None])
def test_body_limit_requires_a_positive_integer(limit: object) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        HttpTransport(Server(ServerOptions()), max_body_bytes=cast("int", limit))


@pytest.mark.asyncio
async def test_declared_body_overflow_is_rejected_without_reading_the_stream() -> None:
    server, calls = _build_body_probe()
    transport = HttpTransport(server, max_body_bytes=16)
    reads = 0

    async def content() -> AsyncIterator[bytes]:
        nonlocal reads
        reads += 1
        yield b"x" * 17

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(transport.app), base_url="http://test",
    ) as client:
        response = await client.post(
            HTTP_ENDPOINT_PATH, content=content(), headers={"content-length": "17"},
        )

    assert response.status_code == 413
    assert response.headers["RateLimit-Remaining"] == "119"
    assert reads == 0
    assert calls == []


@pytest.mark.parametrize("declared_length", [None, "1"])
@pytest.mark.asyncio
async def test_stream_overflow_stops_reading_before_decoding_or_dispatch(
    declared_length: str | None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, calls = _build_body_probe()
    transport = HttpTransport(server, max_body_bytes=16)
    reads = 0

    def unexpected_decode(_body: str) -> dict[str, Any] | None:
        raise AssertionError("An oversized body must not reach EJSON decoding")

    async def content() -> AsyncIterator[bytes]:
        nonlocal reads
        reads += 1
        yield b"x" * 16
        reads += 1
        yield b"x"
        raise AssertionError("The transport must stop reading after overflow")

    monkeypatch.setattr("typeferry.server.transports.http._parse_transport", unexpected_decode)
    headers = {} if declared_length is None else {"content-length": declared_length}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(transport.app), base_url="http://test",
    ) as client:
        response = await client.post(HTTP_ENDPOINT_PATH, content=content(), headers=headers)

    assert response.status_code == 413
    assert response.headers["RateLimit-Remaining"] == "119"
    assert reads == 2
    assert calls == []


@pytest.mark.asyncio
async def test_origin_and_rate_admission_precede_body_limits() -> None:
    server, calls = _build_body_probe()
    origin = "https://allowed.test"
    transport = HttpTransport(
        server, origins=[origin], rate_limit=RateLimit(max=1), max_body_bytes=1,
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(transport.app), base_url="http://test",
    ) as client:
        forbidden = await client.post(HTTP_ENDPOINT_PATH, content=b"xx")
        assert forbidden.status_code == 403
        assert not any(name.startswith("ratelimit") for name in forbidden.headers)

        oversized = await client.post(
            HTTP_ENDPOINT_PATH, content=b"xx", headers={"origin": origin},
        )
        assert oversized.status_code == 413
        assert oversized.headers["RateLimit-Limit"] == "1"
        assert oversized.headers["RateLimit-Remaining"] == "0"
        assert "RateLimit-Reset" in oversized.headers

        blocked = await client.post(
            HTTP_ENDPOINT_PATH, content=b"xx", headers={"origin": origin},
        )
        assert blocked.status_code == 429
        assert blocked.headers["RateLimit-Remaining"] == "0"

    assert calls == []

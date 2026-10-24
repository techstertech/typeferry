"""Method execution: middleware, schema, caching, context, timing."""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import uuid4

import pytest

from typeferry.protocol.constants import ServerEvents
from typeferry.server.client_node import ClientNode
from typeferry.server.context import TypeFerryContext
from typeferry.server.method import Method, MethodOptions
from typeferry.server.schema import (
    SchemaValidator,
    ValidationIssue,
    ValidationResult,
)
from typeferry.server.server import Server, ServerOptions
from typeferry.utils.errors import PublicError, SchemaValidationError


def _server() -> Server:
    return Server(ServerOptions(host="localhost", port=0))


@pytest.mark.asyncio
async def test_basic_invocation() -> None:
    server = _server()

    async def handler(_node: ClientNode | None, params: dict[str, int]) -> int:
        return params["a"] + params["b"]

    method = Method(server, "add", handler)
    result = await method.exec({"a": 2, "b": 3}, ClientNode(server))
    assert result == 5


@pytest.mark.asyncio
async def test_middleware_pipes_through() -> None:
    server = _server()

    async def plus_one(_node: ClientNode | None, params: dict[str, int]) -> dict[str, int]:
        return {**params, "a": params["a"] + 1}

    def times_two(_node: ClientNode | None, params: dict[str, int]) -> dict[str, int]:
        return {**params, "a": params["a"] * 2}

    async def handler(_node: ClientNode | None, params: dict[str, int]) -> int:
        return params["a"]

    method = Method(
        server,
        "m",
        handler,
        MethodOptions(middleware=[plus_one, times_two]),
    )
    result = await method.exec({"a": 3}, ClientNode(server))
    assert result == 8  # (3 + 1) * 2


@pytest.mark.asyncio
async def test_schema_validation_failure_raises() -> None:
    server = _server()

    class FailingValidator:
        def safe_parse(self, _value: Any) -> ValidationResult:
            return ValidationResult(
                success=False,
                issues=[ValidationIssue(path=["a"], message="expected int")],
            )

    validator: SchemaValidator = FailingValidator()

    async def handler(_node: ClientNode | None, _params: Any) -> None:
        raise AssertionError("should not be called")

    method = Method(server, "m", handler, MethodOptions(schema=validator))

    with pytest.raises(SchemaValidationError) as info:
        await method.exec({"a": "not-int"}, ClientNode(server))
    assert info.value.errors == ["a: expected int"]
    assert info.value.message.startswith("Invalid Params: a: expected int")


@pytest.mark.asyncio
async def test_schema_normalizes_none_to_empty_dict() -> None:
    server = _server()

    seen: dict[str, Any] = {}

    class AcceptEmpty:
        def safe_parse(self, value: Any) -> ValidationResult:
            seen["received"] = value
            return ValidationResult(success=True, data=value)

    async def handler(_node: ClientNode | None, params: Any) -> Any:
        return params

    method = Method(server, "m", handler, MethodOptions(schema=AcceptEmpty()))
    await method.exec(None, ClientNode(server))
    assert seen["received"] == {}


@pytest.mark.asyncio
async def test_cached_method_hits_cache_on_identical_params() -> None:
    server = _server()

    count = {"n": 0}

    async def handler(_node: ClientNode | None, params: dict[str, int]) -> int:
        count["n"] += 1
        return params["a"]

    method = Method(
        server,
        "cached",
        handler,
        MethodOptions(cache=True, max_age=60_000),
    )
    a1 = await method.exec({"a": 1}, ClientNode(server))
    a2 = await method.exec({"a": 1}, ClientNode(server))
    b1 = await method.exec({"a": 2}, ClientNode(server))
    assert a1 == 1 and a2 == 1 and b1 == 2
    # Two distinct param objects → two handler invocations; second {a:1} hits cache.
    assert count["n"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("protected", [False, True])
async def test_authenticated_cached_calls_keep_caller_results_separate(protected: bool) -> None:
    server = _server()
    callers = [ClientNode(server) for _ in range(2)]
    for caller in callers:
        caller.authenticated = True
        caller.set_context({"user": {"_id": uuid4().hex}})

    def handler(node: ClientNode, _params: dict[str, str]) -> str | None:
        return node.user_id

    method = Method(server, "private", handler, MethodOptions(cache=True, protected=protected))
    params = {"resource": uuid4().hex}

    for caller in callers:
        assert await method.exec(params, caller) == caller.user_id


@pytest.mark.asyncio
async def test_authenticated_cached_calls_recheck_inline_authorization() -> None:
    server = _server()
    caller = ClientNode(server)
    caller.authenticated = True
    allowed = True

    def handler(_node: ClientNode, _params: dict[str, str]) -> str:
        if not allowed:
            raise PublicError("Access denied")
        return "private result"

    method = Method(server, "permission", handler, MethodOptions(cache=True))
    params = {"resource": uuid4().hex}

    assert await method.exec(params, caller) == "private result"

    allowed = False

    with pytest.raises(PublicError, match="Access denied"):
        await method.exec(params, caller)


@pytest.mark.asyncio
async def test_cache_reads_and_writes_follow_connection_authentication_changes() -> None:
    server = _server()
    caller = ClientNode(server)
    calls = 0

    def handler(node: ClientNode, _params: dict[str, bool]) -> int:
        nonlocal calls
        calls += 1
        return calls

    method = Method(server, "transition", handler, MethodOptions(cache=True))
    fresh_params = {"fresh": True}

    assert await method.exec({}, caller) == 1
    assert await method.exec({}, caller) == 1

    caller.authenticated = True

    assert await method.exec({}, caller) == 2
    assert await method.exec(fresh_params, caller) == 3

    caller.authenticated = False

    assert await method.exec(fresh_params, caller) == 4
    assert await method.exec(fresh_params, caller) == 4
    assert await method.exec({}, caller) == 1

    caller.authenticated = True

    assert await method.exec({}, caller) == 5


@pytest.mark.asyncio
async def test_cache_expires_after_max_age() -> None:
    import time as timemod

    server = _server()
    count = {"n": 0}

    async def handler(_node: ClientNode | None, _params: Any) -> int:
        count["n"] += 1
        return count["n"]

    method = Method(
        server,
        "expire",
        handler,
        MethodOptions(cache=True, max_age=10),
    )
    _ = await method.exec({"a": 1}, ClientNode(server))
    # Advance the monotonic clock past the 10ms window.
    original = timemod.monotonic
    try:
        timemod.monotonic = lambda: original() + 1.0  # type: ignore[assignment]
        _ = await method.exec({"a": 1}, ClientNode(server))
    finally:
        timemod.monotonic = original  # type: ignore[assignment]
    assert count["n"] == 2


@pytest.mark.asyncio
async def test_context_is_visible_inside_handler() -> None:
    server = _server()

    captured: dict[str, Any] = {}

    async def handler(_node: ClientNode | None, _params: Any) -> None:
        store = TypeFerryContext.get_store()
        captured["ctx"] = store.context if store is not None else None

    method = Method(server, "m", handler)
    node = ClientNode(server)
    node.context = {"user": "alice"}
    await method.exec({}, node)
    assert captured["ctx"] == {"user": "alice"}


@pytest.mark.asyncio
async def test_method_execution_event_fires_with_timing() -> None:
    server = _server()

    seen: list[dict[str, Any]] = []
    server.on_server_event(ServerEvents.METHOD_EXECUTION, lambda payload: seen.append(payload))

    async def handler(_node: ClientNode | None, params: dict[str, int]) -> int:
        await asyncio.sleep(0.001)
        return params["a"]

    method = Method(server, "timed", handler)
    await method.exec({"a": 7}, ClientNode(server))
    assert len(seen) == 1
    assert seen[0]["method"] == "timed"
    assert seen[0]["result"] == 7
    assert seen[0]["time"] >= 0.0

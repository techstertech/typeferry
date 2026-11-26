"""Decorator surface: @method, @namespace, @protected, @cached, @schema,
@use, plus ``register``."""

from __future__ import annotations

from typing import Any

import pytest

from typeferry.decorators import (
    cached,
    method,
    namespace,
    no_cache,
    protected,
    public,
    register,
    schema,
    use,
)
from typeferry.server.schema import (
    SchemaValidator,
    ValidationIssue,
    ValidationResult,
)
from typeferry.server.server import Server, ServerOptions
from typeferry.utils.errors import SchemaValidationError


def _server() -> Server:
    return Server(ServerOptions(host="localhost", port=0))


class _AcceptAll:
    def safe_parse(self, value: Any) -> ValidationResult:
        return ValidationResult(success=True, data=value)


class _RejectAll:
    def safe_parse(self, _value: Any) -> ValidationResult:
        return ValidationResult(
            success=False,
            issues=[ValidationIssue(path=["x"], message="bad")],
        )


# ---------------------------------------------------------------------------
# @method
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_register_method_with_class_instance() -> None:
    class Plain:
        @method
        async def hello(self, _node: Any, params: dict[str, str]) -> str:
            return f"hi {params['name']}"

    server = _server()
    names = register(server, Plain())
    assert names == ["hello"]

    result = await server.call("hello", {"name": "ada"})
    assert result == "hi ada"


@pytest.mark.asyncio
async def test_method_name_override() -> None:
    class Plain:
        @method("custom.wire")
        async def native(self, _node: Any, _params: Any) -> str:
            return "ok"

    server = _server()
    names = register(server, Plain())
    assert names == ["custom.wire"]
    assert await server.call("custom.wire") == "ok"


# ---------------------------------------------------------------------------
# @namespace
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_namespace_prefix_applied() -> None:
    @namespace("users")
    class UserMethods:
        @method
        async def list_all(self, _node: Any, _params: Any) -> list[int]:
            return [1, 2, 3]

    server = _server()
    names = register(server, UserMethods())
    assert names == ["users.list_all"]
    assert await server.call("users.list_all") == [1, 2, 3]


# ---------------------------------------------------------------------------
# @protected / @public
# ---------------------------------------------------------------------------


def test_protected_at_class_level() -> None:
    @protected
    class Secret:
        @method
        async def one(self, _node: Any, _params: Any) -> None: ...

        @method
        @public
        async def two(self, _node: Any, _params: Any) -> None: ...

    server = _server()
    register(server, Secret())
    assert server.get_method("one").is_protected is True  # type: ignore[union-attr]
    assert server.get_method("two").is_protected is False  # type: ignore[union-attr]


def test_protected_at_method_level_overrides_unset_class() -> None:
    class Mixed:
        @method
        async def pub(self, _node: Any, _params: Any) -> None: ...

        @method
        @protected
        async def priv(self, _node: Any, _params: Any) -> None: ...

    server = _server()
    register(server, Mixed())
    assert server.get_method("pub").is_protected is False  # type: ignore[union-attr]
    assert server.get_method("priv").is_protected is True  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# @cached / @no_cache
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cached_method_hits_cache() -> None:
    count = {"n": 0}

    class API:
        @method
        @cached(max_age_ms=60_000)
        async def read(self, _node: Any, params: dict[str, int]) -> int:
            count["n"] += 1
            return params["a"]

    server = _server()
    register(server, API())
    from typeferry.server.client_node import ClientNode

    anon = ClientNode(server)
    await server.call_method_on_node("read", {"a": 1}, anon)
    await server.call_method_on_node("read", {"a": 1}, anon)
    assert count["n"] == 1


@pytest.mark.asyncio
async def test_class_cached_default_with_no_cache_opt_out() -> None:
    count = {"all": 0, "fresh": 0}

    @cached(max_age_ms=60_000)
    class API:
        @method
        async def cached_op(self, _node: Any, _p: Any) -> int:
            count["all"] += 1
            return 1

        @method
        @no_cache
        async def always_fresh(self, _node: Any, _p: Any) -> int:
            count["fresh"] += 1
            return 2

    server = _server()
    register(server, API())
    from typeferry.server.client_node import ClientNode

    anon = ClientNode(server)
    await server.call_method_on_node("cached_op", None, anon)
    await server.call_method_on_node("cached_op", None, anon)
    await server.call_method_on_node("always_fresh", None, anon)
    await server.call_method_on_node("always_fresh", None, anon)
    assert count["all"] == 1
    assert count["fresh"] == 2


# ---------------------------------------------------------------------------
# @schema
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_schema_failure_raises_schema_validation_error() -> None:
    class API:
        @method
        @schema(_RejectAll())
        async def op(self, _node: Any, _p: Any) -> None:
            raise AssertionError("should not be called")

    server = _server()
    register(server, API())
    with pytest.raises(SchemaValidationError):
        await server.call("op", {"anything": 1})


@pytest.mark.asyncio
async def test_schema_success_propagates_data() -> None:
    captured: list[Any] = []

    class API:
        @method
        @schema(_AcceptAll())
        async def op(self, _node: Any, params: Any) -> str:
            captured.append(params)
            return "ok"

    server = _server()
    register(server, API())
    result = await server.call("op", {"x": 1})
    assert result == "ok"
    assert captured == [{"x": 1}]


# ---------------------------------------------------------------------------
# @use
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_middleware_runs_outer_to_inner() -> None:
    order: list[str] = []

    async def outer(_node: Any, params: dict[str, int]) -> dict[str, int]:
        order.append("outer")
        return {**params, "a": params["a"] + 1}

    async def inner(_node: Any, params: dict[str, int]) -> dict[str, int]:
        order.append("inner")
        return {**params, "a": params["a"] * 2}

    class API:
        @method
        @use(outer)
        @use(inner)
        async def op(self, _node: Any, params: dict[str, int]) -> int:
            order.append("handler")
            return params["a"]

    server = _server()
    register(server, API())
    result = await server.call("op", {"a": 3})
    assert order == ["outer", "inner", "handler"]
    assert result == (3 + 1) * 2


# ---------------------------------------------------------------------------
# SchemaValidator protocol + PydanticValidator auto-wrap
# ---------------------------------------------------------------------------


def test_schema_accepts_custom_validator_directly() -> None:
    class Always(_AcceptAll):
        pass

    assert isinstance(Always(), SchemaValidator)

    @method
    @schema(Always())
    async def _op(_self: Any, _node: Any, _p: Any) -> None: ...

"""Shared helpers for the conformance harness.

Loads fixtures from ``docs/conformance/fixtures/`` relative to this
file's package, rehydrates tagged EJSON values, and interprets the
``handler:``/``schema:``/``auth:`` hints that fixtures use to describe
a server configuration without pinning to a specific Python import.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from typeferry.ejson import EJSONRegExp, add_type
from typeferry.ejson.base64 import decode_base64
from typeferry.ejson.custom_types import _clear_registry_for_tests
from typeferry.server.method import MethodOptions
from typeferry.server.schema import ValidationIssue, ValidationResult
from typeferry.server.server import AuthSetup, Server
from typeferry.utils.errors import PublicError

FIXTURES_ROOT = Path(__file__).resolve().parents[3] / "docs" / "conformance" / "fixtures"


# ---------------------------------------------------------------------------
# Fixture discovery
# ---------------------------------------------------------------------------


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def list_cases(subdir: str, suffix: str = ".case.json") -> list[Path]:
    root = FIXTURES_ROOT / subdir
    return sorted(p for p in root.iterdir() if p.name.endswith(suffix))


def list_sequences(subdir: str) -> list[Path]:
    root = FIXTURES_ROOT / subdir
    return sorted(p for p in root.iterdir() if p.name.endswith(".seq.ndjson"))


def load_sequence(path: Path) -> list[dict[str, Any]]:
    lines = [line for line in path.read_text().splitlines() if line.strip()]
    return [json.loads(line) for line in lines]


# ---------------------------------------------------------------------------
# EJSON value rehydration
# ---------------------------------------------------------------------------


class FixtureCustom:
    """Minimal CustomType for fixture-defined `custom` values."""

    def __init__(self, name: str, inner: Any) -> None:
        self._name = name
        self._inner = inner

    def type_name(self) -> str:
        return self._name

    def to_json_value(self) -> Any:
        return self._inner


def rehydrate(node: Any) -> Any:
    kind = node["__kind"]
    if kind == "null":
        return None
    if kind == "bool":
        return node["value"]
    if kind == "int":
        return int(node["value"])
    if kind == "float":
        return float(node["value"])
    if kind == "string":
        return node["value"]
    if kind == "array":
        return [rehydrate(i) for i in node["items"]]
    if kind == "object":
        out: dict[str, Any] = {}
        for key, value in node["entries"]:
            out[key] = rehydrate(value)
        return out
    if kind == "date":
        return datetime.fromtimestamp(node["millis"] / 1000, tz=UTC)
    if kind == "binary":
        return decode_base64(node["base64"])
    if kind == "regex":
        return EJSONRegExp(source=node["source"], flags=node["flags"])
    if kind == "inf_nan":
        sign = node["sign"]
        if sign == 0:
            return float("nan")
        if sign == 1:
            return float("inf")
        return float("-inf")
    if kind == "custom":
        return FixtureCustom(node["type"], rehydrate(node["inner"]))
    raise ValueError(f"unknown __kind: {kind}")


def register_custom_types(names: list[str]) -> None:
    """Register each custom type with a factory that rebuilds the inner value."""

    for name in names:
        def factory(payload: Any, _n: str = name) -> FixtureCustom:
            return FixtureCustom(_n, payload)

        add_type(name, factory)


def reset_custom_types() -> None:
    _clear_registry_for_tests()


# ---------------------------------------------------------------------------
# Server fixture: interpret setup hints
# ---------------------------------------------------------------------------


def build_handler(spec: str) -> Callable[..., Any]:
    """Turn a fixture-defined handler string into an async callable."""

    if spec == "add_two_integers":
        async def handler(_node: Any, params: Any) -> int:
            return int(params["a"]) + int(params["b"])

        return handler

    if spec == "echo_params":
        async def handler(_node: Any, params: Any) -> Any:
            return params

        return handler

    if spec == "increment_counter":
        calls = 0

        async def increment_counter(_node: object, _params: object) -> int:
            nonlocal calls
            calls += 1
            return calls

        return increment_counter

    if spec == "return_user_id":
        async def handler(node: Any, _params: Any) -> str | None:
            return node.user_id

        return handler

    if spec.startswith("return_const:"):
        value = spec.removeprefix("return_const:")

        async def handler(_node: Any, _params: Any) -> str:
            return value

        return handler

    if spec.startswith("raise_public:"):
        message = spec.removeprefix("raise_public:")

        async def handler(_node: Any, _params: Any) -> None:
            raise PublicError(message)

        return handler

    raise ValueError(f"unknown handler spec: {spec}")


class _FixtureSchema:
    def __init__(self, issues: list[dict[str, Any]]) -> None:
        self._issues = [
            ValidationIssue(path=i["path"], message=i["message"])
            for i in issues
        ]

    def safe_parse(self, _value: Any) -> ValidationResult:
        return ValidationResult(success=False, issues=list(self._issues))


def build_schema(spec: dict[str, Any] | None) -> Any | None:
    if not spec:
        return None
    if spec.get("reject_all"):
        return _FixtureSchema(spec.get("issues", []))
    return None


def configure_server(server: Server, setup: dict[str, Any]) -> None:
    """Register methods / events / auth from a fixture setup block."""

    for method_spec in setup.get("methods", []):
        handler = build_handler(method_spec["handler"])
        server.add_method(
            method_spec["name"],
            handler,
            MethodOptions(
                protected=bool(method_spec.get("protected", False)),
                cache=bool(method_spec.get("cache", False)),
                schema=build_schema(method_spec.get("schema")),
            ),
        )
    for event_spec in setup.get("events", []):
        server.add_event(event_spec["name"])
    if "auth" in setup:
        auth_spec = setup["auth"]
        accept = auth_spec["accept_token"]
        user = auth_spec["user"]

        async def auth(_node: Any, context: dict[str, Any]) -> Any:
            if context.get("token") == accept:
                return {"user": user}
            return False

        async def log_in(_node: Any, _params: Any) -> bool:
            return True

        server.set_auth(AuthSetup(auth=auth, log_in=log_in))

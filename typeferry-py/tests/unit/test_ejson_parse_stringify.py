"""End-to-end parse/stringify round-trips."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from typeferry.ejson import EJSON, parse, stringify


def test_stringify_orders_index_keys_recursively_before_insertion_order() -> None:
    value = {"z": {"10": 10, "2": 2, "01": 1}, "10": 10, "2": 2, "a": 0}

    assert EJSON.stringify(value) == '{"2":2,"10":10,"z":{"2":2,"10":10,"01":1},"a":0}'


def test_string_round_trip() -> None:
    text = stringify({"name": "Alice", "age": 30})
    assert text == '{"name":"Alice","age":30}'
    assert parse(text) == {"name": "Alice", "age": 30}


def test_date_round_trip_through_text() -> None:
    value = {"at": datetime(2024, 3, 15, 10, 0, 0, tzinfo=UTC)}
    text = stringify(value)
    decoded = parse(text)
    assert decoded["at"] == value["at"]


def test_binary_round_trip_through_text() -> None:
    value = {"payload": b"\x00\x01\x02\xff"}
    text = stringify(value)
    decoded = parse(text)
    assert decoded["payload"] == value["payload"]


def test_parse_rejects_non_string() -> None:
    with pytest.raises(TypeError):
        parse(123)  # type: ignore[arg-type]


def test_stringify_canonical_sorts_keys() -> None:
    text = stringify({"b": 1, "a": 2}, canonical=True)
    assert text == '{"a":2,"b":1}'


def test_stringify_indent_true_is_two_spaces() -> None:
    text = stringify({"a": 1}, indent=True)
    # Matches JS ``JSON.stringify(x, null, 2)``.
    assert text == '{\n  "a": 1\n}'


def test_stringify_rejects_nan_without_conversion() -> None:
    # NaN/Inf go through the converter path; a raw ``float('nan')`` keyed
    # directly into json.dumps would raise because ``allow_nan=False``.
    # Our ``stringify`` tags NaN before serialization, so this succeeds.
    text = stringify(float("nan"))
    assert json.loads(text) == {"$InfNaN": 0}


def test_mixed_payload_round_trip() -> None:
    payload = {
        "user": {
            "id": "u1",
            "created_at": datetime(2024, 1, 1, tzinfo=UTC),
            "avatar": b"\x89PNG\r\n",
        },
        "scores": [1, 2, float("inf")],
        "meta": {"$date": 999},  # decoy — must survive via $escape
    }
    text = stringify(payload)
    decoded = parse(text)
    assert decoded["user"]["id"] == "u1"
    assert decoded["user"]["avatar"] == b"\x89PNG\r\n"
    assert decoded["scores"][2] == float("inf")
    assert decoded["meta"] == {"$date": 999}


def test_ejson_namespace_mirrors_module() -> None:
    assert EJSON.parse is parse
    assert EJSON.stringify is stringify

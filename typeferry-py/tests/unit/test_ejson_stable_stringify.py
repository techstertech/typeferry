"""Canonical stringify output (PROTOCOL.md §3.3)."""

from __future__ import annotations

from typeferry.ejson.stable_stringify import stable_stringify


def test_empty_object() -> None:
    assert stable_stringify({}) == "{}"


def test_flat_keys_are_sorted() -> None:
    assert stable_stringify({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_nested_keys_sorted_recursively() -> None:
    value = {"z": {"b": 1, "a": 2}, "a": [1, 2, 3]}
    assert stable_stringify(value) == '{"a":[1,2,3],"z":{"a":2,"b":1}}'


def test_arrays_preserve_order() -> None:
    assert stable_stringify([3, 1, 2]) == "[3,1,2]"


def test_compact_separators_by_default() -> None:
    assert stable_stringify({"a": 1, "b": 2}) == '{"a":1,"b":2}'


def test_indent_two_adds_whitespace() -> None:
    out = stable_stringify({"b": 1, "a": 2}, indent=2)
    assert out == '{\n  "a": 2,\n  "b": 1\n}'


def test_unicode_is_not_escaped() -> None:
    assert stable_stringify({"v": "café"}) == '{"v":"café"}'


def test_javascript_index_keys_precede_canonical_utf16_keys() -> None:
    value = {"\ue000": 1, "\U00010000": 2, "10": {"2": 3, "1": 4}, "2": 5}

    assert stable_stringify(value) == '{"2":5,"10":{"1":4,"2":3},"𐀀":2,"":1}'

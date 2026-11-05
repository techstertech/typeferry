"""Deep EJSON equality."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from typeferry.ejson import EJSON, equals


def test_identical_primitives() -> None:
    assert equals(1, 1)
    assert equals("a", "a")
    assert equals(True, True)
    assert equals(None, None)


def test_mismatched_primitives() -> None:
    assert not equals(1, 2)
    assert not equals("a", "b")
    assert not equals(1, "1")


def test_nan_is_equal_to_nan_under_ejson() -> None:
    assert equals(float("nan"), float("nan"))


def test_datetime_equal_by_instant() -> None:
    a = datetime(2024, 1, 1, tzinfo=UTC)
    b = datetime(2024, 1, 1, tzinfo=UTC)
    assert equals(a, b)


def test_datetime_mismatch() -> None:
    a = datetime(2024, 1, 1, tzinfo=UTC)
    b = datetime(2024, 1, 2, tzinfo=UTC)
    assert not equals(a, b)


@pytest.mark.parametrize("millis", [-8_640_000_000_000_000, 8_640_000_000_000_000])
def test_full_range_dates_compare_by_date_value(millis: int) -> None:
    encoded = f'{{"$date":{millis}}}'
    first = EJSON.parse(encoded)
    same = EJSON.parse(encoded)
    different = EJSON.from_json_value({"$date": -millis})

    assert first is not same
    assert equals(first, same)
    assert equals({"dates": [first]}, {"dates": [same]})
    assert not equals(first, different)

    for other in [millis, str(millis), {"$date": millis}, datetime(2024, 1, 1, tzinfo=UTC)]:
        assert not equals(first, other)
        assert not equals(other, first)


def test_binary_equality() -> None:
    assert equals(b"abc", b"abc")
    assert equals(bytearray(b"abc"), b"abc")
    assert not equals(b"abc", b"abd")


def test_list_equality() -> None:
    assert equals([1, 2, 3], [1, 2, 3])
    assert not equals([1, 2], [1, 2, 3])
    assert not equals([1, 2], [2, 1])  # arrays are order-sensitive


def test_dict_equality_default_unordered() -> None:
    assert equals({"a": 1, "b": 2}, {"b": 2, "a": 1})


def test_dict_equality_order_sensitive() -> None:
    assert equals({"a": 1, "b": 2}, {"a": 1, "b": 2}, key_order_sensitive=True)
    assert not equals({"a": 1, "b": 2}, {"b": 2, "a": 1}, key_order_sensitive=True)


def test_dict_length_mismatch() -> None:
    assert not equals({"a": 1}, {"a": 1, "b": 2})


def test_bool_not_equal_to_int() -> None:
    # Python ``True == 1`` is truthy; EJSON equals matches JS ``===``.
    assert not equals(True, 1)
    assert not equals(False, 0)


def test_nested_mixed_values() -> None:
    a = {"items": [1, {"when": datetime(2024, 1, 1, tzinfo=UTC)}]}
    b = {"items": [1, {"when": datetime(2024, 1, 1, tzinfo=UTC)}]}
    assert equals(a, b)

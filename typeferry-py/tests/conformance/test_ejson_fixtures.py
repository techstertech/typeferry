"""Replay every EJSON fixture against the Python encoder/decoder."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.conformance.harness import (
    list_cases,
    load_json,
    register_custom_types,
    rehydrate,
    reset_custom_types,
)
from typeferry.ejson import EJSON


@pytest.fixture(autouse=True)
def _reset_customs() -> None:
    reset_custom_types()
    yield
    reset_custom_types()


def _ids(paths: list[Path]) -> list[str]:
    return [p.stem for p in paths]


CASES = list_cases("ejson")


@pytest.mark.parametrize("case_path", CASES, ids=_ids(CASES))
def test_ejson_fixture_encodes_to_expected_wire_bytes(case_path: Path) -> None:
    fixture = load_json(case_path)
    register_custom_types(fixture.get("register", {}).get("custom_types", []))
    value = rehydrate(fixture["value"])
    assert EJSON.stringify(value, canonical=fixture.get("canonical", False)) == fixture["encoded"], (
        f"{case_path.name}: encoded output diverges from fixture"
    )


@pytest.mark.parametrize("case_path", CASES, ids=_ids(CASES))
def test_ejson_fixture_decodes_and_re_encodes_identically(case_path: Path) -> None:
    fixture = load_json(case_path)
    register_custom_types(fixture.get("register", {}).get("custom_types", []))
    decoded = EJSON.parse(fixture["encoded"])
    re_encoded = EJSON.stringify(decoded, canonical=fixture.get("canonical", False))
    assert re_encoded == fixture["encoded"], (
        f"{case_path.name}: decode/re-encode loop diverges"
    )

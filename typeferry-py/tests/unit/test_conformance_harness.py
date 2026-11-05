"""Prove that negative WebSocket fixture operations can detect a regression."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tests.conformance.test_ws_fixtures import test_ws_fixture as replay_sequence
from typeferry.server.client_node import ClientNode
from typeferry.server.server import Server


def test_websocket_fixture_rejects_an_unexpected_void_response(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken_void_handler(
        _server: Server, node: ClientNode, _method: str, _params: Any,
    ) -> None:
        await node.emit_auth_result(True)

    monkeypatch.setattr(
        "typeferry.server.transports.websocket.handle_rpc_void", broken_void_handler
    )
    operations = [
        {"op": "setup"},
        {"op": "connect"},
        {"op": "expect_server_frame", "frame": {"t": "auth", "authenticated": False}},
        {"op": "send", "frame": {"t": "rpc:void", "method": "broken"}},
        {"op": "expect_no_server_frame", "within_ms": 10},
        {"op": "disconnect"},
    ]
    sequence = tmp_path / "unexpected.seq.ndjson"
    sequence.write_text("\n".join(json.dumps(operation) for operation in operations))

    with pytest.raises(AssertionError, match=r"[Uu]nexpected.*frame"):
        replay_sequence(sequence)

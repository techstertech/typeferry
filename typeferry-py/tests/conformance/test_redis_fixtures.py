"""Replay all shared Redis envelopes without opening a network connection."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast

import pytest
from redis.asyncio import Redis

from tests.conformance.harness import list_cases, load_json
from tests.support.redis import FakeRedis
from typeferry.ejson.presentation import Presentation
from typeferry.server.server import Server
from typeferry.server.server_channel import ServerChannel
from typeferry.server.transports.redis import RedisTransport

CASES = list_cases("redis")


@pytest.mark.parametrize("case_path", CASES, ids=[path.stem for path in CASES])
@pytest.mark.asyncio
async def test_redis_fixture(case_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = load_json(case_path)
    server = Server()
    transport = RedisTransport(server)

    if fixture.get("direction") == "inbound":
        calls: list[dict[str, str | None]] = []

        async def propagate(
            channel: ServerChannel, event: str, payload: str, exclude_uuid: str | None = None,
        ) -> None:
            calls.append({
                "channel": channel.channel_name, "event": event,
                "payload": payload, "exclude_uuid": exclude_uuid,
            })

        class Subscriber:
            async def listen(self) -> AsyncIterator[dict[str, str]]:
                yield {"type": "message", "data": fixture["incoming_payload"]}

        monkeypatch.setattr(ServerChannel, "propagate", propagate)

        await transport._listen(Subscriber())

        assert calls == [fixture["expected_propagate_call"]]
    else:
        publisher = FakeRedis()
        transport._pub = cast(Redis, publisher)
        payload: dict[str, Any] = fixture["publish"]

        await transport.publish(
            payload["event"], payload["channel"], payload["message"], payload.get("exclude_uuid")
        )

        assert len(publisher.published) == 1
        channel, encoded = publisher.published[0]
        assert channel == fixture["expected_redis_channel"]
        assert Presentation.decode(encoded) == fixture["expected_payload_decoded"]

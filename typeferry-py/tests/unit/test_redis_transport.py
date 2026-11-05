"""Redis lifecycle and statistics beyond the shared wire fixtures."""

from __future__ import annotations

import pytest

from tests.support.redis import FakeRedis
from typeferry.server.server import Server, ServerOptions
from typeferry.server.transports.redis import RedisTransport


@pytest.mark.asyncio
async def test_get_stats_aggregates_across_servers() -> None:
    server = Server(ServerOptions())
    transport = RedisTransport(server)
    fake = FakeRedis()
    transport._pub = fake  # type: ignore[assignment]

    fake.sets["typeferry:servers"] = {"srv-a", "srv-b"}
    fake.sets["typeferry:clients:srv-a"] = {"c1", "c2"}
    fake.sets["typeferry:clients:srv-b"] = {"c3"}
    fake.sets["typeferry:users:srv-a"] = {"u1", "u2"}
    fake.sets["typeferry:users:srv-b"] = {"u2", "u3"}

    stats = await transport.get_stats()
    assert stats["clientCount"] == 3
    assert stats["userCount"] == 4
    assert stats["users"] == ["u1", "u2", "u3"]


@pytest.mark.asyncio
async def test_close_cleans_up_server_keys() -> None:
    server = Server(ServerOptions())
    transport = RedisTransport(server)
    fake = FakeRedis()
    transport._pub = fake  # type: ignore[assignment]
    transport._sub = FakeRedis()  # type: ignore[assignment]

    await transport.close()

    assert f"typeferry:clients:{server.uuid}" in fake.deleted_keys
    assert ("typeferry:servers", server.uuid) in fake.srem_calls
    assert transport._pub is None
    assert transport._sub is None

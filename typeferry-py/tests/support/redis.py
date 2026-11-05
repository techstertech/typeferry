"""A recording Redis client for fixture bytes and lifecycle assertions."""

from __future__ import annotations


class FakeRedis:
    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []
        self.deleted_keys: list[str] = []
        self.srem_calls: list[tuple[str, str]] = []
        self.sets: dict[str, set[str]] = {}

    async def publish(self, channel: str, payload: str) -> int:
        self.published.append((channel, payload))
        return 1

    async def delete(self, key: str) -> int:
        self.deleted_keys.append(key)
        return 1

    async def srem(self, key: str, *members: str) -> int:
        self.srem_calls.extend((key, member) for member in members)
        return len(members)

    async def smembers(self, key: str) -> set[str]:
        return self.sets.get(key, set())

    async def scard(self, key: str) -> int:
        return len(self.sets.get(key, set()))

    async def aclose(self) -> None:
        pass

    async def ping(self) -> bool:
        return True

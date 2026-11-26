"""Room naming — ``typeferry:<channel>:<event>`` (PROTOCOL.md §10.1)."""

from __future__ import annotations


def get_room_name(channel: str, event_name: str) -> str:
    return f"typeferry:{len(channel.encode('utf-8'))}:{channel}:{event_name}"

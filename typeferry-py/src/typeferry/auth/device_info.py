"""Device info extraction — port of ``typeferry-ts/src/auth/server/device-info.ts``.

Uses :mod:`ua_parser` to mirror the ``ua-parser-js`` regex database. The
parsed shape (browser name+version, OS name+version, device type) is
wire-equivalent to the TS output.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from typeferry.auth.types import DeviceInfo, DeviceType

if TYPE_CHECKING:
    pass


def parse_device_info(
    headers: dict[str, Any] | None,
    *,
    remote_address: str | None = None,
) -> DeviceInfo:
    """Parse a request's headers and address into a :class:`DeviceInfo`."""

    if headers is None:
        return DeviceInfo(ip=remote_address)

    ua_string = _header(headers, "user-agent")
    if ua_string is not None and len(ua_string) > 512:
        ua_string = ua_string[:512]
    ip = remote_address

    if not ua_string:
        return DeviceInfo(ip=ip)

    try:
        from ua_parser import user_agent_parser
    except ImportError:
        return DeviceInfo(ip=ip, user_agent=ua_string)

    result = user_agent_parser.Parse(ua_string)

    browser = _fmt(
        result.get("user_agent", {}).get("family"),
        result.get("user_agent", {}).get("major"),
    )
    os_name = _fmt(
        result.get("os", {}).get("family"),
        result.get("os", {}).get("major"),
    )
    device_family = result.get("device", {}).get("family", "")

    return DeviceInfo(
        ip=ip,
        user_agent=ua_string,
        browser=browser,
        os=os_name,
        device_type=_map_device_type(device_family),
    )


def _header(headers: dict[str, Any], key: str) -> str | None:
    # Accept both raw and lowercased header names.
    for candidate in (key, key.lower()):
        value = headers.get(candidate)
        if isinstance(value, str) and value:
            return value
    return None


def _fmt(name: Any, version: Any) -> str | None:
    if not name or not isinstance(name, str):
        return None
    if version and isinstance(version, str):
        return f"{name} {version}".strip()
    return str(name)


def _map_device_type(family: str) -> DeviceType:
    """Map the ua-parser device family string to the TS device_type enum.

    ua-parser produces generic families like "iPhone", "iPad",
    "Android" — map these to the same mobile/desktop/tablet/unknown
    categories the TS side exposes.
    """

    if not family or family.lower() == "other":
        return "desktop"
    lowered = family.lower()
    if "iphone" in lowered or "android" in lowered or "mobile" in lowered:
        return "mobile"
    if "ipad" in lowered or "tablet" in lowered:
        return "tablet"
    return "unknown"

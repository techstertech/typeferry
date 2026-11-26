"""Base64 encoder/decoder — port of ``typeferry-ts/src/ejson/base64.ts``.

The encoding alphabet MUST be the standard MIME alphabet
(``A-Za-z0-9+/``). The decoder additionally accepts URL-safe input
(``-`` and ``_``) as described in PROTOCOL.md §3.2.

We intentionally avoid the stdlib ``base64`` module so that behavior
stays byte-identical to the TS port — stdlib is stricter about
padding, URL-safe handling, and whitespace than the TS implementation.
"""

from __future__ import annotations

BASE64_ALPHABET = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
)

_INVALID_CHAR = 0xFF

_LOOKUP = bytearray([_INVALID_CHAR] * 256)
for _i, _c in enumerate(BASE64_ALPHABET):
    _LOOKUP[ord(_c)] = _i
# Accept URL-safe input as well.
_LOOKUP[ord("-")] = 62
_LOOKUP[ord("_")] = 63


def _read_char(value: str, index: int) -> int:
    code = ord(value[index])
    if code >= 256:
        raise ValueError("Invalid base64 character")
    decoded = _LOOKUP[code]
    if decoded == _INVALID_CHAR:
        raise ValueError("Invalid base64 character")
    return decoded


def encode_base64(data: bytes) -> str:
    """Encode ``bytes`` as base64 (standard alphabet, ``=`` padded)."""

    out: list[str] = []
    length = len(data)

    for index in range(0, length, 3):
        byte0 = data[index] if index < length else 0
        byte1 = data[index + 1] if index + 1 < length else 0
        byte2 = data[index + 2] if index + 2 < length else 0
        chunk = (byte0 << 16) | (byte1 << 8) | byte2
        remaining = length - index

        out.append(BASE64_ALPHABET[(chunk >> 18) & 63])
        out.append(BASE64_ALPHABET[(chunk >> 12) & 63])
        out.append(BASE64_ALPHABET[(chunk >> 6) & 63] if remaining > 1 else "=")
        out.append(BASE64_ALPHABET[chunk & 63] if remaining > 2 else "=")

    return "".join(out)


def decode_base64(value: str) -> bytes:
    """Decode a base64 string. Accepts both standard and URL-safe alphabets."""

    if len(value) % 4 != 0:
        raise ValueError("Invalid base64 string length")

    pad_index = value.find("=")
    if pad_index != -1:
        pad_count = len(value) - pad_index
        if pad_count not in (1, 2) or value[pad_index:] != "=" * pad_count:
            raise ValueError("Invalid base64 padding")
    valid_length = len(value) if pad_index == -1 else pad_index
    placeholder_length = 0 if valid_length == len(value) else 4 - (valid_length % 4)

    output_length = (valid_length + placeholder_length) * 3 // 4 - placeholder_length
    out = bytearray(output_length)

    byte_index = 0
    end = valid_length - 4 if placeholder_length > 0 else valid_length
    index = 0
    while index < end:
        chunk = (
            (_read_char(value, index) << 18)
            | (_read_char(value, index + 1) << 12)
            | (_read_char(value, index + 2) << 6)
            | _read_char(value, index + 3)
        )
        out[byte_index] = (chunk >> 16) & 0xFF
        out[byte_index + 1] = (chunk >> 8) & 0xFF
        out[byte_index + 2] = chunk & 0xFF
        byte_index += 3
        index += 4

    if placeholder_length == 2:
        b0 = _read_char(value, index)
        b1 = _read_char(value, index + 1)
        if (b1 & 0x0F) != 0:
            raise ValueError("Invalid base64 padding bits")
        chunk = (b0 << 2) | (b1 >> 4)
        out[byte_index] = chunk & 0xFF
    elif placeholder_length == 1:
        b0 = _read_char(value, index)
        b1 = _read_char(value, index + 1)
        b2 = _read_char(value, index + 2)
        if (b2 & 0x03) != 0:
            raise ValueError("Invalid base64 padding bits")
        chunk = (b0 << 10) | (b1 << 4) | (b2 >> 2)
        out[byte_index] = (chunk >> 8) & 0xFF
        out[byte_index + 1] = chunk & 0xFF

    return bytes(out)

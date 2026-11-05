"""Shared WebSocket dispatch helpers — port of
``typeferry-ts/src/server/transports/ws-shared.ts``.

Common logic between alternate ASGI transports (Starlette, direct
ASGI, etc.). See PROTOCOL.md §2.2.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import re
import secrets
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, NoReturn

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import ServerEvents
from typeferry.protocol.messages import MessageType
from typeferry.server._authentication import authentication_succeeded
from typeferry.server.socket import SocketState
from typeferry.utils.errors import Errors, PublicError, SchemaValidationError

if TYPE_CHECKING:
    from typeferry.server.client_node import ClientNode
    from typeferry.server.server import Server


AUTH_TIMEOUT_MS = 5000
MAX_UUID_LENGTH = 64
MAX_META_SIZE = 10_000
PING_INTERVAL_MS = 25_000

# Pre-encoded ping frame — avoids re-encoding on every tick.
PING_PAYLOAD = Presentation.encode({"t": MessageType.PING.value})


@dataclass(frozen=True, slots=True)
class WebSocketHandshake:
    """Framework-neutral metadata for application-owned authentication."""

    path: str
    headers: Mapping[str, str]
    query: Mapping[str, str]


type WebSocketHandshakeAuthenticator = Callable[
    [ClientNode, WebSocketHandshake], Any | Awaitable[Any]
]


_UUID_SANITIZE = re.compile(r"[^a-zA-Z0-9-]")

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# RPC handling
# ---------------------------------------------------------------------------


async def handle_rpc(
    server: Server,
    node: ClientNode,
    rpc_id: str,
    method: str,
    params: Any = None,
) -> None:
    """Handle an RPC call and send the correlated response."""

    method_instance = server.get_method(method)
    if method_instance is None:
        await send_response(node, rpc_id, error=Errors.METHOD_NOT_FOUND.value)
        return
    if method_instance.is_protected and not node.authenticated:
        await send_response(node, rpc_id, error=Errors.METHOD_FORBIDDEN.value)
        return

    try:
        result = await method_instance.exec(params, node)
    except PublicError as err:
        await send_response(node, rpc_id, error=err.message)
        return
    except SchemaValidationError as err:
        server.emit_server_event(
            ServerEvents.METHOD_ERROR,
            {"error": err, "method": method, "params": params, "user_id": node.user_id},
        )
        await send_response(node, rpc_id, error=err.message, errors=err.errors)
        return
    except Exception as err:
        _log.exception("TypeFerry RPC method %s raised", method)
        server.emit_server_event(
            ServerEvents.METHOD_ERROR,
            {"error": err, "method": method, "params": params, "user_id": node.user_id},
        )
        await send_response(node, rpc_id, error=Errors.INTERNAL_ERROR.value)
        return

    await send_response(node, rpc_id, result=result)


async def handle_rpc_void(
    server: Server,
    node: ClientNode,
    method: str,
    params: Any = None,
) -> None:
    """Handle a fire-and-forget RPC; no response frame EVER leaves the server."""

    method_instance = server.get_method(method)
    if method_instance is None:
        _log.warning("Method not found for void call: %s", method)
        return
    if method_instance.is_protected and not node.authenticated:
        _log.warning("Method forbidden for void call: %s", method)
        return

    try:
        await method_instance.exec(params, node)
    except Exception as err:
        _log.exception("TypeFerry void method %s raised", method)
        server.emit_server_event(
            ServerEvents.METHOD_ERROR,
            {"error": err, "method": method, "params": params, "user_id": node.user_id},
        )


_UNSET: Any = object()


async def send_response(
    node: ClientNode,
    rpc_id: str,
    *,
    result: Any = _UNSET,
    error: str | None = None,
    errors: Any = None,
) -> None:
    """Send a correlated ``rpc:res`` frame on ``node.socket``."""

    if node.socket is None or node.socket.readyState != SocketState.OPEN:
        return

    payload: dict[str, Any] = {"t": MessageType.RPC_RESPONSE.value, "id": rpc_id}
    if error is not None:
        payload["error"] = error
        if errors is not None:
            payload["errors"] = errors
    elif result is not _UNSET:
        payload["result"] = result

    encoded = Presentation.encode(payload)
    import inspect as _inspect

    outcome = node.socket.send(encoded)
    if _inspect.isawaitable(outcome):
        await outcome


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


async def authenticate_node(
    server: Server,
    node: ClientNode,
    token: str | None,
    handshake_authenticator: WebSocketHandshakeAuthenticator | None = None,
    handshake: WebSocketHandshake | None = None,
) -> None:
    """Race the auth callback against :data:`AUTH_TIMEOUT_MS`.

    If auth is disabled or no token is provided, immediately emit
    ``{t:"auth", authenticated: false}`` matching PROTOCOL.md §2.2.2.
    """

    node.authenticated = False
    node.set_context(None)

    if handshake_authenticator is None and (not server.is_auth_enabled or not token):
        await node.emit_auth_result(False)
        return

    async def _run_auth() -> Any:
        outcome: Any

        if handshake_authenticator is not None:
            metadata = handshake or WebSocketHandshake(path="", headers={}, query={})
            if inspect.iscoroutinefunction(handshake_authenticator):
                outcome = handshake_authenticator(node, metadata)
            else:
                outcome = await asyncio.to_thread(handshake_authenticator, node, metadata)
        else:
            fn = server.auth
            if fn is None:
                return False
            if inspect.iscoroutinefunction(fn):
                outcome = fn(node, {"token": token})
            else:
                outcome = await asyncio.to_thread(fn, node, {"token": token})
        if inspect.isawaitable(outcome):
            return await outcome
        return outcome

    task = asyncio.create_task(_run_auth())
    task.add_done_callback(_discard_auth_task_error)

    try:
        completed, _ = await asyncio.wait({task}, timeout=AUTH_TIMEOUT_MS / 1000)
        if not completed:
            # Waiting for cancellation would let a callback that catches it
            # exceed the deadline or return a late authenticated result.
            task.cancel()
            result = None
        else:
            result = task.result()
    except asyncio.CancelledError:
        task.cancel()
        raise
    except Exception:
        node.authenticated = False
        node.set_context(None)
        if node.socket is not None and node.socket.readyState == SocketState.OPEN:
            await node.emit_auth_result(False)
        return

    if node.socket is None or node.socket.readyState != SocketState.OPEN:
        return

    node.authenticated = authentication_succeeded(result)
    node.set_context(result if node.authenticated and isinstance(result, dict) else None)

    if node.authenticated:
        server.emit_server_event(ServerEvents.AUTHENTICATION, node)

    await node.emit_auth_result(node.authenticated)


def _discard_auth_task_error(task: asyncio.Task[Any]) -> None:
    """Retrieve a detached callback's error after its authentication deadline."""

    if not task.cancelled():
        task.exception()


# ---------------------------------------------------------------------------
# Query parameter validators
# ---------------------------------------------------------------------------


def validate_uuid(uuid: Any) -> str:
    """Keep valid client UUIDs unchanged; replace invalid identities entirely."""

    if (
        not isinstance(uuid, str) or not uuid or len(uuid) > MAX_UUID_LENGTH
        or _UUID_SANITIZE.search(uuid) is not None
    ):
        return secrets.token_hex(16)
    return uuid


def validate_meta(meta: Any) -> dict[str, Any]:
    if not isinstance(meta, dict) or isinstance(meta, list):
        return {}
    try:
        if len(json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_META_SIZE:
            _log.warning("Meta object too large, ignoring")
            return {}
    except (TypeError, ValueError):
        return {}
    return meta


def parse_meta(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        if len(raw.encode("utf-8")) > MAX_META_SIZE:
            return {}
        decoded = json.loads(raw, parse_constant=_reject_json_constant)
        return decoded if isinstance(decoded, dict) else {}
    except (ValueError, TypeError, RecursionError):
        return {}


def _reject_json_constant(value: str) -> NoReturn:
    """JSON.parse rejects literal NaN and Infinity tokens accepted by Python."""

    raise ValueError(f"Invalid JSON number: {value}")

"""HTTP transport for the TypeFerry server — port of
``typeferry-ts/src/server/transports/http-transport.ts`` and
``bun-hono-transport.ts``.

Implements PROTOCOL.md §2.1:

* ``POST /__h`` accepting ``text/plain`` EJSON bodies
* request envelope ``{context, payload?}``
* response envelope ``{type: "result", uuid?, method, result}`` or
  ``{type: "error", message, uuid?, errors?, method?}``
* ``x-client-id`` / ``x-api-key`` (Bearer-prefix stripped) header semantics
* void calls suppress error bodies and retain successful result bodies
* CORS with allow-credentials when origins are provided
* sliding-window rate limiter, 120 req / 60 s by default

The ASGI app is built with Starlette so consumers can mount it at any
path or combine it with other Starlette routes via
``app.router.routes``.
"""

from __future__ import annotations

import inspect
from typing import TYPE_CHECKING, Any

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import (
    CLIENT_ID_HEADER_KEY,
    HTTP_ENDPOINT_PATH,
    TOKEN_HEADER_KEY,
)
from typeferry.protocol.messages import PayloadType
from typeferry.server._authentication import authentication_succeeded
from typeferry.server.client_node import ClientNode
from typeferry.server.transports._origins import origin_allowed
from typeferry.server.transports.rate_limit import RateLimit, SlidingWindowLimiter
from typeferry.utils.errors import Errors, PublicError, SchemaValidationError

if TYPE_CHECKING:
    from typeferry.server.server import Server


class HttpTransport:
    """Starlette-backed HTTP transport bound to a :class:`Server`.

    ``origins=None`` permits any origin; an empty list denies named origins.
    With an allowlist, ``allow_originless=True`` admits requests whose Origin
    header is absent. This option never permits a mismatching named origin.
    WebSocket originless admission is configured independently.
    """

    server: Server
    app: Starlette
    origins: list[str] | None
    rate_limit: RateLimit | None
    limiter: SlidingWindowLimiter | None

    def __init__(
        self,
        server: Server,
        origins: list[str] | None = None,
        rate_limit: RateLimit | bool | None = True,
        *,
        allow_originless: bool = False,
    ) -> None:
        self.server = server
        self.origins = None if origins is None else list(origins)
        self.allow_originless = allow_originless

        if rate_limit is True:
            self.rate_limit = RateLimit()
        elif isinstance(rate_limit, RateLimit):
            self.rate_limit = rate_limit
        else:
            self.rate_limit = None

        self.limiter = (
            SlidingWindowLimiter(self.rate_limit) if self.rate_limit is not None else None
        )

        middleware: list[Middleware] = []
        if origins is not None:
            middleware.append(
                Middleware(
                    CORSMiddleware,
                    allow_origins=origins,
                    allow_credentials=True,
                    allow_methods=["POST", "OPTIONS"],
                    allow_headers=[
                        CLIENT_ID_HEADER_KEY,
                        TOKEN_HEADER_KEY,
                        "content-type",
                        "cookie",
                    ],
                )
            )

        self.app = Starlette(
            routes=[Route(HTTP_ENDPOINT_PATH, self._handle, methods=["POST"])],
            middleware=middleware,
        )

    # ------------------------------------------------------------------
    # Request dispatch
    # ------------------------------------------------------------------

    async def _handle(self, request: Request) -> Response:
        if not origin_allowed(
            request.headers.get("origin"), self.origins,
            allow_originless=self.allow_originless,
        ):
            return Response("", status_code=403)

        rate_headers: dict[str, str] = {}
        client_address = _client_ip(request)

        # Rate limit first — clients that flood with malformed bodies
        # still cost parsing work, which the limiter protects against.
        if self.limiter is not None:
            allowed, remaining, reset_ms = self.limiter.try_consume(client_address)
            rate_headers = _rate_limit_headers(self, remaining, reset_ms)
            if not allowed:
                return Response("", status_code=429, headers=rate_headers)

        response = await self._dispatch(request, client_address)
        response.headers.update(rate_headers)
        return response

    async def _dispatch(self, request: Request, client_address: str) -> Response:
        request_body = (await request.body()).decode("utf-8", errors="replace")
        transport = _parse_transport(request_body)

        if transport is None or transport.get("payload") is None:
            return self._error(Errors.INVALID_REQUEST.value, None, None, None)

        payload: dict[str, Any] = transport["payload"] or {}
        uuid = payload.get("uuid") if isinstance(payload.get("uuid"), str) else None
        is_void = bool(payload.get("void"))

        method_name = payload.get("method")
        if not isinstance(method_name, str) or not method_name:
            # METHOD_NOT_FOUND: TS envelope carries method, no uuid.
            return self._error(Errors.METHOD_NOT_FOUND.value, None, method_name, is_void)

        method = self.server.get_method(method_name)
        if method is None:
            return self._error(Errors.METHOD_NOT_FOUND.value, None, method_name, is_void)

        try:
            node = await self._build_client_node(request, transport.get("context"), client_address)

            if method.is_protected and not node.authenticated:
                # METHOD_FORBIDDEN: TS envelope carries method, no uuid.
                return self._error(Errors.METHOD_FORBIDDEN.value, None, method_name, is_void)

            result = await method.exec(payload.get("params"), node)
        except PublicError as err:
            # PublicError: TS envelope carries uuid, no method.
            return self._error(err.message, uuid, None, is_void)
        except SchemaValidationError as err:
            if is_void:
                return _empty_200()
            # SchemaValidationError: TS envelope carries uuid + errors, no method.
            return self._error(
                err.message, uuid, None, is_void, errors=err.errors
            )
        except Exception:
            # Unknown errors MUST NOT leak server internals; log and emit
            # INTERNAL_ERROR per PROTOCOL.md §9. TS envelope carries uuid only.
            import logging

            logging.getLogger(__name__).exception(
                "TypeFerry method %s raised", method_name
            )
            return self._error(
                Errors.INTERNAL_ERROR.value, uuid, None, is_void
            )

        # Per PROTOCOL.md §2.1.3 / TS parity: void suppresses error
        # responses, NOT success responses. The success body is always
        # returned (callers that truly want silence should use the WS
        # transport's rpc:void, which IS fully silent).
        response_body: dict[str, Any] = {
            "type": PayloadType.RESULT.value,
            "method": method_name,
            "result": result,
        }
        if uuid is not None:
            response_body["uuid"] = uuid
        return _ejson_response(
            response_body,
            headers=self._drain_response_headers(node),
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _build_client_node(
        self, request: Request, context: Any, client_address: str
    ) -> ClientNode:
        raw_headers = {k.lower(): v for k, v in request.headers.items()}
        node = ClientNode(self.server, headers=raw_headers)
        node.remote_address = client_address

        client_uuid = raw_headers.get(CLIENT_ID_HEADER_KEY)
        if isinstance(client_uuid, str) and client_uuid:
            node.set_id(client_uuid)

        # Pending response headers (e.g. Set-Cookie) are queued on a
        # transport-scoped attribute drained after method execution.
        setattr(node, "_pending_response_headers", [])  # noqa: B010

        ctx_payload: dict[str, Any] = dict(context) if isinstance(context, dict) else {}
        token = raw_headers.get(TOKEN_HEADER_KEY)
        if isinstance(token, str) and token and token != "undefined":
            cleaned = token.removeprefix("Bearer ")
            ctx_payload["token"] = cleaned

        if self.server.auth is None:
            return node

        result = self.server.auth(node, ctx_payload)
        if inspect.isawaitable(result):
            result = await result

        node.authenticated = authentication_succeeded(result)
        node.set_context(result if node.authenticated and isinstance(result, dict) else None)
        return node

    def _drain_response_headers(self, node: ClientNode) -> list[tuple[str, str]]:
        pending: list[tuple[str, str]] = getattr(
            node, "_pending_response_headers", []
        )
        return list(pending)

    def _error(
        self,
        message: str,
        uuid: str | None,
        method: str | None,
        is_void: bool | None,
        *,
        errors: Any = None,
    ) -> Response:
        if is_void:
            return _empty_200()
        body: dict[str, Any] = {"type": PayloadType.ERROR.value, "message": message}
        if uuid is not None:
            body["uuid"] = uuid
        if method:
            body["method"] = method
        if errors is not None:
            body["errors"] = errors
        return _ejson_response(body)

    async def close(self) -> None:
        # Starlette apps do not own their own lifecycle; the ASGI server
        # (uvicorn) manages sockets. Nothing to close here — hook exists
        # for parity with the TS transports.
        return None


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _parse_transport(body: str) -> dict[str, Any] | None:
    if not body:
        return None
    try:
        decoded = Presentation.decode(body)
    except Exception:
        return None
    if not isinstance(decoded, dict):
        return None
    return decoded


def _ejson_response(
    body: dict[str, Any], *, headers: list[tuple[str, str]] | None = None
) -> Response:
    encoded = Presentation.encode(body)
    response = Response(
        encoded,
        status_code=200,
        media_type="text/plain; charset=utf-8",
    )
    if headers:
        for name, value in headers:
            response.headers.append(name, value)
    return response


def _empty_200() -> Response:
    return Response("", status_code=200, media_type="text/plain; charset=utf-8")


def _client_ip(request: Request) -> str:
    # Trusted proxy rewriting belongs to the ASGI host. Header values must not
    # override the address that host supplied for quotas or request metadata.
    if request.client is not None:
        return request.client.host
    return "unknown"


def _rate_limit_headers(
    transport: HttpTransport, remaining: int, reset_ms: int
) -> dict[str, str]:
    if transport.rate_limit is None:
        return {}
    return {
        "RateLimit-Limit": str(transport.rate_limit.max),
        "RateLimit-Remaining": str(remaining),
        "RateLimit-Reset": str((max(0, reset_ms) + 999) // 1000),
    }

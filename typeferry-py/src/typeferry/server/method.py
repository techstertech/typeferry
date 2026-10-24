"""RPC method primitive — port of ``typeferry-ts/src/server/method.ts``.

Python handler signature differs from TS: instead of binding
``this = ClientNode`` the handler receives ``(node, params)``
explicitly. Everything else — schema validation, middleware chain,
cache-key computation via ``EJSON.stringify``, ambient context via
``TypeFerryContext.run`` — matches the TS runtime behavior.
"""

from __future__ import annotations

import inspect
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from typeferry.ejson.parse_stringify import stringify
from typeferry.ejson.presentation import Presentation
from typeferry.protocol.constants import ServerEvents
from typeferry.server.context import TypeFerryContext
from typeferry.server.schema import SchemaValidator
from typeferry.utils.errors import Errors, SchemaValidationError

if TYPE_CHECKING:
    from typeferry.server.client_node import ClientNode
    from typeferry.server.server import Server


MethodFunction = Callable[..., Any]
Middleware = Callable[..., Any]


DEFAULT_MAX_AGE_MS = 60_000


@dataclass(slots=True)
class MethodOptions:
    cache: bool = False
    max_age: int = DEFAULT_MAX_AGE_MS
    protected: bool = False
    middleware: list[Middleware] = field(default_factory=list)
    schema: SchemaValidator | None = None


async def _call_possibly_async(fn: Callable[..., Any], *args: Any) -> Any:
    result = fn(*args)
    if inspect.isawaitable(result):
        return await result
    return result


class Method:
    """Registered RPC method with validation, middleware, cache, and timing.

    Execution flow matches PROTOCOL.md sections 6.3 to 6.7:

    1. If a schema is attached, ``safe_parse`` the params and throw
       :class:`SchemaValidationError` on failure. Params normalize to
       ``{}`` when None.
    2. Enter :func:`TypeFerryContext.run` so handlers see the ambient
       execution context.
    3. Run the middleware chain, each step receiving ``(node, params)``
       and returning transformed params.
    4. Invoke the handler with ``(node, final_params)``.
    5. Emit :class:`ServerEvents.METHOD_EXECUTION` with timing.
    """

    uuid: str
    name: str
    server: Server
    fn: MethodFunction
    is_protected: bool
    middleware: list[Middleware]
    schema: SchemaValidator | None

    def __init__(
        self,
        server: Server,
        name: str,
        fn: MethodFunction,
        opts: MethodOptions | None = None,
    ) -> None:
        opts = opts or MethodOptions()
        self.uuid = Presentation.uuid()
        self.name = name
        self.server = server
        self.is_protected = bool(opts.protected)
        self.middleware = list(opts.middleware)
        self.schema = opts.schema

        self.fn = (
            _memoize(fn, max_age_ms=opts.max_age) if opts.cache else fn
        )

    async def run_middleware(
        self, params: Any, node: ClientNode | None
    ) -> Any:
        """Pipe params through middleware; each callable receives ``(node, params)``."""

        if not self.middleware:
            return params
        buffer = params
        for step in self.middleware:
            buffer = await _call_possibly_async(step, node, buffer)
        return buffer

    async def exec(self, params: Any, node: ClientNode | None = None) -> Any:
        """Execute the method. See class docstring for the flow."""

        start = time.perf_counter()

        clean_params = params

        if self.schema is not None:
            to_validate = params if params is not None else {}
            result = self.schema.safe_parse(to_validate)
            if not result.success:
                error_messages = [issue.format() for issue in result.issues]
                raise SchemaValidationError(
                    f"{Errors.INVALID_PARAMS.value}: {', '.join(error_messages)}",
                    error_messages,
                )
            clean_params = result.data

        caller_context = node.context if node is not None else None
        with TypeFerryContext.run(Presentation.uuid(), caller_context):
            final_params = await self.run_middleware(clean_params, node)
            returned = await _call_possibly_async(self.fn, node, final_params)

        elapsed_ms = (time.perf_counter() - start) * 1000

        self.server.emit_server_event(
            ServerEvents.METHOD_EXECUTION,
            {
                "method": self.name,
                "time": elapsed_ms,
                "params": clean_params,
                "result": returned,
            },
        )

        return returned


def _memoize(
    fn: MethodFunction, *, max_age_ms: int
) -> MethodFunction:
    """Cache-key algorithm MUST match TS: ``EJSON.stringify(first_arg)``
    with non-canonical output (PROTOCOL.md §6.3).

    Authenticated calls bypass both lookup and storage so handler-owned
    permission checks run on every invocation. Anonymous handlers must return
    results independent of caller context.

    The Python handler receives ``(node, params)``; the cache key is
    computed from ``params`` (the first RPC argument) so it aligns with
    the TS ``args[0]`` convention.
    """

    cache: dict[str, tuple[Any, float]] = {}

    async def memoized(node: ClientNode | None, params: Any) -> Any:
        if node is not None and node.authenticated:
            return await _call_possibly_async(fn, node, params)

        key = stringify(params)
        now_ms = time.monotonic() * 1000
        hit = cache.get(key)
        if hit is not None and (now_ms - hit[1]) < max_age_ms:
            return hit[0]
        result = await _call_possibly_async(fn, node, params)
        cache[key] = (result, now_ms)
        return result

    return memoized

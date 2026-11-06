# typeferry-py

The Python implementation of TypeFerry provides a transport-agnostic server runtime, decorators, EJSON, protocol messages, HTTP/WebSocket/Redis integrations, authentication helpers, and shared conformance support. It does not provide a browser client or UI adapter.

> [!IMPORTANT]
> `typeferry-py` is not published to PyPI. Install it only from this repository while package identities remain disabled; see [`RELEASING.md`](../RELEASING.md).

## Local installation

Python 3.12 or newer is required. From the repository root:

```sh
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -e './typeferry-py[all]'
```

Use only the extras an application needs: `http`, `ws`, `redis`, `auth`, or `schema`. The `all` extra is convenient for evaluating the complete server surface.

## Register methods

```python
# app.py
from typing import Any

from typeferry.decorators import method, namespace, protected, register
from typeferry.server import ClientNode, Server, ServerOptions


@namespace("greeting")
class GreetingMethods:
    @method
    async def hello(
        self,
        node: ClientNode,
        params: dict[str, Any],
    ) -> dict[str, str]:
        return {"message": f"Hello, {params['name']}"}

    @protected
    @method
    async def profile(
        self,
        node: ClientNode,
        _params: None,
    ) -> dict[str, Any]:
        return {"context": node.context}


server = Server(ServerOptions(host="127.0.0.1", port=8002))
register(server, GreetingMethods())
```

The registered wire names are `greeting.hello` and `greeting.profile`. Add `@schema(...)`, `@cached(...)`, and `@use(...)` where runtime validation, caching, or middleware is required. Python annotations do not validate untrusted network data by themselves.

EJSON decodes ordinary dates as UTC `datetime` values. Valid JavaScript dates
outside Python's year 1–9999 range use an opaque internal value. Pass that value
back to `EJSON.stringify` or `to_json_value` to preserve the exact milliseconds.
Do not assume every decoded date supports `datetime` methods. Object encoding
follows JavaScript index-key order; canonical non-index keys use UTF-16 order.

## Attach transports

Unlike the TypeScript server, the Python `Server` does not open a listener. An application attaches the HTTP and/or WebSocket adapters from `typeferry.server.transports` to its ASGI host. Redis is optional and propagates events among instances. Review the transport tests and [`scripts/conformance_server.py`](scripts/conformance_server.py) for executable assembly against the current APIs.

Both transports accept `origins=None` for unrestricted admission. An explicit
empty list rejects all named origins. A configured allowlist rejects missing
and mismatching `Origin` headers before authentication or dispatch. Set
`allow_originless=True` separately on `HttpTransport` or `WebSocketTransport`
only for trusted callers without an `Origin` header. This option does not admit
a mismatching named origin.

Enabled HTTP rate limits add `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset` to every admitted response, including RPC errors and HTTP 429.
Reset values are relative seconds rounded up from the current quota window.

HTTP quotas and `ClientNode.remote_address` use the ASGI-provided client address.
The adapter ignores forwarding headers when resolving that address. Configure
trusted proxy rewriting in the ASGI host before mounting the transport. Without
that configuration, clients behind one proxy share the proxy's quota. Inactive
quota buckets expire lazily when another request arrives.

Application-owned WebSocket handshake authentication can be configured without copying credentials into a URL:

```python
from typeferry.server.transports.websocket import WebSocketTransport


async def authenticate_handshake(node, handshake):
    return await application_session_context(handshake.headers)


transport = WebSocketTransport(
    server,
    handshake_authenticator=authenticate_handshake,
)
```

The callback takes precedence over query-token auth. Rejection, exceptions, and
the five-second timeout fail closed. Late results cannot authenticate the
connection. Authentication uses JavaScript truthiness: empty objects and arrays
succeed; null, false, zero, NaN, and empty strings fail. Keep credentials out of
logs and URLs. Perform resource authorization inside protected methods.

## Development and verification

```sh
cd typeferry-py
python -m pip install -e '.[dev,all]'
ruff check .
mypy
python -m pytest
```

## Boundaries and references

- Server-side protocol parity is the goal; use the TypeScript package for browser or React clients.
- [`PROTOCOL.md`](../PROTOCOL.md) is the normative wire contract.
- [Python runtime architecture](../docs/architecture/python-runtime.md) explains package internals.
- [Shared conformance](../docs/conformance/README.md) covers interoperability.
- The [implementation plan](../docs/plans/2026-04-20-python-server-port-and-monorepo.md) is historical, not the current API contract.

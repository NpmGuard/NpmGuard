"""Request id: minted at the edge (or taken from incoming x-request-id),
bound to all log lines, returned in the response. Pure ASGI middleware —
BaseHTTPMiddleware is avoided deliberately (cancellation/streaming issues)."""

import secrets
from contextvars import ContextVar

import structlog

HEADER = b"x-request-id"

_request_id: ContextVar[str | None] = ContextVar("kit_request_id", default=None)


def get_request_id() -> str | None:
    return _request_id.get()


def _mint() -> str:
    return f"req_{secrets.token_hex(8)}"


class RequestIdMiddleware:
    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = dict(scope.get("headers") or []).get(HEADER)
        request_id = incoming.decode("latin-1") if incoming else _mint()
        _request_id.set(request_id)
        structlog.contextvars.bind_contextvars(request_id=request_id)

        async def send_with_header(message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers") or [])
                headers.append((HEADER, request_id.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_header)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")

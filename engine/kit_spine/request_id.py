"""Request id: minted at the edge (or taken from incoming x-request-id),
bound to all log lines, returned in the response. Pure ASGI middleware —
BaseHTTPMiddleware is avoided deliberately (cancellation/streaming issues)."""

import json
import secrets
from contextvars import ContextVar

import structlog

HEADER = b"x-request-id"

log = structlog.get_logger("kit.errors")

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

        response_started = False

        async def send_with_header(message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                headers = list(message.get("headers") or [])
                headers.append((HEADER, request_id.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_header)
        except Exception:
            # the catch-all Exception handler lives in ServerErrorMiddleware,
            # OUTSIDE this middleware — by the time it would run, the id is
            # unbound and the header wrapper bypassed. Handle the 500 here so
            # the log line carries the bound id and the response the header.
            log.exception("unhandled error", path=scope.get("path"))
            if response_started:
                raise  # a response is underway — nothing coherent left to send
            from kit_spine.errors import Internal

            body = json.dumps(Internal("internal error").to_body()).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 500,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (HEADER, request_id.encode("latin-1")),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
        finally:
            structlog.contextvars.unbind_contextvars("request_id")

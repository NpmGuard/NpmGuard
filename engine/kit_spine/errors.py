"""One error taxonomy for everything that crosses the wire.

`code` is stable forever and is what clients branch on; `retryable` answers
the only question every caller has. Core codes live here; modules claim
their own ranges above KIT-1000.
"""

from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

log = structlog.get_logger("kit.errors")


class KitError(Exception):
    code = "KIT-0500"
    http_status = 500
    retryable = False

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details

    def to_body(self) -> dict[str, Any]:
        error: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details is not None:
            error["details"] = self.details
        return {"error": error}


class ValidationFailed(KitError):
    code = "KIT-0400"
    http_status = 400


class Unauthorized(KitError):
    code = "KIT-0401"
    http_status = 401


class Forbidden(KitError):
    code = "KIT-0403"
    http_status = 403


class NotFound(KitError):
    code = "KIT-0404"
    http_status = 404


class Conflict(KitError):
    code = "KIT-0409"
    http_status = 409


class Internal(KitError):
    code = "KIT-0500"
    http_status = 500


class Unavailable(KitError):
    code = "KIT-0503"
    http_status = 503
    retryable = True


class UpstreamTimeout(KitError):
    code = "KIT-0504"
    http_status = 504
    retryable = True


def register_error_handlers(app: FastAPI) -> None:
    """Map every failure to the contract error shape. Unhandled exceptions
    are logged with full detail but cross the wire as an opaque KIT-0500."""

    @app.exception_handler(KitError)
    async def kit_error_handler(request: Request, exc: KitError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content=exc.to_body())

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        # jsonable_encoder is load-bearing: pydantic embeds the raw ValueError
        # instance in ctx for custom-validator failures, and JSONResponse
        # would raise on it — turning a 400 into an opaque 500
        details = {"errors": jsonable_encoder(exc.errors())}
        err = ValidationFailed("request validation failed", details=details)
        return JSONResponse(status_code=err.http_status, content=err.to_body())

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", path=request.url.path)
        return JSONResponse(status_code=500, content=Internal("internal error").to_body())

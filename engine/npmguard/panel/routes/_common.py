"""Shared helpers for the panel routers.

The panel routers are plain FastAPI handlers returning ``JSONResponse`` (the
same style as ``npmguard.api``), so gating / auth are helper functions rather
than dependencies — a dependency can't emit the exact ``{"error": ...}`` 503
body the frontend keys on without going through the error-handler machinery.

Every panel route is gated on ``settings.github_app_enabled``: when the App is
not configured the engine runs exactly as before and every panel route returns
503, so the panel is invisible unless deliberately turned on.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import Request
from fastapi.responses import JSONResponse

from npmguard.panel.sessions import SESSION_COOKIE

if TYPE_CHECKING:
    from npmguard.api import Runtime

PANEL_DISABLED_BODY = {"error": "GitHub App is not configured on this server"}


def runtime_of(request: Request) -> Runtime:
    return request.app.state.runtime


def panel_disabled_response() -> JSONResponse:
    return JSONResponse(PANEL_DISABLED_BODY, status_code=503)


def require_enabled(runtime: Runtime) -> JSONResponse | None:
    """503 when the App is not configured, else ``None`` (proceed)."""
    if not runtime.settings.github_app_enabled:
        return panel_disabled_response()
    return None


def secure_cookies(runtime: Runtime) -> bool:
    """Cookies are ``Secure`` only when the panel is served over https."""
    return runtime.settings.panel_base_url.startswith("https")


async def current_user(request: Request, runtime: Runtime) -> dict[str, Any] | None:
    """Resolve the ``ng_session`` cookie to the ``SessionUser`` projection, or
    ``None`` when there is no valid session."""
    token = request.cookies.get(SESSION_COOKIE)
    user_id = await runtime.panel_sessions.get(token)
    if user_id is None:
        return None
    return await runtime.gh_users.get(user_id)

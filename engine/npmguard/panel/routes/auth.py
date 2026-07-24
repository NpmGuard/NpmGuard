"""GitHub sign-in: OAuth web flow + opaque DB sessions.

A port of the TS engine's ``routes/auth.ts``. OAuth on top of the GitHub App
establishes WHO the signed-in user is; repo access comes from the App
installations they can see (``routes/panel.ts``). Everything is gated on
``settings.github_app_enabled`` — 503 when the App is not configured.

Tokens are AES-GCM encrypted at rest (``GhUserStore``); the session is an
opaque 32-byte-hex cookie (``PanelSessionStore``).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from typing import Any

import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response

from npmguard.panel.github.client import _expires_at_from_ttl
from npmguard.panel.routes._common import (
    current_user,
    require_enabled,
    runtime_of,
    secure_cookies,
)
from npmguard.panel.sessions import SESSION_COOKIE, SESSION_TTL

log = structlog.get_logger("npmguard.panel.auth")

router = APIRouter()

STATE_COOKIE = "ng_oauth_state"
STATE_TTL_SECONDS = 600


def _select_email(profile_email: str | None, emails: Any) -> str | None:
    """Prefer the primary verified email, else the first, else the profile one."""
    if isinstance(emails, list) and emails:
        primary = next(
            (
                e.get("email")
                for e in emails
                if isinstance(e, dict) and e.get("primary") and e.get("verified")
            ),
            None,
        )
        if primary:
            return primary
        first = emails[0]
        if isinstance(first, dict) and first.get("email"):
            return first["email"]
    return profile_email


@router.get("/auth/github/login")
async def github_login(request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled

    state = secrets.token_hex(16)
    response = RedirectResponse(runtime.gh_client.authorize_url(state), status_code=302)
    response.set_cookie(
        STATE_COOKIE,
        state,
        max_age=STATE_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=secure_cookies(runtime),
        path="/",
    )
    return response


@router.get("/auth/github/callback")
async def github_callback(request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled

    params = request.query_params
    code = params.get("code")
    state = params.get("state")
    expected = request.cookies.get(STATE_COOKIE)
    panel_base = runtime.settings.panel_base_url.rstrip("/")

    if not code or not state or not expected or state != expected:
        # Install-initiated authorization (App "Request user authorization during
        # installation") lands here with code + installation_id/setup_action and
        # NO state — the flow began on github.com, so no state cookie exists.
        # Restart a clean state-protected login; GitHub silently re-approves.
        # Login-initiated callbacks never carry setup params, so a broken-cookie
        # browser still terminates at the 400 below instead of looping.
        if params.get("setup_action") or params.get("installation_id"):
            response: Response = RedirectResponse(
                f"{panel_base}/api/auth/github/login", status_code=302
            )
        else:
            response = JSONResponse(
                {"error": "OAuth state mismatch — restart the sign-in flow"},
                status_code=400,
            )
        response.delete_cookie(STATE_COOKIE, path="/")
        return response

    try:
        payload = await runtime.gh_client.exchange_code(code)
        access_token = payload.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise ValueError("OAuth exchange returned no access token")

        octo = runtime.gh_client.user_octokit(access_token)
        gh_user = (await octo.arequest("GET", "/user")).json()
        if not isinstance(gh_user, dict) or "id" not in gh_user:
            raise ValueError("GET /user returned no user id")

        email = gh_user.get("email")
        try:
            emails = (await octo.arequest("GET", "/user/emails")).json()
            email = _select_email(email, emails)
        except Exception:  # noqa: BLE001 - App may lack email scope; non-fatal
            pass

        refresh_token = payload.get("refresh_token")
        expires_at = _expires_at_from_ttl(datetime.now(UTC), payload.get("expires_in"))

        await runtime.gh_users.upsert(
            user_id=int(gh_user["id"]),
            login=gh_user.get("login") or "",
            name=gh_user.get("name"),
            email=email,
            avatar_url=gh_user.get("avatar_url"),
            access_token=access_token,
            refresh_token=refresh_token if isinstance(refresh_token, str) else None,
            token_expires_at=expires_at,
        )

        token = await runtime.panel_sessions.create(int(gh_user["id"]))
    except Exception:
        log.exception("github oauth callback failed")
        response = JSONResponse({"error": "GitHub sign-in failed"}, status_code=502)
        response.delete_cookie(STATE_COOKIE, path="/")
        return response

    response = RedirectResponse(f"{panel_base}/dashboard", status_code=302)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_TTL.total_seconds()),
        httponly=True,
        samesite="lax",
        secure=secure_cookies(runtime),
        path="/",
    )
    response.delete_cookie(STATE_COOKIE, path="/")
    return response


@router.get("/me")
async def me(request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    user = await current_user(request, runtime)
    if user is None:
        return JSONResponse({"error": "Not signed in"}, status_code=401)
    return JSONResponse({"user": user})


@router.post("/auth/logout")
async def logout(request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        await runtime.panel_sessions.delete(token)
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response

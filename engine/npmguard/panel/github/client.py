"""GitHub App client: App JWT, installation tokens, and the OAuth web flow.

A port of the TS engine's ``github/app.ts`` (``@octokit/app``) onto
``githubkit``. Everything here is engine-side only — the CLI never touches the
App private key or user tokens.

Three client flavours, by trust surface:

- **App** (:meth:`GitHubAppClient.app_octokit`) — signs a short-lived App JWT
  from the App id + private key. Used only for ``GET /app`` (to derive the App
  *slug* for the install URL).
- **Installation** (:meth:`GitHubAppClient.installation_octokit`) — mints and
  **caches in memory** an installation access token (``githubkit``'s
  ``AppInstallationAuthStrategy``). Tokens are NEVER persisted to disk/DB.
- **Public** (:meth:`GitHubAppClient.public_octokit`) — credential-free. Used
  for third-party public-repo reads; private repos 404 by construction, so no
  private content can leak even when the signed-in user could see it.

The OAuth web flow (:meth:`authorize_url` / :meth:`exchange_code` /
:meth:`refresh_token`) speaks to the OAuth *host* (``github.com`` in prod),
which is a different origin from the REST API host (``api.github.com``). The
resolution mirrors ``githubkit``'s own rule so that in tests — where
``settings.github_api_base`` points every call at one stub — the OAuth
endpoints resolve to that same stub host.

Base-URL resolution, token-expiry, and URL building are module-level pure
functions so they can be unit-tested without a network or the App key; the
network-touching methods are proven at the e2e tier against the GitHubStub.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

import httpx
import sqlalchemy as sa
from githubkit import (
    AppAuthStrategy,
    AppInstallationAuthStrategy,
    GitHub,
)

from npmguard.config import Settings
from npmguard.panel.crypto import decrypt, encrypt
from npmguard.panel.tables import gh_users

DEFAULT_API_BASE = "https://api.github.com"
DEFAULT_OAUTH_BASE = "https://github.com"
# The OAuth scope the panel requests: identity + verified email only.
OAUTH_SCOPE = "read:user user:email"
PUBLIC_USER_AGENT = "npmguard-public-audit"

# api.github.com (with or without the `api.` host, trailing slash optional) is
# the ONE base whose OAuth host differs from its API host — everything else
# (a test stub) keeps the same origin. Mirrors githubkit.auth._url.
_GITHUB_API_HOST_RE = re.compile(r"^https://(api\.)?github\.com/?$")


class GitHubAppError(Exception):
    """The App is misconfigured, or GitHub rejected an OAuth exchange."""


def resolve_api_base(settings: Settings) -> str:
    """The REST API base URL: the test override, else ``api.github.com``."""
    return settings.github_api_base or DEFAULT_API_BASE


def resolve_oauth_base(api_base: str) -> str:
    """The OAuth host for a given REST API base.

    Prod: ``https://api.github.com`` → ``https://github.com`` (OAuth lives on a
    different host from the API). Any other base (a test stub) keeps its own
    origin so ``/login/oauth/access_token`` hits the same mock server.
    """
    if _GITHUB_API_HOST_RE.match(api_base):
        return DEFAULT_OAUTH_BASE
    parsed = httpx.URL(api_base)
    # Strip any path — the OAuth endpoints hang off the host root.
    return str(parsed.copy_with(raw_path=b"/")).rstrip("/")


def callback_redirect_uri(panel_base_url: str) -> str:
    """The registered OAuth callback: ``{panel_base}/api/auth/github/callback``."""
    return f"{panel_base_url.rstrip('/')}/api/auth/github/callback"


def build_authorize_url(
    oauth_base: str,
    *,
    client_id: str,
    redirect_uri: str,
    state: str,
    scope: str = OAUTH_SCOPE,
) -> str:
    """The ``github.com/login/oauth/authorize`` URL the browser is sent to."""
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": scope,
            "state": state,
        }
    )
    return f"{oauth_base.rstrip('/')}/login/oauth/authorize?{query}"


def install_url(slug: str) -> str:
    """The App install link (always github.com — installs never hit a stub)."""
    return f"{DEFAULT_OAUTH_BASE}/apps/{slug}/installations/new"


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _fmt_iso(moment: datetime) -> str:
    # Same wire format as kit_spine.now_iso.
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def token_not_expired(token_expires_at: str | None, now: str) -> bool:
    """Whether a stored OAuth token is still usable as-is.

    Mirrors the TS ``notExpired`` rule: a token with **no** recorded expiry
    never expires (non-expiring App), otherwise it is good until its expiry
    passes ``now``. Both timestamps are ISO-8601; compared chronologically.
    """
    if not token_expires_at:
        return True
    return _parse_iso(token_expires_at) > _parse_iso(now)


def _expires_at_from_ttl(now: datetime, expires_in: object) -> str | None:
    """Absolute expiry ISO string from a relative ``expires_in`` (seconds)."""
    if not expires_in:
        return None
    try:
        seconds = int(expires_in)
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    return _fmt_iso(now + timedelta(seconds=seconds))


class GitHubAppClient:
    """Holds the App credentials and vends the three client flavours + OAuth.

    Constructed once (at boot, when ``settings.github_app_enabled``) and
    attached to the Runtime. The private key is read from disk exactly once
    here; installation tokens are cached inside per-installation ``githubkit``
    clients and never leave memory.
    """

    def __init__(self, settings: Settings) -> None:
        if not settings.github_app_enabled:
            raise GitHubAppError(
                "GitHub App is not configured (see NPMGUARD_GITHUB_* env vars)"
            )
        # github_app_enabled guarantees these are all set.
        self._app_id: str = settings.github_app_id  # type: ignore[assignment]
        self._private_key: str = Path(
            settings.github_app_private_key_path  # type: ignore[arg-type]
        ).read_text(encoding="utf-8")
        self._client_id: str = settings.github_client_id  # type: ignore[assignment]
        self._client_secret: str = settings.github_client_secret  # type: ignore[assignment]
        self._api_base = resolve_api_base(settings)
        self._oauth_base = resolve_oauth_base(self._api_base)
        self._panel_base_url = settings.panel_base_url

        self._app_octokit: GitHub | None = None
        self._public_octokit: GitHub | None = None
        self._installation_octokits: dict[int, GitHub] = {}
        self._slug: str | None = None

    # --- client flavours -----------------------------------------------------

    def app_octokit(self) -> GitHub:
        """Client authenticated as the App itself (short-lived App JWT)."""
        if self._app_octokit is None:
            self._app_octokit = GitHub(
                AppAuthStrategy(
                    self._app_id,
                    self._private_key,
                    self._client_id,
                    self._client_secret,
                ),
                base_url=self._api_base,
            )
        return self._app_octokit

    def installation_octokit(self, installation_id: int) -> GitHub:
        """Client authenticated as an installation.

        ``githubkit`` mints an installation access token on first use and
        caches it in this client until ~expiry. The client is cached per
        installation id so the token is reused rather than re-minted; tokens
        are never written to disk or DB.
        """
        installation_id = int(installation_id)
        client = self._installation_octokits.get(installation_id)
        if client is None:
            client = GitHub(
                AppInstallationAuthStrategy(
                    self._app_id,
                    self._private_key,
                    installation_id,
                    self._client_id,
                    self._client_secret,
                ),
                base_url=self._api_base,
            )
            self._installation_octokits[installation_id] = client
        return client

    def user_octokit(self, token: str) -> GitHub:
        """Client authenticated as a signed-in user (their OAuth access token).

        Not cached: user tokens are short-lived and per-request. Used to read
        the user's own installations / repositories (``/user/...``).
        """
        return GitHub(token, base_url=self._api_base)

    def public_octokit(self) -> GitHub:
        """Credential-free client for third-party public-repo reads."""
        if self._public_octokit is None:
            self._public_octokit = GitHub(
                base_url=self._api_base,
                user_agent=PUBLIC_USER_AGENT,
            )
        return self._public_octokit

    # --- App slug + install URL ---------------------------------------------

    async def app_slug(self) -> str:
        """The App slug (e.g. ``"npmguard"``), derived once from ``GET /app``."""
        if self._slug is None:
            resp = await self.app_octokit().arequest("GET", "/app")
            data = resp.json()
            slug = data.get("slug") if isinstance(data, dict) else None
            if not slug:
                raise GitHubAppError("GET /app did not return an App slug")
            self._slug = str(slug)
        return self._slug

    async def install_url(self) -> str:  # noqa: D401 - see module install_url()
        """The install link for this App (fetches the slug on first use)."""
        return install_url(await self.app_slug())

    # --- OAuth web flow ------------------------------------------------------

    @property
    def redirect_uri(self) -> str:
        return callback_redirect_uri(self._panel_base_url)

    def authorize_url(self, state: str) -> str:
        """The authorize URL the browser is redirected to at sign-in."""
        return build_authorize_url(
            self._oauth_base,
            client_id=self._client_id,
            redirect_uri=self.redirect_uri,
            state=state,
        )

    async def _post_oauth_token(self, body: dict[str, str]) -> dict[str, object]:
        url = f"{self._oauth_base}/login/oauth/access_token"
        async with httpx.AsyncClient(follow_redirects=False) as client:
            resp = await client.post(
                url,
                json={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    **body,
                },
                headers={"Accept": "application/json"},
            )
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, dict):
            raise GitHubAppError("OAuth token endpoint returned a non-object body")
        # GitHub reports OAuth failures as HTTP 200 + {error, error_description}.
        if data.get("error"):
            raise GitHubAppError(
                str(data.get("error_description") or data.get("error"))
            )
        return data

    async def exchange_code(self, code: str) -> dict[str, object]:
        """Exchange an authorization ``code`` for tokens.

        Returns the raw GitHub token payload: ``access_token`` plus, when the
        App has token expiration enabled, ``refresh_token`` /
        ``expires_in`` / ``refresh_token_expires_in``.
        """
        return await self._post_oauth_token(
            {"code": code, "redirect_uri": self.redirect_uri}
        )

    async def refresh_token(self, refresh: str) -> dict[str, object]:
        """Mint a fresh access token from a refresh token."""
        return await self._post_oauth_token(
            {"grant_type": "refresh_token", "refresh_token": refresh}
        )

    async def get_user_access_token(self, user_id: int, sessions) -> str | None:
        """A usable OAuth access token for ``user_id``, or ``None``.

        Decrypts the stored token; if it has expired (GitHub Apps with token
        expiration issue ~8h tokens), refreshes via the stored refresh token,
        re-encrypts and persists the rotated pair, and returns the new token.
        Returns ``None`` — never raises — when there is no usable token, so the
        caller can surface a "sign in again" (401 ``reauth:true``) state.

        ``sessions`` is an ``async_sessionmaker`` over the panel DB (the users
        store); reads/writes go against ``gh_users``.
        """
        async with sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(
                            gh_users.c.access_token_enc,
                            gh_users.c.refresh_token_enc,
                            gh_users.c.token_expires_at,
                        ).where(gh_users.c.id == user_id)
                    )
                )
                .mappings()
                .one_or_none()
            )
        if row is None or not row["access_token_enc"]:
            return None

        now = datetime.now(UTC)
        if token_not_expired(row["token_expires_at"], _fmt_iso(now)):
            return decrypt(row["access_token_enc"])

        if not row["refresh_token_enc"]:
            return None
        try:
            refreshed = await self.refresh_token(decrypt(row["refresh_token_enc"]))
        except (httpx.HTTPError, GitHubAppError):
            # A dead refresh token is a re-auth signal, not a crash.
            return None

        access_token = refreshed.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            return None
        new_refresh = refreshed.get("refresh_token")
        expires_at = _expires_at_from_ttl(now, refreshed.get("expires_in"))

        async with sessions() as session, session.begin():
            await session.execute(
                gh_users.update()
                .where(gh_users.c.id == user_id)
                .values(
                    access_token_enc=encrypt(access_token),
                    refresh_token_enc=(
                        encrypt(new_refresh) if isinstance(new_refresh, str) else None
                    ),
                    token_expires_at=expires_at,
                    updated_at=_fmt_iso(now),
                )
            )
        return access_token

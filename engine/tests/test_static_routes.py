# CLASS MAP — who owns a path when the engine serves the SPA itself.
# Seam: the real `create_app()` route table and the real `frontend/src/App.tsx`
#   route table. No HTTP and no built `dist/` — the defect is in ROUTING, and it
#   reproduces whether or not anyone ran `vite build`.
# Axes: path namespace (client page / API root / API mirror / below a page)
#   C1  every client route in App.tsx reaches the SPA — no root API route shadows it
#   C2  the moved routes still answer on the /api mirror
#   C3  an unmatched path under an API namespace is a JSON 404, not 200 HTML
#   C4  an unmatched path outside those namespaces falls through to the SPA
#
# WHY THIS TIER EXISTS: Playwright drives vite, whose dev server serves the SPA
# for every path and proxies only /api, so it cannot see this class of defect at
# all. Production is nginx → engine → frontend/dist, where the engine's OWN routes
# match first: a root route named like a page wins silently, and the browser gets
# JSON from a refresh, a pasted link, or the `/audit/{id}` permalink the CLI
# prints as "Watch live".
#
# ONE NAMED EXCEPTION, and it is a real ambiguity rather than an oversight:
# `/package/{name:path}/report` is a published-CLI path (cli/src/api.ts), and the
# client's `/package/*` covers it, so the page for a package literally named
# `@scope/report` is unreachable. Left as-is deliberately: the fix would break
# installed CLIs to serve a name nobody has published. C1 uses a single-segment
# representative for splat routes so it asserts what is true rather than passing
# by accident.
from __future__ import annotations

import re

import pytest
from starlette.routing import Match

from npmguard.api import _is_api_path, create_app
from npmguard.config import REPO_ROOT

APP_TSX = REPO_ROOT / "frontend" / "src" / "App.tsx"

# A concrete URL per route parameter, so a client path becomes something the
# router can actually be asked about.
PARAM_SAMPLES = {
    ":auditId": "5f0f5c3e-2b89-436c-babf-380aeb83173d",
    ":owner": "acme",
    ":name": "widgets",
    "*": "left-pad",
}


def client_routes() -> list[str]:
    """Every `<Route path="...">` in App.tsx, as a concrete URL. Read from the
    real file: a list restated here would agree with itself while the router
    moved on."""
    source = APP_TSX.read_text(encoding="utf-8")
    paths = re.findall(r'<Route\s+path="([^"]+)"', source)
    assert paths, f"no <Route path=...> found in {APP_TSX} — the regex went stale"
    urls = []
    for path in paths:
        if path == "*":  # the SPA's own not-found; every unmatched path is C4
            continue
        for token, sample in PARAM_SAMPLES.items():
            path = path.replace(token, sample)
        urls.append(path)
    return urls


def shadowing_route(app, url: str) -> str | None:
    """The path of the registered API route that would answer `url`, or None when
    the request falls through to the SPA catch-all."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": url,
        "path_params": {},
        "root_path": "",
        "headers": [],
        "query_string": b"",
    }
    for route in app.routes:
        path_format = getattr(route, "path_format", getattr(route, "path", ""))
        if path_format == "/{path}":  # the SPA catch-all itself
            continue
        if route.matches(scope)[0] is Match.FULL:
            return path_format
    return None


@pytest.fixture(scope="module")
def app():
    return create_app()


@pytest.mark.parametrize("url", client_routes())
def test_client_route_is_not_shadowed_by_an_api_route(app, url) -> None:
    """C1: the engine serves the SPA for every page the client router owns."""
    shadow = shadowing_route(app, url)
    assert shadow is None, (
        f"{url} is a client route but the engine answers it from {shadow} — "
        "a browser navigating there gets JSON. Move that route onto "
        "api.py::client_owned_router."
    )
    assert not _is_api_path(url.lstrip("/")), f"{url} is denied the SPA fallback"


@pytest.mark.parametrize("url", ["/api/replays", "/api/packages"])
def test_the_moved_routes_answer_on_the_mirror(app, url) -> None:
    """C2: moving a route off the root does not delete it."""
    assert shadowing_route(app, url) is not None


@pytest.mark.parametrize(
    "path",
    ["api/nope", "checkout/nope", "webhooks/nope", "auth/nope", "panel/nope", "me", "bench/nope"],
)
def test_unmatched_api_path_is_a_json_404(path) -> None:
    """C3: a caller that mistyped an API path is told so, rather than handed HTML
    it will fail to parse somewhere further away."""
    assert _is_api_path(path)


@pytest.mark.parametrize(
    "path",
    [
        "audit/5f0f5c3e-2b89-436c-babf-380aeb83173d",  # the permalink
        "packages",
        "replays",
        "member-area",  # the `me` route is an exact match, not a prefix
        "metrics",
        "nonexistent",
    ],
)
def test_page_path_falls_through_to_the_spa(path) -> None:
    """C4: everything outside an API namespace is the SPA's to answer."""
    assert not _is_api_path(path)


@pytest.mark.parametrize(
    "path",
    [
        "audit/5f0f5c3e/events",
        "audit/5f0f5c3e/report",
        "audit/5f0f5c3e/file/index.js",
    ],
)
def test_below_the_permalink_stays_api(path) -> None:
    """C3: the permalink is a page; everything under it is the audit API, so a
    mistyped `/audit/{id}/evnets` must not answer 200 HTML."""
    assert _is_api_path(path)

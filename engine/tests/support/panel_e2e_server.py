"""Standalone panel fixture server for the BROWSER e2e tier (Playwright).

``GitHubStub`` is a pytest fixture, and the Python ``-m e2e`` tier is the only
thing that has ever driven it. Playwright's engine boots out of pytest entirely,
so a browser scenario needs the same stub as a **process**: this module is that
process, and it is the whole reason the panel is reachable from a browser at
all.

Run it as::

    NPMGUARD_E2E_SCENARIO=<path.json> uv run python -m tests.support.panel_e2e_server --port 8056

and point the engine at it with ``NPMGUARD_GITHUB_API_BASE=http://127.0.0.1:8056``
(githubkit resolves the OAuth host to the same origin whenever the base is not an
``api.github.com`` host, so App-JWT, token exchange, OAuth and contents all land
here and no real GitHub is ever touched).

WHY THE SCENARIO IS AN INPUT AND NOT WRITTEN HERE: the browser side already owns
the fixture — Playwright's config seeds the durable reports that make a dep a
cache hit, and those reports and this stub's lockfiles have to name the same
(package, version) pairs or the scenario proves nothing. One file describes both
(``frontend/e2e/panel-fixture.ts``); this process is a dumb applier of it, so the
two cannot drift.

Three surfaces, mounted on one app:

- ``/`` + the REST/OAuth subset — ``GitHubStub``'s own app, unmodified.
- ``/registry/*`` — a deliberately SLOW 404 npm registry. It is what makes a
  cache-MISS dep deterministic in two directions at once: the audit always fails
  (nothing to download → the dep settles ERROR, never SAFE), and it always takes
  at least ``registryDelayMs``, which is what gives the browser a scan-in-progress
  window to observe instead of a race against a scan that finished before the
  page painted.
- ``/fixture/*`` — the control plane (health + the alert fan-out below).

WHY A CONTROL PLANE EXISTS AT ALL, and its one strict rule: it lives HERE, in the
harness process, and never inside the engine. Payment/auth gating is server-side
by constitution (N-1), so a test-mode bypass compiled into the engine is out of
the question; a harness process holding a second connection to the same throwaway
database is not a bypass of anything.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from kit_spine import make_engine, make_session_factory
from npmguard.panel.alerts.notify import handle_dangerous_verdict
from tests.support.stubs import GitHubStub

DEFAULT_REGISTRY_DELAY_MS = 0


def apply_scenario(stub: GitHubStub, scenario: dict[str, Any]) -> None:
    """Load a JSON scenario into a fresh ``GitHubStub``.

    The shape is the one ``frontend/e2e/panel-fixture.ts`` writes; every key maps
    onto exactly one stub preload call, so there is no scenario logic to keep in
    step with the stub's API.
    """
    stub.clear()
    stub.set_app(slug=scenario.get("appSlug", "npmguard"), app_id=scenario.get("appId", 1))

    user = scenario["user"]
    stub.set_oauth_code(scenario["oauthCode"], scenario["userToken"])
    # The code the authorize hop hands BACK must be the code the exchange
    # accepts. A pytest scenario drives the two halves by hand and can leave them
    # apart; a browser walks the whole redirect chain, so they are one fact here.
    stub.authorize_code = scenario["oauthCode"]
    stub.set_user(
        scenario["userToken"],
        id=user["id"],
        login=user["login"],
        name=user.get("name"),
        email=user.get("email"),
    )

    for installation in scenario["installations"]:
        stub.add_installation(
            installation["id"],
            account_login=installation["account"],
            account_type=installation.get("accountType", "Organization"),
        )

    for repo in scenario["repos"]:
        stub.add_repo(
            repo["owner"],
            repo["name"],
            id=repo["id"],
            installation_id=repo["installationId"],
            private=repo.get("private", False),
            default_branch=repo.get("defaultBranch", "main"),
        )
        # A repo with no lockfile is a repo the panel filters out of /panel/repos
        # — a real state, and one a scenario is allowed to ask for.
        if repo.get("lockfile") is not None:
            stub.set_lockfile(
                repo["owner"],
                repo["name"],
                repo.get("lockfilePath", "package-lock.json"),
                repo["lockfile"],
            )


def build_app(scenario: dict[str, Any], database_url: str | None) -> FastAPI:
    stub = GitHubStub()
    apply_scenario(stub, scenario)

    registry_delay_seconds = (
        float(scenario.get("registryDelayMs", DEFAULT_REGISTRY_DELAY_MS)) / 1000.0
    )
    sessions = make_session_factory(make_engine(database_url)) if database_url else None
    app = FastAPI()

    @app.get("/fixture/health")
    async def health() -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        return JSONResponse({"ok": True, "repos": len(scenario["repos"])})

    @app.post("/fixture/dangerous-fanout")
    async def dangerous_fanout(request: Request) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        """Run the engine's OWN alert producer for one DANGEROUS pair.

        ⚠ REVISIT IN PHASE 4. This endpoint is the only synthetic trigger in the
        panel browser tier and it should not outlive the constraint that forced
        it: once Phase 4 can run an audit that genuinely concludes DANGEROUS,
        delete it and let a real scan raise the alert. Its presence means the
        alert TRIGGER is unproven in the browser — only the feed downstream of it
        is.

        This is the one panel fact a browser harness cannot reach by driving the
        product: alerts are raised by ``PanelScanWorker`` at the moment a real
        audit lands a DANGEROUS verdict (jobs.py), and a real audit needs docker
        plus a live LLM — both excluded from Phase 3 by design, and with
        ``NPMGUARD_MOCK_LLM`` a concluding audit could only ever be SAFE. A dep
        that is a *cache hit* never runs a job at all, so it never reaches the
        hook either.

        So the hook is called directly, with the same arguments the worker passes
        and against the same database the engine is using. Everything downstream
        of it is real: exposure is computed from the ``repo_deps`` index the
        browser's own scan just wrote, and the rows are inserted by the engine's
        writer. What is faked is strictly the trigger.
        """
        if sessions is None:
            return JSONResponse(
                {"error": "no NPMGUARD_DATABASE_URL — the fan-out needs the engine's DB"},
                status_code=503,
            )
        body = await request.json()
        inserted = await handle_dangerous_verdict(
            sessions,
            body["packageName"],
            body["version"],
            origin=body.get("origin", "repo_scan"),
        )
        return JSONResponse({"alerts": inserted})

    @app.api_route("/registry/{path:path}", methods=["GET", "HEAD"])
    async def registry(path: str) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        if registry_delay_seconds:
            await asyncio.sleep(registry_delay_seconds)
        return JSONResponse({"error": "Not found", "path": path}, status_code=404)

    # Mounted LAST and at the root so the stub's own catch-all repo routes
    # (`/repos/{owner}/{repo}`, `/{name:path}`-shaped contents) cannot shadow the
    # fixture and registry paths above.
    app.mount("/", stub.app)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    scenario_path = os.environ.get("NPMGUARD_E2E_SCENARIO")
    if not scenario_path:
        raise SystemExit("NPMGUARD_E2E_SCENARIO must point at the scenario JSON")
    scenario = json.loads(Path(scenario_path).read_text(encoding="utf-8"))

    app = build_app(scenario, os.environ.get("NPMGUARD_DATABASE_URL"))
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

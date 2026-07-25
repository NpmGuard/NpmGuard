"""Panel core routes: the user's orgs (installations) and repos.

The orgs/repos handlers. Both are session-gated and scoped to the GitHub App installations the user can access
(the org-shared view). The ``user_installations`` cache is (re)built on
``/panel/orgs`` and read by ``/panel/repos``.

Two load-bearing error behaviours (the frontend branches on the *field*, never
the message):

- **401 ``{reauth: true}``** when the stored OAuth token can't be refreshed —
  the frontend hard-redirects into ``/api/auth/github/login``.
- **503** ``{"error": "GitHub App is not configured on this server"}`` when the
  App is disabled.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from kit_spine import now_iso
from npmguard.contract import models as contract
from npmguard.panel.audit_set import (
    MAX_DETAIL_ITEMS,
    ORIGIN_PUBLIC_REPO_SCAN,
    ORIGIN_REPO_SCAN,
    latest_set_row,
    latest_set_rows,
    set_item_states,
    set_rollup,
    set_rollups,
    set_wire,
    truncated,
)
from npmguard.panel.caps import CapExceededError
from npmguard.panel.github.content import find_root_lockfile
from npmguard.panel.lockfile import UnsupportedLockfileError
from npmguard.panel.routes._common import (
    current_user,
    panel_disabled_response,
    require_panel,
    runtime_of,
)
from npmguard.panel.scan.repo_scan import LockfileNotFoundError
from npmguard.panel.tables import (
    alerts,
    audit_sets,
    installations,
    repo_deps,
    repos,
    user_installations,
)
from npmguard.panel.watch import sync_watched_packages

log = structlog.get_logger("npmguard.panel.core")

router = APIRouter()

# Fire-and-forget background scans (the protect toggle responds instantly).
# A module-level set retains the task references so they aren't GC'd mid-run.
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()


def _spawn(coro: Any) -> None:
    task = asyncio.create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)

# The auditability probe is cached for a day; a stale/missing marker re-probes.
AUDITABILITY_CACHE_SECONDS = 24 * 60 * 60


def _not_signed_in() -> JSONResponse:
    return JSONResponse({"error": "Not signed in"}, status_code=401)


def _reauth() -> JSONResponse:
    return JSONResponse(
        {"error": "GitHub authorization expired — sign in again", "reauth": True},
        status_code=401,
    )


def _installation_summary(inst: dict[str, Any]) -> dict[str, Any]:
    """Project a GitHub installation onto the wire ``Installation`` shape.

    The installation "account" can be a user / org / enterprise shape, so the
    login falls back through ``login`` → ``slug`` → ``"unknown"`` and the type
    defaults to ``"Organization"`` (matching the TS ``accountInfo`` helper).
    """
    account = inst.get("account") or {}
    login = account.get("login") or account.get("slug") or "unknown"
    account_type = account.get("type") or "Organization"
    return {
        "id": inst.get("id"),
        "accountLogin": login,
        "accountType": account_type,
        "suspended": bool(inst.get("suspended_at")),
    }


def _repo_summary(repo: dict[str, Any]) -> dict[str, Any]:
    owner = (repo.get("owner") or {}).get("login") or "unknown"
    name = repo.get("name") or ""
    return {
        "id": repo.get("id"),
        "owner": owner,
        "name": name,
        "full_name": repo.get("full_name") or f"{owner}/{name}",
        "private": bool(repo.get("private")),
        "default_branch": repo.get("default_branch") or "main",
    }


def _auditability_is_fresh(checked_at: str | None, now: datetime) -> bool:
    if not checked_at:
        return False
    try:
        parsed = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (now - parsed).total_seconds() < AUDITABILITY_CACHE_SECONDS


@router.get("/panel/orgs")
async def panel_orgs(request: Request) -> Response:
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    token = await runtime.gh_client.get_user_access_token(
        user["id"], runtime.sessionmaker
    )
    if not token:
        return _reauth()

    try:
        octo = runtime.gh_client.user_octokit(token)
        data = (
            await octo.arequest(
                "GET", "/user/installations", params={"per_page": 100}
            )
        ).json()
        raw = data.get("installations", []) if isinstance(data, dict) else []
        summaries = [_installation_summary(inst) for inst in raw]
        await runtime.panel_installations.replace_user_installations(
            user["id"], summaries
        )
        install_url = await runtime.gh_client.install_url()
    except Exception:
        log.exception("panel orgs fetch failed")
        return JSONResponse(
            {"error": "Failed to list GitHub installations"}, status_code=502
        )

    return JSONResponse({"installations": summaries, "installUrl": install_url})


async def _refresh_auditability(
    runtime: Any,
    octo: Any,
    summaries: list[dict[str, Any]],
    states: dict[int, dict[str, Any]],
    now: datetime,
) -> None:
    """Probe the root lockfile for repos whose auditability marker is stale.

    Updates the ``states`` dict in place so the response filter sees the fresh
    result. A transient GitHub failure keeps the previous cached state (the
    repo is neither confirmed auditable nor confirmed non-auditable, so it is
    shown, matching the TS behaviour).
    """
    checked_at = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for summary in summaries:
        repo_id = summary["id"]
        state = states.get(repo_id, {})
        if _auditability_is_fresh(state.get("auditability_checked_at"), now):
            continue
        try:
            lockfile = await find_root_lockfile(
                octo, summary["owner"], summary["name"], summary["default_branch"]
            )
        except Exception:  # noqa: BLE001 - keep cached state on a flaky probe
            log.warning("auditability probe failed", repo=summary["full_name"])
            continue
        await runtime.panel_repos.set_auditability(
            repo_id,
            lockfile_path=lockfile.path if lockfile else None,
            lockfile_sha=lockfile.sha if lockfile else None,
            checked_at=checked_at,
        )
        states[repo_id] = {
            **state,
            "lockfile_path": lockfile.path if lockfile else None,
            "lockfile_sha": lockfile.sha if lockfile else None,
            "auditability_checked_at": checked_at,
        }


@router.get("/panel/repos")
async def panel_repos(request: Request) -> Response:
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    token = await runtime.gh_client.get_user_access_token(
        user["id"], runtime.sessionmaker
    )
    if not token:
        return _reauth()

    octo = runtime.gh_client.user_octokit(token)
    now = datetime.now(UTC)
    installation_ids = await runtime.panel_installations.list_installation_ids(
        user["id"]
    )

    repos: list[dict[str, Any]] = []
    for installation_id in installation_ids:
        try:
            data = (
                await octo.arequest(
                    "GET",
                    f"/user/installations/{installation_id}/repositories",
                    params={"per_page": 100},
                )
            ).json()
        except Exception:  # noqa: BLE001 - never prune on a flaky fetch
            log.warning("repo list failed", installation_id=installation_id)
            continue

        raw = data.get("repositories", []) if isinstance(data, dict) else []
        summaries = [_repo_summary(r) for r in raw]
        await runtime.panel_repos.sync_installation_repos(installation_id, summaries)
        states = await runtime.panel_repos.states_for_installation(installation_id)
        await _refresh_auditability(runtime, octo, summaries, states, now)

        shown = [
            summary
            for summary in summaries
            # Confirmed non-auditable (probed, no root lockfile) → filtered out.
            if not (
                states.get(summary["id"], {}).get("auditability_checked_at")
                and not states.get(summary["id"], {}).get("lockfile_path")
            )
        ]
        # `lastScan` is the repo's posture: the dashboard's attention filter, its
        # "not audited" state, its posture rail and its audited counter all read
        # it, and the engine hardcoding null left four surfaces inert. Batched —
        # two queries for the whole list, not two per repo.
        async with runtime.sessionmaker() as session:
            last_sets = await latest_set_rows(
                session, ORIGIN_REPO_SCAN, [s["id"] for s in shown]
            )
            rollups = await set_rollups(session, [row["id"] for row in last_sets.values()])

        for summary in shown:
            state = states.get(summary["id"], {})
            last_set = last_sets.get(summary["id"])
            repos.append(
                {
                    "id": summary["id"],
                    "installationId": installation_id,
                    "owner": summary["owner"],
                    "name": summary["name"],
                    "fullName": summary["full_name"],
                    "private": summary["private"],
                    "defaultBranch": summary["default_branch"],
                    "protected": bool(state.get("protected_at")),
                    "lastScan": (
                        set_wire(last_set, rollups[last_set["id"]]).model_dump(
                            mode="json", exclude_none=False
                        )
                        if last_set is not None
                        else None
                    ),
                }
            )

    return JSONResponse({"repos": repos})


# ---------------------------------------------------------------------------
# Scan / repo-detail / scan-progress SSE
# ---------------------------------------------------------------------------


def _cap_response(exc: CapExceededError) -> JSONResponse:
    """The 402 body the frontend keys on: ``{error, cap, resource, ...}``."""
    return JSONResponse(
        {
            "error": str(exc),
            "cap": True,
            "resource": exc.resource,
            "installationId": exc.installation_id,
            "entitlements": exc.entitlements,
        },
        status_code=402,
    )


async def _authorized_repo(
    runtime: Any, user_id: int, repo_id: int
) -> dict[str, Any] | None:
    """The repo row iff the user can access its installation, else ``None``."""
    async with runtime.sessionmaker() as session:
        repo = (
            (
                await session.execute(sa.select(repos).where(repos.c.id == repo_id))
            )
            .mappings()
            .one_or_none()
        )
        if repo is None:
            return None
        allowed = await _user_has_installation(session, user_id, repo["installation_id"])
    return dict(repo) if allowed else None


async def _repo_by_full_name(
    runtime: Any, user_id: int, full_name: str
) -> dict[str, Any] | None:
    async with runtime.sessionmaker() as session:
        repo = (
            (
                await session.execute(
                    sa.select(repos).where(repos.c.full_name == full_name)
                )
            )
            .mappings()
            .one_or_none()
        )
        if repo is None:
            return None
        allowed = await _user_has_installation(session, user_id, repo["installation_id"])
    return dict(repo) if allowed else None


def _user_orgs(user_id: int) -> Any:
    """Subquery: the ``installations.account_login`` values the user can access.

    ``alerts.org`` stores the account login while authorization is held against
    installation ids, so every org-scoped alerts query joins through
    ``user_installations`` to translate. A user whose cache is empty gets an
    empty set — the correct answer, not an error; ``/panel/orgs`` builds it.
    """
    return (
        sa.select(installations.c.account_login)
        .select_from(
            installations.join(
                user_installations,
                user_installations.c.installation_id == installations.c.id,
            )
        )
        .where(user_installations.c.user_id == user_id)
    )


def _alert_wire(row: Any) -> dict[str, Any]:
    """The one wire projection for an alert row.

    Both the dashboard feed and the repo-detail payload render through this, so
    the two views cannot drift into different shapes for the same record. Built
    through the generated contract model, so a shape that does not validate cannot
    reach the wire at all.
    """
    return contract.Alert(
        id=row["id"],
        org=row["org"],
        repoId=row["repo_id"],
        packageName=row["package_name"],
        version=row["version"],
        outcome=row["outcome"],
        origin=row["origin"],
        message=row["message"],
        seen=bool(row["seen"]),
        createdAt=row["created_at"],
    ).model_dump(mode="json", exclude_none=False)


async def _user_has_installation(session: Any, user_id: int, installation_id: int) -> bool:
    row = (
        await session.execute(
            sa.select(sa.literal(1))
            .select_from(user_installations)
            .where(
                user_installations.c.user_id == user_id,
                user_installations.c.installation_id == installation_id,
            )
            .limit(1)
        )
    ).first()
    return row is not None


async def _live_set_id(runtime: Any, repo_id: int) -> int | None:
    return await runtime.panel_sets.live_set_id(ORIGIN_REPO_SCAN, repo_id)


@router.post("/panel/repo/{repo_id}/scan")
async def panel_repo_scan(repo_id: int, request: Request) -> Response:
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()
    repo = await _authorized_repo(runtime, user["id"], repo_id)
    if repo is None:
        return JSONResponse({"error": "Repo not found"}, status_code=404)

    running = await _live_set_id(runtime, repo_id)
    if running is not None:
        return JSONResponse(
            {"error": "A scan is already running", "scanId": running}, status_code=409
        )

    try:
        scan_id = await runtime.panel_scan.full_repo_scan(repo, "manual")
    except CapExceededError as exc:
        return _cap_response(exc)
    except (LockfileNotFoundError, UnsupportedLockfileError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)
    except Exception:
        log.exception("panel scan failed", repo_id=repo_id)
        return JSONResponse({"error": "Scan failed — see engine logs"}, status_code=502)
    return JSONResponse({"scanId": scan_id})


async def _set_protected_at(runtime: Any, repo_id: int, value: str | None) -> None:
    now = now_iso()
    async with runtime.sessionmaker() as session, session.begin():
        await session.execute(
            repos.update()
            .where(repos.c.id == repo_id)
            .values(protected_at=value, updated_at=now)
        )


async def _repo_has_deps(runtime: Any, repo_id: int) -> bool:
    async with runtime.sessionmaker() as session:
        row = (
            await session.execute(
                sa.select(sa.literal(1))
                .select_from(repo_deps)
                .where(repo_deps.c.repo_id == repo_id)
                .limit(1)
            )
        ).first()
    return row is not None


async def _initial_protect_scan(runtime: Any, repo: dict[str, Any]) -> None:
    """Background full scan when a freshly-protected repo has no dep index yet —
    Protect needs something to watch. Errors are logged, never surfaced (the
    toggle already responded)."""
    try:
        await runtime.panel_scan.full_repo_scan(repo, "manual")
    except Exception as err:  # noqa: BLE001 - background; the toggle already returned
        log.warning(
            "initial protect scan failed",
            repo=repo.get("full_name"),
            error=str(err),
        )


@router.post("/panel/repo/{repo_id}/protect")
async def panel_repo_protect(repo_id: int, request: Request) -> Response:
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()
    repo = await _authorized_repo(runtime, user["id"], repo_id)
    if repo is None:
        return JSONResponse({"error": "Repo not found"}, status_code=404)

    if not repo["protected_at"]:
        try:
            await runtime.panel_caps.assert_protect_cap(repo["installation_id"])
        except CapExceededError as exc:
            return _cap_response(exc)
        protected_at = now_iso()
        await _set_protected_at(runtime, repo_id, protected_at)
        await sync_watched_packages(runtime.sessionmaker)
        # Protection needs a dep index to watch — build it in the background if
        # this repo was never scanned. The toggle responds instantly.
        if not await _repo_has_deps(runtime, repo_id):
            _spawn(_initial_protect_scan(runtime, {**repo, "protected_at": protected_at}))
    return JSONResponse({"ok": True})


@router.delete("/panel/repo/{repo_id}/protect")
async def panel_repo_unprotect(repo_id: int, request: Request) -> Response:
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()
    repo = await _authorized_repo(runtime, user["id"], repo_id)
    if repo is None:
        return JSONResponse({"error": "Repo not found"}, status_code=404)

    await _set_protected_at(runtime, repo_id, None)
    await sync_watched_packages(runtime.sessionmaker)
    return JSONResponse({"ok": True})


@router.post("/panel/repo/{repo_id}/resync")
async def panel_repo_resync(repo_id: int, request: Request) -> Response:
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()
    repo = await _authorized_repo(runtime, user["id"], repo_id)
    if repo is None:
        return JSONResponse({"error": "Repo not found"}, status_code=404)

    try:
        scan_id = await runtime.panel_scan.full_repo_scan(repo, "reconcile")
    except CapExceededError as exc:
        return _cap_response(exc)
    except (LockfileNotFoundError, UnsupportedLockfileError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)
    except Exception:
        log.exception("panel resync failed", repo_id=repo_id)
        return JSONResponse({"error": "Scan failed — see engine logs"}, status_code=502)
    return JSONResponse({"scanId": scan_id})


@router.get("/panel/repo/{owner}/{name}")
async def panel_repo_detail(owner: str, name: str, request: Request) -> Response:
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    repo = await _repo_by_full_name(runtime, user["id"], f"{owner}/{name}")
    if repo is None:
        return JSONResponse({"error": "Repo not found"}, status_code=404)

    async with runtime.sessionmaker() as session:
        # The scan being shown: the live one if any, else the most recent.
        shown = await latest_set_row(session, ORIGIN_REPO_SCAN, repo["id"])
        # `deps` is THIS SET's items and `set.rollup` is the rollup over the same
        # population, so summing deps reproduces the rollup (modulo truncation).
        # Two populations under one response is how a scan whose only DANGEROUS
        # item lay outside the repo's current dep index came to read as SAFE.
        states = (
            await set_item_states(session, shown["id"], limit=MAX_DETAIL_ITEMS)
            if shown is not None
            else []
        )
        rollup = await set_rollup(session, shown["id"]) if shown is not None else None
        alert_rows = (
            (
                await session.execute(
                    sa.select(alerts)
                    .where(alerts.c.repo_id == repo["id"])
                    .order_by(alerts.c.created_at.desc())
                    .limit(20)
                )
            )
            .mappings()
            .all()
        )

    set_body = (
        set_wire(shown, rollup).model_dump(mode="json", exclude_none=False)
        if shown is not None and rollup is not None
        else None
    )
    return JSONResponse(
        {
            "repo": {
                "id": repo["id"],
                "installationId": repo["installation_id"],
                "owner": repo["owner"],
                "name": repo["name"],
                "fullName": repo["full_name"],
                "private": bool(repo["private"]),
                "defaultBranch": repo["default_branch"],
                "protected": bool(repo["protected_at"]),
                # The repo detail already carries the shown set; `lastScan` exists
                # for the LIST view, where there is nothing else to carry it.
                "lastScan": set_body,
            },
            "set": set_body,
            "depsTruncated": truncated(rollup, len(states)) if rollup is not None else False,
            "deps": [
                state.as_wire().model_dump(mode="json", exclude_none=False)
                for state in states
            ],
            "alerts": [_alert_wire(a) for a in alert_rows],
        }
    )


async def _may_read_set(runtime: Any, user_id: int, set_id: int) -> bool:
    """Authorize a set for reading, by ORIGIN.

    One stream serves every origin, so the authorization has to be per-origin here
    rather than per-route. A ``repo_scan`` set is readable by anyone who can access
    its repo's installation; a ``public_repo_scan`` set by anyone who can access
    the installation that paid for it. Every other origin is unreadable until it
    has an access story of its own — an origin nobody can read is a 404, never an
    open default.
    """
    async with runtime.sessionmaker() as session:
        row = (
            (
                await session.execute(
                    sa.select(
                        audit_sets.c.origin, audit_sets.c.origin_ref, audit_sets.c.billed_to
                    ).where(audit_sets.c.id == set_id)
                )
            )
            .mappings()
            .first()
        )
    if row is None:
        return False
    if row["origin"] == ORIGIN_REPO_SCAN:
        return await _authorized_repo(runtime, user_id, row["origin_ref"]) is not None
    if row["origin"] == ORIGIN_PUBLIC_REPO_SCAN and row["billed_to"] is not None:
        async with runtime.sessionmaker() as session:
            return await _user_has_installation(session, user_id, row["billed_to"])
    return False


@router.get("/panel/scan/{scan_id}/events")
async def panel_scan_events(scan_id: int, request: Request) -> Response:
    """Progress SSE for ONE audit set, whatever its origin.

    ``Last-Event-ID`` (or ``?since=``) resumes from the durable log's ``seq``
    cursor, exactly as the audit stream does — the panel's own 1.5s DB poll with a
    per-connection "what did I already send" dict is gone, and so is the public
    scan's client-side polling loop, because a public set streams here too.
    """
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()
    if not await _may_read_set(runtime, user["id"], scan_id):
        return JSONResponse({"error": "Scan not found"}, status_code=404)

    after = _resume_cursor(request)
    response = StreamingResponse(
        runtime.panel_sets.events(scan_id, after=after), media_type="text/event-stream"
    )
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response


def _resume_cursor(request: Request) -> int:
    """The replay cursor: ``Last-Event-ID`` (sent by native EventSource on
    reconnect) else ``?since=``, else ``-1`` for "from the beginning". A
    non-integer value is treated as absent rather than as an error — a garbled
    cursor must degrade to a full replay, never to a 400 on a reconnect."""
    for raw in (request.headers.get("last-event-id"), request.query_params.get("since")):
        if raw:
            try:
                return int(raw)
            except ValueError:
                continue
    return -1


# ---------------------------------------------------------------------------
# Alerts feed — across every org the user can access
# ---------------------------------------------------------------------------
# Org-scoped, NOT repo-scoped. ``alerts.repo_id`` is nullable with an ON DELETE
# SET NULL FK, and the registry watcher raises alerts for a *package* rather
# than a repo — so a repo-only feed would drop exactly the alerts the watcher
# exists to raise. The repo-detail payload carries its own repo-scoped slice.

ALERTS_FEED_LIMIT = 50


@router.get("/panel/alerts")
async def panel_alerts(request: Request) -> Response:
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    async with runtime.sessionmaker() as session:
        rows = (
            (
                await session.execute(
                    sa.select(alerts)
                    .where(alerts.c.org.in_(_user_orgs(user["id"])))
                    # created_at is a string timestamp with second-or-better
                    # resolution; id breaks ties so a burst of alerts written in
                    # the same instant still has one stable order.
                    .order_by(alerts.c.created_at.desc(), alerts.c.id.desc())
                    .limit(ALERTS_FEED_LIMIT)
                )
            )
            .mappings()
            .all()
        )
    return JSONResponse({"alerts": [_alert_wire(row) for row in rows]})


@router.post("/panel/alerts/seen")
async def panel_alerts_seen(request: Request) -> Response:
    """Acknowledge every unseen alert in the user's orgs.

    Whole-feed ack rather than per-id: the UI is a single "dismiss" on the
    banner. Idempotent — a second call matches nothing and still returns ok, so
    a double-click cannot 500.
    """
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    async with runtime.sessionmaker() as session:
        result = await session.execute(
            alerts.update()
            .where(
                alerts.c.seen == sa.false(),
                alerts.c.org.in_(_user_orgs(user["id"])),
            )
            .values(seen=True)
        )
        await session.commit()
    return JSONResponse({"ok": True, "updated": result.rowcount or 0})

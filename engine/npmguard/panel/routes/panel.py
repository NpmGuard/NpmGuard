"""Panel core routes: the user's orgs (installations) and repos.

A port of the TS engine's ``routes/panel.ts`` orgs/repos handlers. Both are
session-gated and scoped to the GitHub App installations the user can access
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
import json
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from kit_spine import now_iso
from npmguard.panel.caps import CapExceededError
from npmguard.panel.github.content import find_root_lockfile
from npmguard.panel.lockfile import UnsupportedLockfileError
from npmguard.panel.routes._common import (
    current_user,
    require_enabled,
    runtime_of,
)
from npmguard.panel.scan.repo_scan import LockfileNotFoundError, compute_rollup
from npmguard.panel.tables import (
    alerts,
    package_verdicts,
    panel_jobs,
    repo_deps,
    repos,
    scan_items,
    scans,
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

# The scan-progress SSE polls the DB on this cadence and emits a snapshot.
SSE_TICK_SECONDS = 1.5


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
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
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
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
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

        for summary in summaries:
            state = states.get(summary["id"], {})
            # Confirmed non-auditable (probed, no root lockfile) → filtered out.
            if state.get("auditability_checked_at") and not state.get("lockfile_path"):
                continue
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
                    "lastScan": None,
                }
            )

    return JSONResponse({"repos": repos})


# ---------------------------------------------------------------------------
# Scan / repo-detail / scan-progress SSE (port of TS routes/panel.ts)
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


async def _running_scan_id(runtime: Any, repo_id: int) -> int | None:
    async with runtime.sessionmaker() as session:
        return (
            await session.execute(
                sa.select(scans.c.id)
                .where(scans.c.repo_id == repo_id, scans.c.status == "running")
                .limit(1)
            )
        ).scalar_one_or_none()


def _job_state_subqueries(name_col: Any, version_col: Any) -> tuple[Any, Any]:
    """Correlated subqueries for a dep's live job state.

    ``active_state`` is the ``queued``/``running`` job state (if any);
    ``has_failed`` flags a terminal ``failed`` job. The wire ``jobState`` is
    ``active_state`` first, else ``failed`` when a failed job exists and the dep
    has no verdict (a null verdict + failed job = the audit gave up).
    """
    active_state = (
        sa.select(panel_jobs.c.state)
        .where(
            panel_jobs.c.package_name == name_col,
            panel_jobs.c.version == version_col,
            panel_jobs.c.state.in_(("queued", "running")),
        )
        .limit(1)
        .scalar_subquery()
    )
    has_failed = (
        sa.select(sa.literal(1))
        .where(
            panel_jobs.c.package_name == name_col,
            panel_jobs.c.version == version_col,
            panel_jobs.c.state == "failed",
        )
        .limit(1)
        .scalar_subquery()
    )
    return active_state, has_failed


def _job_state(active_state: str | None, has_failed: Any, verdict: str | None) -> str | None:
    return active_state or ("failed" if has_failed and not verdict else None)


def _scan_summary(row: Any, verdict: str | None) -> dict[str, Any]:
    return {
        "id": row["id"],
        "status": row["status"],
        "trigger": row["trigger_kind"],
        "total": row["total"],
        "cached": row["cached"],
        "audited": row["audited"],
        "failed": row["failed"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        # The rollup only becomes the scan's verdict once the scan is done.
        "verdict": verdict if row["status"] == "done" else None,
    }


async def _last_scan_row(session: Any, repo_id: int) -> Any:
    return (
        (
            await session.execute(
                sa.select(
                    scans.c.id,
                    scans.c.status,
                    scans.c.trigger_kind,
                    scans.c.total,
                    scans.c.cached,
                    scans.c.audited,
                    scans.c.failed,
                    scans.c.started_at,
                    scans.c.finished_at,
                )
                .where(scans.c.repo_id == repo_id)
                .order_by(scans.c.started_at.desc())
                .limit(1)
            )
        )
        .mappings()
        .first()
    )


@router.post("/panel/repo/{repo_id}/scan")
async def panel_repo_scan(repo_id: int, request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()
    repo = await _authorized_repo(runtime, user["id"], repo_id)
    if repo is None:
        return JSONResponse({"error": "Repo not found"}, status_code=404)

    running = await _running_scan_id(runtime, repo_id)
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
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
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
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
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
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
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
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    repo = await _repo_by_full_name(runtime, user["id"], f"{owner}/{name}")
    if repo is None:
        return JSONResponse({"error": "Repo not found"}, status_code=404)

    active_state, has_failed = _job_state_subqueries(repo_deps.c.name, repo_deps.c.version)
    async with runtime.sessionmaker() as session:
        dep_rows = (
            (
                await session.execute(
                    sa.select(
                        repo_deps.c.name,
                        repo_deps.c.version,
                        repo_deps.c.direct,
                        repo_deps.c.range,
                        package_verdicts.c.verdict,
                        package_verdicts.c.reason,
                        package_verdicts.c.evidence_count,
                        package_verdicts.c.audited_at,
                        active_state.label("active_state"),
                        has_failed.label("has_failed"),
                    )
                    .select_from(
                        repo_deps.outerjoin(
                            package_verdicts,
                            sa.and_(
                                package_verdicts.c.name == repo_deps.c.name,
                                package_verdicts.c.version == repo_deps.c.version,
                            ),
                        )
                    )
                    .where(repo_deps.c.repo_id == repo["id"])
                    .order_by(
                        repo_deps.c.direct.desc(), repo_deps.c.name, repo_deps.c.version
                    )
                )
            )
            .mappings()
            .all()
        )
        last_scan = await _last_scan_row(session, repo["id"])
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

    deps = [
        {
            "name": row["name"],
            "version": row["version"],
            "direct": bool(row["direct"]),
            "range": row["range"],
            "verdict": row["verdict"],
            "verdictReason": row["reason"],
            "evidenceCount": row["evidence_count"] or 0,
            "auditedAt": row["audited_at"],
            "jobState": _job_state(row["active_state"], row["has_failed"], row["verdict"]),
        }
        for row in dep_rows
    ]
    rollup = compute_rollup([row["verdict"] for row in dep_rows]).as_wire()

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
                "lastScan": None,
            },
            "deps": deps,
            "rollup": rollup,
            "scan": _scan_summary(last_scan, rollup["verdict"]) if last_scan else None,
            "alerts": [
                {
                    "id": a["id"],
                    "org": a["org"],
                    "repoId": a["repo_id"],
                    "packageName": a["package_name"],
                    "version": a["version"],
                    "verdict": a["verdict"],
                    "kind": a["kind"],
                    "message": a["message"],
                    "seen": bool(a["seen"]),
                    "createdAt": a["created_at"],
                }
                for a in alert_rows
            ],
        }
    )


def _sse_data(payload: dict[str, Any]) -> str:
    """One UNNAMED SSE frame (data-only; NO ``event:`` line — the panel scan
    stream is consumed via ``EventSource.onmessage``, distinct from the named
    audit stream in ``events.py``)."""
    return f"data: {json.dumps(payload)}\n\n"


async def _scan_stream(runtime: Any, scan_id: int) -> Any:
    """Poll the DB every ~1.5s, emitting dep diffs + a progress snapshot each
    tick, then a terminal ``{type:'done'}`` once the scan leaves ``running``."""
    sent: dict[str, str] = {}
    active_state, has_failed = _job_state_subqueries(scan_items.c.name, scan_items.c.version)
    while True:
        async with runtime.sessionmaker() as session:
            scan = (
                (
                    await session.execute(
                        sa.select(
                            scans.c.status,
                            scans.c.total,
                            scans.c.cached,
                            scans.c.audited,
                            scans.c.failed,
                        ).where(scans.c.id == scan_id)
                    )
                )
                .mappings()
                .first()
            )
            if scan is None:
                break
            items = (
                (
                    await session.execute(
                        sa.select(
                            scan_items.c.name,
                            scan_items.c.version,
                            package_verdicts.c.verdict,
                            package_verdicts.c.reason,
                            package_verdicts.c.evidence_count,
                            active_state.label("active_state"),
                            has_failed.label("has_failed"),
                        )
                        .select_from(
                            scan_items.outerjoin(
                                package_verdicts,
                                sa.and_(
                                    package_verdicts.c.name == scan_items.c.name,
                                    package_verdicts.c.version == scan_items.c.version,
                                ),
                            )
                        )
                        .where(scan_items.c.scan_id == scan_id)
                    )
                )
                .mappings()
                .all()
            )

        for item in items:
            verdict = item["verdict"]
            job_state = _job_state(item["active_state"], item["has_failed"], verdict)
            signature = f"{verdict or ''}|{job_state or ''}"
            key = f"{item['name']}@{item['version']}"
            if sent.get(key) == signature:
                continue  # diff-only: skip a dep whose state didn't change
            sent[key] = signature
            yield _sse_data(
                {
                    "type": "dep",
                    "name": item["name"],
                    "version": item["version"],
                    "verdict": verdict,
                    "verdictReason": item["reason"],
                    "evidenceCount": item["evidence_count"] or 0,
                    "jobState": job_state,
                }
            )

        yield _sse_data(
            {
                "type": "progress",
                "status": scan["status"],
                "total": scan["total"],
                "cached": scan["cached"],
                "audited": scan["audited"],
                "failed": scan["failed"],
            }
        )
        if scan["status"] != "running":
            yield _sse_data({"type": "done"})
            break
        await asyncio.sleep(SSE_TICK_SECONDS)


@router.get("/panel/scan/{scan_id}/events")
async def panel_scan_events(scan_id: int, request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    async with runtime.sessionmaker() as session:
        repo_id = (
            await session.execute(
                sa.select(scans.c.repo_id).where(scans.c.id == scan_id)
            )
        ).scalar_one_or_none()
    if repo_id is None or await _authorized_repo(runtime, user["id"], repo_id) is None:
        return JSONResponse({"error": "Scan not found"}, status_code=404)

    response = StreamingResponse(
        _scan_stream(runtime, scan_id), media_type="text/event-stream"
    )
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response

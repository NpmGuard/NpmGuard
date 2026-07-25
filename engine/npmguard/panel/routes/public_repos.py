"""Public-repo audit routes.

A signed-in user can audit any *public* GitHub repository against the shared
verdict cache. **A GitHub sign-in is the whole requirement** (D-1 / F-F5): no App
installation, no repo ownership, no installation charged. That is the point of
the surface — it is the funnel's front door, and a visitor who has never
installed the App is exactly who it is for.

Endpoints:

- ``POST /panel/public-repos/scan`` — resolve the reference (SSRF-guarded),
  confirm the repo is public, dedupe + audit its root lockfile.
- ``GET  /panel/public-repos``      — the user's last 20 snapshots.
- ``GET  /panel/public-repos/:id``  — one snapshot + its dependencies.

Progress is observed on ``GET /panel/scan/{id}/events`` — the SAME stream an
owned-repo scan uses, because after R-1 both are audit sets and ``scanId`` is a set
id. There is deliberately no public-scan-specific progress transport any more; the
client-side polling loop that stood in for one was the second progress
implementation this rework exists to delete.

Every route is App-gated (503 when the App is not configured) and session-gated
(401 when not signed in). Nothing here can answer 402: a public scan is not
billed, so its ceiling is cost, and past that ceiling the scan covers fewer of
the lockfile's packages rather than being refused (see ``panel/public_limits.py``).
The one refusal is 429 on live-scan concurrency, where the honest answer really is
"wait", never "pay".
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from githubkit.exception import RequestFailed

from npmguard.contract import models as contract
from npmguard.panel.audit_set import (
    MAX_DETAIL_ITEMS,
    set_item_states,
    set_rollup,
    set_rollups,
    set_wire,
    truncated,
)
from npmguard.panel.github.content import (
    PublicRepoFileTooLargeError,
    fetch_public_repo_inputs,
)
from npmguard.panel.lockfile import (
    UnsupportedLockfileError,
    manifest_ranges,
    parse_lockfile,
)
from npmguard.panel.public_limits import TooManyLiveScansError
from npmguard.panel.routes._common import current_user, require_enabled, runtime_of
from npmguard.panel.scan.public_repo_scan import (
    CreatePublicRepoScanInput,
    InvalidPublicRepoReferenceError,
    parse_public_repo_reference,
)
from npmguard.panel.tables import audit_sets, public_repo_scans

log = structlog.get_logger("npmguard.panel.public_repos")

router = APIRouter()


def _not_signed_in() -> JSONResponse:
    return JSONResponse({"error": "Not signed in"}, status_code=401)


def _github_error(err: RequestFailed) -> JSONResponse:
    """Map a GitHub REST failure onto the public-audit wire errors."""
    status = err.response.status_code
    if status == 404:
        return JSONResponse({"error": "Public repository not found"}, status_code=404)
    if status in (403, 429):
        return JSONResponse(
            {"error": "GitHub public API limit reached — try again shortly"},
            status_code=429,
        )
    log.error("public scan github error", status=status)
    return JSONResponse(
        {"error": "Public repository audit failed — see engine logs"}, status_code=502
    )


def _scan_select() -> Any:
    """The snapshot subject joined to its SET.

    One id: `public_repo_scans.set_id` IS the snapshot's primary key, so the wire's
    `scan.id` and `scan.set.id` are the same column and cannot disagree.

    No installation is joined in any more: after D-1 a public scan has a requester
    and no payer, so there is no account behind it whose login could be shown.
    """
    return sa.select(
        public_repo_scans,
        audit_sets.c.origin,
        audit_sets.c.trigger_kind,
        audit_sets.c.requested_by,
        audit_sets.c.commit_sha,
        audit_sets.c.started_at,
        audit_sets.c.finished_at,
    ).select_from(
        public_repo_scans.join(audit_sets, audit_sets.c.id == public_repo_scans.c.set_id)
    )


def _scan_wire(row: Any, rollup: Any) -> contract.PublicRepoScan:
    """The ONE ``PublicRepoScan`` projection: subject + set, nothing duplicated."""
    return contract.PublicRepoScan(
        id=row["set_id"],
        repo=contract.PublicRepo(
            githubRepoId=row["github_repo_id"],
            owner=row["owner"],
            name=row["name"],
            fullName=row["full_name"],
            htmlUrl=row["html_url"],
            defaultBranch=row["default_branch"],
            lockfilePath=row["lockfile_path"],
            lockfileSha=row["lockfile_sha"],
            # What the LOCKFILE held. `set.rollup.total` is what this scan
            # covers, and the two differ when the cost ceiling bound the scan —
            # which is a fact the result screen has to be able to state.
            lockfileDepCount=row["dep_count"],
        ),
        set=set_wire({**row, "id": row["set_id"]}, rollup),
        requestedBy=row["requested_by"],
    )


@router.get("/panel/public-repos")
async def list_public_repos(request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    async with runtime.sessionmaker() as session:
        rows = (
            (
                await session.execute(
                    _scan_select()
                    .where(audit_sets.c.requested_by == user["id"])
                    .order_by(audit_sets.c.started_at.desc())
                    .limit(20)
                )
            )
            .mappings()
            .all()
        )
        # One rollup query for the whole list — not one per row.
        rollups = await set_rollups(session, [row["set_id"] for row in rows])
    return JSONResponse(
        {
            "scans": [
                _scan_wire(row, rollups[row["set_id"]]).model_dump(
                    mode="json", exclude_none=False
                )
                for row in rows
            ]
        }
    )


@router.get("/panel/public-repos/{scan_id}")
async def get_public_repo(scan_id: int, request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    async with runtime.sessionmaker() as session:
        row = (
            (
                await session.execute(
                    _scan_select().where(public_repo_scans.c.set_id == scan_id)
                )
            )
            .mappings()
            .first()
        )
        # Your own snapshots, and only those. `requested_by` is the set's, not the
        # subject's, which is what lets the SSE route authorize the same way
        # without re-deriving ownership from a second table.
        if row is None or row["requested_by"] != user["id"]:
            return JSONResponse({"error": "Public audit not found"}, status_code=404)

        # Same cap, same severity-first ordering, same server-computed flag as the
        # repo detail route — the truncation story is the set's, not the origin's.
        states = await set_item_states(session, scan_id, limit=MAX_DETAIL_ITEMS)
        rollup = await set_rollup(session, scan_id)

    return JSONResponse(
        {
            "scan": _scan_wire(row, rollup).model_dump(mode="json", exclude_none=False),
            "depsTruncated": truncated(rollup, len(states)),
            "deps": [
                state.as_wire().model_dump(mode="json", exclude_none=False)
                for state in states
            ],
        }
    )


@router.post("/panel/public-repos/scan")
async def scan_public_repo(request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - any malformed body is a 400
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    repository = body.get("repository")
    if not isinstance(repository, str):
        return JSONResponse({"error": "Repository is required"}, status_code=400)
    # The body is `{repository}` and nothing else. There is deliberately no
    # account to choose: the requester is the session, the scan is not billed, and
    # asking a visitor who has never installed the App to pick an installation is
    # exactly what made this surface unreachable for the people it is for (F-F5).

    try:
        reference = parse_public_repo_reference(repository)
    except InvalidPublicRepoReferenceError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    engine = runtime.panel_public_scan
    octo = runtime.gh_client.public_octokit()

    # No auth is attached to this client: a private repo 404s regardless of the
    # signed-in user's personal permissions.
    try:
        repo = (
            await octo.arequest("GET", f"/repos/{reference.owner}/{reference.repo}")
        ).json()
    except RequestFailed as err:
        return _github_error(err)
    if not isinstance(repo, dict):
        return JSONResponse({"error": "Public repository not found"}, status_code=404)
    if repo.get("private"):
        return JSONResponse(
            {"error": "Only public repositories can be audited here"}, status_code=403
        )

    canonical_owner = (repo.get("owner") or {}).get("login") or reference.owner
    canonical_name = repo.get("name") or reference.repo
    canonical_full_name = repo.get("full_name") or f"{canonical_owner}/{canonical_name}"
    github_repo_id = repo["id"]

    # Keyed on the stable github_repo_id, so a rename cannot produce a second
    # concurrent audit of the same repo. Scoped to the requester, matching
    # `ix_audit_sets_active_public` — a live scan of the same repo by SOMEONE ELSE
    # is not this user's scan and is not theirs to be handed.
    running = await engine.find_running_public_scan(user["id"], github_repo_id)
    if running is not None:
        return JSONResponse(
            {
                "error": "An audit is already running for this repository",
                "scanId": running,
            },
            status_code=409,
        )

    try:
        inputs = await fetch_public_repo_inputs(
            octo,
            canonical_owner,
            canonical_name,
            repo.get("default_branch"),
            raw_base=runtime.settings.github_raw_base,
        )
    except RequestFailed as err:
        return _github_error(err)
    except PublicRepoFileTooLargeError as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)
    if inputs is None:
        return JSONResponse(
            {
                "error": "No supported lockfile found — commit package-lock.json, "
                "pnpm-lock.yaml, or yarn.lock at the repo root"
            },
            status_code=422,
        )

    try:
        filename = inputs.lockfile.path.rsplit("/", 1)[-1]
        deps = parse_lockfile(
            filename, inputs.lockfile.content, manifest_ranges(inputs.manifest)
        )
    except UnsupportedLockfileError as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)

    try:
        scan_id = await engine.create_public_repo_scan(
            CreatePublicRepoScanInput(
                requested_by=user["id"],
                github_repo_id=github_repo_id,
                owner=canonical_owner,
                name=canonical_name,
                full_name=canonical_full_name,
                html_url=repo.get("html_url") or "",
                default_branch=repo.get("default_branch") or "main",
                # The lockfile is read at the default branch's tip; recording that
                # sha is what makes the snapshot reproducible together with the
                # lockfile blob sha. Hardcoding null here was a real bug.
                commit_sha=inputs.commit_sha,
                lockfile_path=inputs.lockfile.path,
                lockfile_sha=inputs.lockfile.sha,
                deps=deps,
            )
        )
    except TooManyLiveScansError as exc:
        return JSONResponse({"error": str(exc), "limit": exc.limit}, status_code=429)
    return JSONResponse({"scanId": scan_id}, status_code=201)


__all__ = ["router"]

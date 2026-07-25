"""Public-repo audit routes.

A signed-in user can audit any *public* GitHub repository against the shared
verdict cache.

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
(401 when not signed in). The 402 cap body ``{error, cap, resource,
installationId, entitlements}`` is what the frontend keys on for the paywall.
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
from npmguard.panel.caps import CapExceededError
from npmguard.panel.github.content import (
    PublicRepoFileTooLargeError,
    fetch_public_repo_inputs,
)
from npmguard.panel.lockfile import (
    UnsupportedLockfileError,
    manifest_ranges,
    parse_lockfile,
)
from npmguard.panel.routes._common import (
    current_user,
    panel_disabled_response,
    require_panel,
    runtime_of,
)
from npmguard.panel.scan.public_repo_scan import (
    CreatePublicRepoScanInput,
    InvalidPublicRepoReferenceError,
    parse_public_repo_reference,
)
from npmguard.panel.tables import (
    audit_sets,
    installations,
    public_repo_scans,
    user_installations,
)

log = structlog.get_logger("npmguard.panel.public_repos")

router = APIRouter()


def _not_signed_in() -> JSONResponse:
    return JSONResponse({"error": "Not signed in"}, status_code=401)


def _cap_response(exc: CapExceededError) -> JSONResponse:
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


async def _user_has_installation(
    session: Any, user_id: int, installation_id: int
) -> bool:
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


def _scan_select() -> Any:
    """The snapshot subject joined to its SET and the payer's account login.

    One id: `public_repo_scans.set_id` IS the snapshot's primary key, so the wire's
    `scan.id` and `scan.set.id` are the same column and cannot disagree.
    """
    return sa.select(
        public_repo_scans,
        audit_sets.c.origin,
        audit_sets.c.trigger_kind,
        audit_sets.c.billed_to,
        audit_sets.c.commit_sha,
        audit_sets.c.started_at,
        audit_sets.c.finished_at,
        installations.c.account_login.label("account_login"),
    ).select_from(
        public_repo_scans.join(
            audit_sets, audit_sets.c.id == public_repo_scans.c.set_id
        ).outerjoin(installations, installations.c.id == audit_sets.c.billed_to)
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
        ),
        set=set_wire({**row, "id": row["set_id"]}, rollup),
        requestedBy=row["requested_by"],
        installationId=row["billed_to"],
        accountLogin=row["account_login"],
    )


@router.get("/panel/public-repos")
async def list_public_repos(request: Request) -> Response:
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
                    _scan_select()
                    .join(
                        user_installations,
                        user_installations.c.installation_id == audit_sets.c.billed_to,
                    )
                    .where(user_installations.c.user_id == user["id"])
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
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
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
        if (
            row is None
            or row["billed_to"] is None
            or not await _user_has_installation(session, user["id"], row["billed_to"])
        ):
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
    runtime = require_panel(runtime_of(request))
    if runtime is None:
        return panel_disabled_response()
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
    installation_id = body.get("installationId")
    if (
        not isinstance(installation_id, int)
        or isinstance(installation_id, bool)
        or installation_id <= 0
    ):
        return JSONResponse(
            {"error": "Choose the account whose audit allowance should be used"},
            status_code=400,
        )

    async with runtime.sessionmaker() as session:
        if not await _user_has_installation(session, user["id"], installation_id):
            return JSONResponse(
                {"error": "GitHub installation not found"}, status_code=404
            )

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
    # concurrent audit of the same repo.
    running = await engine.find_running_public_scan(installation_id, github_repo_id)
    if running is not None:
        return JSONResponse(
            {
                "error": "An audit is already running for this repository",
                "scanId": running,
            },
            status_code=409,
        )

    try:
        await runtime.panel_caps.assert_public_repo_audit_cap(
            installation_id, github_repo_id
        )
    except CapExceededError as exc:
        return _cap_response(exc)

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
                installation_id=installation_id,
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
    except CapExceededError as exc:
        return _cap_response(exc)
    return JSONResponse({"scanId": scan_id}, status_code=201)


__all__ = ["router"]

"""Public-repo audit routes (port of TS ``routes/public-repos.ts``).

A signed-in user can audit any *public* GitHub repository against the shared
verdict cache. Progress is observed by **polling** — there is deliberately no
SSE here (contrast the protected-repo scan stream in ``routes/panel.py``).

Endpoints (§1c of the port plan):

- ``POST /panel/public-repos/scan`` — resolve the reference (SSRF-guarded),
  confirm the repo is public, dedupe + audit its root lockfile.
- ``GET  /panel/public-repos``      — the user's last 20 snapshots.
- ``GET  /panel/public-repos/:id``  — one snapshot + its dependencies.

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
from npmguard.panel.routes._common import current_user, require_enabled, runtime_of
from npmguard.panel.scan.public_repo_scan import (
    CreatePublicRepoScanInput,
    InvalidPublicRepoReferenceError,
    PublicRepoScanEngine,
    compute_public_scan_rollup,
    parse_public_repo_reference,
)
from npmguard.panel.tables import (
    installations,
    package_verdicts,
    panel_jobs,
    public_repo_scan_items,
    public_repo_scans,
    user_installations,
)

log = structlog.get_logger("npmguard.panel.public_repos")

router = APIRouter()

# Cap the detail payload; large monorepos can carry thousands of transitive deps.
MAX_DETAIL_DEPS = 500


def _public_engine(runtime: Any) -> PublicRepoScanEngine:
    """Build the public-scan engine from the runtime's panel collaborators."""
    return PublicRepoScanEngine(
        sessions=runtime.sessionmaker,
        caps=runtime.panel_caps,
        verdict_index=runtime.panel_verdicts,
        queue=runtime.panel_queue,
    )


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


async def _serialize_scan(session: Any, row: Any) -> dict[str, Any]:
    """The ``PublicScan`` wire shape (§1c), including the computed rollup."""
    rollup = await compute_public_scan_rollup(session, row["id"])
    return {
        "id": row["id"],
        "installationId": row["installation_id"],
        "accountLogin": row["account_login"],
        "requestedBy": row["requested_by"],
        "githubRepoId": row["github_repo_id"],
        "owner": row["owner"],
        "name": row["name"],
        "fullName": row["full_name"],
        "htmlUrl": row["html_url"],
        "defaultBranch": row["default_branch"],
        "commitSha": row["commit_sha"],
        "lockfilePath": row["lockfile_path"],
        "lockfileSha": row["lockfile_sha"],
        "status": row["status"],
        "total": row["total"],
        "cached": row["cached"],
        "audited": row["audited"],
        "failed": row["failed"],
        "error": row["error"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        "rollup": rollup.as_wire(),
    }


def _scan_select() -> Any:
    """``public_repo_scans`` joined to ``installations`` for ``account_login``."""
    return sa.select(
        public_repo_scans,
        installations.c.account_login.label("account_login"),
    ).select_from(
        public_repo_scans.join(
            installations, installations.c.id == public_repo_scans.c.installation_id
        )
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
                    .join(
                        user_installations,
                        user_installations.c.installation_id
                        == public_repo_scans.c.installation_id,
                    )
                    .where(user_installations.c.user_id == user["id"])
                    .order_by(public_repo_scans.c.started_at.desc())
                    .limit(20)
                )
            )
            .mappings()
            .all()
        )
        scans = [await _serialize_scan(session, row) for row in rows]
    return JSONResponse({"scans": scans})


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
                    _scan_select().where(public_repo_scans.c.id == scan_id)
                )
            )
            .mappings()
            .first()
        )
        if row is None or not await _user_has_installation(
            session, user["id"], row["installation_id"]
        ):
            return JSONResponse({"error": "Public audit not found"}, status_code=404)

        # Severity-DESC (DANGEROUS>SUSPECT>UNKNOWN/null>SAFE) then direct then name.
        severity = sa.case(
            (package_verdicts.c.verdict == "DANGEROUS", 4),
            (package_verdicts.c.verdict == "SUSPECT", 3),
            (package_verdicts.c.verdict == "UNKNOWN", 2),
            (package_verdicts.c.verdict == "SAFE", 1),
            else_=2,
        )
        active_exists = (
            sa.select(sa.literal(1))
            .select_from(panel_jobs)
            .where(
                panel_jobs.c.package_name == public_repo_scan_items.c.name,
                panel_jobs.c.version == public_repo_scan_items.c.version,
                panel_jobs.c.state.in_(("queued", "running")),
            )
            .exists()
        )
        dep_rows = (
            (
                await session.execute(
                    sa.select(
                        public_repo_scan_items.c.name,
                        public_repo_scan_items.c.version,
                        public_repo_scan_items.c.direct,
                        public_repo_scan_items.c.range,
                        public_repo_scan_items.c.cached,
                        package_verdicts.c.verdict,
                        package_verdicts.c.reason,
                        package_verdicts.c.evidence_count,
                        package_verdicts.c.audited_at,
                        active_exists.label("active"),
                    )
                    .select_from(
                        public_repo_scan_items.outerjoin(
                            package_verdicts,
                            sa.and_(
                                package_verdicts.c.name
                                == public_repo_scan_items.c.name,
                                package_verdicts.c.version
                                == public_repo_scan_items.c.version,
                            ),
                        )
                    )
                    .where(public_repo_scan_items.c.scan_id == scan_id)
                    .order_by(
                        severity.desc(),
                        public_repo_scan_items.c.direct.desc(),
                        public_repo_scan_items.c.name,
                    )
                    .limit(MAX_DETAIL_DEPS)
                )
            )
            .mappings()
            .all()
        )
        scan = await _serialize_scan(session, row)

    dependencies = [
        {
            "name": dep["name"],
            "version": dep["version"],
            "direct": bool(dep["direct"]),
            "range": dep["range"],
            "cached": bool(dep["cached"]),
            "verdict": dep["verdict"],
            "reason": dep["reason"],
            "evidenceCount": dep["evidence_count"] or 0,
            "auditedAt": dep["audited_at"],
            "active": bool(dep["active"]),
        }
        for dep in dep_rows
    ]
    return JSONResponse(
        {
            "scan": scan,
            # total is the full item count; a truncated LIMIT means more exist.
            "dependenciesTruncated": row["total"] > len(dependencies),
            "dependencies": dependencies,
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
    installation_id = body.get("installationId")
    if not isinstance(installation_id, int) or isinstance(installation_id, bool) or installation_id <= 0:
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

    engine = _public_engine(runtime)
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
        return JSONResponse(
            {"error": "Public repository not found"}, status_code=404
        )
    if repo.get("private"):
        return JSONResponse(
            {"error": "Only public repositories can be audited here"}, status_code=403
        )

    canonical_owner = (repo.get("owner") or {}).get("login") or reference.owner
    canonical_name = repo.get("name") or reference.repo
    canonical_full_name = repo.get("full_name") or f"{canonical_owner}/{canonical_name}"
    github_repo_id = repo["id"]

    running = await engine.find_running_public_scan(
        installation_id, canonical_full_name
    )
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
                commit_sha=None,
                lockfile_path=inputs.lockfile.path,
                lockfile_sha=inputs.lockfile.sha,
                deps=deps,
            )
        )
    except CapExceededError as exc:
        return _cap_response(exc)
    return JSONResponse({"scanId": scan_id}, status_code=201)

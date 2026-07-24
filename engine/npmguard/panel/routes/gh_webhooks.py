"""GitHub App webhooks (port of TS ``routes/gh-webhooks.ts``).

The delivery is HMAC-verified against the **raw** request body (read before any
parsing), then the handler responds ``202`` fast and does the work in an
``asyncio`` task — GitHub's delivery has a ~10s timeout, and a push can trigger
a full dependency scan.

Events handled:

- ``installation`` — ``deleted`` cascade-deletes the installation's repos (via
  the ``installations`` FK cascade) and re-syncs the watch list; ``created``
  upserts the installation + any repositories in the payload; other actions
  (suspend/unsuspend/permissions) just upsert the installation. (TS cancels the
  Stripe subscription first; that is deferred to the billing stage — here we
  cascade-delete and log.)
- ``installation_repositories`` — ``added`` upserts, ``removed`` deletes + re-
  syncs the watch list.
- ``push`` — a root lockfile / ``package.json`` change invalidates the cached
  auditability marker; if the repo is protected, opens a GitHub check and runs a
  delta scan.

The push handler is what keeps ``repo_deps`` fresh — the substrate registry-watch
alerts from.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
from typing import Any

import sqlalchemy as sa
import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from kit_spine import now_iso
from npmguard.panel.github.checks import create_check_run
from npmguard.panel.lockfile import LOCKFILE_CANDIDATES
from npmguard.panel.routes._common import runtime_of
from npmguard.panel.scan.repo_scan import LockfileNotFoundError
from npmguard.panel.tables import installations, repos
from npmguard.panel.watch import sync_watched_packages

log = structlog.get_logger("npmguard.panel.webhooks")

router = APIRouter()

# Paths that, when touched at the repo ROOT, change what the repo installs.
_DEPENDENCY_FILES = frozenset({*LOCKFILE_CANDIDATES, "package.json"})
_ALL_ZERO_SHA = re.compile(r"^0+$")

# Hold references to in-flight background tasks so they aren't GC'd mid-run.
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()


def verify_signature(secret: str, raw_body: bytes, signature: str | None) -> bool:
    """Constant-time HMAC-SHA256 verify of ``x-hub-signature-256``.

    The header is ``sha256=<hex>``. A missing/short/mismatched signature is
    rejected. ``hmac.compare_digest`` avoids a timing side-channel.
    """
    if not signature:
        return False
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def touches_dependencies(payload: dict[str, Any]) -> bool:
    """Did this push add/modify/remove a ROOT lockfile or ``package.json``?

    Webhook file paths are repo-relative, so an exact match against the watched
    filenames is a root-level-only test — a nested ``pkg/package.json`` does not
    count.
    """
    commits = list(payload.get("commits") or [])
    head = payload.get("head_commit")
    if head:
        commits.append(head)
    for commit in commits:
        if not isinstance(commit, dict):
            continue
        for key in ("added", "modified", "removed"):
            for path in commit.get(key) or []:
                if path in _DEPENDENCY_FILES:
                    return True
    return False


@router.post("/webhooks/github")
async def github_webhook(request: Request) -> Response:
    runtime = runtime_of(request)
    settings = runtime.settings
    if not settings.github_app_enabled or not settings.github_webhook_secret:
        return JSONResponse(
            {"error": "GitHub webhooks are not configured"}, status_code=503
        )

    # RAW body BEFORE parsing — the HMAC covers the exact bytes GitHub signed.
    raw = await request.body()
    signature = request.headers.get("x-hub-signature-256")
    if not verify_signature(settings.github_webhook_secret, raw, signature):
        return JSONResponse({"error": "Invalid webhook signature"}, status_code=401)

    try:
        payload = json.loads(raw)
    except ValueError:
        return JSONResponse({"error": "Invalid JSON payload"}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"error": "Invalid JSON payload"}, status_code=400)

    event = request.headers.get("x-github-event")
    _schedule(_handle_event(runtime, event, payload))
    return JSONResponse({"ok": True}, status_code=202)


def _schedule(coro: Any) -> None:
    task = asyncio.create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


async def _handle_event(runtime: Any, event: str | None, payload: dict[str, Any]) -> None:
    try:
        if event == "installation":
            await _handle_installation(runtime, payload)
        elif event == "installation_repositories":
            await _handle_installation_repositories(runtime, payload)
        elif event == "push":
            await _handle_push(runtime, payload)
        # ping and unsubscribed events are ignored.
    except Exception:  # noqa: BLE001 - a webhook must never crash the server
        log.exception("webhook handling failed", event=event)


# --- installation lifecycle -------------------------------------------------


async def _handle_installation(runtime: Any, payload: dict[str, Any]) -> None:
    action = payload.get("action")
    installation = payload.get("installation") or {}
    installation_id = installation.get("id")
    if installation_id is None:
        return

    if action == "deleted":
        async with runtime.sessionmaker() as session, session.begin():
            # Cascades to repos -> repo_deps / scans via the FK.
            await session.execute(
                installations.delete().where(installations.c.id == installation_id)
            )
        await sync_watched_packages(runtime.sessionmaker)
        log.info("installation deleted", installation_id=installation_id)
        return

    await _upsert_installation(runtime, installation)
    if action == "created":
        repositories = payload.get("repositories") or []
        if repositories:
            await _upsert_repos(runtime, installation_id, repositories)


async def _handle_installation_repositories(runtime: Any, payload: dict[str, Any]) -> None:
    installation = payload.get("installation") or {}
    installation_id = installation.get("id")
    if installation_id is None:
        return
    await _upsert_installation(runtime, installation)

    added = payload.get("repositories_added") or []
    removed = payload.get("repositories_removed") or []
    if added:
        await _upsert_repos(runtime, installation_id, added)
    if removed:
        ids = [r["id"] for r in removed if isinstance(r, dict) and r.get("id") is not None]
        if ids:
            async with runtime.sessionmaker() as session, session.begin():
                await session.execute(repos.delete().where(repos.c.id.in_(ids)))
            await sync_watched_packages(runtime.sessionmaker)


async def _upsert_installation(runtime: Any, installation: dict[str, Any]) -> None:
    account = installation.get("account") or {}
    now = now_iso()
    values = {
        "account_login": account.get("login") or account.get("slug") or "unknown",
        "account_type": account.get("type") or "Organization",
        "suspended": bool(installation.get("suspended_at")),
        "updated_at": now,
    }
    async with runtime.sessionmaker() as session, session.begin():
        exists = (
            await session.execute(
                sa.select(installations.c.id).where(
                    installations.c.id == installation["id"]
                )
            )
        ).scalar_one_or_none()
        if exists is None:
            await session.execute(
                installations.insert().values(
                    id=installation["id"], created_at=now, **values
                )
            )
        else:
            await session.execute(
                installations.update()
                .where(installations.c.id == installation["id"])
                .values(**values)
            )


async def _upsert_repos(
    runtime: Any, installation_id: int, repositories: list[dict[str, Any]]
) -> None:
    now = now_iso()
    async with runtime.sessionmaker() as session, session.begin():
        for repo in repositories:
            if not isinstance(repo, dict) or repo.get("id") is None:
                continue
            full_name = repo.get("full_name") or repo.get("name") or ""
            owner = full_name.split("/")[0] if "/" in full_name else ""
            values = {
                "installation_id": installation_id,
                "owner": owner,
                "name": repo.get("name") or "",
                "full_name": full_name,
                "private": bool(repo.get("private")),
                "default_branch": repo.get("default_branch") or "main",
                "updated_at": now,
            }
            exists = (
                await session.execute(
                    sa.select(repos.c.id).where(repos.c.id == repo["id"])
                )
            ).scalar_one_or_none()
            if exists is None:
                await session.execute(
                    repos.insert().values(id=repo["id"], created_at=now, **values)
                )
            else:
                # Don't clobber protect/lockfile state on a metadata refresh.
                values.pop("default_branch", None)
                await session.execute(
                    repos.update().where(repos.c.id == repo["id"]).values(**values)
                )


# --- push -------------------------------------------------------------------


async def _handle_push(runtime: Any, payload: dict[str, Any]) -> None:
    repository = payload.get("repository") or {}
    repo_id = repository.get("id")
    head_sha = payload.get("after")
    ref = payload.get("ref") or ""
    branch = ref[len("refs/heads/") :] if ref.startswith("refs/heads/") else ""
    if not repo_id or not head_sha or not branch or _ALL_ZERO_SHA.match(head_sha):
        return  # branch deletion / malformed push

    async with runtime.sessionmaker() as session:
        repo = (
            (await session.execute(sa.select(repos).where(repos.c.id == repo_id)))
            .mappings()
            .one_or_none()
        )
    if repo is None:
        return
    repo = dict(repo)

    touched = touches_dependencies(payload)
    if touched:
        # The cached auditability classification may have changed; the next
        # /panel/repos re-probes the root before deciding to show the repo.
        now = now_iso()
        async with runtime.sessionmaker() as session, session.begin():
            await session.execute(
                repos.update()
                .where(repos.c.id == repo_id)
                .values(auditability_checked_at=None, updated_at=now)
            )
    if not repo.get("protected_at") or not touched:
        return  # Protect off, or nothing dependency-relevant changed

    log.info("push delta scan", repo=repo["full_name"], branch=branch)
    check_run_id = None
    if runtime.gh_client is not None:
        octo = runtime.gh_client.installation_octokit(repo["installation_id"])
        check_run_id = await create_check_run(
            octo, repo["owner"], repo["name"], head_sha
        )
    try:
        await runtime.panel_scan.delta_repo_scan(repo, branch, head_sha, check_run_id)
    except LockfileNotFoundError:
        log.warning(
            "push lockfile gone — skipping",
            repo=repo["full_name"],
            sha=head_sha[:7],
        )


__all__ = ["router", "touches_dependencies", "verify_signature"]

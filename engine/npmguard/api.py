from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)
from pydantic import BaseModel
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from kit_llm import LlmClient
from kit_spine import (
    RequestIdMiddleware,
    make_engine,
    make_notifier,
    make_session_factory,
    register_error_handlers,
    setup_logging,
)
from kit_spine.db import metadata
from kit_stream import StreamService

from .bench import list_benchmark_runs
from .config import REPO_ROOT, Settings, get_settings
from .demo import DemoService
from .errors import NpmGuardError, QueueFullError
from .events import sse_events
from .llm_runtime import build_npmguard_llm
from .panel.alerts.notify import handle_dangerous_verdict
from .panel.billing import BillingStore
from .panel.caps import CapsStore
from .panel.github.checks import check_conclusion, check_summary, conclude_check_run
from .panel.github.client import GitHubAppClient
from .panel.github.content import fetch_lockfile, fetch_manifest
from .panel.jobs import PanelJobQueue, PanelWorkerPool
from .panel.lockfile import manifest_ranges, parse_lockfile
from .panel.routes.auth import router as panel_auth_router
from .panel.routes.billing import router as panel_billing_router
from .panel.routes.gh_webhooks import router as panel_webhooks_router
from .panel.routes.panel import router as panel_router
from .panel.routes.public_repos import router as panel_public_repos_router
from .panel.scan.public_repo_scan import PublicRepoScanEngine
from .panel.scan.repo_scan import LockfileNotFoundError, ParsedRepoDeps, RepoScanEngine
from .panel.sessions import PanelSessionStore
from .panel.stores import GhUserStore, InstallationStore, RepoStore
from .panel.verdict_index import SavedReport, VerdictIndex
from .panel.watch import Reconciler, RegistryWatcher, sync_watched_packages
from .payments import (
    ChainVerificationError,
    chain_contract,
    construct_webhook_event,
    create_checkout_session,
    handle_subscription_event,
    is_chain_configured,
    read_audit_fee,
    verify_audit_payment,
    verify_checkout_session,
)
from .persistence import AuditSession, AuditSessionStore
from .pipeline import AuditPipeline
from .report_store import list_reports, load_report
from .resolve import resolve_tarball_url
from .service import AuditService
from .validation import (
    AuditRequest,
    CheckoutRequest,
    StreamAuditRequest,
    valid_package_name,
    valid_semver,
)

log = structlog.get_logger("npmguard.api")


@dataclass(frozen=True)
class Runtime:
    settings: Settings
    engine: AsyncEngine
    sessions: AuditSessionStore
    stream: StreamService
    llm: LlmClient
    audits: AuditService
    demos: DemoService
    # Panel state — populated only when settings.github_app_enabled; otherwise
    # None and every panel route returns 503, so the engine behaves identically.
    sessionmaker: async_sessionmaker | None = None
    gh_client: GitHubAppClient | None = None
    panel_sessions: PanelSessionStore | None = None
    gh_users: GhUserStore | None = None
    panel_installations: InstallationStore | None = None
    panel_repos: RepoStore | None = None
    panel_caps: CapsStore | None = None
    panel_verdicts: VerdictIndex | None = None
    panel_queue: PanelJobQueue | None = None
    panel_scan: RepoScanEngine | None = None
    panel_public_scan: PublicRepoScanEngine | None = None
    panel_billing: BillingStore | None = None
    panel_workers: PanelWorkerPool | None = None
    # Registry-watch + reconcile background loops (asyncio tasks, not
    # setInterval). Started in lifespan when the App is enabled, cancelled +
    # awaited on shutdown BEFORE audits.close().
    panel_watch_task: asyncio.Task[None] | None = None
    panel_reconcile_task: asyncio.Task[None] | None = None


def _runtime(request: Request) -> Runtime:
    return request.app.state.runtime


def _saved_reports() -> list[SavedReport]:
    """The on-disk reports as :class:`SavedReport` records for the verdict-index
    boot rebuild. ``list_reports`` gives identity + verdict summaries; the full
    report is loaded to extract rationale + confirmed-hypothesis evidence."""
    records: list[SavedReport] = []
    for summary in list_reports():
        loaded = load_report(summary["packageName"], summary["version"])
        if loaded is None:
            continue
        report, _ = loaded
        records.append(
            SavedReport(
                name=summary["packageName"],
                version=summary["version"],
                report=report,
                audited_at=summary["auditedAt"],
            )
        )
    return records


def _make_fetch_repo_deps(gh_client: GitHubAppClient):
    """Build the RepoScanEngine's fetch+parse seam over the installation client.

    Fetches the root lockfile (+ manifest for direct-dep ranges) via the App
    installation octokit and parses it into normalized deps.
    :class:`LockfileNotFoundError` when the repo has no supported root lockfile.
    """

    async def fetch_repo_deps(repo: Any, ref: str | None) -> ParsedRepoDeps:
        octo = gh_client.installation_octokit(repo["installation_id"])
        owner, name = repo["owner"], repo["name"]
        lockfile = await fetch_lockfile(octo, owner, name, ref)
        if lockfile is None:
            raise LockfileNotFoundError()
        manifest = await fetch_manifest(octo, owner, name, ref)
        ranges = manifest_ranges(manifest)
        filename = lockfile.path.rsplit("/", 1)[-1]
        deps = parse_lockfile(filename, lockfile.content, ranges)
        return ParsedRepoDeps(
            deps=deps, lockfile_path=lockfile.path, lockfile_sha=lockfile.sha
        )

    return fetch_repo_deps


async def _body[T: BaseModel](
    request: Request, model: type[T]
) -> tuple[T | None, JSONResponse | None]:
    try:
        payload = await request.json()
    except Exception:
        return None, JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    try:
        return model.model_validate(payload), None
    except PydanticValidationError as exc:
        return None, JSONResponse(
            {
                "error": "Invalid request",
                "details": exc.errors(include_url=False, include_context=False),
            },
            status_code=400,
        )


def _audit_error(exc: Exception) -> JSONResponse:
    return JSONResponse(
        {
            "error": "Audit failed",
            "message": str(exc) or type(exc).__name__,
            "code": exc.code if isinstance(exc, NpmGuardError) else "NPMGUARD-9999",
            "retryable": exc.retryable if isinstance(exc, NpmGuardError) else False,
        },
        status_code=exc.http_status if isinstance(exc, NpmGuardError) else 500,
    )


def _consume_future(future: asyncio.Future[Any]) -> None:
    if not future.cancelled():
        future.exception()


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _audit_file_path(package_path: str, file_path: str) -> tuple[Path, Path]:
    root = Path(package_path).resolve()
    return root, (root / file_path).resolve()


async def _claim_stripe(runtime: Runtime, session_id: str) -> tuple[AuditSession, str]:
    # Idempotent pre-read: an already-claimed session (e.g. bound by a webhook that
    # never went through the engine's own checkout API) is returned as-is WITHOUT
    # re-verifying — a claimed Stripe session must never be re-hit against Stripe.
    # submit() downstream is a no-op on the resulting terminal/owned row.
    existing = await runtime.sessions.payment("stripe", session_id)
    if existing:
        session = await runtime.sessions.get(existing["audit_id"])
        assert session is not None
        return session, existing["package_name"]
    verification = await verify_checkout_session(runtime.settings, session_id)
    if not verification["paid"]:
        raise PermissionError("Payment not completed")
    package_name = verification["packageName"]
    version = verification["version"]
    # Capacity check BEFORE the claim: a QueueFull refusal never consumes the
    # payment proof (client retries the same session id).
    await runtime.audits.reserve()
    session, _created = await runtime.sessions.claim_payment(
        "stripe", session_id, package_name, version
    )
    return session, package_name


router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/audit")
async def audit(request: Request) -> JSONResponse:
    parsed, error = await _body(request, AuditRequest)
    if error:
        return error
    assert parsed is not None
    runtime = _runtime(request)
    is_cre = (
        bool(runtime.settings.cre_api_key)
        and request.headers.get("x-api-key") == runtime.settings.cre_api_key
    )
    if not is_cre and runtime.settings.payment_required:
        return JSONResponse(
            {
                "error": "Payment required. Use /checkout or /audit/stream with a verified payment proof."
            },
            status_code=402,
        )
    try:
        result = await runtime.audits.admit(parsed.packageName, parsed.version)
        if is_cre:
            result.future.add_done_callback(_consume_future)
            return JSONResponse(
                {
                    "status": "accepted",
                    "auditId": result.audit_id,
                    "packageName": parsed.packageName,
                    "version": parsed.version,
                    "queuePosition": result.queue_position,
                },
                status_code=202,
            )
        return JSONResponse(await result.future)
    except Exception as exc:
        return _audit_error(exc)


@router.post("/audit/stream")
async def start_stream(request: Request) -> JSONResponse:
    parsed, error = await _body(request, StreamAuditRequest)
    if error:
        return error
    assert parsed is not None
    runtime = _runtime(request)

    if parsed.txHash:
        chain = parsed.chain or "base-sepolia"
        if not is_chain_configured(runtime.settings, chain):
            return JSONResponse(
                {"error": f"Chain {chain} is not configured on this engine"}, status_code=501
            )
        if not parsed.packageName or not parsed.version:
            return JSONResponse(
                {"error": "packageName and version are required with txHash"}, status_code=400
            )
        provider = f"chain:{chain}"
        try:
            verified = await verify_audit_payment(
                runtime.settings, chain, parsed.txHash, parsed.packageName, parsed.version
            )
        except ChainVerificationError as exc:
            return JSONResponse({"error": str(exc)}, status_code=402)
        except Exception:
            log.exception("chain verification failed", chain=chain)
            return JSONResponse({"error": "Chain verification failed"}, status_code=500)
        # verify -> reserve -> claim -> submit. reserve() BEFORE claim_payment so a
        # QueueFull refusal (503 retryable) never consumes the tx proof; claim_payment
        # is idempotent (replayed tx -> existing session) and submit() dedupes by
        # audit_id, so a replay never launches twice.
        try:
            await runtime.audits.reserve()
            session, _created = await runtime.sessions.claim_payment(
                provider,
                parsed.txHash,
                verified.package_name,
                verified.version,
                requester=verified.requester,
            )
            result = await runtime.audits.submit(session)
            # Fire-and-forget: the client follows via SSE, so retrieve the future's
            # eventual exception here or asyncio warns "never retrieved" on a failed audit.
            result.future.add_done_callback(_consume_future)
        except Exception as exc:
            return _audit_error(exc)
        return JSONResponse(
            {"auditId": session.audit_id, "packageName": verified.package_name}
        )

    if parsed.stripeSessionId:
        if not runtime.settings.stripe_secret_key:
            return JSONResponse({"error": "Stripe payments not configured"}, status_code=501)
        try:
            session, package_name = await _claim_stripe(runtime, parsed.stripeSessionId)
        except QueueFullError as exc:
            return _audit_error(exc)  # capacity refusal — before any claim, retryable 503
        except Exception:
            log.exception("stripe verification failed")
            return JSONResponse({"error": "Payment verification failed"}, status_code=402)
        result = await runtime.audits.submit(session)
        result.future.add_done_callback(_consume_future)  # fire-and-forget; retrieve exc
        return JSONResponse({"auditId": session.audit_id, "packageName": package_name})

    if not runtime.settings.payment_required:
        if not parsed.packageName:
            return JSONResponse({"error": "packageName is required"}, status_code=400)
        try:
            result = await runtime.audits.admit(parsed.packageName, parsed.version)
        except Exception as exc:
            return _audit_error(exc)
        result.future.add_done_callback(_consume_future)  # fire-and-forget; retrieve exc
        return JSONResponse({"auditId": result.audit_id, "packageName": parsed.packageName})

    return JSONResponse(
        {"error": "Payment required. Use /checkout or provide txHash + chain."},
        status_code=402,
    )


@router.get("/audit/{audit_id}/events")
async def events(audit_id: str, request: Request) -> Response:
    runtime = _runtime(request)
    session = await runtime.sessions.get(audit_id)
    if session is None:
        return JSONResponse({"error": "Audit session not found"}, status_code=404)
    cursor_value = request.headers.get("last-event-id") or request.query_params.get("since") or "-1"
    try:
        cursor = int(cursor_value)
    except ValueError:
        cursor = -1
    response = StreamingResponse(
        sse_events(
            audit_id,
            runtime.stream,
            after=cursor,
            follow=session.status in ("queued", "running"),
        ),
        media_type="text/event-stream",
    )
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@router.get("/audit/{audit_id}/file/{file_path:path}")
async def audit_file(audit_id: str, file_path: str, request: Request) -> Response:
    session = await _runtime(request).sessions.get(audit_id)
    if session is None:
        return JSONResponse({"error": "Audit session not found"}, status_code=404)
    if not session.package_path:
        return JSONResponse({"error": "Package not yet resolved"}, status_code=404)
    if session.file_contents is not None:
        content = session.file_contents.get(file_path)
        return (
            PlainTextResponse(content)
            if content is not None
            else JSONResponse({"error": "File not found"}, status_code=404)
        )
    root, target = _audit_file_path(session.package_path, file_path)
    if not target.is_relative_to(root):
        return JSONResponse({"error": "Path traversal denied"}, status_code=403)
    try:
        content = await asyncio.to_thread(target.read_text, encoding="utf-8")
    except (OSError, UnicodeError):
        return JSONResponse({"error": "File not found"}, status_code=404)
    return PlainTextResponse(content)


@router.get("/audit/{audit_id}/report")
async def audit_report(audit_id: str, request: Request) -> JSONResponse:
    session = await _runtime(request).sessions.get(audit_id)
    if session is None:
        return JSONResponse({"error": "Audit session not found"}, status_code=404)
    if session.status in ("queued", "running"):
        return JSONResponse({"status": session.status}, status_code=202)
    if session.report is not None:
        return JSONResponse(session.report)
    return JSONResponse(
        {"error": "Audit failed", "message": session.error or "Unknown audit failure"},
        status_code=500,
    )


@router.post("/checkout")
async def checkout(request: Request) -> JSONResponse:
    runtime = _runtime(request)
    if not runtime.settings.stripe_secret_key:
        return JSONResponse({"error": "Stripe payments not configured"}, status_code=501)
    parsed, error = await _body(request, CheckoutRequest)
    if error:
        return error
    assert parsed is not None
    version = parsed.version or "latest"
    if not parsed.packageName.startswith("test-pkg-"):
        try:
            await resolve_tarball_url(parsed.packageName, version)
        except Exception:
            return JSONResponse(
                {"error": f"Package {parsed.packageName}@{version} not found on npm"},
                status_code=404,
            )
    origin = request.headers.get("origin") or (
        request.headers.get("referer") or "https://npmguard.com"
    ).rstrip("/")
    try:
        url, session_id = await create_checkout_session(
            runtime.settings,
            package_name=parsed.packageName,
            version=version,
            email=str(parsed.email) if parsed.email else None,
            origin=origin,
        )
        return JSONResponse({"url": url, "sessionId": session_id})
    except Exception:
        log.exception("stripe checkout creation failed")
        return JSONResponse({"error": "Payment system error"}, status_code=500)


@router.get("/checkout/{session_id}/status")
async def checkout_status(session_id: str, request: Request) -> JSONResponse:
    runtime = _runtime(request)
    if not runtime.settings.stripe_secret_key:
        return JSONResponse({"error": "Stripe payments not configured"}, status_code=501)
    existing = await runtime.sessions.payment("stripe", session_id)
    if existing:
        return JSONResponse(
            {
                "paid": True,
                "packageName": existing["package_name"],
                "version": existing["version"],
                "auditId": existing["audit_id"],
            }
        )
    try:
        verification = await verify_checkout_session(runtime.settings, session_id)
        return JSONResponse(
            {
                "paid": verification["paid"],
                "packageName": verification["packageName"],
                "version": verification["version"],
            }
        )
    except Exception:
        return JSONResponse({"error": "Invalid session"}, status_code=400)


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request) -> JSONResponse:
    runtime = _runtime(request)
    if not runtime.settings.stripe_secret_key or not runtime.settings.stripe_webhook_secret:
        return JSONResponse({"error": "Webhook not configured"}, status_code=501)
    signature = request.headers.get("stripe-signature")
    if not signature:
        return JSONResponse({"error": "Missing signature"}, status_code=400)
    try:
        event = construct_webhook_event(runtime.settings, await request.body(), signature)
    except Exception:
        return JSONResponse({"error": "Invalid signature"}, status_code=400)
    if _field(event, "type") == "checkout.session.completed":
        stripe_session = _field(_field(event, "data"), "object")
        metadata_value = _field(stripe_session, "metadata", {}) or {}
        package_name = _field(metadata_value, "packageName")
        version = _field(metadata_value, "version") or "latest"
        session_id = _field(stripe_session, "id")
        if package_name and session_id:
            try:
                # HMAC-verified metadata is the proof; reserve -> claim -> submit.
                # A QueueFull here returns non-200 so Stripe redelivers (never a
                # dropped claim); claim_payment + submit are idempotent on replay.
                await runtime.audits.reserve()
                session, _created = await runtime.sessions.claim_payment(
                    "stripe", session_id, package_name, version
                )
                result = await runtime.audits.submit(session)
                result.future.add_done_callback(_consume_future)  # fire-and-forget

            except Exception:
                log.exception("webhook failed to start audit", package_name=package_name)
                return JSONResponse({"error": "Failed to start audit"}, status_code=500)
    # Repo-panel subscription billing coexists with the one-off audit branch
    # above: handle_subscription_event only acts on subscription-kind checkout
    # sessions + customer.subscription.* events (returns None otherwise), so the
    # one-off flow is untouched. Only runs when the panel is configured.
    if runtime.panel_billing is not None:
        try:
            await handle_subscription_event(
                runtime.settings, event, runtime.panel_billing
            )
        except Exception:
            log.exception("subscription webhook handling failed")
            return JSONResponse(
                {"error": "Failed to process subscription event"}, status_code=500
            )
    return JSONResponse({"received": True})


@router.get("/config/public")
async def public_config(request: Request) -> JSONResponse:
    runtime = _runtime(request)
    settings = runtime.settings
    base = {
        "paymentRequired": settings.payment_required,
        "paymentEnabled": settings.payment_required,
        "stripeEnabled": bool(settings.stripe_secret_key),
        "priceCents": settings.audit_price_cents,
    }
    if not is_chain_configured(settings, "base-sepolia"):
        return JSONResponse({**base, "crypto": None})
    try:
        fee = await read_audit_fee(settings, "base-sepolia")
        return JSONResponse(
            {
                **base,
                "crypto": {
                    "chain": "base-sepolia",
                    "chainId": 84532,
                    "contract": chain_contract(settings, "base-sepolia"),
                    "auditFeeWei": str(fee) if fee is not None else None,
                },
            }
        )
    except Exception:
        log.warning("failed to read audit fee")
        return JSONResponse({**base, "crypto": None})


@router.get("/demo/packages")
async def demo_packages(request: Request) -> dict[str, list[str]]:
    return {"packages": list(_runtime(request).demos.recordings)}


@router.post("/demo/start")
async def demo_start(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    package_name = payload.get("packageName") if isinstance(payload, dict) else None
    if not package_name:
        return JSONResponse({"error": "packageName is required"}, status_code=400)
    try:
        return JSONResponse(await _runtime(request).demos.start(package_name))
    except KeyError as exc:
        return JSONResponse({"error": exc.args[0]}, status_code=404)


@router.get("/packages")
async def packages(request: Request) -> Response:
    index = REPO_ROOT / "frontend" / "dist" / "index.html"
    if "text/html" in request.headers.get("accept", "") and index.exists():
        return FileResponse(index)
    return JSONResponse({"packages": list_reports()})


@router.get("/package/{name:path}/report")
async def package_report(name: str, request: Request) -> JSONResponse:
    version = request.query_params.get("version")
    try:
        valid_package_name(name)
        if version:
            valid_semver(version)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    result = load_report(name, version)
    if result is None:
        suffix = f"@{version}" if version else ""
        return JSONResponse({"error": f"No audit report found for {name}{suffix}"}, status_code=404)
    report, resolved_version = result
    return JSONResponse({"report": report, "version": resolved_version, "packageName": name})


@router.get("/resolve/{name:path}")
async def resolve(name: str, request: Request) -> JSONResponse:
    version = request.query_params.get("version", "latest")
    try:
        valid_package_name(name)
        resolved_version, _ = await resolve_tarball_url(name, version)
        return JSONResponse({"packageName": name, "version": resolved_version})
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:
        return JSONResponse({"error": str(exc) or "Resolution failed"}, status_code=404)


@router.get("/bench/results")
async def benchmark_results() -> dict[str, Any]:
    return await asyncio.to_thread(list_benchmark_runs)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.mock_llm and settings.env == "prod":
        raise RuntimeError(
            "Refusing to start: NPMGUARD_MOCK_LLM=true is forbidden when NPMGUARD_ENV=prod"
        )
    setup_logging(settings.log_level)
    if settings.database_url.startswith("sqlite"):
        # make_url counts slashes correctly: sqlite:///rel = relative,
        # sqlite:////abs = absolute. The old rsplit("///") dropped an absolute
        # path's leading slash, so an absolute data dir was never created (masked
        # in dev only because data/ pre-exists).
        from sqlalchemy.engine import make_url

        db_path = make_url(settings.database_url).database
        if db_path and db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    engine = make_engine(settings.database_url)
    sessions_factory = make_session_factory(engine)
    if settings.env != "prod":
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
    notifier = make_notifier(settings.database_url)
    await notifier.start()
    stream = StreamService(sessions_factory, notifier)
    sessions = AuditSessionStore(sessions_factory)
    llm = build_npmguard_llm(sessions_factory, settings)
    pipeline = AuditPipeline(settings, llm, sessions)
    audits = AuditService(
        pipeline,
        sessions,
        stream,
        queue_size=settings.queue_size,
        max_concurrent=settings.max_running_sessions,
    )
    await audits.start()
    # Panel wiring: build the GitHub App client + panel stores only when the App
    # is configured. Without it every panel route 503s and these stay None, so
    # the engine boots and behaves exactly as it does without the panel.
    gh_client: GitHubAppClient | None = None
    panel_sessions: PanelSessionStore | None = None
    gh_users: GhUserStore | None = None
    panel_installations: InstallationStore | None = None
    panel_repos: RepoStore | None = None
    panel_caps: CapsStore | None = None
    panel_verdicts: VerdictIndex | None = None
    panel_queue: PanelJobQueue | None = None
    panel_scan: RepoScanEngine | None = None
    panel_public_scan: PublicRepoScanEngine | None = None
    panel_billing: BillingStore | None = None
    panel_workers: PanelWorkerPool | None = None
    panel_watch_task: asyncio.Task[None] | None = None
    panel_reconcile_task: asyncio.Task[None] | None = None
    if settings.github_app_enabled:
        gh_client = GitHubAppClient(settings)
        panel_sessions = PanelSessionStore(sessions_factory)
        gh_users = GhUserStore(sessions_factory)
        panel_installations = InstallationStore(sessions_factory)
        panel_repos = RepoStore(sessions_factory)
        panel_caps = CapsStore(sessions_factory, settings)
        panel_verdicts = VerdictIndex(sessions_factory)
        panel_queue = PanelJobQueue(sessions_factory)

        # Conclude a push-scan's GitHub check-run once the scan finalizes. The
        # fail-only-on-DANGEROUS mapping is check_conclusion; an unresolved
        # rollup (None/UNKNOWN) leaves the check open (never concluded early).
        async def finalize_check(
            repo: Any, check_run_id: int, verdict: str | None
        ) -> None:
            conclusion = check_conclusion(verdict)
            if conclusion == "in_progress":
                return  # not a pass/fail yet — leave the check running
            octo = gh_client.installation_octokit(repo["installation_id"])
            await conclude_check_run(
                octo,
                repo["owner"],
                repo["name"],
                check_run_id,
                conclusion,
                check_summary(verdict),
            )

        panel_scan = RepoScanEngine(
            sessions=sessions_factory,
            caps=panel_caps,
            verdict_index=panel_verdicts,
            queue=panel_queue,
            fetch_repo_deps=_make_fetch_repo_deps(gh_client),
            # Keep watched_packages reconciled after a protected repo's index
            # changes (reconcile/push full scans) — the same seam the routes and
            # webhook handlers call directly.
            watch_sync=lambda: sync_watched_packages(sessions_factory),
            finalize_check=finalize_check,
        )
        # The public-repo audit engine reuses the same collaborators (its routes
        # build one per-request too, so no Runtime field is strictly required —
        # but the worker needs THIS instance's refresh hook so public-scan
        # progress advances as cache-miss verdicts land).
        panel_public_scan = PublicRepoScanEngine(
            sessions=sessions_factory,
            caps=panel_caps,
            verdict_index=panel_verdicts,
            queue=panel_queue,
        )
        panel_billing = BillingStore(sessions_factory)

        # A worker settle nudges BOTH the protected-repo scans AND the public-repo
        # snapshots covering the pair — either kind may be waiting on this verdict.
        async def on_scans_touched(name: str, version: str) -> None:
            await panel_scan.refresh_scans_touching(name, version)
            await panel_public_scan.refresh_public_scans_touching(name, version)

        # The alert hook: fired by a worker only when IT lands a DANGEROUS
        # verdict. It fans out over the exposed repos and emails each org — it
        # never touches the core engine. ``source`` is 'watch' (registry-watch,
        # no owning scan) or 'scan'.
        async def on_dangerous(name: str, version: str, source: str) -> None:
            await handle_dangerous_verdict(
                sessions_factory, name, version, source=source, settings=settings
            )

        # The panel scan-engine funnels cache-misses into the SAME AuditService
        # (the single owner of the Docker cap), never a second executor; the
        # worker awaits admit's future then indexes the saved verdict.
        panel_workers = PanelWorkerPool(
            panel_queue,
            audits,
            panel_verdicts,
            count=settings.scan_concurrency,
            load_report=load_report,
            on_scans_touched=on_scans_touched,
            on_dangerous=on_dangerous,
        )
        rebuilt = await panel_verdicts.rebuild(_saved_reports)
        requeued = await panel_queue.reset_stale()
        panel_workers.start()

        # Registry-watch + reconcile background loops. Both self-schedule with a
        # short first-run delay so boot isn't blocked; interval from
        # settings.watch_interval_min (reconcile stays on its daily default).
        watch_interval_seconds = settings.watch_interval_min * 60
        watcher = RegistryWatcher(sessions_factory, panel_queue, panel_verdicts)
        panel_watch_task = asyncio.create_task(
            watcher.run_forever(watch_interval_seconds),
            name="npmguard-panel-registry-watch",
        )
        reconciler = Reconciler(
            sessions=sessions_factory,
            gh_client=gh_client,
            panel_scan=panel_scan,
            fetch_lockfile=fetch_lockfile,
        )
        panel_reconcile_task = asyncio.create_task(
            reconciler.run_forever(),
            name="npmguard-panel-reconcile",
        )

        log.info(
            "panel enabled: GitHub App configured",
            verdicts_rebuilt=rebuilt,
            jobs_requeued=requeued,
            scan_concurrency=settings.scan_concurrency,
            watch_interval_min=settings.watch_interval_min,
        )
    app.state.runtime = Runtime(
        settings,
        engine,
        sessions,
        stream,
        llm,
        audits,
        DemoService(sessions, stream),
        sessionmaker=sessions_factory,
        gh_client=gh_client,
        panel_sessions=panel_sessions,
        gh_users=gh_users,
        panel_installations=panel_installations,
        panel_repos=panel_repos,
        panel_caps=panel_caps,
        panel_verdicts=panel_verdicts,
        panel_queue=panel_queue,
        panel_scan=panel_scan,
        panel_public_scan=panel_public_scan,
        panel_billing=panel_billing,
        panel_workers=panel_workers,
        panel_watch_task=panel_watch_task,
        panel_reconcile_task=panel_reconcile_task,
    )
    try:
        yield
    finally:
        # Stop the background loops + worker pool BEFORE the executor closes, so
        # nothing tries to admit/enqueue against a shutting-down AuditService.
        for task in (panel_watch_task, panel_reconcile_task):
            if task is not None:
                task.cancel()
        for task in (panel_watch_task, panel_reconcile_task):
            if task is not None:
                with suppress(asyncio.CancelledError):
                    await task
        if panel_workers is not None:
            await panel_workers.close()
        await audits.close(settings.shutdown_deadline_seconds)
        await llm.aclose()
        await notifier.close()
        await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="NpmGuard Engine", lifespan=lifespan)
    settings = get_settings()
    app.add_middleware(RequestIdMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.cors_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    app.include_router(router)
    app.include_router(router, prefix="/api")
    # Panel routers, mirrored under /api like the existing router. Included
    # unconditionally — each handler 503s when settings.github_app_enabled is
    # False, so an unconfigured engine is unaffected (the paths just 503).
    app.include_router(panel_auth_router)
    app.include_router(panel_auth_router, prefix="/api")
    app.include_router(panel_router)
    app.include_router(panel_router, prefix="/api")
    app.include_router(panel_webhooks_router)
    app.include_router(panel_webhooks_router, prefix="/api")
    app.include_router(panel_public_repos_router)
    app.include_router(panel_public_repos_router, prefix="/api")
    app.include_router(panel_billing_router)
    app.include_router(panel_billing_router, prefix="/api")

    frontend = REPO_ROOT / "frontend" / "dist"
    assets = frontend / "assets"
    if assets.exists():
        from fastapi.staticfiles import StaticFiles

        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> Response:
        candidate = (frontend / path).resolve()
        if candidate.is_relative_to(frontend.resolve()) and candidate.is_file():
            return FileResponse(candidate)
        index = frontend / "index.html"
        if index.exists() and not path.startswith(
            ("api/", "audit/", "checkout/", "webhooks/", "auth/", "me", "panel/")
        ):
            return FileResponse(index)
        return JSONResponse({"error": "Not found"}, status_code=404)

    return app


app = create_app()

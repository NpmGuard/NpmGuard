from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import sqlalchemy as sa
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

from .bench.routes import router as bench_router
from .config import REPO_ROOT, Settings, get_settings
from .contract.models import (
    AuditAcceptedResponse,
    CheckoutResponse,
    CheckoutStatus,
    CryptoConfig,
    DemoPackagesResponse,
    PackageIndexResponse,
    PackageReportResponse,
    PublicConfig,
    ReplayEntry,
    ReplayGalleryResponse,
    ResolveResponse,
    StartAuditResponse,
    ValidationFailed,
    ValidationIssue,
)
from .demo import DemoService
from .errors import NpmGuardError, QueueFullError
from .events import sse_events
from .llm_runtime import build_npmguard_llm
from .panel.alerts.notify import handle_dangerous_verdict
from .panel.audit_set import AuditSetStore, Rollup, build_store
from .panel.billing import BillingStore
from .panel.caps import CapsStore
from .panel.github.checks import check_conclusion, check_summary, conclude_check_run
from .panel.github.client import GitHubAppClient
from .panel.github.content import fetch_lockfile, fetch_manifest
from .panel.lockfile import manifest_ranges, parse_lockfile
from .panel.public_limits import PublicScanLimits
from .panel.routes.auth import router as panel_auth_router
from .panel.routes.billing import router as panel_billing_router
from .panel.routes.gh_webhooks import router as panel_webhooks_router
from .panel.routes.panel import router as panel_router
from .panel.routes.public_repos import router as panel_public_repos_router
from .panel.scan.public_repo_scan import PublicRepoScanEngine
from .panel.scan.repo_scan import LockfileNotFoundError, ParsedRepoDeps, RepoScanEngine
from .panel.sessions import PanelSessionStore
from .panel.settle import build_settle_hook
from .panel.stores import GhUserStore, InstallationStore, RepoStore
from .panel.tables import audit_sets
from .panel.tables import repos as repo_table
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
from .report_store import (
    REPORT_SCHEMA_VERSIONS,
    REPORT_VERDICTS,
    extract_report_version,
    list_reports,
    load_report,
)
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
    # Populated whether or not the GitHub App is on — bench read surfaces use it.
    sessionmaker: async_sessionmaker
    # Registry-watch + reconcile background loops (asyncio tasks, not
    # setInterval). Started in lifespan when the App is enabled, cancelled +
    # awaited on shutdown BEFORE audits.close().
    panel_watch_task: asyncio.Task[None] | None = None
    panel_reconcile_task: asyncio.Task[None] | None = None


@dataclass(frozen=True, kw_only=True)
class PanelRuntime(Runtime):
    """The runtime of an engine whose GitHub App **is** configured.

    The panel components exist together or not at all, so they live on a
    distinct type rather than as fourteen independently-``None`` fields: the
    engine builds a ``PanelRuntime`` exactly when ``settings.github_app_enabled``
    and a plain ``Runtime`` otherwise. Panel routes narrow to it via
    ``require_panel``, which is also the 503 gate — so "the App is configured"
    is checked once, structurally, instead of re-asserted at every access.
    """

    gh_client: GitHubAppClient
    panel_sessions: PanelSessionStore
    gh_users: GhUserStore
    panel_installations: InstallationStore
    panel_repos: RepoStore
    panel_caps: CapsStore
    panel_verdicts: VerdictIndex
    # The ONE audit-set entity (R-1): creation, progress, rollup, and the SSE
    # stream every origin shares.
    panel_sets: AuditSetStore
    panel_scan: RepoScanEngine
    panel_public_scan: PublicRepoScanEngine
    panel_billing: BillingStore


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


def _wire(model: BaseModel, status_code: int = 200) -> JSONResponse:
    """One response, serialized from the generated contract rather than authored here.

    Every audit-surface envelope goes through this. The point is not brevity: a
    route that builds a dict literal is a SECOND author of a shape the contract
    already declares, and two authors of one shape is the drift N-12 exists to
    end. Constructing the model means a renamed or dropped field fails at the
    route instead of at whichever client notices first.

    ``exclude_none=False`` is load-bearing and matches every other wire payload:
    the contract's nullability rule is that an absent value arrives as an explicit
    ``null``, so dropping the key would collapse "not set" and "this engine does
    not send that field" into one observation the client cannot tell apart.
    """
    return JSONResponse(model.model_dump(mode="json", exclude_none=False), status_code=status_code)


def _validation_failed(message: str, issues: list[ValidationIssue]) -> JSONResponse:
    """The contract's ``ValidationFailed`` body, dumped with ``exclude_none=False``
    like every other wire payload."""
    body = ValidationFailed(error=message, details=issues)
    return JSONResponse(body.model_dump(mode="json", exclude_none=False), status_code=400)


async def _body[T: BaseModel](
    request: Request, model: type[T]
) -> tuple[T | None, JSONResponse | None]:
    """Parse a request body, or the contract's 400.

    The failure body is ``ValidationFailed`` — a DECLARED shape. It used to be an
    undeclared ``details`` key alongside ``ApiError``'s ``error``, carrying
    ``PydanticValidationError.errors()`` verbatim: a shape no schema described, that
    a generated consumer could not see, and that pinned a third-party library's
    internal error format to NpmGuard's wire. What a caller needs from a 400 — the
    rule that failed and where — is kept; ``type`` and ``input`` are dropped, the
    latter because it echoes submitted values back out of routes that also accept
    payment proofs.

    ``field`` is ``""`` for a rule declared about the whole body, which today is most
    of them: ``validation.py`` enforces the package-name and semver rules in a
    ``model_validator(mode="after")``, and pydantic reports those with an empty
    ``loc``. That is unchanged from the raw ``details`` this replaced — the
    information was never there — and it is ``message`` that distinguishes the causes
    until those two rules become ``field_validator``s.

    INVARIANT: ``details == []`` ⟺ the body was not parseable JSON. Pydantic never
    reports a validation failure with zero issues, so the empty list is reachable
    only from the branch above the schema — which is what lets a client tell
    "malformed JSON" from "wrong fields" without reading ``error``'s prose.
    """
    try:
        payload = await request.json()
    except Exception:
        return None, _validation_failed("Invalid JSON body", [])
    try:
        return model.model_validate(payload), None
    except PydanticValidationError as exc:
        return None, _validation_failed(
            "Invalid request",
            [
                ValidationIssue(
                    field=".".join(str(part) for part in error["loc"]),
                    message=error["msg"],
                )
                for error in exc.errors(include_url=False, include_context=False)
            ],
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

# Routes whose path is ALSO a client route in the SPA's router. The engine serves
# frontend/dist itself in production (nginx proxies everything to it), so a route
# mounted at the root shadows the page of the same name: a hard navigation, a
# refresh or a pasted link returns JSON to a browser. These are therefore mounted
# under /api ONLY — the mirror every client already talks to — and the root path
# is left to the SPA. Adding a page whose path collides with a root route means
# moving that route here, not teaching it to sniff `Accept`.
client_owned_router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def _local_path_refused(runtime: Any, local_path: str | None) -> JSONResponse | None:
    """Refuse a staged-package audit unless this engine is configured for one.

    INVARIANT: the capability is checked HERE, at admission, and nowhere else.
    Downstream (`service.admit`, `pipeline.run`, `resolve_package`) takes the
    declared source as given, and no READ path consults the setting at all — an
    engine with it off still serves every stored bench run, row, metric and
    replay, which is how production publishes benchmark results it cannot
    produce.
    """
    if local_path is None or runtime.settings.local_package_audits:
        return None
    return JSONResponse(
        {"error": "localPath audits are not enabled on this engine"}, status_code=403
    )


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
    refused = _local_path_refused(runtime, parsed.localPath)
    if refused:
        return refused
    try:
        result = await runtime.audits.admit(
            parsed.packageName, parsed.version, local_path=parsed.localPath
        )
        if is_cre:
            result.future.add_done_callback(_consume_future)
            return _wire(
                AuditAcceptedResponse(
                    status="accepted",
                    auditId=result.audit_id,
                    packageName=parsed.packageName,
                    version=parsed.version,
                    queuePosition=result.queue_position,
                ),
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
        return _wire(
            StartAuditResponse(auditId=session.audit_id, packageName=verified.package_name)
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
        return _wire(StartAuditResponse(auditId=session.audit_id, packageName=package_name))

    if not runtime.settings.payment_required:
        if not parsed.packageName:
            return JSONResponse({"error": "packageName is required"}, status_code=400)
        refused = _local_path_refused(runtime, parsed.localPath)
        if refused:
            return refused
        try:
            result = await runtime.audits.admit(
                parsed.packageName, parsed.version, local_path=parsed.localPath
            )
        except Exception as exc:
            return _audit_error(exc)
        result.future.add_done_callback(_consume_future)  # fire-and-forget; retrieve exc
        return _wire(
            StartAuditResponse(auditId=result.audit_id, packageName=parsed.packageName)
        )

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
    # Unconditional: CheckoutRequest refuses a localPath, so everything reaching
    # here is a registry package and must exist before money is taken.
    try:
        await resolve_tarball_url(parsed.packageName, version)
    except Exception:
        return JSONResponse(
            {"error": f"Package {parsed.packageName}@{version} not found on npm"},
            status_code=404,
        )
    try:
        url, session_id = await create_checkout_session(
            runtime.settings,
            package_name=parsed.packageName,
            version=version,
            email=str(parsed.email) if parsed.email else None,
            # Configuration, never the request. `success_url` carries
            # `{CHECKOUT_SESSION_ID}`, and that id is the bearer proof
            # `POST /audit/stream` accepts — so an origin read from the caller's
            # `Origin`/`Referer` header lets anyone mint a real Stripe page that
            # delivers the payer, and their session id, to a site of their
            # choosing. `panel_base_url` is this deployment's own app origin; the
            # subscription checkout in panel/routes/billing.py already uses it.
            origin=runtime.settings.panel_base_url.rstrip("/"),
        )
        return _wire(CheckoutResponse(url=url, sessionId=session_id))
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
        return _wire(
            CheckoutStatus(
                paid=True,
                packageName=existing["package_name"],
                version=existing["version"],
                auditId=existing["audit_id"],
            )
        )
    try:
        verification = await verify_checkout_session(runtime.settings, session_id)
        # `auditId` is null rather than absent: the payment is verified but has
        # not been claimed into an audit yet, and a client must be able to tell
        # that from an engine that does not report claims at all.
        return _wire(
            CheckoutStatus(
                paid=verification["paid"],
                packageName=verification["packageName"],
                version=verification["version"],
                auditId=None,
            )
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
    if isinstance(runtime, PanelRuntime):
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

    def config(crypto: CryptoConfig | None) -> JSONResponse:
        return _wire(
            PublicConfig(
                paymentRequired=settings.payment_required,
                paymentEnabled=settings.payment_required,
                stripeEnabled=bool(settings.stripe_secret_key),
                priceCents=settings.audit_price_cents,
                crypto=crypto,
            )
        )

    contract = chain_contract(settings, "base-sepolia")
    if not is_chain_configured(settings, "base-sepolia"):
        return config(None)
    # `is_chain_configured` IS "a contract address is set" (payments.py), which is
    # why CryptoConfig.contract is not nullable and this assert cannot fire.
    assert contract is not None, "chain reported configured with no contract address"
    try:
        fee = await read_audit_fee(settings, "base-sepolia")
    except Exception:
        # A crypto block the client cannot pay with is worse than no crypto
        # option: it renders a pay button that cannot build a transaction. So an
        # unreadable fee retracts the whole method, which is the invariant
        # CryptoConfig is authored around.
        log.warning("failed to read audit fee")
        return config(None)
    # None only for an unconfigured chain, excluded above.
    assert fee is not None, "audit fee read succeeded with no value on a configured chain"
    return config(
        CryptoConfig(
            chain="base-sepolia",
            chainId=84532,
            contract=contract,
            auditFeeWei=str(fee),
        )
    )


@router.get("/demo/packages")
async def demo_packages(request: Request) -> JSONResponse:
    return _wire(DemoPackagesResponse(packages=list(_runtime(request).demos.recordings)))


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
        return _wire(await _runtime(request).demos.start(package_name))
    except KeyError as exc:
        return JSONResponse({"error": exc.args[0]}, status_code=404)


def _replay_entry(session: AuditSession) -> ReplayEntry | None:
    """One finished audit as a gallery card, or None if it does not belong on one.

    Every value is read back off the row and its stored report. Nothing here is
    authored, so the gallery cannot describe a run differently from how it went.

    Two rejections, both silent because neither is a failure to report: a locally
    staged package is not a product exhibit — the gallery claims to show audits of
    published packages — and a report outside the contract's readable domain is one
    no client could render. The bench surfaces show these same audits deliberately,
    and `/audit/{id}` serves every one of them, so nothing here hides a run.

    That second screen is `report_store._readable`'s rule, applied at this store's
    door. It cannot BE that function — this reads `audit_sessions.report`, keyed by
    `audit_id`, which is a different store from `data/reports/` and has no `Path` to
    name — but the rule must be the same, and for the sharper reason: a row listed
    here is a link to `/audit/{id}/report`, which serves the stored report RAW. So
    an unrenderable report does not fail here, it fails on the page this row sends
    someone to. Screening the version as well as the verdict is what makes that
    unreachable: an in-domain verdict on an off-version body passes a verdict check
    and then dies on the client's first missing v2 field.
    """
    assert session.report is not None, f"replayable() yielded {session.audit_id} with no report"
    if session.local_path is not None:
        return None
    schema_version, verdict = session.report.get("schemaVersion"), session.report.get("verdict")
    if schema_version not in REPORT_SCHEMA_VERSIONS or verdict not in REPORT_VERDICTS:
        log.warning(
            "ignoring replay outside the readable domain",
            audit_id=session.audit_id,
            schemaVersion=schema_version,
            verdict=verdict,
        )
        return None
    started = datetime.fromisoformat(session.created_at)
    finished = datetime.fromisoformat(session.updated_at)
    return ReplayEntry(
        auditId=session.audit_id,
        packageName=session.package_name,
        version=extract_report_version(session.report) or session.requested_version,
        verdict=verdict,
        durationMs=max(0, round((finished - started).total_seconds() * 1000)),
        recordedAt=session.created_at,
    )


@client_owned_router.get("/replays")
async def replays(request: Request) -> JSONResponse:
    """The replay gallery. Each row's `auditId` is its permalink: /audit/{id} rebuilds
    the whole run from the durable event log, so there is nothing to record and no
    second renderer."""
    sessions = await _runtime(request).sessions.replayable()
    entries = [entry for entry in map(_replay_entry, sessions) if entry is not None]
    return JSONResponse(
        ReplayGalleryResponse(replays=entries).model_dump(mode="json", exclude_none=False)
    )


@client_owned_router.get("/packages")
async def packages() -> JSONResponse:
    return _wire(PackageIndexResponse(packages=list_reports()))


@router.get("/package/{name:path}/report")
async def package_report(name: str, request: Request) -> JSONResponse:
    version = request.query_params.get("version")
    try:
        valid_package_name(name)
        if version:
            valid_semver(version)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    suffix = f"@{version}" if version else ""
    not_found = JSONResponse(
        {"error": f"No audit report found for {name}{suffix}"}, status_code=404
    )
    result = load_report(name, version)
    if result is None:
        return not_found
    report, resolved_version = result
    try:
        envelope = PackageReportResponse(
            report=report, version=resolved_version, packageName=name
        )
    except PydanticValidationError as exc:
        # The store's readable-domain screen is two fields (schemaVersion +
        # verdict); this is the rest of the contract, applied where the body
        # actually crosses a wire. A report that passes the screen but is not an
        # `AuditReport` is the failure `report_store._readable` names in its own
        # docstring: it satisfies a verdict check and then dies on the client's
        # first missing v2 field, bricking that package's page for as long as the
        # file sits on disk. 404 is the same answer the screen gives — unreadable
        # is unreadable — and it is NOT a 500, matching the store's rule that one
        # bad report must not take a route down. Logged, because N-3 forbids a
        # silently fabricated absence.
        log.warning(
            "stored report is outside the contract", package=name, version=resolved_version,
            error=str(exc),
        )
        return not_found
    return _wire(envelope)


@router.get("/resolve/{name:path}")
async def resolve(name: str, request: Request) -> JSONResponse:
    version = request.query_params.get("version", "latest")
    try:
        valid_package_name(name)
        resolved_version, _ = await resolve_tarball_url(name, version)
        return _wire(ResolveResponse(packageName=name, version=resolved_version))
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:
        return JSONResponse({"error": str(exc) or "Resolution failed"}, status_code=404)


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
    # Panel wiring: build the GitHub App client + panel stores only when the App
    # is configured. Without it every panel route 503s and none of this exists,
    # so the engine boots and behaves exactly as it does without the panel.
    runtime: Runtime = Runtime(
        settings,
        engine,
        sessions,
        stream,
        llm,
        audits,
        DemoService(sessions, stream),
        sessionmaker=sessions_factory,
    )
    if settings.github_app_enabled:
        gh_client = GitHubAppClient(settings)
        panel_sessions = PanelSessionStore(sessions_factory)
        gh_users = GhUserStore(sessions_factory)
        panel_installations = InstallationStore(sessions_factory)
        panel_repos = RepoStore(sessions_factory)
        panel_caps = CapsStore(sessions_factory, settings)
        panel_verdicts = VerdictIndex(sessions_factory)

        # Conclude a set's GitHub check-run once the set finalizes. The mapping is
        # check_conclusion over the ROLLUP (fail only on DANGEROUS, neutral on
        # ERROR, neutral when the set covered nothing) — every answer is terminal,
        # because only a finalized set gets here and a finalized set has no pending
        # items — including the empty push, whose check run would otherwise spin
        # forever.
        async def finalize_check(set_id: int, check_run_id: int, rollup: Rollup) -> None:
            async with sessions_factory() as session:
                repo = (
                    (
                        await session.execute(
                            sa.select(repo_table)
                            .select_from(
                                repo_table.join(
                                    audit_sets,
                                    audit_sets.c.origin_ref == repo_table.c.id,
                                )
                            )
                            .where(audit_sets.c.id == set_id)
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
            if repo is None:
                return
            octo = gh_client.installation_octokit(repo["installation_id"])
            await conclude_check_run(
                octo,
                repo["owner"],
                repo["name"],
                check_run_id,
                check_conclusion(rollup),
                check_summary(rollup),
            )

        # The ONE audit-set entity: every origin's progress, rollup and stream.
        panel_sets = build_store(
            sessions_factory,
            panel_verdicts,
            audits,
            stream,
            notifier,
            finalize_check=finalize_check,
        )
        panel_scan = RepoScanEngine(
            sessions=sessions_factory,
            caps=panel_caps,
            sets=panel_sets,
            fetch_repo_deps=_make_fetch_repo_deps(gh_client),
            # Keep watched_packages reconciled after a protected repo's index
            # changes (reconcile/push full scans) — the same seam the routes and
            # webhook handlers call directly.
            watch_sync=lambda: sync_watched_packages(sessions_factory),
        )
        panel_public_scan = PublicRepoScanEngine(
            sessions=sessions_factory,
            limits=PublicScanLimits(sessions=sessions_factory, settings=settings),
            sets=panel_sets,
        )
        panel_billing = BillingStore(sessions_factory)

        # The alert hook: fired by a worker only when IT lands a DANGEROUS
        # verdict. It fans out over the exposed repos and emails each org — it
        # never touches the core engine. ``origin`` is the job's own recorded
        # AuditSetOrigin, so a public-repo finding is not filed as a registry-watch
        # alert.
        async def on_dangerous(name: str, version: str, origin: str) -> None:
            await handle_dangerous_verdict(
                sessions_factory, name, version, origin=origin, settings=settings
            )

        # The panel's aftermath, fired once per audit that reaches a terminal state
        # on a cache-filling lane: index the verdict, alert on DANGEROUS, advance
        # every live set covering the pair. One hook where a whole worker pool used
        # to await futures for audits it had itself admitted.
        audits.bind_settle_hook(
            build_settle_hook(
                panel_verdicts,
                panel_sets,
                on_dangerous=on_dangerous,
                load_report=load_report,
            )
        )
        rebuilt = await panel_verdicts.rebuild(_saved_reports)
        # Sets left live by a crashed process are finalized honestly here, BEFORE
        # the pool starts: without it a set whose work never existed stays
        # `running` forever, its check run never concludes, and its stream never
        # terminates.
        swept = await panel_sets.refresh_live()

        # Registry-watch + reconcile background loops. Both self-schedule with a
        # short first-run delay so boot isn't blocked; interval from
        # settings.watch_interval_min (reconcile stays on its daily default).
        watch_interval_seconds = settings.watch_interval_min * 60
        watcher = RegistryWatcher(sessions_factory, audits, panel_verdicts)
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
            live_sets_swept=swept,
            scan_concurrency=settings.scan_concurrency,
            watch_interval_min=settings.watch_interval_min,
        )
        runtime = PanelRuntime(
            settings,
            engine,
            sessions,
            stream,
            llm,
            audits,
            runtime.demos,
            sessionmaker=sessions_factory,
            gh_client=gh_client,
            panel_sessions=panel_sessions,
            gh_users=gh_users,
            panel_installations=panel_installations,
            panel_repos=panel_repos,
            panel_caps=panel_caps,
            panel_verdicts=panel_verdicts,
            panel_sets=panel_sets,
            panel_scan=panel_scan,
            panel_public_scan=panel_public_scan,
            panel_billing=panel_billing,
            panel_watch_task=panel_watch_task,
            panel_reconcile_task=panel_reconcile_task,
        )
    # LAST, so every settle consumer is bound before a worker can claim: start()
    # also runs restart recovery, which settles interrupted rows immediately.
    await audits.start()
    app.state.runtime = runtime
    try:
        yield
    finally:
        # Stop the background loops + worker pool BEFORE the executor closes, so
        # nothing tries to admit/enqueue against a shutting-down AuditService.
        tasks = (runtime.panel_watch_task, runtime.panel_reconcile_task)
        for task in tasks:
            if task is not None:
                task.cancel()
        for task in tasks:
            if task is not None:
                with suppress(asyncio.CancelledError):
                    await task
        await audits.close(settings.shutdown_deadline_seconds)
        await llm.aclose()
        await notifier.close()
        await engine.dispose()


# Namespaces the API owns, so a request that matched no route there answers a
# JSON 404 rather than 200 HTML that the caller then fails to parse. Everything
# else falls through to the SPA, which renders its own not-found.
_API_NAMESPACES = ("api/", "checkout/", "webhooks/", "auth/", "panel/", "bench/")


def _is_api_path(path: str) -> bool:
    if path == "me" or path.startswith(_API_NAMESPACES):
        return True
    # /audit/{id} is the audit permalink — a CLIENT route, and the most-shared
    # link the product emits. Everything BELOW it (events, file, report) is API.
    # A prefix test on "audit/" cannot tell those apart, and 404s the permalink.
    return path.startswith("audit/") and path.count("/") > 1


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
    app.include_router(client_owned_router, prefix="/api")
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
    # Bench read surfaces, unconditional and ungated: bench is not a panel
    # feature, and runtime.sessionmaker is populated whether or not the GitHub
    # App is on. Without this the routes exist and answer nothing.
    app.include_router(bench_router)
    app.include_router(bench_router, prefix="/api")

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
        if index.exists() and not _is_api_path(path):
            return FileResponse(index)
        return JSONResponse({"error": "Not found"}, status_code=404)

    return app


app = create_app()

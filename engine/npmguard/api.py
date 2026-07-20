from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
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
from sqlalchemy.ext.asyncio import AsyncEngine

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
from .errors import NpmGuardError
from .events import sse_events
from .llm_runtime import build_npmguard_llm
from .payments import (
    ChainVerificationError,
    chain_contract,
    construct_webhook_event,
    create_checkout_session,
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


def _runtime(request: Request) -> Runtime:
    return request.app.state.runtime


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


async def _claim_stripe(runtime: Runtime, session_id: str) -> tuple[AuditSession, bool, str, str]:
    existing = await runtime.sessions.payment("stripe", session_id)
    if existing:
        session = await runtime.sessions.get(existing["audit_id"])
        assert session is not None
        return session, False, existing["package_name"], existing["version"]
    verification = await verify_checkout_session(runtime.settings, session_id)
    if not verification["paid"]:
        raise PermissionError("Payment not completed")
    package_name = verification["packageName"]
    version = verification["version"]
    session, created = await runtime.sessions.claim_payment(
        "stripe", session_id, package_name, version
    )
    return session, created, package_name, version


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
        session, future, position = await runtime.audits.enqueue(parsed.packageName, parsed.version)
        if is_cre:
            future.add_done_callback(_consume_future)
            return JSONResponse(
                {
                    "status": "accepted",
                    "auditId": session.audit_id,
                    "packageName": parsed.packageName,
                    "version": parsed.version,
                    "queuePosition": position,
                },
                status_code=202,
            )
        return JSONResponse(await future)
    except Exception as exc:
        return _audit_error(exc)


@router.post("/audit/stream")
async def start_stream(request: Request) -> JSONResponse:
    parsed, error = await _body(request, StreamAuditRequest)
    if error:
        return error
    assert parsed is not None
    runtime = _runtime(request)
    session: AuditSession
    created = True
    package_name: str
    version: str | None

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
        existing = await runtime.sessions.payment(provider, parsed.txHash)
        if existing:
            return JSONResponse(
                {"auditId": existing["audit_id"], "packageName": existing["package_name"]}
            )
        try:
            verified = await verify_audit_payment(
                runtime.settings, chain, parsed.txHash, parsed.packageName, parsed.version
            )
        except ChainVerificationError as exc:
            return JSONResponse({"error": str(exc)}, status_code=402)
        except Exception:
            log.exception("chain verification failed", chain=chain)
            return JSONResponse({"error": "Chain verification failed"}, status_code=500)
        package_name, version = verified.package_name, verified.version
        session, created = await runtime.sessions.claim_payment(
            provider,
            parsed.txHash,
            package_name,
            version,
            requester=verified.requester,
        )
    elif parsed.stripeSessionId:
        if not runtime.settings.stripe_secret_key:
            return JSONResponse({"error": "Stripe payments not configured"}, status_code=501)
        try:
            session, created, package_name, version = await _claim_stripe(
                runtime, parsed.stripeSessionId
            )
        except Exception:
            log.exception("stripe verification failed")
            return JSONResponse({"error": "Payment verification failed"}, status_code=402)
    elif not runtime.settings.payment_required:
        if not parsed.packageName:
            return JSONResponse({"error": "packageName is required"}, status_code=400)
        package_name, version = parsed.packageName, parsed.version
        session = await runtime.sessions.create(package_name, version)
    else:
        return JSONResponse(
            {"error": "Payment required. Use /checkout or provide txHash + chain."},
            status_code=402,
        )

    if created:
        runtime.audits.launch(session)
    return JSONResponse({"auditId": session.audit_id, "packageName": package_name})


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
            follow=session.status == "running",
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
    if session.status == "running":
        return JSONResponse({"status": "running"}, status_code=202)
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
                session, created = await runtime.sessions.claim_payment(
                    "stripe", session_id, package_name, version
                )
                if created:
                    runtime.audits.launch(session)
            except Exception:
                log.exception("webhook failed to start audit", package_name=package_name)
                return JSONResponse({"error": "Failed to start audit"}, status_code=500)
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
    setup_logging(settings.log_level)
    if settings.database_url.startswith("sqlite"):
        Path(settings.database_url.rsplit("///", 1)[-1]).parent.mkdir(parents=True, exist_ok=True)
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
    audits = AuditService(pipeline, sessions, stream)
    await audits.start()
    app.state.runtime = Runtime(
        settings, engine, sessions, stream, llm, audits, DemoService(sessions, stream)
    )
    try:
        yield
    finally:
        await audits.close()
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
        if index.exists() and not path.startswith(("api/", "audit/", "checkout/", "webhooks/")):
            return FileResponse(index)
        return JSONResponse({"error": "Not found"}, status_code=404)

    return app


app = create_app()

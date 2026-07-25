"""HTTP surface for publisher attestation.

Four routes, one per step of a single flow:

    POST /attest/session              resolve the release, open a session
    POST /attest/session/{id}/own     prove GitHub push access, freeze the signal
    GET  /attest/session/{id}/request the IDKit config the browser needs
    POST /attest/session/{id}/proof   verify the proof, record, publish

Style matches the panel routers: plain handlers returning ``JSONResponse``, and
gating as helper calls rather than dependencies, so the exact ``{"error": ...}``
body the frontend keys on survives.

Everything that decides anything happens here or deeper. The browser supplies a
proof; it never supplies the signal that proof is checked against.
"""

from __future__ import annotations

import time
from typing import Any

import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from kit_spine import now_iso

from .attest_ownership import OwnershipError, verify_ownership
from .attest_store import AttestationConflict
from .attestations import (
    RP_SIGNATURE_TTL_SECONDS,
    AttestationError,
    build_envelope,
    release_signal,
    sign_rp_request,
)
from .panel.routes._common import current_user, runtime_of
from .resolve import PackageNotFoundError, resolve_release
from .validation import valid_package_name

log = structlog.get_logger("npmguard.attest")

router = APIRouter()

WORLD_DISABLED_BODY = {"error": "World ID attestation is not configured on this server"}


def _require_enabled(runtime: Any) -> JSONResponse | None:
    if not runtime.settings.world_enabled or runtime.attest is None:
        return JSONResponse(WORLD_DISABLED_BODY, status_code=503)
    return None


# Marks a session whose ownership was NOT proven. Carried into the envelope so a
# bypassed attestation can never read as a proven one.
DEV_OWNER = {"id": "dev", "login": None}


async def _require_user(request: Request, runtime: Any) -> tuple[dict[str, Any] | None, Any]:
    """The signed-in GitHub user, or a 401. Attestation always needs one: the
    World proof says a human is present, not which packages they may speak for."""
    if runtime.settings.attest_dev_trust_ownership:
        # Development only — the settings validator refuses this combination
        # against production World credentials.
        log.warning(
            "attest: ownership check BYPASSED (dev mode)",
            world_environment=runtime.settings.world_environment,
        )
        return DEV_OWNER, None
    if not runtime.settings.github_app_enabled:
        return None, JSONResponse(
            {"error": "GitHub sign-in is not configured, so ownership cannot be proven"},
            status_code=503,
        )
    user = await current_user(request, runtime)
    if user is None:
        return None, JSONResponse({"error": "Sign in with GitHub to attest"}, status_code=401)
    return user, None


def _public_session(session: Any, attestation: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "sessionId": session.id,
        "packageName": session.package_name,
        "version": session.version,
        "status": session.status,
        "githubLogin": session.github_login,
        "error": session.error,
    }
    if attestation is not None:
        body["attestation"] = {
            "tier": attestation.tier,
            "nullifier": attestation.nullifier,
            "environment": attestation.environment,
            "assertions": attestation.assertions,
            "storageRoot": attestation.storage_root,
            "chainTx": attestation.chain_tx,
            "attestedAt": attestation.attested_at,
        }
    return body


@router.post("/attest/session")
async def open_session(request: Request) -> JSONResponse:
    runtime = runtime_of(request)
    if (disabled := _require_enabled(runtime)) is not None:
        return disabled
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    package_name = (payload or {}).get("packageName")
    version = (payload or {}).get("version")
    if not isinstance(package_name, str) or not isinstance(version, str):
        return JSONResponse({"error": "packageName and version are required"}, status_code=400)
    try:
        valid_package_name(package_name)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    # Resolve against npm ourselves. The artifact binding must come from the
    # registry, never from whatever the caller claims it is publishing.
    try:
        resolved, _, integrity = await resolve_release(package_name, version)
    except PackageNotFoundError:
        return JSONResponse({"error": f"npm has no package {package_name}"}, status_code=404)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)

    session = await runtime.attest.create_session(package_name, resolved, integrity)
    base = runtime.settings.panel_base_url.rstrip("/")
    return JSONResponse(
        {
            **_public_session(session),
            "version": resolved,
            "integrity": integrity,
            "url": f"{base}/attest/{session.id}",
        },
        status_code=201,
    )


@router.post("/attest/session/{session_id}/own")
async def prove_ownership(request: Request, session_id: str) -> JSONResponse:
    runtime = runtime_of(request)
    if (disabled := _require_enabled(runtime)) is not None:
        return disabled
    user, refusal = await _require_user(request, runtime)
    if refusal is not None:
        return refusal

    session = await runtime.attest.get_session(session_id)
    if session is None:
        return JSONResponse({"error": "Unknown attestation session"}, status_code=404)
    if session.status == "verified":
        return JSONResponse({"error": "This release is already attested"}, status_code=409)

    bypassed = user is DEV_OWNER
    ref = None
    if not bypassed:
        token = await runtime.gh_client.get_user_access_token(
            user["id"], runtime.panel_sessions
        )
        if not token:
            return JSONResponse(
                {"error": "GitHub session expired — sign in again"}, status_code=401
            )
        try:
            ref = await verify_ownership(
                session.package_name, runtime.gh_client.user_octokit(token)
            )
        except OwnershipError as exc:
            await runtime.attest.mark_status(session_id, "created", str(exc))
            return JSONResponse({"error": str(exc)}, status_code=403)

    # Freeze the signal server-side. Verification compares against THIS value.
    signal = release_signal(
        package_name=session.package_name,
        version=session.version,
        integrity=session.integrity,
        github_user_id=str(user["id"]),
    )
    await runtime.attest.mark_owned(
        session_id,
        github_user_id=str(user["id"]),
        github_login=user.get("login") or "",
        signal=signal,
    )
    refreshed = await runtime.attest.get_session(session_id)
    return JSONResponse(
        {
            **_public_session(refreshed),
            "repository": ref.full_name if ref is not None else None,
            "ownershipProven": not bypassed,
        }
    )


@router.get("/attest/session/{session_id}/request")
async def idkit_request(request: Request, session_id: str) -> JSONResponse:
    """The config the browser hands IDKit.

    The signal is returned so the widget can bind it, but it is not a secret and
    not authoritative — the engine re-derives it from its own session row when
    the proof comes back.
    """
    runtime = runtime_of(request)
    if (disabled := _require_enabled(runtime)) is not None:
        return disabled
    session = await runtime.attest.get_session(session_id)
    if session is None:
        return JSONResponse({"error": "Unknown attestation session"}, status_code=404)
    if session.status not in ("owned", "failed"):
        return JSONResponse(
            {"error": "Prove repository ownership before requesting a proof"}, status_code=409
        )
    settings = runtime.settings
    # The RP signature is minted here and only here: it is what stops any other
    # page from producing proof requests that look like ours. The signing key
    # never leaves the engine.
    try:
        rp = sign_rp_request(
            signing_key=settings.world_signing_key or "",
            action=settings.world_action,
            now=int(time.time()),
        )
    except AttestationError as exc:
        log.error("rp signature failed", error=str(exc))
        return JSONResponse({"error": "World ID signing key is misconfigured"}, status_code=503)
    return JSONResponse(
        {
            "appId": settings.world_app_id,
            "rpId": settings.world_rp_id,
            "rpContext": {
                "rp_id": settings.world_rp_id,
                "nonce": rp["nonce"],
                "created_at": rp["createdAt"],
                "expires_at": rp["expiresAt"],
                "signature": rp["sig"],
            },
            "ttlSeconds": RP_SIGNATURE_TTL_SECONDS,
            "action": settings.world_action,
            "signal": session.signal,
            # Which credential to ask for, and whether a legacy proof may answer.
            # Both are the engine's call, not the browser's: they decide what an
            # attestation is allowed to mean.
            "credential": settings.world_credential,
            "allowLegacyProofs": settings.world_allow_legacy_proofs,
            "requireUserPresence": settings.world_require_user_presence,
            "environment": settings.world_environment,
            # The UI must say so loudly: a staging proof carries no real-world
            # assurance and must never be presentable as though it did.
            "isProduction": settings.world_is_production,
            "minimumAge": settings.world_minimum_age,
            "packageName": session.package_name,
            "version": session.version,
        }
    )


@router.get("/attest/session/{session_id}")
async def read_session(request: Request, session_id: str) -> JSONResponse:
    runtime = runtime_of(request)
    if (disabled := _require_enabled(runtime)) is not None:
        return disabled
    session = await runtime.attest.get_session(session_id)
    if session is None:
        return JSONResponse({"error": "Unknown attestation session"}, status_code=404)
    attestation = None
    if session.status == "verified":
        attestation = await runtime.attest.for_release(session.package_name, session.version)
    return JSONResponse(_public_session(session, attestation))


@router.get("/attest/enrol/request")
async def enrol_request(request: Request) -> JSONResponse:
    """The IDKit config for an Identity Check enrolment.

    No session, and deliberately so: enrolment is not about a release. There is
    no artifact to resolve, no ownership to prove and no signal to freeze —
    `IdentityCheck` accepts no ``signal`` at all (finding D-1). What comes back
    is a claim about a person, joined to releases later by nullifier.

    The requested attributes are fixed here, server-side, so a client cannot ask
    World for more than this product justifies.
    """
    runtime = runtime_of(request)
    if (disabled := _require_enabled(runtime)) is not None:
        return disabled
    settings = runtime.settings
    try:
        rp = sign_rp_request(
            signing_key=settings.world_signing_key or "",
            action=settings.world_action,
            now=int(time.time()),
        )
    except AttestationError as exc:
        log.error("rp signature failed", error=str(exc))
        return JSONResponse({"error": "World ID signing key is misconfigured"}, status_code=503)
    return JSONResponse(
        {
            "appId": settings.world_app_id,
            "rpId": settings.world_rp_id,
            "rpContext": {
                "rp_id": settings.world_rp_id,
                "nonce": rp["nonce"],
                "created_at": rp["createdAt"],
                "expires_at": rp["expiresAt"],
                "signature": rp["sig"],
            },
            # Same action as release proofs ON PURPOSE: the nullifier is scoped
            # to (identity, app, action), so only a matching action lets a
            # release proof find this enrolment. Whether two credential types
            # under one action really share a nullifier is unresolved in World's
            # docs — see Q3/D-9 — and this flow is how we find out.
            "action": settings.world_action,
            # Exactly what we justify needing, and nothing else. No full_name, no
            # document_number, no nationality: the target is pseudonymous,
            # unique and document-backed, and identity would defeat it.
            "attributes": [
                {"type": "minimum_age", "value": settings.world_minimum_age},
            ],
            "environment": settings.world_environment,
            "isProduction": settings.world_is_production,
            "minimumAge": settings.world_minimum_age,
            "requireUserPresence": settings.world_require_user_presence,
            "allowLegacyProofs": settings.world_allow_legacy_proofs,
        }
    )


@router.post("/attest/enrol/proof")
async def enrol_proof(request: Request) -> JSONResponse:
    """Verify an Identity Check proof and record the tier against the nullifier.

    This authorizes nothing on its own. It records that the human behind a
    pseudonym holds a document-backed credential; a release still needs its own
    signal-bound proof.
    """
    runtime = runtime_of(request)
    if (disabled := _require_enabled(runtime)) is not None:
        return disabled
    try:
        proof = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    if not isinstance(proof, dict):
        return JSONResponse({"error": "Proof payload must be an object"}, status_code=400)

    try:
        verified = await runtime.world.verify_enrolment(proof)
    except AttestationError as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)

    assertions = {
        "identity_attested": verified.identity_attested,
        f"minimum_age>={runtime.settings.world_minimum_age}": verified.identity_attested,
        "document_backed": verified.identity_attested or verified.document_backed,
    }
    if runtime.settings.world_allow_legacy_proofs:
        # Finding D-15: a v3 proof and a v4 proof from one human carry different
        # nullifiers, and enrolment is v4-only. So with legacy proofs enabled a
        # publisher can enrol under one pseudonym and attest under another, and
        # the tier lookup misses with no way to tell that from "never enrolled".
        log.warning(
            "enrolment recorded while legacy proofs are enabled — the tier may not "
            "join to releases attested with a v3 proof (different nullifier)",
            nullifier=verified.nullifier,
        )

    enrolment = await runtime.attest.record_enrolment(
        nullifier=verified.nullifier,
        tier=verified.tier,
        assertions=assertions,
        environment=verified.environment,
        action=verified.action,
    )
    return JSONResponse(
        {
            "nullifier": enrolment.nullifier,
            "tier": enrolment.tier,
            "assertions": enrolment.assertions,
            "environment": enrolment.environment,
            "enrolledAt": enrolment.enrolled_at,
        }
    )


@router.post("/attest/session/{session_id}/proof")
async def submit_proof(request: Request, session_id: str) -> JSONResponse:
    runtime = runtime_of(request)
    if (disabled := _require_enabled(runtime)) is not None:
        return disabled
    try:
        proof = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    if not isinstance(proof, dict):
        return JSONResponse({"error": "Proof payload must be an object"}, status_code=400)

    session = await runtime.attest.get_session(session_id)
    if session is None:
        return JSONResponse({"error": "Unknown attestation session"}, status_code=404)
    # "failed" is retryable and must stay so: `/request` already re-issues an RP
    # signature for it, and a rejected proof means the maintainer produced the
    # wrong proof, not that they lost the right to attest. Requiring "owned" here
    # would let a single rejection brick a session that still holds a frozen,
    # ownership-checked signal. What is NOT retryable is a signal-less session —
    # that is the one that never passed the ownership gate.
    if session.status not in ("owned", "failed") or not session.signal:
        return JSONResponse(
            {"error": "Prove repository ownership before submitting a proof"}, status_code=409
        )

    try:
        verified = await runtime.world.verify(
            proof,
            expected_signal=session.signal,
            require_user_presence=runtime.settings.world_require_user_presence,
        )
    except AttestationError as exc:
        await runtime.attest.mark_status(session_id, "failed", str(exc))
        return JSONResponse({"error": str(exc)}, status_code=422)

    # The Identity Check join. The document tier is a durable property of the
    # human, established once at enrolment and looked up here by nullifier —
    # re-scanning a passport per release would prove nothing new, and could not
    # be bound to the artifact anyway. An unenrolled publisher is simply tier 1;
    # absence of an enrolment is never an error.
    enrolment = await runtime.attest.enrolment_for(verified.nullifier)
    tier = max(verified.tier, enrolment.tier) if enrolment else verified.tier
    enrolled_document = bool(enrolment and enrolment.assertions.get("document_backed"))
    enrolled_age = bool(
        enrolment
        and enrolment.assertions.get(f"minimum_age>={runtime.settings.world_minimum_age}")
    )

    assertions = {
        "ownership_proven": not runtime.settings.attest_dev_trust_ownership,
        "human_verified": True,
        "user_present": verified.user_presence,
        f"minimum_age>={runtime.settings.world_minimum_age}": (
            verified.identity_attested or enrolled_age
        ),
        # True via any of three routes: an IdentityCheck attestation on this very
        # proof, an enrolment this publisher completed earlier, or a proof issued
        # against a passport/MNC credential. The last two disclose nothing.
        "document_backed": (
            verified.identity_attested or verified.document_backed or enrolled_document
        ),
    }
    attested_at = now_iso()
    try:
        attestation = await runtime.attest.record(
            package_name=session.package_name,
            version=session.version,
            integrity=session.integrity,
            nullifier=verified.nullifier,
            tier=tier,
            assertions=assertions,
            environment=verified.environment,
            github_login=session.github_login,
            attested_at=attested_at,
        )
    except AttestationConflict as exc:
        await runtime.attest.mark_status(session_id, "failed", str(exc))
        return JSONResponse({"error": str(exc)}, status_code=409)

    await runtime.attest.mark_status(session_id, "verified")

    # Publishing is best-effort and deliberately AFTER the durable record: the
    # attestation is real once verified, and a storage or chain outage must not
    # discard a proof the maintainer already produced.
    envelope = build_envelope(
        package_name=session.package_name,
        version=session.version,
        integrity=session.integrity,
        verified=verified,
        attested_at=attested_at,
        assertions=assertions,
        verifier=runtime.settings.world_rp_id or "npmguard",
        tier=tier,
    )
    storage_root = None
    if runtime.zerog is not None:
        stored = await runtime.zerog.try_put_json(
            envelope, filename=f"attestation-{session.package_name}@{session.version}.json"
        )
        storage_root = stored.root_hash if stored else None
        if storage_root:
            await runtime.attest.attach_publication(
                session.package_name, session.version, storage_root=storage_root, chain_tx=None
            )

    refreshed = await runtime.attest.for_release(session.package_name, session.version)
    return JSONResponse(
        {
            **_public_session(await runtime.attest.get_session(session_id), refreshed or attestation),
            "envelope": envelope,
        }
    )

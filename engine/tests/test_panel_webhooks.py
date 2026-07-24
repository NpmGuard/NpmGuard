# CLASS MAP — panel.routes.gh_webhooks (port of TS routes/gh-webhooks.ts)
# (seam A: verify_signature + touches_dependencies are PURE — bytes/dict in,
#  bool out, no IO. seam B: the /webhooks/github route runs over a real
#  ASGITransport with a FAKE runtime on app.state — no GitHub, no DB touched by
#  the ping/verification paths.)
# verify_signature (HMAC-SHA256 over the RAW body, constant-time):
#   C1  a signature over the exact raw bytes verifies
#   C2  a wrong signature is rejected
#   C3  a missing signature is rejected
#   C4  the signature covers the RAW bytes, not a reparsed/re-serialized body —
#       a payload with insignificant JSON whitespace still verifies
# touches_dependencies (ROOT-only path match):
#   C5  a root lockfile (package-lock.json) in commits.modified -> True
#   C6  a root package.json in head_commit.added -> True
#   C7  a NESTED pkg/package.json -> False (repo-relative == root-only)
#   C8  an unrelated file (src/index.js) -> False; no commits -> False
# route /webhooks/github:
#   C9  App disabled / no webhook secret -> 503
#   C10 invalid signature -> 401 (no work scheduled)
#   C11 missing signature -> 401
#   C12 valid signature over raw body (ping) -> 202 {ok:true}
#   C13 valid signature but non-JSON body -> 400
import hashlib
import hmac
import json
from types import SimpleNamespace

import httpx
from fastapi import FastAPI

from npmguard.panel.routes.gh_webhooks import (
    router,
    touches_dependencies,
    verify_signature,
)

_SECRET = "s3cr3t-webhook-key"


def _sign(secret: str, raw: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------
# verify_signature — pure HMAC
# --------------------------------------------------------------------------


def test_verify_signature_accepts_matching() -> None:
    """C1: a signature computed over the exact raw bytes verifies."""
    raw = b'{"action":"created"}'
    assert verify_signature(_SECRET, raw, _sign(_SECRET, raw)) is True


def test_verify_signature_rejects_wrong() -> None:
    """C2: a signature for different bytes (or a different key) is rejected."""
    raw = b'{"action":"created"}'
    assert verify_signature(_SECRET, raw, _sign(_SECRET, b"other")) is False
    assert verify_signature(_SECRET, raw, _sign("wrong-key", raw)) is False


def test_verify_signature_rejects_missing() -> None:
    """C3: a missing/empty signature is rejected."""
    assert verify_signature(_SECRET, b"{}", None) is False
    assert verify_signature(_SECRET, b"{}", "") is False


def test_verify_signature_is_over_raw_bytes() -> None:
    """C4: the HMAC covers the raw bytes — a payload with odd whitespace still
    verifies against its own bytes (proving no reparse/re-serialize)."""
    raw = b'{"zen":   "Non-blocking is better than blocking.",  "hook_id": 1}'
    assert verify_signature(_SECRET, raw, _sign(_SECRET, raw)) is True
    # Canonical re-serialization would change the bytes and break the match.
    canonical = json.dumps(json.loads(raw), separators=(",", ":")).encode()
    assert canonical != raw
    assert verify_signature(_SECRET, canonical, _sign(_SECRET, raw)) is False


# --------------------------------------------------------------------------
# touches_dependencies — root-only path matching
# --------------------------------------------------------------------------


def test_touches_dependencies_root_lockfile() -> None:
    """C5: a modified root lockfile counts."""
    payload = {"commits": [{"modified": ["package-lock.json"]}]}
    assert touches_dependencies(payload) is True


def test_touches_dependencies_root_manifest_in_head_commit() -> None:
    """C6: an added root package.json in head_commit counts."""
    payload = {"head_commit": {"added": ["package.json"], "modified": [], "removed": []}}
    assert touches_dependencies(payload) is True


def test_touches_dependencies_ignores_nested() -> None:
    """C7: a nested package.json is NOT a root change (paths are repo-relative)."""
    payload = {"commits": [{"modified": ["packages/app/package.json"]}]}
    assert touches_dependencies(payload) is False


def test_touches_dependencies_unrelated_or_empty() -> None:
    """C8: an unrelated file (and an empty push) does not touch deps."""
    assert touches_dependencies({"commits": [{"added": ["src/index.js"]}]}) is False
    assert touches_dependencies({}) is False


# --------------------------------------------------------------------------
# /webhooks/github route — over a real ASGITransport, fake runtime
# --------------------------------------------------------------------------


def _app(*, enabled: bool = True, secret: str | None = _SECRET) -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.state.runtime = SimpleNamespace(
        settings=SimpleNamespace(
            github_app_enabled=enabled,
            github_webhook_secret=secret,
        ),
        # ping never touches these; present so an accidental handler call is loud.
        sessionmaker=None,
        gh_client=None,
        panel_scan=None,
    )
    return app


async def _post(app: FastAPI, raw: bytes, *, event: str, signature: str | None):
    headers = {"content-type": "application/json", "x-github-event": event}
    if signature is not None:
        headers["x-hub-signature-256"] = signature
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        return await client.post("/webhooks/github", content=raw, headers=headers)


async def test_route_503_when_disabled() -> None:
    """C9: the App (or the webhook secret) not configured -> 503."""
    app = _app(enabled=False)
    raw = b'{"zen":"x"}'
    resp = await _post(app, raw, event="ping", signature=_sign(_SECRET, raw))
    assert resp.status_code == 503

    app = _app(secret=None)
    resp = await _post(app, raw, event="ping", signature=_sign(_SECRET, raw))
    assert resp.status_code == 503


async def test_route_401_on_bad_signature() -> None:
    """C10: an invalid signature -> 401 (the body is never acted on)."""
    app = _app()
    raw = b'{"zen":"x"}'
    resp = await _post(app, raw, event="ping", signature=_sign(_SECRET, b"tampered"))
    assert resp.status_code == 401


async def test_route_401_on_missing_signature() -> None:
    """C11: a missing signature header -> 401."""
    app = _app()
    resp = await _post(app, b'{"zen":"x"}', event="ping", signature=None)
    assert resp.status_code == 401


async def test_route_202_on_valid_signature() -> None:
    """C12: a valid signature over the raw ping body -> 202 {ok:true}."""
    app = _app()
    raw = b'{"zen":  "Design for failure.",  "hook_id": 7}'
    resp = await _post(app, raw, event="ping", signature=_sign(_SECRET, raw))
    assert resp.status_code == 202
    assert resp.json() == {"ok": True}


async def test_route_400_on_non_json_body() -> None:
    """C13: a validly-signed but non-JSON body -> 400 (parse fails AFTER the
    signature is verified over the raw bytes)."""
    app = _app()
    raw = b"not json at all"
    resp = await _post(app, raw, event="ping", signature=_sign(_SECRET, raw))
    assert resp.status_code == 400

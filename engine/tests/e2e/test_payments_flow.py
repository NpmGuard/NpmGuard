# CLASS MAP — payment gate + audit launch paths (e2e: real engine, real HTTP stubs)
# Axes: proof kind (chain tx / stripe session / webhook / free / CRE) × proof validity
#       × delivery timing (immediate / delayed / replayed / concurrent) × db engine
#   S4  valid chain tx → verified claim, exactly one launch, SAFE verdict [C5, C11]
#   C17 delayed receipt (< 30s wait bound) verifies — stub timing, never a wall-clock 30s
#   S5  replayed tx: sequential + concurrent (sqlite AND postgres) → 200-idempotent,
#       same auditId, exactly one audit_started [C5, C10]
#   S6  invalid receipt matrix → 402 AND zero session/claim rows (negative probes paired
#       with a positive valid-tx probe on the same engine) [C5, C11];
#       unconfigured chain → 501; missing/invalid fields → 400
#   S7  stripe checkout create + live-verified status (paid:false) + paid-session
#       stream launch + claimed-session idempotency
#   S8  webhook claim once-only across replays + bad signature → 400 (offline HMAC) [C5]
#   S26 webhook vs /audit/stream race for one paid session → exactly one
#       session/claim/launch [C5, C10] — sqlite only, a DELIBERATE narrowing of
#       the §S36 pg axis: the race resolves in claim_payment, whose sqlite vs
#       postgres divergence is proven by S5/C15-postgres; the webhook/stream
#       plumbing above it is engine-agnostic
#   S27 launch-path parity: sync /audit vs CRE /audit vs free /audit/stream produce the
#       same report + event vocabulary; parallel-stream divergence pinned (UNENFORCED)
#   S9  payment gate 402; CRE key → 202 + queuePosition; invalid payload → 400 [C5]
#   S37 boot invariant (F3): MOCK_LLM=true + env=prod refuses to start; dev boots [C8]
# Adversarial pass: W4b — "can a failed verification leave rows or launches behind?"
#   answered by the S6/S8 row-count negative probes paired with positive probes.
#
# Blackbox: engine HTTP API + SSE + report files + DB rows (observable effects only).

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time

import httpx
import pytest
import sqlalchemy as sa

from tests.e2e.llm_mock import SAFE_FLAG_BODY, SAFE_INTENT_BODY, scripted_safe_roles
from tests.support.harness import DEAD_URL
from tests.support.sse import collect_frames, event_types, find_frames, terminal_frame
from tests.support.waits import wait_audit_report, wait_report_file

pytestmark = pytest.mark.e2e

ENV_EXFIL_PKG = "test-pkg-env-exfil"
ENV_EXFIL_VERSION = "2.0.1"

CONTRACT = "0x" + "c1" * 20
OTHER_CONTRACT = "0x" + "d2" * 20
CRE_KEY = "cre-test-key"
STRIPE_KEY = "sk_test_x"
WEBHOOK_SECRET = "whsec_test_secret"

AUDIT_DEADLINE_SECONDS = 90.0
HTTP_TIMEOUT_SECONDS = 30.0
# Receipt appears 3s after first poll — well under payments.py's 30s wait bound (C17).
RECEIPT_DELAY_SECONDS = 3.0
# Divergence pin: intent delayed by this much makes serial-vs-parallel observable.
PARALLEL_PIN_DELAY_MS = 6000

def _tx(n: int) -> str:
    return "0x" + f"{n:064x}"


async def _post(url: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        return await client.post(url, **kwargs)


async def _get(url: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        return await client.get(url, **kwargs)


def _row_count(db_url: str, table: str) -> int:
    """Count rows via a sync engine — DB rows are a sanctioned observable effect."""
    sync_url = db_url.replace("+aiosqlite", "").replace("+asyncpg", "")
    engine = sa.create_engine(sync_url)
    try:
        with engine.connect() as connection:
            return connection.execute(
                sa.text(f"SELECT COUNT(*) FROM {table}")  # noqa: S608 — fixed table names
            ).scalar_one()
    finally:
        engine.dispose()


def _stripe_signature(payload: bytes, secret: str) -> str:
    timestamp = int(time.time())
    signed = f"{timestamp}.".encode() + payload
    digest = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


def _webhook_payload(session_id: str, package_name: str, version: str) -> bytes:
    event = {
        "id": "evt_test_0001",
        "object": "event",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": session_id,
                "object": "checkout.session",
                "metadata": {"packageName": package_name, "version": version},
            }
        },
    }
    return json.dumps(event).encode()


def _chain_engine(engine_factory, mock_llm, fake_chain, **kwargs):
    return engine_factory(
        llm_url=mock_llm.v1_url,
        payment_required=True,
        chain_rpc_url=fake_chain.base_url,
        chain_contract=CONTRACT,
        **kwargs,
    )


async def _finished_frames(engine, audit_id: str):
    return await collect_frames(engine.base_url, audit_id, deadline=AUDIT_DEADLINE_SECONDS)


# ---------------------------------------------------------------------------
# S4 / C17 — valid chain proofs
# ---------------------------------------------------------------------------


async def test_valid_chain_tx_claims_and_launches(engine_factory, mock_llm, fake_chain):
    """S4 [C5,C11]: a valid AuditRequested receipt verifies, claims, launches exactly one audit."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    fake_chain.add_receipt(
        _tx(1), contract=CONTRACT, package_name=ENV_EXFIL_PKG, version=ENV_EXFIL_VERSION
    )
    engine = _chain_engine(engine_factory, mock_llm, fake_chain)

    started = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION, txHash=_tx(1))
    assert started["packageName"] == ENV_EXFIL_PKG
    frames = await _finished_frames(engine, started["auditId"])
    terminal = terminal_frame(frames)
    assert terminal is not None and terminal.type == "verdict_reached"
    assert terminal.data["verdict"] == "SAFE"
    assert len(find_frames(frames, "audit_started")) == 1
    assert _row_count(engine.db_url, "payment_claims") == 1
    assert _row_count(engine.db_url, "audit_sessions") == 1


async def test_delayed_receipt_still_verifies(engine_factory, mock_llm, fake_chain):
    """C17: receipt appearing after a delay < the 30s wait bound verifies (stub timing, no wall-clock 30s)."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    fake_chain.add_receipt(
        _tx(2),
        contract=CONTRACT,
        package_name=ENV_EXFIL_PKG,
        version=ENV_EXFIL_VERSION,
        delay_seconds=RECEIPT_DELAY_SECONDS,
    )
    engine = _chain_engine(engine_factory, mock_llm, fake_chain)

    started = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION, txHash=_tx(2))
    frames = await _finished_frames(engine, started["auditId"])
    assert terminal_frame(frames).data["verdict"] == "SAFE"
    # positive probe that the poll loop actually ran more than once
    polls = [r for r in fake_chain.requests if r["method"] == "eth_getTransactionReceipt"]
    assert len(polls) >= 2


# ---------------------------------------------------------------------------
# S5 — replay / concurrency (sqlite + postgres via db_url axis)
# ---------------------------------------------------------------------------


async def test_replayed_tx_is_idempotent(engine_factory, mock_llm, fake_chain):
    """S5 [C5,C10]: replaying a claimed txHash returns 200 with the SAME auditId and no relaunch."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    fake_chain.add_receipt(
        _tx(3), contract=CONTRACT, package_name=ENV_EXFIL_PKG, version=ENV_EXFIL_VERSION
    )
    engine = _chain_engine(engine_factory, mock_llm, fake_chain)

    first = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION, txHash=_tx(3))
    frames = await _finished_frames(engine, first["auditId"])
    assert terminal_frame(frames).data["verdict"] == "SAFE"

    replay = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION, txHash=_tx(3))
    assert replay["auditId"] == first["auditId"]
    # positive probe: full channel replay still holds exactly one launch
    replay_frames = await _finished_frames(engine, first["auditId"])
    assert len(find_frames(replay_frames, "audit_started")) == 1
    assert _row_count(engine.db_url, "audit_sessions") == 1


async def test_concurrent_same_tx_single_claim(engine_factory, mock_llm, fake_chain, db_url):
    """S5 [C5,C10]: two CONCURRENT posts of one txHash → both 200, same auditId, one audit_started.

    Runs on the sqlite AND postgres axis (db_url fixture) — sqlite serializes writers,
    so only the postgres variant honestly exercises C10's concurrent clause.
    """
    mock_llm.load(scripted_roles=scripted_safe_roles())
    fake_chain.add_receipt(
        _tx(4), contract=CONTRACT, package_name=ENV_EXFIL_PKG, version=ENV_EXFIL_VERSION
    )
    engine = _chain_engine(engine_factory, mock_llm, fake_chain, db_url=db_url)

    payload = {
        "packageName": ENV_EXFIL_PKG,
        "version": ENV_EXFIL_VERSION,
        "txHash": _tx(4),
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        first, second = await asyncio.gather(
            client.post(f"{engine.base_url}/audit/stream", json=payload),
            client.post(f"{engine.base_url}/audit/stream", json=payload),
        )
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["auditId"] == second.json()["auditId"]

    frames = await _finished_frames(engine, first.json()["auditId"])
    assert terminal_frame(frames).data["verdict"] == "SAFE"
    assert len(find_frames(frames, "audit_started")) == 1
    assert _row_count(db_url, "payment_claims") == 1
    assert _row_count(db_url, "audit_sessions") == 1


# ---------------------------------------------------------------------------
# S6 — invalid proofs never create state
# ---------------------------------------------------------------------------


async def test_invalid_receipt_matrix_rejects_and_leaves_no_rows(
    engine_factory, mock_llm, fake_chain
):
    """S6 [C5,C11]: reverted/wrong-pkg/wrong-ver/wrong-topic/wrong-contract receipts → 402
    and ZERO session/claim rows; paired positive probe: a valid tx then creates exactly one."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = _chain_engine(engine_factory, mock_llm, fake_chain)

    ok = dict(contract=CONTRACT, package_name=ENV_EXFIL_PKG, version=ENV_EXFIL_VERSION)
    cases = {
        "reverted": dict(ok, status=0),
        "wrong-package": dict(ok, package_name="some-other-pkg"),
        "wrong-version": dict(ok, version="9.9.9"),
        "wrong-event-topic": dict(ok, wrong_event=True),
        "log-at-other-contract": dict(ok, log_address=OTHER_CONTRACT),
    }
    for index, (name, kwargs) in enumerate(cases.items(), start=10):
        fake_chain.add_receipt(_tx(index), **kwargs)
        response = await _post(
            f"{engine.base_url}/audit/stream",
            json={
                "packageName": ENV_EXFIL_PKG,
                "version": ENV_EXFIL_VERSION,
                "txHash": _tx(index),
            },
        )
        assert response.status_code == 402, f"case {name}: {response.text}"
        assert _row_count(engine.db_url, "audit_sessions") == 0, f"case {name} left a session"
        assert _row_count(engine.db_url, "payment_claims") == 0, f"case {name} left a claim"

    # positive probe on the same engine: the gate opens for a valid receipt
    fake_chain.add_receipt(_tx(30), **ok)
    started = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION, txHash=_tx(30))
    frames = await _finished_frames(engine, started["auditId"])
    assert terminal_frame(frames).data["verdict"] == "SAFE"
    assert _row_count(engine.db_url, "audit_sessions") == 1
    assert _row_count(engine.db_url, "payment_claims") == 1


def test_unfetchable_receipt_rejects_quickly(engine_factory, mock_llm, fake_chain):
    """S6 [C5]: an RPC that refuses connections → 402, no rows.

    Stands in for the receipt-never-arrives class: an absent receipt makes web3 poll
    the full hardcoded 30s (payments.py), which the determinism rules forbid burning;
    a dead RPC exercises the same ChainVerificationError → 402 mapping instantly.
    """
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        payment_required=True,
        chain_rpc_url=DEAD_URL,
        chain_contract=CONTRACT,
    )
    response = httpx.post(
        f"{engine.base_url}/audit/stream",
        json={"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION, "txHash": _tx(40)},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    assert response.status_code == 402
    assert _row_count(engine.db_url, "audit_sessions") == 0
    assert _row_count(engine.db_url, "payment_claims") == 0


def test_chain_unconfigured_and_bad_fields(engine_factory, mock_llm):
    """S6: unconfigured chain → 501; txHash without pkg/version → 400; malformed txHash/chain → 400."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url, payment_required=True)  # no contract

    def post(payload: dict) -> httpx.Response:
        return httpx.post(
            f"{engine.base_url}/audit/stream", json=payload, timeout=HTTP_TIMEOUT_SECONDS
        )

    assert (
        post(
            {"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION, "txHash": _tx(50)}
        ).status_code
        == 501
    )
    assert post({"txHash": _tx(50), "chain": "base-sepolia"}).status_code == 501
    assert post({"packageName": ENV_EXFIL_PKG, "txHash": "0xnothex"}).status_code == 400
    assert (
        post({"packageName": ENV_EXFIL_PKG, "txHash": _tx(50), "chain": "dogecoin"}).status_code
        == 400
    )

    configured = engine_factory(
        llm_url=mock_llm.v1_url,
        payment_required=True,
        chain_rpc_url=DEAD_URL,
        chain_contract=CONTRACT,
    )
    # configured chain but txHash without packageName/version → 400 before any RPC call
    missing = httpx.post(
        f"{configured.base_url}/audit/stream",
        json={"txHash": _tx(51)},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    assert missing.status_code == 400


# ---------------------------------------------------------------------------
# S7 — stripe checkout + status
# ---------------------------------------------------------------------------


def _stripe_engine(engine_factory, mock_llm, stripe_stub, **kwargs):
    return engine_factory(
        llm_url=mock_llm.v1_url,
        payment_required=True,
        stripe_api_base=stripe_stub.base_url,
        stripe_secret_key=STRIPE_KEY,
        stripe_webhook_secret=WEBHOOK_SECRET,
        **kwargs,
    )


def test_checkout_creates_stripe_session(engine_factory, mock_llm, stripe_stub):
    """S7: POST /checkout builds a stripe session (via K4 api_base stub) carrying pkg metadata."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = _stripe_engine(engine_factory, mock_llm, stripe_stub)

    response = httpx.post(
        f"{engine.base_url}/checkout",
        json={"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["url"].startswith("https://checkout.stripe.example/")
    session = stripe_stub.sessions[body["sessionId"]]
    assert session["metadata"] == {
        "packageName": ENV_EXFIL_PKG,
        "version": ENV_EXFIL_VERSION,
    }


def test_checkout_status_unclaimed_session(engine_factory, mock_llm, stripe_stub):
    """S7: status of an unclaimed session comes from live Stripe verification (paid:false)."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = _stripe_engine(engine_factory, mock_llm, stripe_stub)
    stripe_stub.add_session(
        "cs_test_unpaid", package_name=ENV_EXFIL_PKG, version=ENV_EXFIL_VERSION,
        payment_status="unpaid",
    )
    response = httpx.get(
        f"{engine.base_url}/checkout/cs_test_unpaid/status", timeout=HTTP_TIMEOUT_SECONDS
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "paid": False,
        "packageName": ENV_EXFIL_PKG,
        "version": ENV_EXFIL_VERSION,
    }


async def test_stream_verifies_paid_stripe_session(engine_factory, mock_llm, stripe_stub):
    """S7 [C5]: /audit/stream{stripeSessionId} verifies a PAID unclaimed session and launches."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = _stripe_engine(engine_factory, mock_llm, stripe_stub)
    stripe_stub.add_session(
        "cs_test_paid", package_name=ENV_EXFIL_PKG, version=ENV_EXFIL_VERSION
    )
    response = await _post(
        f"{engine.base_url}/audit/stream", json={"stripeSessionId": "cs_test_paid"}
    )
    assert response.status_code == 200, response.text
    frames = await _finished_frames(engine, response.json()["auditId"])
    assert terminal_frame(frames).data["verdict"] == "SAFE"


async def test_claimed_stripe_session_is_idempotent(engine_factory, mock_llm, stripe_stub):
    """S7 [C5,C10]: once claimed (via webhook), status reports paid+auditId and
    /audit/stream replays 200-idempotently with the same auditId — no re-verify, no relaunch."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = _stripe_engine(engine_factory, mock_llm, stripe_stub)
    session_id = "cs_test_claimed"

    payload = _webhook_payload(session_id, ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    delivered = await _post(
        f"{engine.base_url}/webhooks/stripe",
        content=payload,
        headers={"stripe-signature": _stripe_signature(payload, WEBHOOK_SECRET)},
    )
    assert delivered.status_code == 200

    status = (await _get(f"{engine.base_url}/checkout/{session_id}/status")).json()
    assert status["paid"] is True
    audit_id = status["auditId"]

    replay = await _post(
        f"{engine.base_url}/audit/stream", json={"stripeSessionId": session_id}
    )
    assert replay.status_code == 200
    assert replay.json()["auditId"] == audit_id

    frames = await _finished_frames(engine, audit_id)
    assert terminal_frame(frames).data["verdict"] == "SAFE"
    assert len(find_frames(frames, "audit_started")) == 1


# ---------------------------------------------------------------------------
# S8 / S26 — webhook exactly-once + race
# ---------------------------------------------------------------------------


async def test_webhook_claims_once_across_replays(engine_factory, mock_llm, stripe_stub):
    """S8 [C5,C10]: replayed checkout.session.completed deliveries claim+launch exactly
    once — including a LATE redelivery arriving after the audit already finished
    (Stripe redelivers hours later; a relaunch there would restart a done audit)."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = _stripe_engine(engine_factory, mock_llm, stripe_stub)
    session_id = "cs_test_replayed"
    payload = _webhook_payload(session_id, ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    headers = {"stripe-signature": _stripe_signature(payload, WEBHOOK_SECRET)}

    for _ in range(3):
        response = await _post(
            f"{engine.base_url}/webhooks/stripe", content=payload, headers=headers
        )
        assert response.status_code == 200
        assert response.json() == {"received": True}

    assert _row_count(engine.db_url, "audit_sessions") == 1
    assert _row_count(engine.db_url, "payment_claims") == 1
    status = (await _get(f"{engine.base_url}/checkout/{session_id}/status")).json()
    frames = await _finished_frames(engine, status["auditId"])
    assert terminal_frame(frames).data["verdict"] == "SAFE"
    assert len(find_frames(frames, "audit_started")) == 1

    # LATE replay: redeliver AFTER the verdict, then drain the FULL finished
    # channel (until_terminal=False — a truncated collection could hide a
    # post-terminal relaunch). Exactly one launch and one terminal, ever.
    late = await _post(
        f"{engine.base_url}/webhooks/stripe", content=payload, headers=headers
    )
    assert late.status_code == 200
    full = await collect_frames(
        engine.base_url,
        status["auditId"],
        until_terminal=False,
        deadline=AUDIT_DEADLINE_SECONDS,
    )
    assert len(find_frames(full, "audit_started")) == 1
    assert len([f for f in full if f.type in ("verdict_reached", "audit_error")]) == 1
    assert _row_count(engine.db_url, "audit_sessions") == 1
    assert _row_count(engine.db_url, "payment_claims") == 1


def test_webhook_bad_signature_rejected(engine_factory, mock_llm, stripe_stub):
    """S8 [C5]: a tampered signature → 400 and zero rows (paired: the valid-signature
    class is the positive probe in test_webhook_claims_once_across_replays)."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = _stripe_engine(engine_factory, mock_llm, stripe_stub)
    payload = _webhook_payload("cs_test_forged", ENV_EXFIL_PKG, ENV_EXFIL_VERSION)

    response = httpx.post(
        f"{engine.base_url}/webhooks/stripe",
        content=payload,
        headers={"stripe-signature": _stripe_signature(payload, "whsec_wrong_secret")},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    assert response.status_code == 400
    missing = httpx.post(
        f"{engine.base_url}/webhooks/stripe", content=payload, timeout=HTTP_TIMEOUT_SECONDS
    )
    assert missing.status_code == 400
    assert _row_count(engine.db_url, "audit_sessions") == 0
    assert _row_count(engine.db_url, "payment_claims") == 0


async def test_webhook_vs_stream_race_single_launch(engine_factory, mock_llm, stripe_stub):
    """S26 [C5,C10]: webhook delivery racing /audit/stream for ONE paid session →
    exactly one session row, one claim, one audit_started.

    BOTH sides must succeed with 200: whichever loses the claim race converges on
    the winner's session (stream via live-verify + idempotent claim_payment).
    """
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = _stripe_engine(engine_factory, mock_llm, stripe_stub)
    session_id = "cs_test_race"
    stripe_stub.add_session(session_id, package_name=ENV_EXFIL_PKG, version=ENV_EXFIL_VERSION)
    payload = _webhook_payload(session_id, ENV_EXFIL_PKG, ENV_EXFIL_VERSION)

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        webhook_response, stream_response = await asyncio.gather(
            client.post(
                f"{engine.base_url}/webhooks/stripe",
                content=payload,
                headers={"stripe-signature": _stripe_signature(payload, WEBHOOK_SECRET)},
            ),
            client.post(
                f"{engine.base_url}/audit/stream", json={"stripeSessionId": session_id}
            ),
        )
    assert webhook_response.status_code == 200
    assert stream_response.status_code == 200

    assert _row_count(engine.db_url, "audit_sessions") == 1
    assert _row_count(engine.db_url, "payment_claims") == 1
    status = (await _get(f"{engine.base_url}/checkout/{session_id}/status")).json()
    assert status["paid"] is True
    assert stream_response.json()["auditId"] == status["auditId"]
    frames = await _finished_frames(engine, status["auditId"])
    assert len(find_frames(frames, "audit_started")) == 1


# ---------------------------------------------------------------------------
# S27 — launch-path parity
# ---------------------------------------------------------------------------


async def test_launch_path_parity(engine_factory, mock_llm):
    """S27 [C15]: sync /audit, CRE /audit, and free /audit/stream yield the same report
    shape/verdict, the same event vocabulary, and the same persisted file."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    # triage_concurrency=1 makes per-file event order deterministic for the comparison
    engine = engine_factory(
        llm_url=mock_llm.v1_url, cre_api_key=CRE_KEY, triage_concurrency=1
    )
    request = {"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION}

    sync_report = (
        await _post(f"{engine.base_url}/audit", json=request, timeout=AUDIT_DEADLINE_SECONDS)
    ).json()
    assert sync_report["verdict"] == "SAFE"

    cre = await _post(
        f"{engine.base_url}/audit", json=request, headers={"x-api-key": CRE_KEY}
    )
    assert cre.status_code == 202
    assert cre.json()["queuePosition"] == 1
    cre_frames = await _finished_frames(engine, cre.json()["auditId"])
    # Terminal frame precedes finalize — poll the report route past its 202
    # (tests/support/waits.py) instead of a raw GET.
    cre_report = wait_audit_report(engine.base_url, cre.json()["auditId"]).json()

    stream = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    stream_frames = await _finished_frames(engine, stream["auditId"])
    stream_report = wait_audit_report(engine.base_url, stream["auditId"]).json()

    for report in (cre_report, stream_report):
        assert report["verdict"] == sync_report["verdict"]
        assert report["counts"] == sync_report["counts"]
        assert report["schemaVersion"] == sync_report["schemaVersion"]
        assert set(report) == set(sync_report)
    assert event_types(cre_frames) == event_types(stream_frames)

    persisted = engine.data_dir / "reports" / ENV_EXFIL_PKG / f"{ENV_EXFIL_VERSION}.json"
    assert wait_report_file(persisted)["verdict"] == "SAFE"


async def test_parallel_stream_launches_not_queue_serialized(engine_factory, mock_llm):
    """S27 divergence pin: N free /audit/stream launches run in PARALLEL, bypassing the
    single-worker queue that serializes /audit — only the session cap bounds them.

    # UNENFORCED: pinned current behavior, intended-or-hole per scenario-adversarial §1.
    Proof by timing with a 2x margin: each intent call stalls PARALLEL_PIN_DELAY_MS in the
    mock, so two SERIALIZED audits would need >= 2 delays of wall time; parallel ≈ one.
    """
    mock_llm.load(
        scripted_roles={
            "intent": {
                "kind": "delay",
                "delay_ms": PARALLEL_PIN_DELAY_MS,
                "then": {"kind": "static", "body": SAFE_INTENT_BODY},
            },
            "flag": {"kind": "static", "body": SAFE_FLAG_BODY},
        }
    )
    engine = engine_factory(llm_url=mock_llm.v1_url)

    start = time.monotonic()
    first = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    second = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    first_frames, second_frames = await asyncio.gather(
        _finished_frames(engine, first["auditId"]),
        _finished_frames(engine, second["auditId"]),
    )
    elapsed = time.monotonic() - start
    assert terminal_frame(first_frames).data["verdict"] == "SAFE"
    assert terminal_frame(second_frames).data["verdict"] == "SAFE"
    assert first["auditId"] != second["auditId"]  # free path never dedupes (engine/CLAUDE.md)
    assert elapsed < 2 * (PARALLEL_PIN_DELAY_MS / 1000), (
        f"two stream audits took {elapsed:.1f}s — queue-serialized? (parallel ≈ "
        f"{PARALLEL_PIN_DELAY_MS / 1000:.0f}s, serial >= {2 * PARALLEL_PIN_DELAY_MS / 1000:.0f}s)"
    )


# ---------------------------------------------------------------------------
# S9 — gate + CRE + payload validation
# ---------------------------------------------------------------------------


async def test_payment_gate_and_cre_key(engine_factory, mock_llm):
    """S9 [C5]: payment_required gates /audit and bare /audit/stream with 402; a valid
    CRE key opens /audit as 202+queuePosition and the audit completes."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(
        llm_url=mock_llm.v1_url, payment_required=True, cre_api_key=CRE_KEY
    )
    request = {"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION}

    assert (await _post(f"{engine.base_url}/audit", json=request)).status_code == 402
    assert (await _post(f"{engine.base_url}/audit/stream", json=request)).status_code == 402
    wrong_key = await _post(
        f"{engine.base_url}/audit", json=request, headers={"x-api-key": "not-the-key"}
    )
    assert wrong_key.status_code == 402

    accepted = await _post(
        f"{engine.base_url}/audit", json=request, headers={"x-api-key": CRE_KEY}
    )
    assert accepted.status_code == 202
    body = accepted.json()
    assert body["status"] == "accepted"
    assert body["queuePosition"] == 1
    frames = await _finished_frames(engine, body["auditId"])
    assert terminal_frame(frames).data["verdict"] == "SAFE"


def test_invalid_payloads_rejected_before_gate(engine_factory, mock_llm):
    """S9: malformed names/semver → 400 pydantic details, on /audit and /audit/stream alike."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url, payment_required=True)

    for payload in (
        {"packageName": "UPPERCASE-Bad"},
        {"packageName": "ok-pkg", "version": "not.a.semver.at.all"},
        {"packageName": ""},
    ):
        for route in ("/audit", "/audit/stream"):
            response = httpx.post(
                f"{engine.base_url}{route}", json=payload, timeout=HTTP_TIMEOUT_SECONDS
            )
            assert response.status_code == 400, f"{route} {payload}: {response.text}"


# ---------------------------------------------------------------------------
# S37 — boot invariant (F3)
# ---------------------------------------------------------------------------


def test_mock_llm_in_prod_refuses_to_start(engine_factory):
    """S37 [C8]: NPMGUARD_MOCK_LLM=true + NPMGUARD_ENV=prod → the engine refuses to boot."""
    engine = engine_factory(
        wait_ready=False, env={"NPMGUARD_MOCK_LLM": "true", "NPMGUARD_ENV": "prod"}
    )
    code = engine.wait_exit(timeout=20)
    assert code not in (None, 0), f"engine should refuse to start, exit={code}"
    assert "Refusing to start" in engine.stderr_tail(200)


def test_mock_llm_in_dev_boots(engine_factory):
    """S37 [C8] positive pair: MOCK_LLM=true is allowed outside prod — dev boots fine."""
    engine = engine_factory(env={"NPMGUARD_MOCK_LLM": "true"})
    response = httpx.get(f"{engine.base_url}/health", timeout=HTTP_TIMEOUT_SECONDS)
    assert response.status_code == 200

# CLASS MAP — engine lifecycle: restart recovery + shutdown (e2e: real engine, SIGKILL/SIGTERM)
# Axes: interruption point (mid-run / mid-queue / after completion) × restart vs shutdown
#       × client resume position (live cursor / cold replay)
#   S20 SIGKILL mid-audit → restart on same port+db → NPMGUARD-0031 retryable audit_error
#       lands on the client's RESUMED cursor [C9]
#   S21 payment claim survives restart: replayed txHash after restart → same auditId,
#       no relaunch [C10]
#   S32 restart mid-QUEUE: the executing AND the queued CRE sessions (all status=running
#       rows) each get their own 0031; queued-never-started channels hold ONLY the 0031 [C9]
#   S31 shutdown-stall PIN: SIGTERM with an in-flight audit is NOT graceful —
#       audits.close() awaits in-flight tasks unbounded (api.py lifespan) — bounded
#       observation via harness grace, never a suite hang  # UNENFORCED / expect-finding
# Adversarial pass: W4b — "do queued-but-never-started sessions get abandoned silently?"
#   answered by S32's per-channel replay assertions.
# DB axis (§S36) — DELIBERATE narrowing: S20/S21/S32 run sqlite-only. Restart
#   recovery + claim durability go through AuditSessionStore/claim_payment,
#   whose engine divergence (MVCC vs serialized writers) is proven by the
#   postgres-marked claim classes (test_payments.py C15-postgres, S5[postgres],
#   S14[postgres]); the SIGKILL/respawn choreography itself is engine-agnostic.
#
# Blackbox: engine HTTP + SSE + DB rows; restart/close via the harness process controls.

from __future__ import annotations

import asyncio

import httpx
import pytest
import sqlalchemy as sa

from tests.e2e.llm_mock import SAFE_FLAG_BODY, SAFE_INTENT_BODY, scripted_safe_roles
from tests.support.sse import (
    SseFrame,
    collect_frames,
    find_frames,
    iter_frames,
    terminal_frame,
)
from tests.support.waits import wait_audit_report

pytestmark = pytest.mark.e2e

ENV_EXFIL_PKG = "test-pkg-env-exfil"
ENV_EXFIL_VERSION = "2.0.1"

CONTRACT = "0x" + "c1" * 20
CRE_KEY = "cre-test-key"
TX_HASH = "0x" + "ab" * 32

AUDIT_DEADLINE_SECONDS = 90.0
EVENT_WAIT_SECONDS = 30.0
HTTP_TIMEOUT_SECONDS = 30.0
# Intent stalls this long in the mock so an audit is reliably in-flight when the engine
# is killed; the engine-side LLM timeout is raised above it so the stall cannot resolve
# into an error inside the observation window.
STALL_DELAY_MS = 120_000
STALL_LLM_TIMEOUT_SECONDS = 180.0
# S31: generous bound for observing the non-graceful close; must stay far below the stall.
SHUTDOWN_STALL_GRACE_SECONDS = 4.0

INTERRUPTED_CODE = "NPMGUARD-0031"


def _stalling_roles() -> dict:
    return {
        "intent": {
            "kind": "delay",
            "delay_ms": STALL_DELAY_MS,
            "then": {"kind": "static", "body": SAFE_INTENT_BODY},
        },
        "flag": {"kind": "static", "body": SAFE_FLAG_BODY},
    }


async def _post(url: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        return await client.post(url, **kwargs)


async def _get(url: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        return await client.get(url, **kwargs)


async def _first_frame_of_type(
    base_url: str, audit_id: str, event_type: str, deadline: float = EVENT_WAIT_SECONDS
) -> SseFrame:
    async with asyncio.timeout(deadline):
        async for frame in iter_frames(base_url, audit_id, deadline=deadline):
            if frame.type == event_type:
                return frame
    raise AssertionError(f"stream for {audit_id} closed without a {event_type} frame")


def _row_count(db_url: str, table: str) -> int:
    sync_url = db_url.replace("+aiosqlite", "").replace("+asyncpg", "")
    engine = sa.create_engine(sync_url)
    try:
        with engine.connect() as connection:
            return connection.execute(
                sa.text(f"SELECT COUNT(*) FROM {table}")  # noqa: S608 — fixed table names
            ).scalar_one()
    finally:
        engine.dispose()


async def test_restart_mid_run_emits_retryable_error_on_resumed_cursor(
    engine_factory, mock_llm
):
    """S20 [C9]: SIGKILL mid-audit + restart (same port/db) → the durable channel gains a
    retryable NPMGUARD-0031 audit_error, visible from the client's pre-kill cursor."""
    mock_llm.load(scripted_roles=_stalling_roles())
    engine = engine_factory(
        llm_url=mock_llm.v1_url, llm_timeout_seconds=STALL_LLM_TIMEOUT_SECONDS
    )
    started = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    audit_id = started["auditId"]

    live = await _first_frame_of_type(engine.base_url, audit_id, "audit_started")
    assert live.id is not None
    engine.restart()  # SIGKILL group, respawn on the SAME port with the SAME db

    resumed = await collect_frames(
        engine.base_url, audit_id, since=live.id, deadline=AUDIT_DEADLINE_SECONDS
    )
    terminal = terminal_frame(resumed)
    assert terminal is not None and terminal.type == "audit_error"
    assert terminal.data["code"] == INTERRUPTED_CODE
    assert terminal.data["retryable"] is True
    # no duplicate launch: audit_started was before the cursor, none after
    assert find_frames(resumed, "audit_started") == []

    # _fail_interrupted emits the 0031 BEFORE finalizing the session, so the
    # report route can still say 202 right after the terminal frame — poll
    # bounded past the 202 (tests/support/waits.py).
    report = wait_audit_report(engine.base_url, audit_id)
    assert report.status_code == 500
    assert "interrupted" in report.json()["message"].lower()


async def test_payment_claim_survives_restart(engine_factory, mock_llm, fake_chain):
    """S21 [C10]: a claimed (chain, txHash) is durable — after restart the replayed tx
    returns the SAME auditId with no relaunch and no new rows."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    fake_chain.add_receipt(
        TX_HASH, contract=CONTRACT, package_name=ENV_EXFIL_PKG, version=ENV_EXFIL_VERSION
    )
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        payment_required=True,
        chain_rpc_url=fake_chain.base_url,
        chain_contract=CONTRACT,
    )
    first = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION, txHash=TX_HASH)
    frames = await collect_frames(
        engine.base_url, first["auditId"], deadline=AUDIT_DEADLINE_SECONDS
    )
    assert terminal_frame(frames).data["verdict"] == "SAFE"

    engine.restart()
    replay = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION, txHash=TX_HASH)
    assert replay["auditId"] == first["auditId"]
    replay_frames = await collect_frames(
        engine.base_url, first["auditId"], deadline=AUDIT_DEADLINE_SECONDS
    )
    assert len(find_frames(replay_frames, "audit_started")) == 1
    assert terminal_frame(replay_frames).data["verdict"] == "SAFE"
    assert _row_count(engine.db_url, "audit_sessions") == 1
    assert _row_count(engine.db_url, "payment_claims") == 1


async def test_restart_mid_queue_fails_queued_sessions_too(engine_factory, mock_llm):
    """S32 [C9]: SIGKILL with one executing + two QUEUED CRE audits → after restart all
    three sessions carry a 0031; the queued ones never started (0031 is their only event)."""
    mock_llm.load(scripted_roles=_stalling_roles())
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        cre_api_key=CRE_KEY,
        llm_timeout_seconds=STALL_LLM_TIMEOUT_SECONDS,
    )
    audit_ids: list[str] = []
    for _ in range(3):
        response = await _post(
            f"{engine.base_url}/audit",
            json={"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION},
            headers={"x-api-key": CRE_KEY},
        )
        assert response.status_code == 202, response.text
        audit_ids.append(response.json()["auditId"])

    # bounded wait: the worker has dequeued the first item and is executing it
    await _first_frame_of_type(engine.base_url, audit_ids[0], "audit_started")
    engine.restart()

    for index, audit_id in enumerate(audit_ids):
        frames = await collect_frames(
            engine.base_url, audit_id, deadline=AUDIT_DEADLINE_SECONDS
        )
        terminal = terminal_frame(frames)
        assert terminal is not None and terminal.type == "audit_error", f"audit {index}"
        assert terminal.data["code"] == INTERRUPTED_CODE, f"audit {index}"
        assert terminal.data["retryable"] is True, f"audit {index}"
    for audit_id in audit_ids[1:]:  # queued, never started: the 0031 is the whole channel
        frames = await collect_frames(
            engine.base_url, audit_id, deadline=AUDIT_DEADLINE_SECONDS
        )
        assert find_frames(frames, "audit_started") == []
        assert len(frames) == 1


async def test_shutdown_with_inflight_audit_is_not_graceful(engine_factory, mock_llm):
    """S31 pin: SIGTERM while an audit is in-flight does NOT shut down within grace.

    # UNENFORCED / expect-finding: audits.close() awaits in-flight audit tasks with no
    # bound (api.py lifespan finally-block), and uvicorn's --timeout-graceful-shutdown
    # only bounds connection draining, not lifespan shutdown. Until a bounded close is
    # added, SIGTERM stalls behind the slowest in-flight phase; the harness documents
    # this by observing a non-graceful close within its own bounded grace window.
    """
    mock_llm.load(scripted_roles=_stalling_roles())
    engine = engine_factory(
        llm_url=mock_llm.v1_url, llm_timeout_seconds=STALL_LLM_TIMEOUT_SECONDS
    )
    started = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    await _first_frame_of_type(engine.base_url, started["auditId"], "audit_started")

    graceful = engine.close(grace=SHUTDOWN_STALL_GRACE_SECONDS)
    assert graceful is False, (
        "close() became graceful with an in-flight audit — the unbounded await in "
        "audits.close() was fixed; update this pin to assert graceful shutdown"
    )
    assert engine.is_running is False  # the SIGKILL fallback still reaped the process

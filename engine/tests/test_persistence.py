# CLASS MAP — AuditSessionStore sessions + exact-once payment claims
# (seam: real DB per test; sqlite default, postgres race variant env-gated)
# Axes: claim concurrency, claim conflict shape, durability across process
#       restart, finalize lifecycle guard
#   C1 12-way concurrent claim, same key → exactly one created, one audit id
#      [sqlite — writers serialize, so this proves ordering, not MVCC]
#   C2 same class on postgres (true concurrent writers) — the only honest proof
#      of the exactly-once claim under concurrency; gated on NPMGUARD_TEST_PG_DSN
#   C3 losing claim leaves NO orphan session row (session+claim are one txn)
#   C4 session state durable: rows born 'queued'; finalize → status done + report
#   C5 claim durable across engine restart — a fresh store over the same DB
#      returns the original audit id, created=False
#   C6 (single-owner flip) the running-count session cap is GONE: create() and
#      claim_payment() both insert a 'queued' row and consult no cap. Backpressure
#      is the wait-queue bound (queued_count vs queue_size) via AuditService.
#      reserve(), so create() no longer takes max_running. Also covers the new
#      mark_running (queued->running, once) + reset_to_queued (error->queued) guards.
#   C7 finalize guard — INVARIANT: finalize transitions exactly one NON-TERMINAL
#      (queued|running) row -> done|error; it succeeds on a queued row (close/
#      recovery), and a re-finalize or a finalize of a nonexistent audit_id RAISE,
#      never overwriting a terminal row.
#   C8 transaction() seam — a raise inside the block rolls back a joined
#      finalize (row stays 'queued'); this is what makes the row transition and
#      the terminal-event append atomic in AuditService._finish.
# Adversarial pass: 2026-07-23/W6 — C1 alone was vacuous for the concurrency
# clause (sqlite serializes); C2/C3/C5 add the MVCC, atomicity, and restart axes.
# Adversarial pass: 2026-07-23/A1 — the Claim axis and the Cap axis never
# intersected in any file; C6 adds the missing claim×cap class as a pin.
# Invariant pass: 2026-07-23/lifecycle-coherence — finalize was an unconditional
# UPDATE (no rowcount, no WHERE status); C7/C8 assert the enforced guard.
import asyncio
import os

import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.persistence import AuditSessionStore, audit_sessions


async def _session_count(engine) -> int:
    async with engine.connect() as connection:
        result = await connection.execute(
            sa.select(sa.func.count()).select_from(audit_sessions)
        )
        return result.scalar_one()


async def _fresh_store(url: str):
    engine = make_engine(url)
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    return AuditSessionStore(make_session_factory(engine)), engine


@pytest.fixture
async def db(tmp_path):
    store, engine = await _fresh_store(f"sqlite+aiosqlite:///{tmp_path / 'state.sqlite3'}")
    yield store, engine
    await engine.dispose()


async def _race_claims(store: AuditSessionStore) -> None:
    claims = await asyncio.gather(
        *(store.claim_payment("stripe", "cs_same", "is-number", "7.0.0") for _ in range(12))
    )
    audit_ids = {session.audit_id for session, _created in claims}
    assert len(audit_ids) == 1
    assert sum(created for _session, created in claims) == 1


async def test_payment_claim_is_exactly_once_under_race(db) -> None:
    """C1: 12 concurrent claims of one key → one session, one created=True (sqlite)."""
    store, _engine = db
    await _race_claims(store)


@pytest.mark.postgres
@pytest.mark.skipif(
    not os.environ.get("NPMGUARD_TEST_PG_DSN"),
    reason=(
        "C2 postgres race variant skipped: set NPMGUARD_TEST_PG_DSN to a reachable "
        "postgres server. SQLite serializes writers, so only postgres proves the "
        "exactly-once payment claim under true concurrency (MVCC)."
    ),
)
async def test_payment_claim_is_exactly_once_under_race_postgres() -> None:
    """C2: the same 12-way race against postgres, where writers truly overlap."""
    import psycopg2

    from tests.support.harness import PostgresProvisioner

    provisioner = PostgresProvisioner.start()  # DSN set → uses it, no docker
    url = provisioner.fresh_database(prefix="npmguard_test_persistence")
    database = sa.engine.make_url(url).database
    engine = None
    try:
        store, engine = await _fresh_store(url)
        await _race_claims(store)
        assert await _session_count(engine) == 1  # C3 holds under MVCC too
    finally:
        if engine is not None:
            await engine.dispose()
        conn = psycopg2.connect(provisioner.sync_dsn())
        try:
            conn.autocommit = True
            with conn.cursor() as cursor:
                cursor.execute(f'DROP DATABASE IF EXISTS "{database}"')
        finally:
            conn.close()


async def test_losing_claim_leaves_no_orphan_session(db) -> None:
    """C3: the conflicting claim's freshly-inserted session must roll back with it."""
    store, engine = db
    first, created_first = await store.claim_payment("stripe", "cs_dup", "is-number", "7.0.0")
    assert created_first
    second, created_second = await store.claim_payment("stripe", "cs_dup", "is-number", "7.0.0")
    assert not created_second
    assert second.audit_id == first.audit_id
    assert await _session_count(engine) == 1


async def test_session_state_is_durable(db) -> None:
    """C4: a row is born 'queued'; finalize persists status=done and the report
    payload (the guard accepts queued->done directly)."""
    store, _engine = db
    session = await store.create("left-pad", "1.3.0")
    assert session.status == "queued"  # rows are born queued, not running
    await store.set_package_path(session.audit_id, "/tmp/package")
    await store.finalize(session.audit_id, {"verdict": "SAFE"})
    restored = await store.get(session.audit_id)
    assert restored is not None
    assert restored.status == "done"
    assert restored.report == {"verdict": "SAFE"}


async def test_finalize_requires_exactly_one_non_terminal_row(db) -> None:
    """C7 — INVARIANT: finalize transitions exactly one non-terminal (queued|
    running) row -> done|error. It succeeds on a queued row (the close/recovery
    path); a second finalize (the old silent done->error flip) raises and leaves
    the terminal row untouched; a finalize of a nonexistent audit_id raises."""
    store, _engine = db
    # a freshly-created queued row finalizes straight to terminal (close path)
    queued = await store.create("queued-pkg", "1.0.0")
    assert queued.status == "queued"
    await store.finalize(queued.audit_id, None, "shutting down")
    assert (await store.get(queued.audit_id)).status == "error"

    session = await store.create("left-pad", "1.3.0")
    await store.mark_running(session.audit_id)  # queued -> running
    await store.finalize(session.audit_id, {"verdict": "SAFE"})
    with pytest.raises(AssertionError, match="matched 0 non-terminal rows"):
        await store.finalize(session.audit_id, None, "late failure")
    restored = await store.get(session.audit_id)
    assert restored is not None
    assert restored.status == "done"  # the terminal row was never overwritten
    assert restored.error is None
    with pytest.raises(AssertionError, match="matched 0 non-terminal rows"):
        await store.finalize("no-such-audit", {"verdict": "SAFE"})


async def test_transaction_rolls_back_composed_writes(db) -> None:
    """C8: an exception inside transaction() rolls back the joined finalize —
    the row is still 'queued' (its pre-finalize state). AuditService._finish
    relies on this to keep the non-terminal->terminal transition and the
    terminal-event append atomic."""
    store, _engine = db
    session = await store.create("left-pad", "1.3.0")
    with pytest.raises(RuntimeError, match="append failed"):
        async with store.transaction() as joined:
            await store.finalize(session.audit_id, {"verdict": "SAFE"}, session=joined)
            raise RuntimeError("append failed")
    restored = await store.get(session.audit_id)
    assert restored is not None
    assert restored.status == "queued"  # nothing committed — recovery can repair


async def test_create_and_claim_insert_queued_and_have_no_cap(tmp_path) -> None:
    """C6 (flipped): the running-count session cap is gone. Both admission
    inserts — free create() and paid claim_payment() — land a 'queued' row, and
    neither consults any cap. Backpressure is now the wait-queue bound
    (queued_count vs queue_size), enforced by AuditService.reserve(), not a DB
    running-count gate — so create() no longer takes a max_running argument."""
    url = f"sqlite+aiosqlite:///{tmp_path / 'cap.sqlite3'}"
    engine = make_engine(url)
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    store = AuditSessionStore(make_session_factory(engine))
    try:
        free = await store.create("free-pkg", "1.0.0")
        assert free.status == "queued"  # born queued
        again = await store.create("free-pkg-2", "1.0.0")  # no cap: never refuses
        assert again.status == "queued"
        paid, created = await store.claim_payment("stripe", "cs_cap", "paid-pkg", "1.0.0")
        assert created is True
        assert paid.status == "queued"  # paid claim also lands queued
        assert await store.queued_count() == 3  # all three counted by the bound
        assert await _session_count(engine) == 3
    finally:
        await engine.dispose()


async def test_mark_running_and_reset_to_queued_guards(db) -> None:
    """queued->running is won exactly once (a second mark_running returns False);
    error->queued reset clears the terminal payload and is guarded to the error
    state (asserts on a non-error row)."""
    store, _engine = db
    session = await store.create("guard-pkg", "1.0.0")
    assert await store.mark_running(session.audit_id) is True
    assert await store.mark_running(session.audit_id) is False  # already running
    await store.finalize(session.audit_id, None, "boom")
    assert (await store.get(session.audit_id)).status == "error"
    await store.reset_to_queued(session.audit_id)
    restored = await store.get(session.audit_id)
    assert restored.status == "queued"
    assert restored.error is None and restored.report is None
    with pytest.raises(AssertionError):
        await store.reset_to_queued(session.audit_id)  # not in error state now


async def test_claim_is_visible_after_restart(tmp_path) -> None:
    """C5: a fresh engine+store over the same DB file sees the claim and refuses
    to re-create it — the restart twin of the exactly-once guarantee."""
    url = f"sqlite+aiosqlite:///{tmp_path / 'restart.sqlite3'}"
    store, engine = await _fresh_store(url)
    original, created = await store.claim_payment("chain:base", "0xabc", "chalk", "5.6.2")
    assert created
    await engine.dispose()

    restarted = make_engine(url)
    try:
        fresh_store = AuditSessionStore(make_session_factory(restarted))
        recorded = await fresh_store.payment("chain:base", "0xabc")
        assert recorded is not None and recorded["audit_id"] == original.audit_id
        session, created_again = await fresh_store.claim_payment(
            "chain:base", "0xabc", "chalk", "5.6.2"
        )
        assert not created_again
        assert session.audit_id == original.audit_id
    finally:
        await restarted.dispose()

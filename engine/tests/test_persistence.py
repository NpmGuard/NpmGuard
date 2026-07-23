# CLASS MAP — AuditSessionStore sessions + exact-once payment claims
# (seam: real DB per test; sqlite default, postgres race variant env-gated)
# Axes: claim concurrency, claim conflict shape, durability across process
#       restart, finalize lifecycle guard
#   C1 12-way concurrent claim, same key → exactly one created, one audit id
#      [sqlite — writers serialize, so this proves ordering, not MVCC]
#   C2 same class on postgres (true concurrent writers) — the only honest proof
#      of the exactly-once claim under concurrency; gated on NPMGUARD_TEST_PG_DSN
#   C3 losing claim leaves NO orphan session row (session+claim are one txn)
#   C4 session state durable: finalize → status done + report readable
#   C5 claim durable across engine restart — a fresh store over the same DB
#      returns the original audit id, created=False
#   C6 claim_payment at the max_running boundary — PINNED, UNENFORCED: unlike
#      create(), claim_payment inserts its running session with NO cap check,
#      so PAID audits bypass the session cap entirely (api.py routes all paid
#      launches through claim_payment). Intended-or-hole: a maintainer decision.
#   C7 finalize guard — INVARIANT: finalize transitions exactly one row
#      running->done|error; a re-finalize (the old silent done->error overwrite)
#      and a finalize of a nonexistent audit_id both RAISE, and the terminal row
#      is never overwritten.
#   C8 transaction() seam — a raise inside the block rolls back a joined
#      finalize (row stays running); this is what makes the row transition and
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
    """C4: finalize persists status=done and the report payload."""
    store, _engine = db
    session = await store.create("left-pad", "1.3.0")
    await store.set_package_path(session.audit_id, "/tmp/package")
    await store.finalize(session.audit_id, {"verdict": "SAFE"})
    restored = await store.get(session.audit_id)
    assert restored is not None
    assert restored.status == "done"
    assert restored.report == {"verdict": "SAFE"}


async def test_finalize_requires_exactly_one_running_row(db) -> None:
    """C7 — INVARIANT: finalize transitions exactly one row running->done|error.
    A second finalize (the old silent done->error flip after a post-finalize
    failure) raises and leaves the terminal row untouched; a finalize of a
    nonexistent audit_id raises instead of updating zero rows."""
    store, _engine = db
    session = await store.create("left-pad", "1.3.0")
    await store.finalize(session.audit_id, {"verdict": "SAFE"})
    with pytest.raises(AssertionError, match="matched 0 running rows"):
        await store.finalize(session.audit_id, None, "late failure")
    restored = await store.get(session.audit_id)
    assert restored is not None
    assert restored.status == "done"  # the terminal row was never overwritten
    assert restored.error is None
    with pytest.raises(AssertionError, match="matched 0 running rows"):
        await store.finalize("no-such-audit", {"verdict": "SAFE"})


async def test_transaction_rolls_back_composed_writes(db) -> None:
    """C8: an exception inside transaction() rolls back the joined finalize —
    the row is still 'running'. AuditService._finish relies on this to keep the
    running->terminal transition and the terminal-event append atomic."""
    store, _engine = db
    session = await store.create("left-pad", "1.3.0")
    with pytest.raises(RuntimeError, match="append failed"):
        async with store.transaction() as joined:
            await store.finalize(session.audit_id, {"verdict": "SAFE"}, session=joined)
            raise RuntimeError("append failed")
    restored = await store.get(session.audit_id)
    assert restored is not None
    assert restored.status == "running"  # nothing committed — recovery can repair


async def test_claim_payment_bypasses_session_cap_pinned(tmp_path) -> None:
    """C6 — PINNED, UNENFORCED: with max_running=1 already saturated by create(),
    claim_payment still inserts a SECOND running session — paid audits are not
    subject to the cap. If the cap is ever meant to gate paid launches too,
    claim_payment must run the same running-count check and this pin flips to
    expecting SessionLimitError."""
    url = f"sqlite+aiosqlite:///{tmp_path / 'cap.sqlite3'}"
    engine = make_engine(url)
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    store = AuditSessionStore(make_session_factory(engine), max_running=1)
    try:
        await store.create("free-pkg", "1.0.0")  # saturates the cap
        from npmguard.errors import SessionLimitError

        with pytest.raises(SessionLimitError):
            await store.create("free-pkg-2", "1.0.0")  # create() enforces it
        paid, created = await store.claim_payment("stripe", "cs_cap", "paid-pkg", "1.0.0")
        assert created is True  # pinned bypass: the claim path ignored the cap
        assert paid.status == "running"
        assert await _session_count(engine) == 2  # cap=1, yet two running rows
    finally:
        await engine.dispose()


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

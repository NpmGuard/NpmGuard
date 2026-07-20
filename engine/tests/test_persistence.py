import asyncio

import pytest

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.persistence import AuditSessionStore


@pytest.fixture
async def store(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'state.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    yield AuditSessionStore(make_session_factory(engine))
    await engine.dispose()


async def test_payment_claim_is_exactly_once_under_race(store: AuditSessionStore) -> None:
    claims = await asyncio.gather(
        *(store.claim_payment("stripe", "cs_same", "is-number", "7.0.0") for _ in range(12))
    )
    audit_ids = {session.audit_id for session, _created in claims}
    assert len(audit_ids) == 1
    assert sum(created for _session, created in claims) == 1


async def test_session_state_is_durable(store: AuditSessionStore) -> None:
    session = await store.create("left-pad", "1.3.0")
    await store.set_package_path(session.audit_id, "/tmp/package")
    await store.finalize(session.audit_id, {"verdict": "SAFE"})
    restored = await store.get(session.audit_id)
    assert restored is not None
    assert restored.status == "done"
    assert restored.report == {"verdict": "SAFE"}

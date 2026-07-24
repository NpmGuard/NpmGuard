# CLASS MAP — panel.alerts.notify (port of TS alerts/notify.ts)
# (seam A: range_satisfies is PURE — (version, npm-range) -> bool via univers,
#  no IO. seam B: handle_dangerous_verdict runs over a real throwaway sqlite
#  seeded directly (installations/repos/repo_deps/gh_users/user_installations);
#  the email sender is an INJECTED collector — no SMTP, no network.)
# range_satisfies (npm semver range satisfaction):
#   C1  caret ^4.17.0 admits 4.18.1, rejects 5.0.0
#   C2  tilde ~1.2.3 admits 1.2.9, rejects 1.3.0
#   C3  exact 1.2.3 admits only 1.2.3
#   C4  wildcard * admits anything
#   C5  a non-semver range (workspace:/git:/file:) is NOT adoptable -> False
#   C6  a missing range or unparseable version -> False (never raises)
# handle_dangerous_verdict exposure:
#   C7  EXACT: a repo whose repo_deps has (name, version) -> alert kind='scan',
#       message "installed at <version>"
#   C8  RANGE: a PROTECTED repo whose direct-dep range would adopt version ->
#       alert, message "range ... would adopt"
#   C9  range exposure is PROTECTED-only: an unprotected repo with the same
#       adopting range is NOT exposed
#   C10 a non-semver direct range on a protected repo is skipped (no alert)
#   C11 exact beats range: a repo exposed exactly is not double-counted
#   C12 DEDUP by (repo_id, name, version): a second call inserts 0 new alerts
#   C13 one email per affected org, addressed to that org's users with emails;
#       kind reflects the source ('watch')
import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from npmguard.panel import tables
from npmguard.panel.alerts.notify import handle_dangerous_verdict, range_satisfies

_ = tables


# --------------------------------------------------------------------------
# range_satisfies — pure npm-range matrix
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("version", "spec", "expected"),
    [
        ("4.18.1", "^4.17.0", True),  # C1
        ("5.0.0", "^4.17.0", False),  # C1
        ("1.2.9", "~1.2.3", True),  # C2
        ("1.3.0", "~1.2.3", False),  # C2
        ("1.2.3", "1.2.3", True),  # C3
        ("1.2.4", "1.2.3", False),  # C3
        ("9.9.9", "*", True),  # C4
        ("1.0.0", "workspace:*", False),  # C5
        ("1.0.0", "git+https://example.com/x.git", False),  # C5
        ("1.0.0", "file:../local", False),  # C5
        ("1.0.0", None, False),  # C6
        ("not-a-version", "^1.0.0", False),  # C6
    ],
)
def test_range_satisfies(version, spec, expected) -> None:
    """C1-C6: npm range satisfaction via univers; non-semver ranges and bad
    versions are non-adoptable (False), never raising."""
    assert range_satisfies(version, spec) is expected


# --------------------------------------------------------------------------
# handle_dangerous_verdict — DB-backed exposure + dedup + email fan-out
# --------------------------------------------------------------------------


class _EmailCollector:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def __call__(self, settings, org, recipients, package_name, version, lines):
        self.sent.append(
            {
                "org": org,
                "recipients": recipients,
                "package": package_name,
                "version": version,
                "lines": lines,
            }
        )


@pytest.fixture
async def db(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'alerts.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    yield factory
    await engine.dispose()


async def _installation(factory, inst_id, login) -> None:
    now = now_iso()
    async with factory() as session, session.begin():
        await session.execute(
            tables.installations.insert().values(
                id=inst_id, account_login=login, account_type="Organization",
                created_at=now, updated_at=now,
            )
        )


async def _repo(factory, repo_id, inst_id, full_name, *, protected=False) -> None:
    now = now_iso()
    owner, name = full_name.split("/")
    async with factory() as session, session.begin():
        await session.execute(
            tables.repos.insert().values(
                id=repo_id, installation_id=inst_id, owner=owner, name=name,
                full_name=full_name, protected_at=now if protected else None,
                created_at=now, updated_at=now,
            )
        )


async def _dep(factory, repo_id, name, version, *, direct=False, rng=None) -> None:
    async with factory() as session, session.begin():
        await session.execute(
            tables.repo_deps.insert().values(
                repo_id=repo_id, name=name, version=version, direct=direct, range=rng
            )
        )


async def _user(factory, user_id, inst_id, email) -> None:
    now = now_iso()
    async with factory() as session, session.begin():
        await session.execute(
            tables.gh_users.insert().values(
                id=user_id, login=f"u{user_id}", email=email,
                created_at=now, updated_at=now,
            )
        )
        await session.execute(
            tables.user_installations.insert().values(
                user_id=user_id, installation_id=inst_id, refreshed_at=now
            )
        )


async def _alerts(factory) -> list[dict]:
    async with factory() as session:
        rows = (
            (await session.execute(sa.select(tables.alerts))).mappings().all()
        )
    return [dict(r) for r in rows]


async def test_exact_exposure_inserts_alert(db) -> None:
    """C7: a repo with the exact (name, version) installed gets an alert whose
    message says 'installed at', kind = the source."""
    await _installation(db, 1, "acme")
    await _repo(db, 10, 1, "acme/app")
    await _dep(db, 10, "evil", "1.2.3", direct=True, rng="^1.0.0")

    inserted = await handle_dangerous_verdict(
        db, "evil", "1.2.3", source="scan", verdict_reason="exfil"
    )

    assert inserted == 1
    rows = await _alerts(db)
    assert len(rows) == 1
    assert rows[0]["repo_id"] == 10
    assert rows[0]["kind"] == "scan"
    assert rows[0]["verdict"] == "DANGEROUS"
    assert "installed at 1.2.3" in rows[0]["message"]
    assert "exfil" in rows[0]["message"]


async def test_range_exposure_protected_only(db) -> None:
    """C8/C9: a PROTECTED repo whose direct-dep range would adopt the version is
    exposed ('would adopt'); an unprotected repo with the same range is NOT."""
    await _installation(db, 1, "acme")
    await _repo(db, 10, 1, "acme/protected", protected=True)
    await _dep(db, 10, "evil", "1.0.0", direct=True, rng="^1.0.0")  # not installed at 1.5.0
    await _repo(db, 11, 1, "acme/unprotected", protected=False)
    await _dep(db, 11, "evil", "1.0.0", direct=True, rng="^1.0.0")

    inserted = await handle_dangerous_verdict(db, "evil", "1.5.0", source="watch")

    assert inserted == 1
    rows = await _alerts(db)
    assert [r["repo_id"] for r in rows] == [10]
    assert "would adopt 1.5.0" in rows[0]["message"]


async def test_nonsemver_range_skipped(db) -> None:
    """C10: a non-semver direct range (workspace:) on a protected repo can't
    adopt a registry version — no alert."""
    await _installation(db, 1, "acme")
    await _repo(db, 10, 1, "acme/mono", protected=True)
    await _dep(db, 10, "evil", "0.0.0", direct=True, rng="workspace:*")

    inserted = await handle_dangerous_verdict(db, "evil", "9.9.9", source="watch")

    assert inserted == 0
    assert await _alerts(db) == []


async def test_exact_beats_range_no_double_count(db) -> None:
    """C11: a repo that has the version installed AND a range that would adopt it
    is alerted once (exact), not twice."""
    await _installation(db, 1, "acme")
    await _repo(db, 10, 1, "acme/app", protected=True)
    await _dep(db, 10, "evil", "1.5.0", direct=True, rng="^1.0.0")  # exact match

    inserted = await handle_dangerous_verdict(db, "evil", "1.5.0", source="scan")

    assert inserted == 1
    rows = await _alerts(db)
    assert len(rows) == 1
    assert "installed at 1.5.0" in rows[0]["message"]


async def test_dedup_by_repo_pkg_version(db) -> None:
    """C12: a second fan-out for the same (repo, pkg, version) inserts nothing."""
    await _installation(db, 1, "acme")
    await _repo(db, 10, 1, "acme/app")
    await _dep(db, 10, "evil", "1.2.3", direct=True, rng="^1.0.0")

    first = await handle_dangerous_verdict(db, "evil", "1.2.3", source="scan")
    second = await handle_dangerous_verdict(db, "evil", "1.2.3", source="watch")

    assert (first, second) == (1, 0)
    assert len(await _alerts(db)) == 1


async def test_email_one_per_org_to_known_recipients(db) -> None:
    """C13: one email per affected org, to that org's users with a known email;
    the injected sender receives the exposure lines."""
    await _installation(db, 1, "acme")
    await _repo(db, 10, 1, "acme/app")
    await _dep(db, 10, "evil", "1.2.3", direct=True, rng="^1.0.0")
    await _user(db, 100, 1, "dev@acme.test")
    await _user(db, 101, 1, None)  # no email — must not appear

    collector = _EmailCollector()
    inserted = await handle_dangerous_verdict(
        db, "evil", "1.2.3", source="scan", settings=object(), send_email=collector
    )

    assert inserted == 1
    assert len(collector.sent) == 1
    mail = collector.sent[0]
    assert mail["org"] == "acme"
    assert mail["recipients"] == ["dev@acme.test"]
    assert mail["package"] == "evil"
    assert any("acme/app" in line for line in mail["lines"])


async def test_no_exposure_no_alert_no_email(db) -> None:
    """C7 (negative): a package nobody uses yields no alerts and no email."""
    await _installation(db, 1, "acme")
    await _repo(db, 10, 1, "acme/app")
    await _dep(db, 10, "safe-pkg", "1.0.0", direct=True, rng="^1.0.0")

    collector = _EmailCollector()
    inserted = await handle_dangerous_verdict(
        db, "evil", "1.2.3", settings=object(), send_email=collector
    )

    assert inserted == 0
    assert collector.sent == []

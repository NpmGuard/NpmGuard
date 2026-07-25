# CLASS MAP — alembic 0006 (collapse scans + public_repo_scans into audit_sets) and
# 0007 (constrain package_verdicts.verdict to SAFE|DANGEROUS)
# (seam: the SHIPPED migration chain against a throwaway sqlite. The schema is
#  built by `alembic upgrade npmguard_panel_0005`, real rows are seeded through
#  raw SQL against THAT schema — never through today's table definitions, which no
#  longer describe it — and then `alembic upgrade head` runs the migration under
#  test. Both alembic invocations are subprocesses because env.py reads
#  NPMGUARD_DATABASE_URL through an lru_cached get_settings.)
#
# The claim being tested is narrow and total: every row present before the
# migration is present and correct after it.
#   C1  a repo scan becomes an audit_set with origin='repo_scan',
#       origin_ref = its repo id, and billed_to = that repo's installation
#   C2  a scan's status/finished_at pair collapses to ONE column: a 'done' scan
#       keeps its finished_at, a 'running' scan keeps NULL — and a 'done' scan
#       whose finished_at was somehow NULL is healed to started_at rather than
#       becoming a done set that claims it never finished
#   C3  scan_items carry across, and direct/range are RECOVERED from repo_deps for
#       pairs still in the index (scan_items never stored either)
#   C4  a pair NOT in the index lands direct=false / range=NULL — named as the one
#       lossy step, and lossy in the OLD schema rather than in this one
#   C5  a public scan becomes an audit_set with origin='public_repo_scan' and
#       origin_ref = its stable github_repo_id, offset past the repo-scan ids so
#       the two old id sequences cannot collide
#   C6  its snapshot columns survive on the rebuilt public_repo_scans, keyed by
#       set_id — and the counters/status/error/full_name_lower are gone
#   C7  public_repo_scan_items carry across with direct/range intact
#   C8  panel_jobs.scan_id becomes panel_jobs.origin: a job that owned a scan is
#       'repo_scan', one that owned none is 'watchlist'
#   C9  alerts.verdict -> outcome and kind -> origin, with 'scan'/'watch' mapped
#       into the AuditSetOrigin domain
#   C10 nothing is silently dropped: the row COUNTS match, and the collapsed
#       tables are gone
#   C11 the migrated schema is byte-equivalent to metadata.create_all (the kit
#       substitution rule) — asserted here too, because a migration that carries
#       data correctly into a slightly different schema is still broken
# 0007 — the verdict domain becomes a DB constraint:
#   C12 every in-domain package_verdicts row is present and column-for-column
#       correct after 0007, which on sqlite recreates the table to add the CHECK
#   C13 the out-of-domain rows (SUSPECT, UNKNOWN — representable because 0005
#       created the column with no CHECK, and written today by the TS lineage's
#       unfiltered upsertVerdict) are removed, and the constraint refuses their
#       return, proven by attempting the insert
import os
import subprocess
import sys
from pathlib import Path

import pytest
import sqlalchemy as sa

ENGINE_ROOT = Path(__file__).resolve().parents[1]


def _alembic(database_url: str, revision: str) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", revision],
        cwd=ENGINE_ROOT,
        env={**dict(os.environ), "NPMGUARD_DATABASE_URL": database_url},
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, f"alembic upgrade {revision} failed:\n{result.stderr}"


# The pre-0006 seed, written against the 0005 schema explicitly. Spelled as SQL on
# purpose: using today's SQLAlchemy tables would seed the NEW shape and prove
# nothing about carrying the OLD one across.
_SEED = [
    """
    INSERT INTO installations (id, account_login, account_type, suspended,
                               created_at, updated_at)
    VALUES (500, 'acme', 'Organization', 0, '2026-01-01T00:00:00Z',
            '2026-01-01T00:00:00Z')
    """,
    """
    INSERT INTO gh_users (id, login, created_at, updated_at)
    VALUES (42, 'octocat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    """,
    """
    INSERT INTO repos (id, installation_id, owner, name, full_name, private,
                       default_branch, created_at, updated_at)
    VALUES (1001, 500, 'acme', 'web', 'acme/web', 0, 'main',
            '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    """,
    # The repo's CURRENT dep index — where direct/range are recovered from.
    """
    INSERT INTO repo_deps (repo_id, name, version, direct, range)
    VALUES (1001, 'lodash', '4.17.21', 1, '^4.17.0')
    """,
    # A finished repo scan and a live one.
    """
    INSERT INTO scans (id, repo_id, trigger_kind, commit_sha, status, total, cached,
                       audited, failed, error, check_run_id, started_at, finished_at)
    VALUES (1, 1001, 'manual', 'abc1234', 'done', 2, 1, 1, 0, NULL, 77,
            '2026-02-01T00:00:00Z', '2026-02-01T00:05:00Z')
    """,
    """
    INSERT INTO scans (id, repo_id, trigger_kind, commit_sha, status, total, cached,
                       audited, failed, error, check_run_id, started_at, finished_at)
    VALUES (2, 1001, 'push', 'def5678', 'running', 1, 0, 0, 0, NULL, NULL,
            '2026-02-02T00:00:00Z', NULL)
    """,
    # A 'done' scan with a NULL finished_at — impossible via the old writer, kept
    # here because the collapse must not turn it into a done set that claims it
    # never finished.
    """
    INSERT INTO scans (id, repo_id, trigger_kind, commit_sha, status, total, cached,
                       audited, failed, error, check_run_id, started_at, finished_at)
    VALUES (3, 1001, 'reconcile', NULL, 'done', 0, 0, 0, 0, NULL, NULL,
            '2026-02-03T00:00:00Z', NULL)
    """,
    # lodash is still in the index (direct/range recoverable); ghost-pkg is not.
    "INSERT INTO scan_items (scan_id, name, version, cached) VALUES (1, 'lodash', '4.17.21', 1)",
    "INSERT INTO scan_items (scan_id, name, version, cached) VALUES (1, 'ghost-pkg', '9.9.9', 0)",
    "INSERT INTO scan_items (scan_id, name, version, cached) VALUES (2, 'lodash', '4.17.21', 0)",
    # A public snapshot whose OLD id (1) collides with scan id 1.
    """
    INSERT INTO public_repo_scans (id, installation_id, requested_by, github_repo_id,
        owner, name, full_name, full_name_lower, html_url, default_branch,
        commit_sha, lockfile_path, lockfile_sha, status, total, cached, audited,
        failed, error, started_at, finished_at)
    VALUES (1, 500, 42, 30000, 'facebook', 'react', 'facebook/react',
            'facebook/react', 'https://github.com/facebook/react', 'main',
            'feed0000', 'package-lock.json', 'lockshaA', 'done', 1, 1, 0, 0, NULL,
            '2026-03-01T00:00:00Z', '2026-03-01T00:02:00Z')
    """,
    """
    INSERT INTO public_repo_scan_items (scan_id, name, version, direct, range, cached)
    VALUES (1, 'react', '18.2.0', 1, '^18.0.0', 1)
    """,
    # A job that owned a scan, and one that owned none.
    """
    INSERT INTO panel_jobs (id, kind, lane, org, scan_id, package_name, version,
                            state, attempts, created_at)
    VALUES (1, 'audit_package', 'cheap', 'acme', 1, 'lodash', '4.17.21', 'done', 0,
            '2026-02-01T00:00:00Z')
    """,
    """
    INSERT INTO panel_jobs (id, kind, lane, org, scan_id, package_name, version,
                            state, attempts, created_at)
    VALUES (2, 'audit_package', 'cheap', NULL, NULL, 'watched', '1.0.0', 'done', 0,
            '2026-02-01T00:00:00Z')
    """,
    """
    INSERT INTO alerts (id, org, repo_id, package_name, version, verdict, kind,
                        message, seen, created_at)
    VALUES (1, 'acme', 1001, 'evil', '1.2.3', 'DANGEROUS', 'scan', 'installed at',
            0, '2026-02-01T00:00:00Z')
    """,
    """
    INSERT INTO alerts (id, org, repo_id, package_name, version, verdict, kind,
                        message, seen, created_at)
    VALUES (2, 'acme', 1001, 'evil', '2.0.0', 'DANGEROUS', 'watch', 'would adopt',
            0, '2026-02-01T00:00:00Z')
    """,
    # package_verdicts as it exists BEFORE 0007 constrains it: two in-domain rows and
    # two from the retired 4-state vocabulary. The foreign pair is what the TS
    # lineage's unfiltered `upsertVerdict` writes into this same table, and 0005
    # created the column with no CHECK — so these two rows are representable today.
    """
    INSERT INTO package_verdicts (name, version, verdict, reason, evidence_count,
                                  audited_at)
    VALUES ('lodash', '4.17.21', 'SAFE', 'no exploit', 0, '2026-01-05T00:00:00Z')
    """,
    """
    INSERT INTO package_verdicts (name, version, verdict, reason, evidence_count,
                                  audited_at)
    VALUES ('evil', '1.2.3', 'DANGEROUS', 'exfil', 3, '2026-01-06T00:00:00Z')
    """,
    """
    INSERT INTO package_verdicts (name, version, verdict, reason, evidence_count,
                                  audited_at)
    VALUES ('hazy', '9.9.9', 'SUSPECT', 'needs review', 1, '2026-01-07T00:00:00Z')
    """,
    """
    INSERT INTO package_verdicts (name, version, verdict, reason, evidence_count,
                                  audited_at)
    VALUES ('stale', '0.0.1', 'UNKNOWN', 'never concluded', 0, '2026-01-08T00:00:00Z')
    """,
]


@pytest.fixture
def migrated(tmp_path):
    """A DB seeded on the 0005 schema and then migrated to head."""
    path = tmp_path / "migrate.sqlite3"
    url = f"sqlite+aiosqlite:///{path}"
    _alembic(url, "npmguard_panel_0005")

    engine = sa.create_engine(f"sqlite:///{path}")
    with engine.begin() as connection:
        for statement in _SEED:
            connection.execute(sa.text(statement))
    engine.dispose()

    _alembic(url, "head")
    engine = sa.create_engine(f"sqlite:///{path}")
    yield engine
    engine.dispose()


def _rows(engine, query: str) -> list[dict]:
    with engine.connect() as connection:
        return [dict(r) for r in connection.execute(sa.text(query)).mappings()]


def test_repo_scans_become_audit_sets(migrated) -> None:
    """C1/C2: each scan is an audit_set carrying its repo as origin_ref and that
    repo's installation as the payer; status collapses into finished_at, and the
    incoherent 'done with no finished_at' row is healed rather than carried."""
    sets = _rows(
        migrated,
        "SELECT * FROM audit_sets WHERE origin = 'repo_scan' ORDER BY id",
    )
    assert [s["id"] for s in sets] == [1, 2, 3]
    assert {s["origin_ref"] for s in sets} == {1001}
    assert {s["billed_to"] for s in sets} == {500}
    by_id = {s["id"]: s for s in sets}
    assert by_id[1]["finished_at"] == "2026-02-01T00:05:00Z"
    assert by_id[1]["commit_sha"] == "abc1234"
    assert by_id[1]["check_run_id"] == 77
    assert by_id[1]["trigger_kind"] == "manual"
    # A live scan stays live.
    assert by_id[2]["finished_at"] is None
    # A 'done' scan with no finished_at is healed to its start, never left NULL —
    # that pair is now ONE column, so "done" and "never finished" cannot coexist.
    assert by_id[3]["finished_at"] == "2026-02-03T00:00:00Z"


def test_scan_items_recover_direct_and_range(migrated) -> None:
    """C3/C4: items carry across; direct/range are recovered from repo_deps where
    the pair is still indexed, and default to false/NULL where it is not. scan_items
    never stored either, so that gap is the old schema's, not this one's."""
    items = _rows(
        migrated,
        "SELECT * FROM audit_set_items WHERE set_id IN (1, 2) ORDER BY set_id, name",
    )
    assert [(i["set_id"], i["name"]) for i in items] == [
        (1, "ghost-pkg"),
        (1, "lodash"),
        (2, "lodash"),
    ]
    by_key = {(i["set_id"], i["name"]): i for i in items}
    recovered = by_key[(1, "lodash")]
    assert (recovered["direct"], recovered["range"], recovered["cached"]) == (
        1, "^4.17.0", 1,
    )
    ghost = by_key[(1, "ghost-pkg")]
    assert (ghost["direct"], ghost["range"]) == (0, None)


def test_public_scans_become_offset_audit_sets(migrated) -> None:
    """C5/C6: a public snapshot becomes an audit_set keyed on its STABLE
    github_repo_id, its id offset past the repo-scan ids so the two independent old
    sequences cannot collide; its subject columns live on a public_repo_scans
    rebuilt around set_id, and the counters/status/error/full_name_lower are gone."""
    sets = _rows(migrated, "SELECT * FROM audit_sets WHERE origin = 'public_repo_scan'")
    assert len(sets) == 1
    public = sets[0]
    # max(scans.id) was 3, so the old public id 1 lands at 4 — no collision with
    # the repo-scan set that also had id 1.
    assert public["id"] == 4
    assert public["origin_ref"] == 30000
    assert public["billed_to"] == 500
    assert public["commit_sha"] == "feed0000"
    assert public["finished_at"] == "2026-03-01T00:02:00Z"

    snapshots = _rows(migrated, "SELECT * FROM public_repo_scans")
    assert len(snapshots) == 1
    snapshot = snapshots[0]
    assert snapshot["set_id"] == 4
    assert snapshot["github_repo_id"] == 30000
    assert snapshot["full_name"] == "facebook/react"
    assert snapshot["lockfile_sha"] == "lockshaA"
    assert snapshot["requested_by"] == 42
    for gone in ("status", "total", "cached", "audited", "failed", "error",
                 "full_name_lower", "installation_id", "commit_sha", "id"):
        assert gone not in snapshot, gone


def test_public_items_carry_across(migrated) -> None:
    """C7: the snapshot's items land under the offset set id, direct/range intact
    (public_repo_scan_items always had them)."""
    items = _rows(migrated, "SELECT * FROM audit_set_items WHERE set_id = 4")
    assert len(items) == 1
    assert (items[0]["name"], items[0]["direct"], items[0]["range"], items[0]["cached"]) == (
        "react", 1, "^18.0.0", 1,
    )


def test_jobs_gain_an_origin(migrated) -> None:
    """C8: scan_id is replaced by origin. A job that owned a scan is 'repo_scan';
    one that owned none is 'watchlist' — which is exactly the derivation the old
    code did at READ time, now recorded once at enqueue time instead."""
    jobs = _rows(migrated, "SELECT * FROM panel_jobs ORDER BY id")
    assert [(j["id"], j["origin"]) for j in jobs] == [(1, "repo_scan"), (2, "watchlist")]
    assert "scan_id" not in jobs[0]


def test_alerts_are_renamed_into_the_contract_domain(migrated) -> None:
    """C9: verdict -> outcome and kind -> origin, with the two legacy kinds mapped
    into AuditSetOrigin. A row whose origin were left as 'scan' would be outside the
    domain every consumer branches on."""
    alerts = _rows(migrated, "SELECT * FROM alerts ORDER BY id")
    assert [(a["outcome"], a["origin"]) for a in alerts] == [
        ("DANGEROUS", "repo_scan"),
        ("DANGEROUS", "watchlist"),
    ]
    assert "verdict" not in alerts[0]
    assert "kind" not in alerts[0]


def test_nothing_is_dropped_and_the_old_tables_are_gone(migrated) -> None:
    """C10: the counts match — 3 scans + 1 public scan = 4 sets, 3 scan_items + 1
    public item = 4 set items — and the four collapsed tables no longer exist."""
    assert _rows(migrated, "SELECT COUNT(*) AS n FROM audit_sets")[0]["n"] == 4
    assert _rows(migrated, "SELECT COUNT(*) AS n FROM audit_set_items")[0]["n"] == 4
    names = {
        row["name"]
        for row in _rows(migrated, "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert not names & {"scans", "scan_items", "public_repo_scan_items"}
    assert "public_repo_scans_stash" not in names


def test_in_domain_verdict_rows_survive_0007(migrated) -> None:
    """C12: every in-domain package_verdicts row is present AND correct after 0007.

    The column-by-column assertion matters more here than in the collapse above,
    because 0007 adds its CHECK on sqlite by RECREATING the table and copying every
    row through it — a step that can silently lose a default, a type or a value. The
    claim is the same one C1-C10 make for the collapsed tables: present before,
    present and correct after.
    """
    rows = _rows(migrated, "SELECT * FROM package_verdicts ORDER BY name")
    assert [dict(r) for r in rows] == [
        {
            "name": "evil",
            "version": "1.2.3",
            "verdict": "DANGEROUS",
            "reason": "exfil",
            "evidence_count": 3,
            "audited_at": "2026-01-06T00:00:00Z",
        },
        {
            "name": "lodash",
            "version": "4.17.21",
            "verdict": "SAFE",
            "reason": "no exploit",
            "evidence_count": 0,
            "audited_at": "2026-01-05T00:00:00Z",
        },
    ]


def test_out_of_domain_verdict_rows_are_removed_by_0007(migrated) -> None:
    """C13: the SUSPECT and UNKNOWN rows are gone, and the CHECK stops them coming
    back — asserted by attempting the insert the constraint exists to refuse.

    Not silent data loss: `package_verdicts` is a DERIVED index whose authoritative
    copy is `data/reports/`, `verdict_index.rebuild` repopulates it at every boot,
    and 0007 logs the count it removed. It is also the only thing that ever removed
    them — `rebuild` skips a foreign report with `continue` and never DELETEs, so
    before this such a row survived every boot and raised on every dashboard read.
    """
    assert not [r for r in _rows(migrated, "SELECT verdict FROM package_verdicts")
                if r["verdict"] not in ("SAFE", "DANGEROUS")]

    with (
        migrated.begin() as connection,
        pytest.raises(sa.exc.IntegrityError, match="verdict_domain"),
    ):
        connection.execute(
            sa.text(
                "INSERT INTO package_verdicts (name, version, verdict, reason,"
                " evidence_count, audited_at) VALUES ('back', '1.0.0',"
                " 'SUSPECT', '', 0, '2026-07-25T00:00:00Z')"
            )
        )


def test_migrated_schema_matches_create_all(migrated) -> None:
    """C11: the migrated schema is equivalent to metadata.create_all. Carrying data
    correctly into a subtly different schema is still a broken migration, so the
    parity check runs against the SEEDED database too, not only an empty one."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    import kit_llm  # noqa: F401
    import kit_stream  # noqa: F401
    import npmguard.panel.tables  # noqa: F401
    import npmguard.persistence  # noqa: F401
    from kit_spine.db import metadata

    with migrated.connect() as connection:
        assert compare_metadata(MigrationContext.configure(connection), metadata) == []

# CLASS MAP — panel.scan.public_repo_scan (item discovery for one origin)
# (seam A: parse_public_repo_reference is PURE — string in, PublicRepoReference
#  out or InvalidPublicRepoReferenceError; it is the SSRF boundary, so its
#  rejection classes are the security-relevant part.
#  seam B: PublicRepoScanEngine over a real throwaway sqlite — the REAL caps store
#  and the REAL shared AuditSetStore, so the snapshot row, the cap keyed on the
#  stable repo id, and the live-audit lookup are observable without GitHub/docker.)
#
# After R-1 this module owns discovery + the cap + the snapshot row and NOTHING
# else: dedupe, cache-first enqueue, progress, rollup, truncation and the stream
# are the shared audit-set entity's and are enumerated ONCE in
# tests/test_panel_audit_set.py — including a per-origin class that proves this
# origin's rollup is byte-identical to repo_scan's over the same item list.
#
# parse_public_repo_reference — ACCEPT classes:
#   C1  plain owner/repo
#   C2  https://github.com/owner/repo URL
#   C3  bare github.com/owner/repo (no scheme) is normalized
#   C4  trailing .git is stripped (owner/repo.git, URL form)
#   C5  surrounding whitespace / trailing slash tolerated
# parse_public_repo_reference — REJECT (SSRF / garbage) classes:
#   C6  empty / one segment / three segments
#   C7  non-github host (https://evil.com/owner/repo)
#   C8  http (not https) github URL
#   C9  URL carrying credentials / query / fragment
#   C10 scp-style git@github.com:owner/repo (colon in a non-URL input)
#   C11 an owner or repo failing the identity grammar (spaces, '..', '.')
# PublicRepoScanEngine.create_public_repo_scan:
#   C12 the set is created with origin_ref = the STABLE github_repo_id, and the
#       snapshot row is keyed by set_id — one id, so `scanId` means one thing
#   C13 the returned id is the SET id (streamable on /panel/scan/{id}/events)
#   C14 the cap is asserted before the set exists: a refusal leaves no snapshot
# find_running_public_scan:
#   C15 a live audit is found by (github_repo_id, payer) — NOT by a lowercased
#       full name, so a RENAME can no longer smuggle in a second concurrent audit
#   C16 a finished audit is not "running"; another installation's is not visible
#   C17 the durable partial-unique index refuses a second live audit of the same
#       repo by the same payer (the guard, not the pre-check, is what holds)
from typing import Any

import pytest
import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard.config import Settings
from npmguard.panel import tables
from npmguard.panel.audit_set import build_store
from npmguard.panel.caps import CapExceededError, CapsStore
from npmguard.panel.jobs import PanelJobQueue
from npmguard.panel.lockfile import LockfileDep
from npmguard.panel.scan.public_repo_scan import (
    CreatePublicRepoScanInput,
    InvalidPublicRepoReferenceError,
    PublicRepoScanEngine,
    parse_public_repo_reference,
)
from npmguard.panel.verdict_index import VerdictIndex

# Import so metadata.create_all sees the panel tables.
_ = tables


# ---------------------------------------------------------------------------
# parse_public_repo_reference — the SSRF boundary (pure)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "owner", "repo"),
    [
        ("owner/repo", "owner", "repo"),  # C1
        ("https://github.com/facebook/react", "facebook", "react"),  # C2
        ("github.com/vercel/next.js", "vercel", "next.js"),  # C3
        ("https://github.com/owner/repo.git", "owner", "repo"),  # C4
        ("owner/repo.git", "owner", "repo"),  # C4 (plain form)
        ("  owner/repo/  ", "owner", "repo"),  # C5 (whitespace + trailing slash)
        ("https://github.com/owner/repo/", "owner", "repo"),  # C5 (URL trailing slash)
        ("a-b/c_d.e-f", "a-b", "c_d.e-f"),  # grammar edges
    ],
)
def test_parse_reference_accepts(raw: str, owner: str, repo: str) -> None:
    """C1–C5: recognizable GitHub identities normalize to owner/repo."""
    ref = parse_public_repo_reference(raw)
    assert (ref.owner, ref.repo) == (owner, repo)
    assert ref.full_name == f"{owner}/{repo}"


@pytest.mark.parametrize(
    "raw",
    [
        "",  # C6 empty
        "owner",  # C6 one segment
        "owner/repo/extra",  # C6 three segments
        "owner//repo",  # C6 empty inner segment
        "https://evil.com/owner/repo",  # C7 wrong host
        "https://raw.githubusercontent.com/owner/repo",  # C7 raw host is not an identity
        "http://github.com/owner/repo",  # C8 not https
        "https://user:pass@github.com/owner/repo",  # C9 credentials
        "https://github.com/owner/repo?x=1",  # C9 query
        "https://github.com/owner/repo#frag",  # C9 fragment
        "git@github.com:owner/repo",  # C10 scp-style (colon)
        "ftp://github.com/owner/repo",  # C10 other scheme
        "own er/repo",  # C11 space in owner
        "owner/..",  # C11 parent traversal
        "owner/.",  # C11 dot
        "-bad/repo",  # C11 owner cannot start with '-'
        "owner/.git",  # C11 repo empties after .git strip
    ],
)
def test_parse_reference_rejects(raw: str) -> None:
    """C6–C11: anything that is not a plain GitHub identity is refused — this is
    the SSRF boundary, so a miss here is a security defect, not a UX one."""
    with pytest.raises(InvalidPublicRepoReferenceError):
        parse_public_repo_reference(raw)




# ---------------------------------------------------------------------------
# PublicRepoScanEngine — discovery + cap + the snapshot subject row
# ---------------------------------------------------------------------------


def _settings() -> Settings:
    return Settings(
        free_max_protected_repos=3,
        free_max_public_repo_audits=10,
        free_max_audits_month=250,
        pro_max_protected_repos=25,
        pro_max_public_repo_audits=0,
        pro_max_audits_month=5000,
    )


@pytest.fixture
async def public_engine(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'public.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)

    async with factory() as session, session.begin():
        now = now_iso()
        await session.execute(
            tables.installations.insert().values(
                id=1, account_login="acme", account_type="Organization",
                created_at=now, updated_at=now,
            )
        )
        await session.execute(
            tables.installations.insert().values(
                id=2, account_login="other", account_type="Organization",
                created_at=now, updated_at=now,
            )
        )
        await session.execute(
            tables.gh_users.insert().values(
                id=7, login="dev", created_at=now, updated_at=now,
            )
        )

    notifier = PollingNotifier(poll_interval=0.01)
    await notifier.start()
    sets = build_store(
        factory,
        VerdictIndex(factory),
        PanelJobQueue(factory),
        StreamService(factory, notifier),
        notifier,
    )
    yield PublicRepoScanEngine(
        sessions=factory, caps=CapsStore(factory, _settings()), sets=sets
    ), factory
    await notifier.close()
    await engine.dispose()


def _input(deps: list[LockfileDep], **overrides) -> CreatePublicRepoScanInput:
    base: dict[str, Any] = dict(
        installation_id=1,
        requested_by=7,
        github_repo_id=999,
        owner="facebook",
        name="react",
        full_name="facebook/react",
        html_url="https://github.com/facebook/react",
        default_branch="main",
        commit_sha="cafe" * 10,
        lockfile_path="package-lock.json",
        lockfile_sha="sha-1",
        deps=deps,
    )
    base.update(overrides)
    return CreatePublicRepoScanInput(**base)


async def _row(factory, table, **where) -> dict:
    async with factory() as session:
        query = sa.select(table)
        for column, value in where.items():
            query = query.where(table.c[column] == value)
        return dict((await session.execute(query)).mappings().one())


async def test_create_keys_the_snapshot_on_the_set(public_engine) -> None:
    """C12/C13: the set carries the STABLE github_repo_id as origin_ref, and the
    snapshot row is keyed by set_id — so `scan.id` and `scan.set.id` are the same
    column and the returned id is what a caller streams."""
    engine, factory = public_engine
    set_id = await engine.create_public_repo_scan(
        _input([LockfileDep("lodash", "4.17.21", True, "^4.17.21")])
    )
    audit_set = await _row(factory, tables.audit_sets, id=set_id)
    assert (audit_set["origin"], audit_set["origin_ref"], audit_set["billed_to"]) == (
        "public_repo_scan", 999, 1,
    )
    # The commit sha is recorded, which together with the lockfile blob sha is what
    # makes the snapshot reproducible; the old path hardcoded null here.
    assert audit_set["commit_sha"] == "cafe" * 10
    snapshot = await _row(factory, tables.public_repo_scans, set_id=set_id)
    assert snapshot["github_repo_id"] == 999
    assert snapshot["full_name"] == "facebook/react"


async def test_cap_refusal_leaves_no_snapshot(public_engine) -> None:
    """C14: the cap is asserted before the set exists, so a refused audit leaves
    neither a set nor a snapshot row to stream or count."""
    engine, factory = public_engine
    # A limit of 0 means UNLIMITED (the wire's "no cap" signal), so the ceiling
    # under test is 1 — consumed by the first audit below.
    engine.caps = CapsStore(factory, Settings(free_max_public_repo_audits=1))
    await engine.create_public_repo_scan(_input([LockfileDep("a", "1.0.0", True, None)]))
    with pytest.raises(CapExceededError):
        await engine.create_public_repo_scan(
            _input([LockfileDep("b", "1.0.0", True, None)], github_repo_id=1000)
        )
    async with factory() as session:
        snapshots = (
            await session.execute(sa.select(tables.public_repo_scans))
        ).mappings().all()
    assert [s["github_repo_id"] for s in snapshots] == [999]


async def test_find_running_is_keyed_on_the_stable_repo_id(public_engine) -> None:
    """C15/C16: a live audit is found by (github_repo_id, payer). Keying on the
    stable id rather than a lowercased full name is what makes a RENAME unable to
    open a second concurrent audit of the same repository."""
    engine, factory = public_engine
    set_id = await engine.create_public_repo_scan(
        _input([LockfileDep("x", "1.0.0", True, None)])
    )
    assert await engine.find_running_public_scan(1, 999) == set_id
    # A different payer does not see it, and neither does a different repo.
    assert await engine.find_running_public_scan(2, 999) is None
    assert await engine.find_running_public_scan(1, 1000) is None

    # Once finished it is no longer running — even though the snapshot row remains.
    async with factory() as session, session.begin():
        await session.execute(
            tables.audit_sets.update()
            .where(tables.audit_sets.c.id == set_id)
            .values(finished_at=now_iso())
        )
    assert await engine.find_running_public_scan(1, 999) is None


async def test_second_live_audit_is_refused_by_the_index(public_engine) -> None:
    """C17: the durable partial-unique index — not the application pre-check — is
    what guarantees at most one LIVE public audit per (repo, payer). The pre-check
    loses a cross-process race; the index cannot."""
    engine, factory = public_engine
    await engine.create_public_repo_scan(_input([LockfileDep("x", "1.0.0", True, None)]))
    with pytest.raises(IntegrityError):
        async with factory() as session, session.begin():
            await session.execute(
                tables.audit_sets.insert().values(
                    origin="public_repo_scan", origin_ref=999, billed_to=1,
                    trigger_kind="manual", started_at=now_iso(),
                )
            )

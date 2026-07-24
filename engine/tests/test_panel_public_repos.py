# CLASS MAP — panel.scan.public_repo_scan (parse boundary + snapshot engine)
# (seam A: parse_public_repo_reference is PURE — string in, PublicRepoReference
#  out or InvalidPublicRepoReferenceError; it is the SSRF boundary, so its
#  rejection classes are the security-relevant part.
#  seam B: PublicRepoScanEngine over a real throwaway sqlite — caps/verdict/queue
#  are the REAL stores so dedupe, cache-first enqueue, progress finalize, and
#  rollup reuse are observable without GitHub/docker.)
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
#   C12 dedupe: duplicate (name,version) pairs collapse to one item + one job
#   C13 cache-first: a pair with a landed verdict is cached, NOT enqueued
#   C14 misses (no verdict) are enqueued as panel_jobs (scan_id NULL, org NULL)
#   C15 find_running_public_scan matches case-insensitively while running
# refresh_public_scan_progress + rollup reuse:
#   C16 a scan with an ACTIVE job stays running; counters reflect items
#   C17 no active job left -> finalized to done + finished_at set; failed counted
#   C18 compute_public_scan_rollup reuses compute_rollup (worst-dep-wins; a null
#       dep -> unknown so a snapshot is never SAFE while a dep is pending)
import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.panel import tables
from npmguard.panel.caps import CapsStore
from npmguard.panel.jobs import PanelJobQueue
from npmguard.panel.lockfile import LockfileDep
from npmguard.panel.scan.public_repo_scan import (
    CreatePublicRepoScanInput,
    InvalidPublicRepoReferenceError,
    PublicRepoScanEngine,
    compute_public_scan_rollup,
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
# PublicRepoScanEngine — DB-backed (real caps / verdict-index / queue)
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
            tables.gh_users.insert().values(
                id=7, login="dev", created_at=now, updated_at=now,
            )
        )

    scan_engine = PublicRepoScanEngine(
        sessions=factory,
        caps=CapsStore(factory, _settings()),
        verdict_index=VerdictIndex(factory),
        queue=PanelJobQueue(factory),
    )
    yield scan_engine, factory
    await engine.dispose()


def _input(deps: list[LockfileDep], **overrides) -> CreatePublicRepoScanInput:
    base = dict(
        installation_id=1,
        requested_by=7,
        github_repo_id=999,
        owner="facebook",
        name="react",
        full_name="facebook/react",
        html_url="https://github.com/facebook/react",
        default_branch="main",
        commit_sha=None,
        lockfile_path="package-lock.json",
        lockfile_sha="sha-1",
        deps=deps,
    )
    base.update(overrides)
    return CreatePublicRepoScanInput(**base)


async def _rows(factory, table) -> list:
    async with factory() as session:
        return (await session.execute(sa.select(table))).mappings().all()


async def test_create_dedupes_duplicate_pairs(public_engine) -> None:
    """C12: a lockfile carrying the same (name,version) twice yields ONE item and
    ONE job — the item set and job queue are both keyed on the pair."""
    engine, factory = public_engine
    deps = [
        LockfileDep("lodash", "4.17.21", True, "^4.17.21"),
        LockfileDep("lodash", "4.17.21", False, None),  # duplicate pair
        LockfileDep("react", "18.2.0", True, "^18.0.0"),
    ]
    scan_id = await engine.create_public_repo_scan(_input(deps))

    items = [r for r in await _rows(factory, tables.public_repo_scan_items) if r["scan_id"] == scan_id]
    assert {(i["name"], i["version"]) for i in items} == {
        ("lodash", "4.17.21"),
        ("react", "18.2.0"),
    }
    jobs = await _rows(factory, tables.panel_jobs)
    assert len(jobs) == 2  # one job per unique pair, not per dep


async def test_create_is_cache_first(public_engine) -> None:
    """C13/C14: a pair with a landed verdict is marked cached and NOT enqueued;
    only misses become jobs, with scan_id NULL and org NULL (public snapshots own
    no scan and are not charged to the org budget)."""
    engine, factory = public_engine
    await engine.verdict_index.upsert("cached-pkg", "1.0.0", "SAFE")
    deps = [
        LockfileDep("cached-pkg", "1.0.0", True, "^1.0.0"),
        LockfileDep("fresh-pkg", "2.0.0", True, "^2.0.0"),
    ]
    scan_id = await engine.create_public_repo_scan(_input(deps))

    async with factory() as session:
        scan = (
            await session.execute(
                sa.select(tables.public_repo_scans).where(
                    tables.public_repo_scans.c.id == scan_id
                )
            )
        ).mappings().one()
    assert scan["total"] == 2
    assert scan["cached"] == 1

    jobs = await _rows(factory, tables.panel_jobs)
    assert len(jobs) == 1
    assert jobs[0]["package_name"] == "fresh-pkg"
    assert jobs[0]["scan_id"] is None
    assert jobs[0]["org"] is None


async def test_find_running_public_scan_case_insensitive(public_engine) -> None:
    """C15: an in-flight scan is discoverable case-insensitively (the store keeps
    a full_name_lower mirror) — the route turns this into a 409+scanId success."""
    engine, factory = public_engine
    scan_id = await engine.create_public_repo_scan(
        _input([LockfileDep("x", "1.0.0", True, None)])
    )
    assert await engine.find_running_public_scan(1, "Facebook/React") == scan_id
    # A different installation does not see it.
    assert await engine.find_running_public_scan(2, "facebook/react") is None


async def test_progress_stays_running_with_active_job(public_engine) -> None:
    """C16: a miss enqueues a job, so a freshly-created scan (job still queued)
    stays running with total reflecting the item set."""
    engine, factory = public_engine
    scan_id = await engine.create_public_repo_scan(
        _input([LockfileDep("pending", "1.0.0", True, None)])
    )
    async with factory() as session:
        scan = (
            await session.execute(
                sa.select(tables.public_repo_scans).where(
                    tables.public_repo_scans.c.id == scan_id
                )
            )
        ).mappings().one()
    assert scan["status"] == "running"
    assert scan["total"] == 1
    assert scan["finished_at"] is None


async def test_progress_finalizes_when_no_active_job(public_engine) -> None:
    """C17: once the job settles (here: verdict landed + job completed), a refresh
    finalizes the scan to done; an item that never resolved counts as failed."""
    engine, factory = public_engine
    scan_id = await engine.create_public_repo_scan(
        _input(
            [
                LockfileDep("resolved", "1.0.0", True, None),
                LockfileDep("lost", "2.0.0", False, None),
            ]
        )
    )
    # Simulate the worker: land a verdict for one pair, drain both jobs.
    await engine.verdict_index.upsert("resolved", "1.0.0", "DANGEROUS")
    async with factory() as session, session.begin():
        await session.execute(
            tables.panel_jobs.update().values(state="failed", finished_at=now_iso())
        )

    await engine.refresh_public_scan_progress(scan_id)

    async with factory() as session:
        scan = (
            await session.execute(
                sa.select(tables.public_repo_scans).where(
                    tables.public_repo_scans.c.id == scan_id
                )
            )
        ).mappings().one()
    assert scan["status"] == "done"
    assert scan["finished_at"] is not None
    assert scan["audited"] == 1  # resolved
    assert scan["failed"] == 1  # lost (no verdict, no active job)


async def test_rollup_reuse_never_safe_while_pending(public_engine) -> None:
    """C18: compute_public_scan_rollup reuses the shared worst-dep-wins rollup —
    a DANGEROUS dep wins, and a still-null dep lands in unknown so a snapshot is
    never SAFE while a dep is pending."""
    engine, factory = public_engine
    scan_id = await engine.create_public_repo_scan(
        _input(
            [
                LockfileDep("safe-pkg", "1.0.0", True, None),
                LockfileDep("bad-pkg", "2.0.0", True, None),
                LockfileDep("pending-pkg", "3.0.0", False, None),
            ]
        )
    )
    await engine.verdict_index.upsert("safe-pkg", "1.0.0", "SAFE")
    await engine.verdict_index.upsert("bad-pkg", "2.0.0", "DANGEROUS")
    # pending-pkg keeps a null verdict.

    async with factory() as session:
        rollup = await compute_public_scan_rollup(session, scan_id)
    wire = rollup.as_wire()
    assert wire["verdict"] == "DANGEROUS"
    assert wire["dangerous"] == 1
    assert wire["safe"] == 1
    assert wire["unknown"] == 1  # the pending dep
    assert wire["suspect"] == 0  # dev never emits SUSPECT

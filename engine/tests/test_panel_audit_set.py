# CLASS MAP — panel.audit_set: the ONE "set of (name, version) plus a rollup".
#
# Seam A: compute_rollup + compute_progress are PURE — RollupItems in, counters out,
#   no DB. They are the functions R-1 collapsed three copies into, so the matrix is
#   enumerated ONCE and then re-run per ORIGIN, which is what proves the collapse is
#   real rather than three code paths that happen to agree today.
# Seam B: AuditSetStore over a real throwaway sqlite — audit_sets, audit_set_items,
#   package_verdicts and panel_jobs are the REAL tables and the REAL queue, so
#   creation, cache-first enqueue, progress finalization, the durable stream and the
#   check-run hand-off are all observable without GitHub or docker.
#
# Axes: (outcome x cached) over {SAFE, DANGEROUS, ERROR, None} with severity
#       DANGEROUS > ERROR > SAFE × origin {repo_scan, public_repo_scan, bench_run} ×
#       set lifecycle (live / finalized / orphaned) × stream cursor position
#
# The rules the matrix exists to hold, none of them derivable from one row:
#  - pending NEVER contributes to the outcome, and `cached` is orthogonal: a subset of
#    the concluded items, excluded from the sum, and unable to change the verdict.
#  - ERROR beats SAFE. A set whose audits crashed is not green, and the check-run
#    hand-off carries the set's own rollup so one crashed audit among SAFE ones
#    concludes ERROR rather than a silent pass.
#  - An empty set is 'done', not 'running'. "Covered nothing" has to be expressible,
#    or it is indistinguishable from "not concluded yet", and an empty push hangs
#    in_progress for ever.
#  - pending is (live job AND live set), so a FINALIZED set never reports pending even
#    when a later set enqueues a job for one of its pairs.
#  - Only jobs actually INSERTED are charged: a pair another set already queued is
#    shared, not re-bought. And a refused budget creates NO set and NO items, because
#    the assert precedes the write.
#  - bench_run is designed-for and never built: an origin with no subject table and no
#    billing still creates, rolls up and streams. That is the proof adding an origin
#    costs an item-discovery function and nothing else.
import json

import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard.config import Settings
from npmguard.panel import tables
from npmguard.panel.audit_set import (
    ORIGIN_BENCH_RUN,
    ORIGIN_PUBLIC_REPO_SCAN,
    ORIGIN_REPO_SCAN,
    AuditSetSpec,
    Rollup,
    RollupItem,
    build_store,
    compute_progress,
    compute_rollup,
    monthly_budget_hooks,
    set_item_states,
    set_rollup,
    set_wire,
    truncated,
)
from npmguard.panel.caps import CapExceededError, CapsStore
from npmguard.panel.jobs import JobSpec, PanelJobQueue
from npmguard.panel.lockfile import LockfileDep
from npmguard.panel.verdict_index import VerdictIndex

_ = tables


def _items(*outcomes: str | None) -> list[RollupItem]:
    return [RollupItem(outcome=outcome) for outcome in outcomes]


# --------------------------------------------------------------------------
# compute_rollup — the pure matrix
# --------------------------------------------------------------------------


def test_rollup_empty() -> None:
    """C1: no items -> outcome None, zeroed counters (the invariant holds at 0)."""
    r = compute_rollup([])
    assert r.outcome is None
    assert (r.total, r.safe, r.dangerous, r.error, r.pending, r.cached) == (0, 0, 0, 0, 0, 0)


def test_rollup_all_safe() -> None:
    """C2: every item SAFE -> SAFE."""
    r = compute_rollup(_items("SAFE", "SAFE", "SAFE"))
    assert r.outcome == "SAFE"
    assert (r.safe, r.total) == (3, 3)


def test_rollup_dangerous_beats_safe() -> None:
    """C3: one DANGEROUS among SAFE -> DANGEROUS."""
    r = compute_rollup(_items("SAFE", "DANGEROUS", "SAFE"))
    assert r.outcome == "DANGEROUS"
    assert (r.dangerous, r.safe) == (1, 2)


def test_rollup_all_pending_has_no_outcome() -> None:
    """C4: nothing concluded -> outcome None. Not concluded is progress, never a
    verdict bucket."""
    r = compute_rollup(_items(None, None))
    assert r.outcome is None
    assert (r.pending, r.total) == (2, 2)
    assert (r.safe, r.dangerous, r.error) == (0, 0, 0)


def test_rollup_all_error() -> None:
    """C5: every audit failed -> ERROR, and the count says how many."""
    r = compute_rollup(_items("ERROR", "ERROR"))
    assert r.outcome == "ERROR"
    assert (r.error, r.total) == (2, 2)


def test_rollup_error_beats_safe() -> None:
    """C6: 12 crashed audits among 40 deps is NOT a green repo — ERROR outranks
    SAFE, and the error count is on the wire to prove it."""
    r = compute_rollup(_items(*(["SAFE"] * 28 + ["ERROR"] * 12)))
    assert r.outcome == "ERROR"
    assert (r.safe, r.error, r.total) == (28, 12, 40)


def test_rollup_dangerous_beats_error() -> None:
    """C7: severity is DANGEROUS > ERROR > SAFE."""
    r = compute_rollup(_items("ERROR", "DANGEROUS", "SAFE"))
    assert r.outcome == "DANGEROUS"


def test_rollup_pending_never_contributes() -> None:
    """C8: SAFE items + a pending one is 'SAFE so far, 1 pending' — never the old
    UNKNOWN, which is what conflated pending with failed."""
    r = compute_rollup(_items("SAFE", "SAFE", None))
    assert r.outcome == "SAFE"
    assert (r.safe, r.pending, r.total) == (2, 1, 3)


def test_rollup_mixed_counters_exact() -> None:
    """C9: one item in each state -> exact counters and DANGEROUS overall."""
    r = compute_rollup(_items("SAFE", "DANGEROUS", "ERROR", None))
    assert r.outcome == "DANGEROUS"
    assert (r.safe, r.dangerous, r.error, r.pending, r.total) == (1, 1, 1, 1, 4)


def test_rollup_cached_is_orthogonal() -> None:
    """C10: a cached item counts in its outcome bucket AND in cached; cached is
    excluded from the four-way sum, so it cannot double-count."""
    r = compute_rollup(
        [
            RollupItem(outcome="SAFE", cached=True),
            RollupItem(outcome="DANGEROUS", cached=True),
            RollupItem(outcome="SAFE", cached=False),
        ]
    )
    assert (r.safe, r.dangerous, r.cached, r.total) == (2, 1, 2, 3)
    assert r.safe + r.dangerous + r.error + r.pending == r.total
    assert r.outcome == "DANGEROUS"


def test_rollup_wire_shape() -> None:
    """C11: as_wire is exactly the contract's AuditSetRollup — built through the
    generated model, so a drifted shape cannot reach the wire at all."""
    r = compute_rollup([RollupItem(outcome="SAFE", cached=True), RollupItem(outcome=None)])
    assert r.as_wire().model_dump(mode="json", exclude_none=False) == {
        "outcome": "SAFE",
        "total": 2,
        "safe": 1,
        "dangerous": 0,
        "error": 0,
        "pending": 1,
        "cached": 1,
    }


def test_rollup_rejects_foreign_outcome() -> None:
    """C12: a value outside the 3-state domain (a corrupt row
    reaching the rollup) fails loud rather than being counted.

    The enforcement is ``outcome_severity``'s total mapping, and the ``KeyError``
    names the offending value. ``compute_rollup`` no longer re-checks the domain
    itself: both producers of :class:`RollupItem` derive ``outcome`` from
    ``item_outcome``, so a domain assert here re-established an upstream guarantee
    from the same call chain (N-4 rule 5) — and it was also what made this test pass
    for the wrong reason, since it matched on the word "outcome", which the
    ``outcome_severity`` guard's message contained too.
    """
    for foreign in ("SUSPECT", "UNKNOWN", "safe"):
        with pytest.raises(KeyError, match=foreign):
            compute_rollup([RollupItem(outcome=foreign)])


def test_rollup_rejects_cached_without_landed_verdict() -> None:
    """C13: cached => a landed verdict. A cached item that is pending, or one that
    is cached AND errored, would misdescribe what "resolved from an existing
    report" means, so both are refused."""
    for bad in (None, "ERROR"):
        with pytest.raises(AssertionError, match="cached item cannot"):
            compute_rollup([RollupItem(outcome=bad, cached=True)])


# --------------------------------------------------------------------------
# compute_progress — the ONE running/done decision
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("outcomes", "status"),
    [
        ((None,), "running"),
        (("SAFE", None), "running"),
        (("SAFE", "DANGEROUS", "ERROR"), "done"),
        ((), "done"),
    ],
)
def test_progress_status_tracks_pending(outcomes, status) -> None:
    """C14: status is 'done' iff pending == 0 — including for an EMPTY set, which
    is finished rather than forever-unresolved. That distinction is why the check
    mapper can now conclude an empty push instead of leaving it in_progress."""
    progress = compute_progress(_items(*outcomes))
    assert progress.status == status
    assert progress.finished == (status == "done")
    assert (progress.rollup.pending == 0) == progress.finished


# --------------------------------------------------------------------------
# truncated()
# --------------------------------------------------------------------------


def test_truncated_flag() -> None:
    """C35: the flag is server-computed from the rollup's true total, and a
    projection claiming MORE items than the set has is a bug, not a False."""
    rollup = Rollup(total=10)
    assert truncated(rollup, 5) is True
    assert truncated(rollup, 10) is False
    with pytest.raises(AssertionError, match="detail projection"):
        truncated(rollup, 11)


# --------------------------------------------------------------------------
# AuditSetStore — DB-backed, real queue + verdict index
# --------------------------------------------------------------------------


def _settings() -> Settings:
    return Settings(
        free_max_protected_repos=3,
        free_max_audits_month=250,
        pro_max_protected_repos=25,
        pro_max_audits_month=5000,
    )


class _Store:
    """The store plus the collaborators a test needs to reach around it."""

    def __init__(self, store, factory, caps, verdicts, queue, concluded) -> None:
        self.store = store
        self.factory = factory
        self.caps = caps
        self.verdicts = verdicts
        self.queue = queue
        self.concluded = concluded


@pytest.fixture
async def store(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'sets.sqlite3'}")
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
            tables.repos.insert().values(
                id=10, installation_id=1, owner="acme", name="app",
                full_name="acme/app", created_at=now, updated_at=now,
            )
        )
        await session.execute(
            tables.gh_users.insert().values(
                id=7, login="dev", created_at=now, updated_at=now
            )
        )

    concluded: list[tuple[int, int, Rollup]] = []

    async def finalize_check(set_id: int, check_run_id: int, rollup: Rollup) -> None:
        concluded.append((set_id, check_run_id, rollup))

    # A polling notifier is the sqlite-side EventNotifier adapter: the same port
    # LISTEN/NOTIFY implements under postgres, so the stream code under test is the
    # production one on both engines (TESTING.md's DB-engine axis).
    notifier = PollingNotifier(poll_interval=0.01)
    await notifier.start()
    caps = CapsStore(factory, _settings())
    verdicts = VerdictIndex(factory)
    queue = PanelJobQueue(factory)
    built = build_store(
        factory,
        verdicts,
        queue,
        StreamService(factory, notifier),
        notifier,
        finalize_check=finalize_check,
    )
    yield _Store(built, factory, caps, verdicts, queue, concluded)
    await notifier.close()
    await engine.dispose()


def _deps(*pairs: tuple[str, str]) -> list[LockfileDep]:
    return [LockfileDep(name, version, True, f"^{version}") for name, version in pairs]


def _repo_spec(store: _Store, deps: list[LockfileDep], **overrides) -> AuditSetSpec:
    assert_budget, consume_budget = monthly_budget_hooks(store.caps, 1)
    base = dict(
        origin=ORIGIN_REPO_SCAN,
        origin_ref=10,
        trigger="manual",
        items=deps,
        billed_to=1,
        billed_org="acme",
        assert_budget=assert_budget,
        consume_budget=consume_budget,
    )
    base.update(overrides)
    return AuditSetSpec(**base)


def _public_spec(deps: list[LockfileDep], **overrides) -> AuditSetSpec:
    # No budget hooks and no payer: nobody is billed for a public snapshot (D-1).
    # Its identity is the REQUESTER, and that absence-plus-requester IS the
    # per-origin billing difference.
    base = dict(
        origin=ORIGIN_PUBLIC_REPO_SCAN,
        origin_ref=999,
        trigger="manual",
        items=deps,
        requested_by=7,
    )
    base.update(overrides)
    return AuditSetSpec(**base)


def _bench_spec(deps: list[LockfileDep], **overrides) -> AuditSetSpec:
    # An origin with NO subject table and NO payer. It exists in this test only to
    # prove the shared machinery does not need either.
    base = dict(
        origin=ORIGIN_BENCH_RUN, origin_ref=4242, trigger="manual", items=deps
    )
    base.update(overrides)
    return AuditSetSpec(**base)


async def _set_row(store: _Store, set_id: int):
    async with store.factory() as session:
        return (
            (
                await session.execute(
                    sa.select(tables.audit_sets).where(tables.audit_sets.c.id == set_id)
                )
            )
            .mappings()
            .one()
        )


async def _rollup(store: _Store, set_id: int) -> Rollup:
    async with store.factory() as session:
        return await set_rollup(session, set_id)


async def _rows(store: _Store, table) -> list:
    async with store.factory() as session:
        return (await session.execute(sa.select(table))).mappings().all()


async def _drain_jobs(store: _Store, state: str = "done") -> None:
    async with store.factory() as session, session.begin():
        await session.execute(
            tables.panel_jobs.update().values(state=state, finished_at=now_iso())
        )


# --- per-origin classes over the SAME functions ----------------------------


async def test_repo_scan_origin_rolls_up(store) -> None:
    """C15: a repo lockfile becomes a repo_scan set whose rollup is the max
    severity over ITS OWN items, and whose misses are charged to the monthly
    budget."""
    deps = _deps(("safe-pkg", "1.0.0"), ("bad-pkg", "2.0.0"), ("pending-pkg", "3.0.0"))
    set_id = await store.store.create(_repo_spec(store, deps))
    await store.verdicts.upsert("safe-pkg", "1.0.0", "SAFE")
    await store.verdicts.upsert("bad-pkg", "2.0.0", "DANGEROUS")

    rollup = await _rollup(store, set_id)
    assert rollup.as_wire().model_dump(mode="json", exclude_none=False) == {
        "outcome": "DANGEROUS", "total": 3, "safe": 1, "dangerous": 1,
        "error": 0, "pending": 1, "cached": 0,
    }
    row = await _set_row(store, set_id)
    assert (row["origin"], row["origin_ref"], row["billed_to"]) == (
        ORIGIN_REPO_SCAN, 10, 1,
    )
    usage = await _rows(store, tables.account_usage)
    assert [u["audits"] for u in usage] == [3]


async def test_public_scan_origin_rolls_up_identically(store) -> None:
    """C16: the SAME item list through the SAME functions under a different origin
    yields the IDENTICAL rollup — that equality is the R-1 claim, and it used to be
    two implementations that merely happened to agree. Public audits are NOT
    charged to the monthly budget."""
    deps = _deps(("safe-pkg", "1.0.0"), ("bad-pkg", "2.0.0"), ("pending-pkg", "3.0.0"))
    repo_set = await store.store.create(_repo_spec(store, deps))
    public_set = await store.store.create(_public_spec(deps))
    await store.verdicts.upsert("safe-pkg", "1.0.0", "SAFE")
    await store.verdicts.upsert("bad-pkg", "2.0.0", "DANGEROUS")

    assert (await _rollup(store, repo_set)).as_wire() == (
        await _rollup(store, public_set)
    ).as_wire()
    # The monthly budget was charged ONCE — by the repo scan. The public set
    # enqueued nothing new (the pairs already had live jobs) and bills nothing.
    usage = await _rows(store, tables.account_usage)
    assert [u["audits"] for u in usage] == [3]


async def test_bench_run_origin_needs_no_subject_or_payer(store) -> None:
    """C17: an origin with no subject table, no repo, and nobody billed still
    creates, rolls up and finalizes. This is what "adding an origin costs one
    item-discovery function" means, tested rather than asserted."""
    set_id = await store.store.create(_bench_spec(_deps(("fixture-pkg", "0.0.1"))))
    await store.verdicts.upsert("fixture-pkg", "0.0.1", "DANGEROUS")
    await _drain_jobs(store)
    await store.store.refresh(set_id, changed=[("fixture-pkg", "0.0.1")])

    row = await _set_row(store, set_id)
    assert row["billed_to"] is None
    assert row["finished_at"] is not None
    rollup = await _rollup(store, set_id)
    assert (rollup.outcome, rollup.dangerous, rollup.total) == ("DANGEROUS", 1, 1)
    assert await _rows(store, tables.account_usage) == []


# --- create ---------------------------------------------------------------


async def test_create_dedupes_duplicate_pairs(store) -> None:
    """C18: a lockfile carrying the same (name,version) twice yields ONE item and
    ONE job — both are keyed on the pair."""
    deps = [
        LockfileDep("lodash", "4.17.21", True, "^4.17.21"),
        LockfileDep("lodash", "4.17.21", False, None),  # duplicate pair
        LockfileDep("react", "18.2.0", True, "^18.0.0"),
    ]
    set_id = await store.store.create(_repo_spec(store, deps))
    items = [i for i in await _rows(store, tables.audit_set_items) if i["set_id"] == set_id]
    assert {(i["name"], i["version"]) for i in items} == {
        ("lodash", "4.17.21"),
        ("react", "18.2.0"),
    }
    assert len(await _rows(store, tables.panel_jobs)) == 2


async def test_create_is_cache_first_and_stamps_origin(store) -> None:
    """C19: a pair with a landed verdict is marked cached and NOT enqueued; a miss
    becomes a job carrying the SET's origin (so an alert on its verdict knows where
    it came from) and the set's fairness key — which for a public scan is the
    REQUESTER, since nobody is billed for one."""
    await store.verdicts.upsert("cached-pkg", "1.0.0", "SAFE")
    set_id = await store.store.create(
        _public_spec(
            _deps(("cached-pkg", "1.0.0"), ("fresh-pkg", "2.0.0")), billed_org="octocat"
        )
    )
    items = {
        i["name"]: i
        for i in await _rows(store, tables.audit_set_items)
        if i["set_id"] == set_id
    }
    assert items["cached-pkg"]["cached"] is True
    assert items["fresh-pkg"]["cached"] is False
    jobs = await _rows(store, tables.panel_jobs)
    assert len(jobs) == 1
    assert (jobs[0]["package_name"], jobs[0]["origin"], jobs[0]["org"]) == (
        "fresh-pkg", ORIGIN_PUBLIC_REPO_SCAN, "octocat",
    )


async def test_refused_budget_creates_no_set(store) -> None:
    """C20: the budget is asserted BEFORE any row is written, so a refusal leaves
    no half-created set to finalize, stream, or count."""
    tight = CapsStore(store.factory, Settings(free_max_audits_month=1))
    assert_budget, consume_budget = monthly_budget_hooks(tight, 1)
    spec = _repo_spec(
        store,
        _deps(("a", "1.0.0"), ("b", "1.0.0")),
        assert_budget=assert_budget,
        consume_budget=consume_budget,
    )
    with pytest.raises(CapExceededError):
        await store.store.create(spec)
    assert await _rows(store, tables.audit_sets) == []
    assert await _rows(store, tables.audit_set_items) == []
    assert await _rows(store, tables.panel_jobs) == []


async def test_only_inserted_jobs_are_charged(store) -> None:
    """C21: a pair another set already queued is SHARED, not re-bought — the
    monthly meter counts inserted rows, not requested ones."""
    await store.queue.enqueue_many([JobSpec("shared", "1.0.0", "acme", ORIGIN_REPO_SCAN)])
    await store.store.create(_repo_spec(store, _deps(("shared", "1.0.0"), ("own", "1.0.0"))))
    usage = await _rows(store, tables.account_usage)
    assert [u["audits"] for u in usage] == [1]  # 'own' only


# --- refresh / finalization ------------------------------------------------


async def test_stays_live_with_an_active_job(store) -> None:
    """C22: a set whose job is still queued is live — finished_at NULL, status
    'running' on the wire, and the pending counter says how much is outstanding."""
    set_id = await store.store.create(_repo_spec(store, _deps(("pending-pkg", "1.0.0"))))
    row = await _set_row(store, set_id)
    assert row["finished_at"] is None
    rollup = await _rollup(store, set_id)
    assert set_wire(row, rollup).status == "running"
    assert (rollup.pending, rollup.total) == (1, 1)


async def test_finalizes_when_no_active_job(store) -> None:
    """C23/C24: once the jobs settle, a refresh finalizes the set; an item that
    landed no verdict and has no attempt left is ERROR — a visible coverage gap
    rather than a spinner waiting for a result nothing will produce."""
    set_id = await store.store.create(
        _repo_spec(store, _deps(("resolved", "1.0.0"), ("lost", "2.0.0")))
    )
    await store.verdicts.upsert("resolved", "1.0.0", "DANGEROUS")
    await _drain_jobs(store, state="failed")
    await store.store.refresh(set_id, changed=[("resolved", "1.0.0")])

    row = await _set_row(store, set_id)
    assert row["finished_at"] is not None
    rollup = await _rollup(store, set_id)
    assert set_wire(row, rollup).status == "done"
    assert (rollup.dangerous, rollup.error, rollup.pending) == (1, 1, 0)


async def test_refresh_is_noop_on_finalized_set(store) -> None:
    """C25: the finished_at guard makes finalization fire exactly once, which is
    what lets the GitHub check run be concluded a single time even though refresh
    runs on every worker settle."""
    set_id = await store.store.create(
        _repo_spec(store, _deps(("x", "1.0.0")), check_run_id=555)
    )
    await store.verdicts.upsert("x", "1.0.0", "SAFE")
    await _drain_jobs(store)
    await store.store.refresh(set_id, changed=[("x", "1.0.0")])
    finished_first = (await _set_row(store, set_id))["finished_at"]

    await store.store.refresh(set_id, changed=[("x", "1.0.0")])
    assert (await _set_row(store, set_id))["finished_at"] == finished_first
    assert len(store.concluded) == 1


async def test_finalized_set_never_reports_pending(store) -> None:
    """C26: a job a LATER set enqueues for one of this set's pairs cannot make a
    finished set pending again — an item is pending only while its job is live AND
    its set is live. Without that, `pending == 0 iff finished` would be false at
    read time and a done scan would render a spinner."""
    set_id = await store.store.create(_repo_spec(store, _deps(("shared", "1.0.0"))))
    await _drain_jobs(store, state="failed")
    await store.store.refresh(set_id, changed=[("shared", "1.0.0")])
    assert (await _set_row(store, set_id))["finished_at"] is not None

    # A second set re-enqueues the same pair; the first set stays finished.
    await store.store.create(_public_spec(_deps(("shared", "1.0.0"))))
    rollup = await _rollup(store, set_id)
    assert (rollup.pending, rollup.error, rollup.outcome) == (0, 1, "ERROR")


async def test_check_run_gets_the_sets_own_rollup(store) -> None:
    """C27: one crashed audit among otherwise-SAFE deps concludes ERROR. This is
    the whole point of ERROR being an outcome — the pre-change rollup answered
    UNKNOWN here, which the check mapper read as 'not resolved yet'."""
    set_id = await store.store.create(
        _repo_spec(store, _deps(("fine", "1.0.0"), ("crashed", "2.0.0")), check_run_id=77)
    )
    await store.verdicts.upsert("fine", "1.0.0", "SAFE")
    await _drain_jobs(store, state="failed")
    await store.store.refresh(set_id, changed=[("fine", "1.0.0")])

    assert len(store.concluded) == 1
    concluded_set, check_run_id, rollup = store.concluded[0]
    assert (concluded_set, check_run_id) == (set_id, 77)
    assert (rollup.outcome, rollup.error, rollup.safe) == ("ERROR", 1, 1)


async def test_empty_set_finalizes_and_concludes(store) -> None:
    """C28: a set that covered NOTHING finalizes immediately and hands the check
    run a total==0 rollup. Before R-1 this was a push whose delta was empty: its
    outcome was None, the mapper read None as 'in progress', and the check run
    stayed open forever. "Covered nothing" is a rollup fact, not an outcome."""
    set_id = await store.store.create(_repo_spec(store, [], check_run_id=99))
    row = await _set_row(store, set_id)
    assert row["finished_at"] is not None
    assert len(store.concluded) == 1
    _, _, rollup = store.concluded[0]
    assert (rollup.total, rollup.outcome, rollup.pending) == (0, None, 0)


async def test_refresh_touching_spans_origins(store) -> None:
    """C29: a settle nudges every LIVE set covering the pair regardless of origin —
    a job deduped across two sets belongs to neither, so "my job finished" is not a
    signal any single set can own. A finalized set is left alone."""
    repo_set = await store.store.create(_repo_spec(store, _deps(("shared", "1.0.0"))))
    public_set = await store.store.create(_public_spec(_deps(("shared", "1.0.0"))))
    bench_set = await store.store.create(_bench_spec(_deps(("other", "9.9.9"))))
    await store.verdicts.upsert("shared", "1.0.0", "SAFE")
    await _drain_jobs(store)

    await store.store.refresh_touching("shared", "1.0.0")

    assert (await _set_row(store, repo_set))["finished_at"] is not None
    assert (await _set_row(store, public_set))["finished_at"] is not None
    # The bench set does not cover the pair, so it was not touched.
    assert (await _set_row(store, bench_set))["finished_at"] is None


async def test_refresh_live_sweeps_orphans(store) -> None:
    """C30: a set orphaned by a crash — items written, jobs never enqueued — is
    finalized by the boot sweep as ERROR. Without the sweep it stays running
    forever, its check run never concludes, and its stream never terminates."""
    async with store.factory() as session, session.begin():
        result = await session.execute(
            tables.audit_sets.insert().values(
                origin=ORIGIN_REPO_SCAN, origin_ref=10, billed_to=1,
                trigger_kind="manual", started_at=now_iso(),
            )
        )
        set_id = int(result.inserted_primary_key[0])
        await session.execute(
            tables.audit_set_items.insert().values(
                set_id=set_id, name="orphan", version="1.0.0"
            )
        )

    assert await store.store.refresh_live() == 1
    row = await _set_row(store, set_id)
    assert row["finished_at"] is not None
    rollup = await _rollup(store, set_id)
    assert (rollup.outcome, rollup.error) == ("ERROR", 1)


# --- the stream -----------------------------------------------------------


def _parse(frames: list[str]) -> list[dict]:
    """Payloads of the data-only SSE frames a reader emitted."""
    out: list[dict] = []
    for frame in frames:
        for line in frame.splitlines():
            if line.startswith("data: "):
                out.append(json.loads(line.removeprefix("data: ")))
    return out


async def _read(store: _Store, set_id: int, *, after: int = -1) -> list[str]:
    frames: list[str] = []
    async for frame in store.store.events(set_id, after=after, heartbeat=0.01):
        frames.append(frame)
    return frames


async def test_stream_replays_the_whole_log_then_done(store) -> None:
    """C31/C34: a fresh reader gets the log from seq 0 — a dep frame per item, a
    progress frame, then a terminal done — and each frame carries an `id:` line
    with NO `event:` line, so a client reads them with onmessage while
    Last-Event-ID still resumes."""
    set_id = await store.store.create(
        _repo_spec(store, _deps(("a", "1.0.0"), ("b", "2.0.0")))
    )
    await store.verdicts.upsert("a", "1.0.0", "SAFE")
    await store.verdicts.upsert("b", "2.0.0", "DANGEROUS")
    await _drain_jobs(store)
    await store.store.refresh(set_id, changed=[("a", "1.0.0"), ("b", "2.0.0")])

    frames = await _read(store, set_id)
    assert all("event:" not in frame for frame in frames)
    assert any(frame.startswith("id: ") for frame in frames)

    payloads = _parse(frames)
    assert payloads[-1] == {"type": "done"}
    deps = [p["item"] for p in payloads if p["type"] == "dep"]
    assert {d["name"] for d in deps} == {"a", "b"}
    # The dep frame is the WHOLE contract item, not a lossier subset: the old
    # frame dropped direct / range / auditedAt / cached.
    assert set(deps[0]) == {
        "name", "version", "direct", "range", "outcome", "verdictReason",
        "evidenceCount", "auditedAt", "jobState", "cached",
    }
    final = [p for p in payloads if p["type"] == "progress"][-1]
    assert final["status"] == "done"
    assert final["rollup"]["outcome"] == "DANGEROUS"


async def test_stream_resumes_from_last_event_id(store) -> None:
    """C32: reading after a cursor yields only NEWER frames. The cursor is the
    durable log's seq, which is what the `id:` line carries — the poll-and-diff
    stream this replaced had no cursor at all, so a reconnect re-sent everything
    from a per-connection memo that a second process could not see."""
    set_id = await store.store.create(_repo_spec(store, _deps(("a", "1.0.0"))))
    await store.verdicts.upsert("a", "1.0.0", "SAFE")
    await _drain_jobs(store)
    await store.store.refresh(set_id, changed=[("a", "1.0.0")])

    first = await _read(store, set_id)
    seqs = [
        int(line.removeprefix("id: "))
        for frame in first
        for line in frame.splitlines()
        if line.startswith("id: ")
    ]
    assert seqs, first
    resumed = _parse(await _read(store, set_id, after=max(seqs)))
    # Everything logged is already delivered, so a resume gets only the freshly
    # computed final progress + done — never a replay of the dep frames.
    assert [p["type"] for p in resumed] == ["progress", "done"]


async def test_finalized_set_with_empty_log_still_terminates(store) -> None:
    """C33: terminality is derived from the SET ROW, not from a stored terminal
    frame. A set finished before the log existed (or one whose last publish was
    contended out) still closes its stream with a truthful final rollup — which is
    why there is no exactly-once `done` frame to get wrong."""
    async with store.factory() as session, session.begin():
        result = await session.execute(
            tables.audit_sets.insert().values(
                origin=ORIGIN_REPO_SCAN, origin_ref=10, billed_to=1,
                trigger_kind="manual", started_at=now_iso(), finished_at=now_iso(),
            )
        )
        set_id = int(result.inserted_primary_key[0])
        await session.execute(
            tables.audit_set_items.insert().values(
                set_id=set_id, name="legacy", version="1.0.0", cached=True
            )
        )
    await store.verdicts.upsert("legacy", "1.0.0", "SAFE")

    payloads = _parse(await _read(store, set_id))
    assert [p["type"] for p in payloads] == ["progress", "done"]
    assert payloads[0]["rollup"] == {
        "outcome": "SAFE", "total": 1, "safe": 1, "dangerous": 0,
        "error": 0, "pending": 0, "cached": 1,
    }


async def test_item_states_are_capped_severity_first(store) -> None:
    """C35 (ordering half): the capped detail projection drops the LEAST urgent
    tail — DANGEROUS first, then ERROR, then pending, then SAFE — so a truncated
    view never hides the finding it exists to show."""
    set_id = await store.store.create(
        _repo_spec(store, _deps(("z-safe", "1.0.0"), ("a-bad", "2.0.0")))
    )
    await store.verdicts.upsert("z-safe", "1.0.0", "SAFE")
    await store.verdicts.upsert("a-bad", "2.0.0", "DANGEROUS")
    async with store.factory() as session:
        states = await set_item_states(session, set_id, limit=1)
    assert [s.name for s in states] == ["a-bad"]

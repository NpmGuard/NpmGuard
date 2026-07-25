"""The ONE "set of ``(name, version)`` to audit, plus a rollup" entity (R-1).

Three near-identical copies of this existed or were planned — ``scans``,
``public_repo_scans``, and a ``bench_runs`` about to be written — each with its own
status/counters, its own items table, its own progress refresher, its own severity
rollup, and (for one of them) its own progress transport. A dep-tree audit (R-7)
would have been a fourth. They are one thing, and this module is it.

**What differs per origin, and nothing else:**

1. *how the item list is discovered* — a repo's lockfile, a public repo's lockfile,
   a pinned bench corpus. That is the caller's job: it hands :class:`AuditSetSpec`
   a finished list of ``(name, version)``.
2. *who is billed* — expressed as two injected budget hooks, so an unbilled origin
   passes no-ops instead of this module growing an ``if``.

Everything downstream is shared and lives here exactly once: one progress
function, one rollup function, one item projection, one truncation rule, one SSE
stream.

Three structural decisions worth naming, because each removes a class of state
rather than a bug:

- **Nothing is counted, only recomputed.** There is no stored ``total``/``cached``/
  ``audited``/``failed``. Every counter comes from
  ``audit_set_items ⋈ package_verdicts`` + live jobs on read, so a crashed worker
  cannot desynchronize a counter from reality — there is no counter to
  desynchronize.
- **``finished_at`` is the only liveness fact.** There is no stored ``status``:
  the wire's ``status`` is ``"done"`` iff ``finished_at`` is set. Two columns
  encoding one bit is how they come to disagree.
- **An item is pending only while its job is live AND the set is live.** That is
  what makes ``pending == 0 ⟺ the set is finished`` true at read time forever: a
  job some *other* set enqueues later cannot retroactively un-finish this one.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Collection, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

import sqlalchemy as sa
import structlog
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import Conflict, now_iso
from kit_spine.ports import EventNotifier
from kit_stream import StreamService
from kit_stream.service import READ_BATCH

from ..contract import models as contract
from ..contract.kinds import JobState, PackageOutcome, SetStatus
from .caps import CapsStore
from .jobs import JobSpec, PanelJobQueue
from .lockfile import LockfileDep
from .tables import audit_set_items, audit_sets, package_verdicts, panel_jobs
from .verdict_index import (
    LANDABLE_VERDICTS,
    VerdictIndex,
    item_outcome,
    outcome_severity,
)

log = structlog.get_logger("npmguard.panel.audit_set")

# ---------------------------------------------------------------------------
# The origin + trigger domains (contract AuditSetOrigin / AuditSetTrigger)
# ---------------------------------------------------------------------------

ORIGIN_REPO_SCAN = "repo_scan"
ORIGIN_PUBLIC_REPO_SCAN = "public_repo_scan"
ORIGIN_DEP_TREE = "dep_tree"
ORIGIN_BENCH_RUN = "bench_run"
ORIGIN_WATCHLIST = "watchlist"

# `dep_tree` and `bench_run` are designed-for, not built (R-7 / §4.3): listed so
# adding either costs an item-discovery function and no schema or wire change.
# `watchlist` has a producer TODAY — but only on `panel_jobs.origin` and
# `alerts.origin`, because a registry-watch audit fills the shared cache without
# belonging to any set. It is the one origin that names work rather than a set.
ORIGINS = frozenset(
    {
        ORIGIN_REPO_SCAN,
        ORIGIN_PUBLIC_REPO_SCAN,
        ORIGIN_DEP_TREE,
        ORIGIN_BENCH_RUN,
        ORIGIN_WATCHLIST,
    }
)
SET_ORIGINS = ORIGINS - {ORIGIN_WATCHLIST}

TRIGGERS = frozenset({"manual", "push", "reconcile", "publish"})

# Cap on the item list a DETAIL response carries — one number for every origin.
# The set itself is never capped (see `depsTruncated` on both detail responses):
# truncation is a property of the projection, so it is reported by the route that
# performs it and is never stored on the set as though the set were incomplete.
MAX_DETAIL_ITEMS = 500

# Match kit_stream's own append contention policy: a set's channel is appended to
# by every worker that settles one of its items, so collisions are expected and
# transient. Exhausting these loses one progress frame, not correctness — the next
# settle republishes, and the stream reader derives terminality from the set row
# rather than from a frame.
_PUBLISH_RETRIES = 10
_PUBLISH_RETRY_BASE_SECONDS = 0.002

_ACTIVE_JOB_STATES = ("queued", "running")


# ---------------------------------------------------------------------------
# The rollup — pure, over an item list
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RollupItem:
    """One item as the rollup sees it: its outcome, and whether it was cached.

    Deliberately not "a row" — every origin lifts its own rows through
    :func:`~npmguard.panel.verdict_index.item_outcome` before counting, which keeps
    the rollup pure and stops it from guessing which key holds the verdict.
    """

    outcome: PackageOutcome | None
    cached: bool = False


@dataclass
class Rollup:
    """The one counters object over a set's items (contract ``AuditSetRollup``).

    Replaces today's ``{total, cached, audited, failed}`` PLUS a separate
    ``{verdict, dangerous, suspect, unknown, safe}``. Two objects counting the same
    items, neither summing to anything checkable, is how ``unknown`` came to mean
    three different facts.
    """

    outcome: PackageOutcome | None = None
    total: int = 0
    safe: int = 0
    dangerous: int = 0
    error: int = 0
    pending: int = 0
    cached: int = 0

    def as_wire(self) -> contract.AuditSetRollup:
        return contract.AuditSetRollup(
            outcome=self.outcome,
            total=self.total,
            safe=self.safe,
            dangerous=self.dangerous,
            error=self.error,
            pending=self.pending,
            cached=self.cached,
        )


def compute_rollup(items: Iterable[RollupItem]) -> Rollup:
    """Roll a set of :class:`RollupItem` up into its counters + outcome.

    INVARIANT: ``safe + dangerous + error + pending == total`` — every item is in
    exactly one of those four states, which is what makes the old ``unknown``
    bucket (three facts under one name) unrepresentable. ``cached`` is orthogonal
    (a subset of the concluded two, ``SAFE``/``DANGEROUS``) and excluded from the
    sum. Unasserted on purpose: the loop below does ``total += 1`` and then exactly
    one of four increments unconditionally, so the partition cannot fail on any
    input. An assert over it is a unit test spelled as an assert, and it is pinned
    as one instead (tests/test_panel_audit_set.py).

    INVARIANT: ``outcome`` is the max severity (``DANGEROUS > ERROR > SAFE``)
    over CONCLUDED items only, and ``None`` when none has concluded. Pending
    never contributes — a half-finished set is "SAFE so far, N pending".

    INVARIANT: an item's outcome is a panel outcome or ``None``, so the three-arm
    classification below is exhaustive and ``outcome_severity`` is total. Also
    unasserted, and this one is the substantive case: BOTH producers of
    :class:`RollupItem` (``ItemState.as_rollup_item`` and ``set_rollups``) derive
    ``outcome`` from ``verdict_index.item_outcome``, which raises on anything
    outside ``LANDABLE_VERDICTS`` and returns only ``SAFE|DANGEROUS|ERROR|None``.
    Re-checking it here is the re-establishment of an upstream guarantee that N-4
    rule 5 forbids by name, and it misleads the next reader about where the real
    boundary is — the boundary is ``item_outcome`` and the 0007 CHECK behind it.
    """
    rollup = Rollup()
    best: int | None = None
    for item in items:
        rollup.total += 1
        # INVARIANT: cached ⇒ the item concluded on a LANDED verdict. Cached means
        # "resolved from an existing report", so it can be neither pending nor
        # ERROR. Load-bearing and kept: `cached` is a stored column
        # (`audit_set_items.cached`) written at set creation from a verdict-index
        # hit, while `outcome` is recomputed on every read — so the two are
        # independent facts that CAN drift (a verdict row deleted under a live set),
        # and no upstream step relates them.
        assert not item.cached or item.outcome in LANDABLE_VERDICTS, (
            f"a cached item cannot have outcome {item.outcome!r}; cached means "
            f"'resolved from an existing report', so it is one of "
            f"{sorted(LANDABLE_VERDICTS)}"
        )
        if item.cached:
            rollup.cached += 1
        if item.outcome is None:
            rollup.pending += 1
            continue
        if item.outcome == "SAFE":
            rollup.safe += 1
        elif item.outcome == "DANGEROUS":
            rollup.dangerous += 1
        else:  # ERROR — exhaustive by item_outcome's domain, see the docstring
            rollup.error += 1
        severity = outcome_severity(item.outcome)
        if best is None or severity > best:
            best = severity
            rollup.outcome = item.outcome
    return rollup


# ---------------------------------------------------------------------------
# The progress function — pure, over the same item list
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SetProgress:
    """What an item list says about the SET: its rollup, and whether it is done.

    The single place the ``running -> done`` decision is made, for every origin.
    """

    rollup: Rollup
    status: SetStatus

    @property
    def finished(self) -> bool:
        return self.status == "done"


def compute_progress(items: Iterable[RollupItem]) -> SetProgress:
    """Decide a set's progress from its items.

    INVARIANT: ``status == "done" ⟺ rollup.pending == 0``. ``pending`` is the ONE
    progress counter — the second, independent "does any item still have an active
    job" scan that used to drive finalization could disagree with the rollup the
    wire reported, and did.
    """
    rollup = compute_rollup(items)
    return SetProgress(rollup=rollup, status="running" if rollup.pending else "done")


# ---------------------------------------------------------------------------
# One item state, one item projection
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ItemState:
    """Everything known about one ``(name, version)`` inside a set.

    The ONE lift from raw rows to a classified item. Four divergent projections of
    this existed (repo detail, repo list, public detail, the scan stream), and they
    disagreed: the progress refresher called a jobless item "failed" while the wire
    called it ``null``, and the stream dropped ``direct``/``range``/``auditedAt``/
    ``cached`` entirely.
    """

    name: str
    version: str
    direct: bool
    range: str | None
    cached: bool
    outcome: PackageOutcome | None
    verdict_reason: str | None
    evidence_count: int
    audited_at: str | None
    job_state: JobState | None

    def as_rollup_item(self) -> RollupItem:
        return RollupItem(outcome=self.outcome, cached=self.cached)

    def as_wire(self) -> contract.AuditSetItem:
        return contract.AuditSetItem(
            name=self.name,
            version=self.version,
            direct=self.direct,
            range=self.range,
            outcome=self.outcome,
            verdictReason=self.verdict_reason,
            evidenceCount=self.evidence_count,
            auditedAt=self.audited_at,
            jobState=self.job_state,
            cached=self.cached,
        )


def rollup_items(states: Iterable[ItemState]) -> list[RollupItem]:
    """Lift classified item states into rollup inputs."""
    return [state.as_rollup_item() for state in states]


def job_state(
    active_state: JobState | None, has_failed: Any, verdict: str | None
) -> JobState | None:
    """The wire ``jobState`` — a fact about the ATTEMPT, never an outcome.

    ``failed`` here means "a terminal failed job exists for this pair"; the OUTCOME
    of an unconcluded item is ERROR and comes from ``item_outcome``. The two are
    not interchangeable: an item can be ERROR with ``jobState: null`` (its job row
    was never written — a lost enqueue batch), and it can carry a stale ``failed``
    job alongside a landed verdict from a later attempt.
    """
    return active_state or ("failed" if has_failed and not verdict else None)


def _item_state(row: Mapping[str, Any]) -> ItemState:
    active_state = row["active_state"]
    # `pending` is (a live job) AND (the set is live) — see the module docstring.
    pending = active_state is not None and bool(row["set_live"])
    return ItemState(
        name=row["name"],
        version=row["version"],
        direct=bool(row["direct"]),
        range=row["range"],
        cached=bool(row["cached"]),
        outcome=item_outcome(row["verdict"], pending=pending),
        verdict_reason=row["reason"],
        evidence_count=row["evidence_count"] or 0,
        audited_at=row["audited_at"],
        job_state=job_state(active_state, row["has_failed"], row["verdict"]),
    )


def _item_state_query(set_id: int, *, limit: int | None) -> sa.Select:
    """``audit_set_items ⋈ package_verdicts`` + job state + set liveness.

    Progress comes from the SET's items — never from ``repo_deps`` (a push can
    replace the index underneath a live set) and never from job ownership (jobs are
    deduped across sets by ``ix_panel_jobs_active_pkg``, so a shared job belongs to
    no single set).

    ``limit`` is for the capped DETAIL projection only; a rollup always reads the
    whole set. The severity ordering is what makes the cut safe: the tail a
    truncated view drops is the least urgent, on every origin.
    """
    set_live = audit_sets.c.finished_at.is_(None)
    active_state = (
        sa.select(panel_jobs.c.state)
        .where(
            panel_jobs.c.package_name == audit_set_items.c.name,
            panel_jobs.c.version == audit_set_items.c.version,
            panel_jobs.c.state.in_(_ACTIVE_JOB_STATES),
        )
        .limit(1)
        .scalar_subquery()
    )
    has_failed = (
        sa.select(sa.literal(1))
        .where(
            panel_jobs.c.package_name == audit_set_items.c.name,
            panel_jobs.c.version == audit_set_items.c.version,
            panel_jobs.c.state == "failed",
        )
        .limit(1)
        .scalar_subquery()
    )
    query = (
        sa.select(
            audit_set_items.c.name,
            audit_set_items.c.version,
            audit_set_items.c.direct,
            audit_set_items.c.range,
            audit_set_items.c.cached,
            package_verdicts.c.verdict,
            package_verdicts.c.reason,
            package_verdicts.c.evidence_count,
            package_verdicts.c.audited_at,
            active_state.label("active_state"),
            has_failed.label("has_failed"),
            set_live.label("set_live"),
        )
        .select_from(
            audit_set_items.join(
                audit_sets, audit_sets.c.id == audit_set_items.c.set_id
            ).outerjoin(
                package_verdicts,
                sa.and_(
                    package_verdicts.c.name == audit_set_items.c.name,
                    package_verdicts.c.version == audit_set_items.c.version,
                ),
            )
        )
        .where(audit_set_items.c.set_id == set_id)
    )
    if limit is None:
        return query.order_by(audit_set_items.c.direct.desc(), audit_set_items.c.name)
    # Sort key = the outcome domain, DESC. INVARIANT: the stored verdict is SAFE or
    # DANGEROUS (verdict_index), so these arms are exhaustive. An unconcluded item
    # ranks by whether an attempt is still live: ERROR outranks pending, because a
    # truncated tail must be the least urgent and "we tried and failed" is news.
    severity = sa.case(
        (package_verdicts.c.verdict == "DANGEROUS", 3),
        (package_verdicts.c.verdict == "SAFE", 0),
        (sa.and_(active_state.is_not(None), set_live), 1),
        else_=2,
    )
    return query.order_by(
        severity.desc(), audit_set_items.c.direct.desc(), audit_set_items.c.name
    ).limit(limit)


async def set_item_states(
    session: Any, set_id: int, *, limit: int | None = None
) -> list[ItemState]:
    """The set's classified items. ONE query, ONE classifier, every consumer."""
    rows = (await session.execute(_item_state_query(set_id, limit=limit))).mappings().all()
    return [_item_state(row) for row in rows]


async def set_rollup(session: Any, set_id: int) -> Rollup:
    """A set's rollup over its OWN items — the single answer to "what did this set
    conclude", shared by the progress projection, the GitHub check run, the SSE
    frames and the wire."""
    return compute_rollup(rollup_items(await set_item_states(session, set_id)))


async def set_rollups(session: Any, set_ids: Collection[int]) -> dict[int, Rollup]:
    """Batched :func:`set_rollup` for a list view (``/panel/repos``).

    One query for every set instead of one per set — the repo list needs a rollup
    per repo, and N+1 there is what made ``lastScan`` cheap to leave hardcoded null.
    """
    if not set_ids:
        return {}
    set_live = audit_sets.c.finished_at.is_(None)
    active_exists = (
        sa.select(sa.literal(1))
        .select_from(panel_jobs)
        .where(
            panel_jobs.c.package_name == audit_set_items.c.name,
            panel_jobs.c.version == audit_set_items.c.version,
            panel_jobs.c.state.in_(_ACTIVE_JOB_STATES),
        )
        .exists()
    )
    rows = (
        (
            await session.execute(
                sa.select(
                    audit_set_items.c.set_id,
                    audit_set_items.c.cached,
                    package_verdicts.c.verdict,
                    sa.and_(active_exists, set_live).label("pending"),
                )
                .select_from(
                    audit_set_items.join(
                        audit_sets, audit_sets.c.id == audit_set_items.c.set_id
                    ).outerjoin(
                        package_verdicts,
                        sa.and_(
                            package_verdicts.c.name == audit_set_items.c.name,
                            package_verdicts.c.version == audit_set_items.c.version,
                        ),
                    )
                )
                .where(audit_set_items.c.set_id.in_(set_ids))
            )
        )
        .mappings()
        .all()
    )
    grouped: dict[int, list[RollupItem]] = {set_id: [] for set_id in set_ids}
    for row in rows:
        grouped[row["set_id"]].append(
            RollupItem(
                outcome=item_outcome(row["verdict"], pending=bool(row["pending"])),
                cached=bool(row["cached"]),
            )
        )
    return {set_id: compute_rollup(items) for set_id, items in grouped.items()}


def set_wire(row: Mapping[str, Any], rollup: Rollup) -> contract.AuditSet:
    """The ONE ``AuditSet`` projection.

    ``status`` is DERIVED from ``finished_at`` rather than read from a column, so
    the contract's "finishedAt is non-null iff status is done" cannot be violated:
    there is only one fact.
    """
    finished_at = row["finished_at"]
    return contract.AuditSet(
        id=row["id"],
        origin=row["origin"],
        trigger=row["trigger_kind"],
        status="done" if finished_at else "running",
        rollup=rollup.as_wire(),
        commitSha=row["commit_sha"],
        startedAt=row["started_at"],
        finishedAt=finished_at,
    )


def truncated(rollup: Rollup, shown: int) -> bool:
    """``depsTruncated`` for a detail response — server-computed on BOTH routes.

    The true count is the rollup's ``total``; a truncated view must never be summed
    for a posture, which is exactly why the flag is emitted rather than left for a
    consumer to infer by comparing two lengths.
    """
    assert shown <= rollup.total, (
        f"a detail projection showed {shown} items for a set of {rollup.total}"
    )
    return shown < rollup.total


# ---------------------------------------------------------------------------
# The stream — ONE progress transport for every origin
# ---------------------------------------------------------------------------
# Every origin's progress rides the durable log kit_stream provides: frames are
# appended by whoever advances the set, and a reader replays from a `seq` cursor —
# no DB poll and no per-connection "what did I already send" state. Frame payloads
# are the contract's; the SSE framing carries an `id:` line and NO `event:` line, so
# `onmessage` fires and `Last-Event-ID` resumes.


def set_channel(set_id: int) -> str:
    """The durable-log channel for one set. Must be a Postgres-safe identifier
    (``^[a-z_][a-z0-9_]{0,62}$``) — LISTEN/NOTIFY is one of the adapters."""
    return f"audit_set_{set_id}"


def _sse(payload: Mapping[str, Any], seq: int | None) -> str:
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    prefix = "" if seq is None else f"id: {seq}\n"
    return f"{prefix}data: {data}\n\n"


def _progress_frame(progress: SetProgress) -> dict[str, Any]:
    return contract.ScanProgressFrame(
        type="progress", status=progress.status, rollup=progress.rollup.as_wire()
    ).model_dump(mode="json", exclude_none=False)


def _dep_frame(state: ItemState) -> dict[str, Any]:
    return contract.ScanDepFrame(type="dep", item=state.as_wire()).model_dump(
        mode="json", exclude_none=False
    )


DONE_FRAME: dict[str, Any] = {"type": "done"}


# ---------------------------------------------------------------------------
# Creation + progress
# ---------------------------------------------------------------------------

# "How many cache misses is this set about to buy" -> raise CapExceededError, or
# meter them. Injected rather than branched: an origin nobody is billed for passes
# no-ops, so `create` has no `if origin ==` in it. The ordering `assert_budget`
# BEFORE any row is written is load-bearing — a refusal must create no set.
BudgetHook = Callable[[int], Awaitable[None]]


async def _no_budget(_count: int) -> None:
    return None


@dataclass(frozen=True, slots=True)
class AuditSetSpec:
    """Everything needed to persist one audit set. The ONLY per-origin inputs."""

    origin: str
    # The subject's id in the origin's namespace: repos.id | github_repo_id | ...
    origin_ref: int
    trigger: str
    # The discovered item list — the exact (name, version) pairs the set covers.
    items: list[LockfileDep]
    # The installation that pays for the set (None = nobody is billed).
    billed_to: int | None = None
    # The gh_user who asked for the set (None = nobody asked; push, reconcile,
    # watch, bench). Required for `public_repo_scan`, which after D-1 has a
    # requester and no payer — see the invariant in `create`.
    requested_by: int | None = None
    # The account login `panel_jobs.org` groups on for queue fairness. NOT a
    # billing field: money is metered by the budget hooks above.
    billed_org: str | None = None
    commit_sha: str | None = None
    check_run_id: int | None = None
    # At most this many cache MISSES may join the set; the rest are left out of
    # its coverage entirely. `None` = uncovered, which is what every billed origin
    # passes: a repo scan covers its repo or refuses (`assert_budget`), it never
    # half-covers it. Only the public scan degrades, because refusing a signed-in
    # stranger at the funnel's front door is worse than covering less and saying
    # so (see public_limits.py).
    #
    # Uncovered deps are NOT parked in the set as unenqueued items:
    # `item_outcome` maps "no verdict and no live job" to ERROR, so that would
    # report every one of them as an audit that was attempted and failed. What is
    # covered is the set; what the lockfile held is the caller's to record.
    max_new_audits: int | None = None
    assert_budget: BudgetHook = _no_budget
    consume_budget: BudgetHook = _no_budget


def dedupe(deps: Iterable[LockfileDep]) -> list[LockfileDep]:
    """Collapse duplicate ``(name, version)`` pairs — the item table is keyed on
    the pair, so a dup would collide on insert. The first occurrence (direct-
    classified if present) wins."""
    seen: dict[tuple[str, str], LockfileDep] = {}
    for dep in deps:
        seen.setdefault((dep.name, dep.version), dep)
    return list(seen.values())


@dataclass
class AuditSetStore:
    """Owns audit-set creation, progress finalization, rollups, and the stream.

    Collaborators are injected so every path is drivable without GitHub or docker.
    """

    sessions: async_sessionmaker
    verdicts: VerdictIndex
    queue: PanelJobQueue
    stream: StreamService
    notifier: EventNotifier
    # Called ONCE, on the single running -> done transition of a set that carries a
    # GitHub check run: (set_id, check_run_id, rollup). Injected so this module
    # stays GitHub-free; the wire stage binds it over the installation octokit.
    finalize_check: Callable[[int, int, Rollup], Awaitable[None]] | None = field(default=None)
    random_source: Callable[[], float] = random.random

    # -- creation ----------------------------------------------------------

    async def create(self, spec: AuditSetSpec) -> int:
        """Insert the set + its items, enqueue budget-checked cache misses, and
        publish the set's opening progress. Returns the set id."""
        # INVARIANT: every audit_sets row holds an origin that owns a set and a
        # trigger in the contract's domain. `raise`, not `assert`: this guards a DB
        # write of two enum columns that carry NO CHECK constraint, deliberately —
        # `dep_tree` and `bench_run` are designed-for-not-built, so the whole point
        # of R-1 is that a new origin costs one item-discovery function and no
        # schema change (see 0007's docstring for the per-column reasoning). With no
        # constraint behind them, an `assert` here would leave these columns
        # unguarded under `python -O`, which is the one configuration where a bad
        # row silently lands.
        if spec.origin not in SET_ORIGINS:
            raise AssertionError(
                f"{spec.origin!r} is not an origin that owns a set; expected one of "
                f"{sorted(SET_ORIGINS)}"
            )
        if spec.trigger not in TRIGGERS:
            raise AssertionError(f"{spec.trigger!r} is not an AuditSetTrigger")
        # INVARIANT: a public repo scan has a REQUESTER and no PAYER (D-1) — a
        # sign-in is required, an App installation is not, and no installation is
        # charged. Guarded here, not as a CHECK, for the same reason as the two
        # above: this table carries no enum constraints so that a new origin
        # costs no schema change. It is not decoration — `requested_by` is the
        # key column of `ix_audit_sets_active_public`, so a NULL slipping through
        # would silently void the "one live scan per (repo, user)" guarantee
        # rather than fail, and a non-NULL `billed_to` would re-attach the set to
        # an installation's CASCADE, letting an uninstall delete a user's scans.
        if spec.origin == ORIGIN_PUBLIC_REPO_SCAN and (
            spec.requested_by is None or spec.billed_to is not None
        ):
            raise AssertionError(
                "a public_repo_scan set needs requested_by and no billed_to; got "
                f"requested_by={spec.requested_by!r} billed_to={spec.billed_to!r}"
            )
        items = dedupe(spec.items)

        verdicts = await self.verdicts.get_many([(d.name, d.version) for d in items])
        misses = [d for d in items if (d.name, d.version) not in verdicts]

        if spec.max_new_audits is not None and len(misses) > spec.max_new_audits:
            # Cover what the budget buys, and drop the rest OUT of the set rather
            # than into it. Direct dependencies first, then by (name, version):
            # deterministic, so the same lockfile under the same budget covers the
            # same packages, and a snapshot stays reproducible.
            misses.sort(key=lambda d: (not d.direct, d.name, d.version))
            del misses[spec.max_new_audits :]
            covered = {(d.name, d.version) for d in misses} | set(verdicts)
            items = [d for d in items if (d.name, d.version) in covered]

        # Budget check BEFORE any row is written — a refusal creates no set.
        await spec.assert_budget(len(misses))

        now = now_iso()
        async with self.sessions() as session, session.begin():
            result = await session.execute(
                audit_sets.insert().values(
                    origin=spec.origin,
                    origin_ref=spec.origin_ref,
                    billed_to=spec.billed_to,
                    requested_by=spec.requested_by,
                    trigger_kind=spec.trigger,
                    commit_sha=spec.commit_sha,
                    check_run_id=spec.check_run_id,
                    started_at=now,
                )
            )
            set_id = int(result.inserted_primary_key[0])
            for dep in items:
                await session.execute(
                    audit_set_items.insert().values(
                        set_id=set_id,
                        name=dep.name,
                        version=dep.version,
                        direct=dep.direct,
                        range=dep.range,
                        cached=(dep.name, dep.version) in verdicts,
                    )
                )

        # TODO(R-2): the `public` lane. A public scan's jobs go into the same
        # queue as paid and panel work, which F-F6 says they must never starve.
        # That lane belongs to the ONE durable queue R-2 builds (lanes
        # paid|panel|watch|bench|public, with panel_jobs and the panel worker
        # pool deleted) — building it here would make this the repo's THIRD queue
        # implementation, the exact mistake R-1 was done to stop. `public` now has
        # a live caller. Until then the bound is admission-side: the per-user
        # budget in public_limits.py caps how much work one scan can enqueue.
        inserted = await self.queue.enqueue_many(
            [JobSpec(d.name, d.version, spec.billed_org, spec.origin) for d in misses]
        )
        # Charge only jobs actually inserted — a pair already queued by another set
        # is shared, not re-bought.
        await spec.consume_budget(inserted)

        # Publish the opening progress frame — and deliberately NOT a dep frame per
        # item. The log carries TRANSITIONS; a client's initial per-item state comes
        # from the detail route it has to fetch anyway (that is where the cap, the
        # ordering and the truncation flag live). Seeding N frames here would put a
        # 5000-INSERT transaction in front of the scan-trigger response for a
        # payload the client already has. A set with no work finalizes right here.
        await self.refresh(set_id)
        return set_id

    # -- progress ----------------------------------------------------------

    async def refresh(
        self, set_id: int, changed: Collection[tuple[str, str]] = ()
    ) -> None:
        """Recompute a live set's progress, publish it, and finalize when done.

        ``changed`` is the pairs whose state just moved, so a ``dep`` frame is
        appended for exactly those. A no-op on a set that is already finished — the
        ``finished_at IS NULL`` guard makes the finalize transition fire exactly
        once, which is what lets the GitHub check run be concluded a single time
        even though this is called on every worker settle.
        """
        to_conclude: tuple[int, int, Rollup] | None = None
        for attempt in range(_PUBLISH_RETRIES):
            try:
                to_conclude = await self._refresh_once(set_id, changed)
                break
            except Conflict:
                # Another settle is appending to this set's channel. Back off and
                # redo the whole unit of work: a failed append poisons the txn.
                await asyncio.sleep(
                    self.random_source() * _PUBLISH_RETRY_BASE_SECONDS * 2**attempt
                )
        else:
            log.warning("audit set progress publish contended out", set_id=set_id)
            return

        # Conclude the check run OUTSIDE the write txn (a network call), and only on
        # the single running -> done transition above.
        if to_conclude is not None and self.finalize_check is not None:
            await self.finalize_check(*to_conclude)

    async def _refresh_once(
        self, set_id: int, changed: Collection[tuple[str, str]]
    ) -> tuple[int, int, Rollup] | None:
        wanted = set(changed)
        async with self.sessions() as session, session.begin():
            row = (
                (
                    await session.execute(
                        sa.select(
                            audit_sets.c.finished_at, audit_sets.c.check_run_id
                        ).where(audit_sets.c.id == set_id)
                    )
                )
                .mappings()
                .first()
            )
            if row is None or row["finished_at"] is not None:
                return None

            channel = set_channel(set_id)
            states = await set_item_states(session, set_id)
            progress = compute_progress(rollup_items(states))
            for state in states:
                if (state.name, state.version) in wanted:
                    await self.stream.append(
                        channel, "dep", _dep_frame(state), session=session
                    )
            await self.stream.append(
                channel, "progress", _progress_frame(progress), session=session
            )
            if not progress.finished:
                return None

            result = await session.execute(
                audit_sets.update()
                .where(audit_sets.c.id == set_id, audit_sets.c.finished_at.is_(None))
                .values(finished_at=now_iso())
            )
            if result.rowcount != 1:
                # Lost the finalize race, and this is REACHABLE rather than a
                # violated invariant — the falsification pass earned this branch.
                # It looks unreachable because a competing refresher would collide
                # on the channel's next `seq` and roll back first; under Postgres
                # READ COMMITTED it does not. Each statement takes a fresh
                # snapshot, so a refresher can read `finished_at IS NULL`, then see
                # the winner's committed frame while allocating its own `seq`
                # (no collision), and only discover the loss here. Asserting would
                # have 500'd a live route on real concurrency.
                #
                # The winner published `done`-worthy progress and concluded the
                # check run; this transaction's own frames are still valid
                # snapshots, so it commits them and hands nothing back.
                return None
            if row["check_run_id"] is None:
                return None
            return (set_id, int(row["check_run_id"]), progress.rollup)

    async def refresh_touching(self, package_name: str, version: str) -> None:
        """Nudge every LIVE set covering ``(package_name, version)``.

        Cross-set job sharing makes this the only reliable completion signal: a job
        deduped across two sets belongs to neither, so "my job finished" is not a
        signal a set can own. Used as the panel worker's settle callback, for every
        origin at once.
        """
        async with self.sessions() as session:
            set_ids = (
                (
                    await session.execute(
                        sa.select(audit_sets.c.id)
                        .select_from(
                            audit_sets.join(
                                audit_set_items,
                                audit_set_items.c.set_id == audit_sets.c.id,
                            )
                        )
                        .where(
                            audit_sets.c.finished_at.is_(None),
                            audit_set_items.c.name == package_name,
                            audit_set_items.c.version == version,
                        )
                        .distinct()
                    )
                )
                .scalars()
                .all()
            )
        for set_id in set_ids:
            await self.refresh(set_id, changed=[(package_name, version)])

    async def refresh_live(self) -> int:
        """Boot recovery: refresh every set left live by a crashed process.

        Without this a set whose items have no job left — a lost enqueue batch, a
        process killed between the item insert and the enqueue — stays ``running``
        forever, its check run never concludes, and its stream never terminates.
        Refreshing finalizes it honestly: no verdict and no attempt left is ERROR,
        which is a visible coverage gap rather than a spinner waiting for a result
        nothing will produce.
        """
        async with self.sessions() as session:
            set_ids = (
                (
                    await session.execute(
                        sa.select(audit_sets.c.id).where(
                            audit_sets.c.finished_at.is_(None),
                            # Boot recovery exists for sets whose progress is
                            # PANEL-JOB driven: refresh() finalizes a set once no
                            # live job remains, which is how an orphaned scan gets
                            # closed after a restart. A bench_run's items go through
                            # the audit core's own admission path and never create a
                            # panel job, so it has no jobs to be orphaned FROM --
                            # sweeping it finalizes a run that is still going.
                            audit_sets.c.origin != ORIGIN_BENCH_RUN,
                        )
                    )
                )
                .scalars()
                .all()
            )
        for set_id in set_ids:
            await self.refresh(set_id)
        return len(set_ids)

    # -- the stream --------------------------------------------------------

    async def events(
        self, set_id: int, *, after: int = -1, heartbeat: float = 15.0
    ) -> AsyncIterator[str]:
        """SSE frames for one set: replay from ``after``, then follow live.

        Terminality is derived from the SET ROW, not from a stored terminal frame —
        so a set finished before this code existed (or one whose last publish was
        contended out) still terminates, and there is no exactly-once frame to get
        wrong. The final ``progress`` frame is recomputed here rather than read from
        the log for the same reason: the client's last view of the rollup is always
        the truth.
        """
        channel = set_channel(set_id)
        cursor = after
        last_emit = time.monotonic()
        async with self.notifier.subscribe(channel) as subscription:
            while True:
                # Liveness is sampled BEFORE the drain: everything committed before
                # a "finished" observation is already in the log, and a finished set
                # publishes nothing more — so draining after the check cannot race
                # past a frame.
                finished = await self._is_finished(set_id)
                if finished is None:
                    return  # the set was deleted (its installation was removed)
                # Shielded: a client disconnect cancelling us mid-query would
                # abandon the pooled connection un-checked-in.
                frames = await asyncio.shield(self.stream.read_after(channel, cursor))
                for envelope in frames:
                    cursor = envelope["seq"]
                    last_emit = time.monotonic()
                    yield _sse(envelope.get("data") or {}, envelope["seq"])
                if len(frames) >= READ_BATCH:
                    continue  # a full batch: more is pending, don't stall a heartbeat
                if finished:
                    async with self.sessions() as session:
                        rollup = await set_rollup(session, set_id)
                    # These two carry the LAST LOGGED seq (or no id at all when the
                    # log was empty): they are computed, not stored, so advancing
                    # the cursor past a frame that does not exist would make a
                    # reconnect skip real ones.
                    tail = cursor if cursor >= 0 else None
                    yield _sse(_progress_frame(SetProgress(rollup, "done")), tail)
                    yield _sse(DONE_FRAME, tail)
                    return
                await subscription.wait(heartbeat)
                if time.monotonic() - last_emit >= heartbeat:
                    last_emit = time.monotonic()
                    yield ": keep-alive\n\n"

    async def _is_finished(self, set_id: int) -> bool | None:
        """``True``/``False`` for a set that exists, ``None`` when it does not."""
        async with self.sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(audit_sets.c.finished_at).where(
                            audit_sets.c.id == set_id
                        )
                    )
                )
                .mappings()
                .first()
            )
        return None if row is None else row["finished_at"] is not None

    # -- lookups -----------------------------------------------------------

    async def live_set_id(self, origin: str, origin_ref: int) -> int | None:
        """The id of a still-live set for this subject, or ``None`` — the 409
        ``{scanId}`` a caller streams instead of starting a second one."""
        async with self.sessions() as session:
            return (
                await session.execute(
                    sa.select(audit_sets.c.id)
                    .where(
                        audit_sets.c.origin == origin,
                        audit_sets.c.origin_ref == origin_ref,
                        audit_sets.c.finished_at.is_(None),
                    )
                    .order_by(audit_sets.c.started_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()


async def latest_set_row(session: Any, origin: str, origin_ref: int) -> Any:
    """The subject's most recent set: the live one if any, else the newest.

    ``finished_at IS NULL`` sorts first so a live set always wins, which is what
    "the scan being shown" means on a repo detail page.
    """
    return (
        (
            await session.execute(
                sa.select(audit_sets)
                .where(
                    audit_sets.c.origin == origin, audit_sets.c.origin_ref == origin_ref
                )
                .order_by(
                    audit_sets.c.finished_at.is_(None).desc(),
                    audit_sets.c.started_at.desc(),
                )
                .limit(1)
            )
        )
        .mappings()
        .first()
    )


async def latest_set_rows(
    session: Any, origin: str, origin_refs: Collection[int]
) -> dict[int, Any]:
    """:func:`latest_set_row` for many subjects at once (``/panel/repos``)."""
    if not origin_refs:
        return {}
    rows = (
        (
            await session.execute(
                sa.select(audit_sets)
                .where(
                    audit_sets.c.origin == origin,
                    audit_sets.c.origin_ref.in_(origin_refs),
                )
                .order_by(
                    audit_sets.c.finished_at.is_(None).desc(),
                    audit_sets.c.started_at.desc(),
                )
            )
        )
        .mappings()
        .all()
    )
    latest: dict[int, Any] = {}
    for row in rows:
        latest.setdefault(row["origin_ref"], row)
    return latest


def build_store(
    sessions: async_sessionmaker,
    verdicts: VerdictIndex,
    queue: PanelJobQueue,
    stream: StreamService,
    notifier: EventNotifier,
    *,
    finalize_check: Callable[[int, int, Rollup], Awaitable[None]] | None = None,
) -> AuditSetStore:
    return AuditSetStore(
        sessions=sessions,
        verdicts=verdicts,
        queue=queue,
        stream=stream,
        notifier=notifier,
        finalize_check=finalize_check,
    )


def monthly_budget_hooks(
    caps: CapsStore, installation_id: int
) -> tuple[BudgetHook, BudgetHook]:
    """The ``monthly_audits`` budget, as the two hooks :class:`AuditSetSpec` wants.

    Named here rather than inlined at the two call sites so "who is billed" stays a
    one-line difference between origins.
    """

    async def assert_budget(count: int) -> None:
        await caps.assert_audit_budget(installation_id, count)

    async def consume_budget(count: int) -> None:
        await caps.consume_audit_budget(installation_id, count)

    return assert_budget, consume_budget


__all__ = [
    "MAX_DETAIL_ITEMS",
    "ORIGINS",
    "ORIGIN_BENCH_RUN",
    "ORIGIN_DEP_TREE",
    "ORIGIN_PUBLIC_REPO_SCAN",
    "ORIGIN_REPO_SCAN",
    "ORIGIN_WATCHLIST",
    "SET_ORIGINS",
    "TRIGGERS",
    "AuditSetSpec",
    "AuditSetStore",
    "BudgetHook",
    "ItemState",
    "Rollup",
    "RollupItem",
    "SetProgress",
    "build_store",
    "compute_progress",
    "compute_rollup",
    "dedupe",
    "job_state",
    "latest_set_row",
    "latest_set_rows",
    "monthly_budget_hooks",
    "rollup_items",
    "set_channel",
    "set_item_states",
    "set_rollup",
    "set_rollups",
    "set_wire",
    "truncated",
]

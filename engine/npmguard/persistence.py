from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy.engine import CursorResult, Result
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kit_spine import now_iso
from kit_spine.db import metadata

from .lanes import DEFAULT_LANE, LANES

# The dedupe index's predicate, shared with the migration that creates it so the
# declared schema and the migrated schema cannot drift.
_ACTIVE_DEDUPE_WHERE = "dedupe_key IS NOT NULL AND status IN ('queued', 'running')"


def _rowcount(result: Result[Any]) -> int:
    """How many rows a DML statement matched.

    ``execute`` is typed as returning a ``Result``; every UPDATE/DELETE actually
    returns a ``CursorResult``, which is the only kind that carries ``rowcount``.
    Asserting that here keeps the guarded-update invariants below reading as one
    comparison rather than one comparison plus a type apology.
    """
    assert isinstance(result, CursorResult)
    return result.rowcount


audit_sessions = sa.Table(
    "audit_sessions",
    metadata,
    sa.Column("audit_id", sa.String(36), primary_key=True),
    sa.Column("package_name", sa.String(214), nullable=False),
    sa.Column("requested_version", sa.String(128), nullable=True),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("package_path", sa.Text, nullable=True),
    # Where this audit's bytes came from. NULL means the registry — the only
    # source a public audit ever has. Set once at admission and never updated:
    # it is the durable record of a decision, so a row re-claimed after a
    # restart resolves the same way it would have the first time.
    sa.Column("local_path", sa.Text, nullable=True),
    sa.Column("file_contents", sa.JSON, nullable=True),
    sa.Column("report", sa.JSON, nullable=True),
    sa.Column("error", sa.Text, nullable=True),
    # The DURABLE work claim. `claimed_by` is the opaque id of the
    # service INCARNATION holding the row, `lease_expires_at` the instant that
    # claim goes stale. Together they replace what used to be a process-local
    # `dict[audit_id, Future]`: ownership is now a committed fact any process can
    # read, which is what makes an orphaned claim recoverable by someone other
    # than the process that made it.
    #
    # They are deliberately ORTHOGONAL to `status` rather than a new status value:
    # `status` is on the wire (contract `AuditStatus`), and the lease is not a
    # lifecycle stage a client has any business seeing. That orthogonality is also
    # what gives us the state `status='queued' AND claimed_by IS NOT NULL` — a row
    # claimed but not yet started — which shutdown must RELEASE rather than
    # terminalize (see AuditService.close).
    sa.Column("claimed_by", sa.String(64), nullable=True),
    sa.Column("lease_expires_at", sa.String(64), nullable=True),
    # The DISPATCH columns, lifted from `panel_jobs` so one queue
    # can serve every class of work. `lane` decides claim order, admission bound
    # and retry budget (npmguard/lanes.py); `org` is claim FAIRNESS and not a
    # billing field; `origin` is the AuditSetOrigin an alert needs; `attempts`
    # counts executions against the lane's budget; `dedupe_key` is set only by
    # work that SHOULD be shared between callers.
    sa.Column("lane", sa.String(16), nullable=False, server_default="paid"),
    sa.Column("org", sa.String(255), nullable=True),
    sa.Column("origin", sa.String(24), nullable=True),
    sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
    sa.Column("dedupe_key", sa.String(400), nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("updated_at", sa.String(64), nullable=False),
    sa.Index("ix_audit_sessions_status", "status"),
    # Covers both claim scans: claimable (status + lease) and orphan sweep.
    sa.Index("ix_audit_sessions_lease", "status", "lease_expires_at"),
    sa.Index("ix_audit_sessions_lane_claim", "lane", "status", "created_at"),
    # At most one ACTIVE row per dedupe_key — the durable backstop for the
    # cross-process race an enqueue-time pre-check SELECT cannot close. Partial on
    # BOTH engines (N-11): declared with only one `*_where`, the other engine gets
    # a FULL unique index, i.e. "at most one audit per package, ever".
    sa.Index(
        "ix_audit_sessions_active_dedupe",
        "dedupe_key",
        unique=True,
        sqlite_where=sa.text(_ACTIVE_DEDUPE_WHERE),
        postgresql_where=sa.text(_ACTIVE_DEDUPE_WHERE),
    ),
)


def lease_deadline(seconds: float) -> str:
    """An ISO instant `seconds` from now, in EXACTLY ``now_iso()``'s rendering.

    Lease expiry is compared LEXICOGRAPHICALLY in SQL (these are string columns,
    the convention throughout this schema), so the two formats must agree to the
    character. MEASURED, and it is not a theoretical hazard: `now_iso()` renders
    millisecond precision with a `Z` suffix, while a bare
    `datetime.isoformat()` renders microseconds with `+00:00` — and for two
    instants inside the SAME SECOND the bare form sorts BELOW the `Z` form
    (`'…079511+00:00' < '…079Z'`, because `ord('5') == 53 < ord('Z') == 90`).
    A lease minted in the default format would therefore read as ALREADY EXPIRED
    for the remainder of its first second, so every claim would be instantly
    stealable. Cross-second comparisons happen to work, which is exactly what
    would let this survive a casual test and fail under contention.
    """
    return (
        (datetime.now(UTC) + timedelta(seconds=seconds))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _lane_rank() -> sa.ColumnElement[int]:
    """The lane registry rendered as a CASE, so claim order IS lane policy.

    Ranking in SQL from the same table the service reads means a lane cannot be
    ordered one way by the queue and treated another way by admission. The ELSE
    sorts an unknown lane LAST rather than first: a row written by code newer than
    this deployment must not preempt paid work.
    """
    return sa.case(
        {name: lane.rank for name, lane in LANES.items()},
        value=audit_sessions.c.lane,
        else_=max(lane.rank for lane in LANES.values()) + 1,
    )


def _lease_dead(now: str) -> sa.ColumnElement[bool]:
    """No LIVE claim covers this row: unclaimed, or claimed with a lapsed lease.

    A claim with a NULL expiry counts as dead. No writer produces that pair
    (both columns are always written together), but a claim that can never
    expire is not a claim — it is a row nothing will ever pick up again.
    """
    return sa.or_(
        audit_sessions.c.claimed_by.is_(None),
        audit_sessions.c.lease_expires_at.is_(None),
        audit_sessions.c.lease_expires_at < now,
    )


def _claimable(now: str) -> sa.ColumnElement[bool]:
    """A queued row no live claim covers — the candidate set for ``claim_next``.

    ``_not_demo()`` is LOAD-BEARING here and is not inherited boilerplate. A demo
    replay row is created ``queued`` and STAYS ``queued`` for its entire life
    (``DemoService.start`` -> ``_replay`` -> ``finalize``; it never calls
    ``mark_running``), so the moment the wait queue became "whatever SQL says is
    queued", every live demo replay became a claim candidate that a worker would
    then run the REAL pipeline on. MEASURED at 071b9a9: an unfiltered
    ``SELECT ... WHERE status='queued'`` returns the demo row. The old in-memory
    queue excluded demo rows for free, because nothing ever enqueued them; a
    durable queue has to say so.

    The predicate is ``_not_demo()`` — the ``package_path`` tag — and NOT
    ``file_contents IS NULL``, which is what this filter was written as when the
    surrounding code still keyed the demo exclusion on that column. Two reasons
    the tag is the correct one, and the second is a live defect rather than a
    consistency preference: (a) ``running()``/``queued()``/``queued_count()`` all
    key on the tag, and a claim scan that disagreed with the admission count about
    what a demo row is would put the bound and the queue out of step; (b)
    ``file_contents`` is set on REAL audits too — ``_execute`` calls
    ``set_file_contents`` for any audit whose result carries sources, just before
    the terminal transaction — so ``file_contents IS NULL`` silently excludes a
    genuine audit from ``orphaned_running`` for exactly the window in which it is
    most likely to be orphaned.
    """
    return sa.and_(
        audit_sessions.c.status == "queued",
        _not_demo(),
        _lease_dead(now),
    )


payment_claims = sa.Table(
    "payment_claims",
    metadata,
    sa.Column("provider", sa.String(32), primary_key=True),
    sa.Column("payment_key", sa.String(128), primary_key=True),
    sa.Column("audit_id", sa.String(36), sa.ForeignKey("audit_sessions.audit_id"), nullable=False),
    sa.Column("package_name", sa.String(214), nullable=False),
    sa.Column("version", sa.String(128), nullable=False),
    sa.Column("requester", sa.String(128), nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
)


DEMO_PACKAGE_PATH = "__demo__"


def _not_demo() -> sa.ColumnElement[bool]:
    """Excludes demo replays from running() / queued() / queued_count(): they are
    driven by DemoService, so restart recovery must not 0031 or re-run them.

    The IS NULL arm is required, not defensive — `package_path` is NULL until
    resolve fills it in, and SQL `col != 'x'` is NULL for a NULL column, which
    would hide every freshly-queued audit.
    """
    return sa.or_(
        audit_sessions.c.package_path.is_(None),
        audit_sessions.c.package_path != DEMO_PACKAGE_PATH,
    )


def dedupe_key(package_name: str, version: str | None) -> str:
    """The sharing key for one ``(package, version)``.

    One spelling, in one place, because the whole guarantee rests on two enqueues
    for the same pair producing byte-identical strings — a second spelling
    elsewhere would silently mean "never shares", and the symptom is a duplicate
    audit rather than an error. ``None`` is distinct from every concrete version:
    "whatever is latest" is not the same request as a pin, and resolving it may
    land anywhere.
    """
    return f"{package_name}@{version if version is not None else ''}"


@dataclass(frozen=True)
class EnqueueSpec:
    """One row to create, for a caller enqueueing a BATCH.

    ``dedupe_key`` present means "share this work with anyone already doing it";
    absent means "this caller gets its own audit". A repo scan sets it (300 deps
    across two sets are one audit each, not two), a paid audit never does.
    """

    package_name: str
    version: str | None
    lane: str
    org: str | None = None
    origin: str | None = None
    dedupe_key: str | None = None


@dataclass(frozen=True)
class AuditSession:
    audit_id: str
    package_name: str
    requested_version: str | None
    status: Literal["queued", "running", "done", "error"]
    package_path: str | None
    local_path: str | None
    file_contents: dict[str, str] | None
    report: dict[str, Any] | None
    error: str | None
    claimed_by: str | None
    lease_expires_at: str | None
    lane: str
    org: str | None
    origin: str | None
    attempts: int
    dedupe_key: str | None
    created_at: str
    updated_at: str


def _session(row: sa.RowMapping) -> AuditSession:
    return AuditSession(**{key: row[key] for key in AuditSession.__dataclass_fields__})


class AuditSessionStore:
    def __init__(self, sessions: async_sessionmaker) -> None:
        self._sessions = sessions

    async def create(
        self,
        package_name: str,
        version: str | None = None,
        *,
        file_contents: dict[str, str] | None = None,
        package_path: str | None = None,
        local_path: str | None = None,
        lane: str = DEFAULT_LANE,
        org: str | None = None,
        origin: str | None = None,
        dedupe_key: str | None = None,
    ) -> AuditSession:
        # Rows are born 'queued'. The wait-queue bound (queued_count vs queue_size)
        # is enforced by AuditService.reserve() BEFORE create/claim — there is no
        # DB running-count cap here anymore. `file_contents`/`package_path` let the
        # demo path create its tagged row atomically (package_path == DEMO_PACKAGE_PATH
        # is the demo tag; real audits fill package_path in from resolve).
        now = now_iso()
        audit_id = str(uuid4())
        values: dict[str, Any] = dict(
            audit_id=audit_id,
            package_name=package_name,
            requested_version=version,
            status="queued",
            lane=lane,
            org=org,
            origin=origin,
            attempts=0,
            dedupe_key=dedupe_key,
            created_at=now,
            updated_at=now,
        )
        # Only set file_contents/package_path when provided. The JSON column
        # renders an explicit Python None as JSON 'null' rather than SQL NULL, and
        # `api.audit_file` branches on `file_contents is not None` to decide between
        # the stored sources and the on-disk package — so omit them to keep SQL NULL.
        if file_contents is not None:
            values["file_contents"] = file_contents
        if package_path is not None:
            values["package_path"] = package_path
        if local_path is not None:
            values["local_path"] = local_path
        async with self._sessions() as session, session.begin():
            await session.execute(audit_sessions.insert().values(**values))
        result = await self.get(audit_id)
        assert result is not None
        return result

    async def get(self, audit_id: str) -> AuditSession | None:
        async with self._sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(audit_sessions).where(audit_sessions.c.audit_id == audit_id)
                    )
                )
                .mappings()
                .one_or_none()
            )
        return _session(row) if row is not None else None

    async def running(self) -> list[AuditSession]:
        # Excludes demo replays (see _not_demo): those are driven by DemoService,
        # never by AuditService, and must not be swept into 0031 restart recovery.
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    sa.select(audit_sessions).where(
                        audit_sessions.c.status == "running",
                        _not_demo(),
                    )
                )
            ).mappings()
            return [_session(row) for row in rows]

    async def queued(self) -> list[AuditSession]:
        # Durable wait-queue rows (excludes demo). Restart recovery re-enqueues
        # these rather than erroring them — a claimed paid audit is never dropped.
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    sa.select(audit_sessions).where(
                        audit_sessions.c.status == "queued",
                        _not_demo(),
                    )
                )
            ).mappings()
            return [_session(row) for row in rows]

    async def queued_count(self, lane: str | None = None) -> int:
        """Queued rows, optionally in ONE lane — the admission bound's denominator.

        Demo rows are excluded so a running demo never eats a real audit's queue
        slot. ``lane`` narrows it because the bound is per-lane
        (``AuditService.reserve``): the unbounded scan lanes are the durable buffer
        that a repo scan of 300 deps enqueues into all at once, and counting their
        rows against a paid caller's bound would refuse the paying customer on
        behalf of a background scan.
        """
        conditions = [audit_sessions.c.status == "queued", _not_demo()]
        if lane is not None:
            conditions.append(audit_sessions.c.lane == lane)
        async with self._sessions() as session:
            return (
                await session.execute(
                    sa.select(sa.func.count()).select_from(audit_sessions).where(*conditions)
                )
            ).scalar_one()

    async def replayable(self) -> list[AuditSession]:
        """Every finished audit, newest first — the replay gallery's whole source.

        There is no recorded/not-recorded distinction to filter on: `/audit/{id}/events`
        replays any terminal session straight off `stream_events`, so an audit that
        reached a report IS a replay. Demo rows are excluded (see _not_demo) because
        they are the committed-recording lineage and already have their own entry.

        `report.isnot(None)` rather than status alone: a gallery row promises a
        conclusion, and an errored audit has none.
        """
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    sa.select(audit_sessions)
                    .where(
                        audit_sessions.c.status == "done",
                        audit_sessions.c.report.isnot(None),
                        _not_demo(),
                    )
                    .order_by(audit_sessions.c.created_at.desc())
                )
            ).mappings()
            return [_session(row) for row in rows]

    async def create_deduped(self, specs: list[EnqueueSpec]) -> list[AuditSession]:
        """Insert one row per spec, SKIPPING any whose dedupe_key is already
        active. Returns the rows actually created — which is the budget to charge.

        Lifted from ``PanelJobQueue.enqueue_many``, semantics intact: the
        pre-check ``SELECT`` runs inside the enqueue transaction so a duplicate
        earlier in the SAME batch is caught too (a repo's lockfile can name one
        package at one version twice), and the partial-unique index is the durable
        backstop for the cross-process race the pre-check cannot close.

        A spec with no ``dedupe_key`` is never deduped: sharing is opt-in, because
        two sets needing one pair should share an audit and two PAYERS must not.
        """
        if not specs:
            return []
        created: list[str] = []
        now = now_iso()
        async with self._sessions() as session, session.begin():
            for spec in specs:
                if spec.dedupe_key is not None:
                    active = (
                        await session.execute(
                            sa.select(audit_sessions.c.audit_id)
                            .where(
                                audit_sessions.c.dedupe_key == spec.dedupe_key,
                                audit_sessions.c.status.in_(("queued", "running")),
                            )
                            .limit(1)
                        )
                    ).first()
                    if active is not None:
                        continue
                audit_id = str(uuid4())
                await session.execute(
                    audit_sessions.insert().values(
                        audit_id=audit_id,
                        package_name=spec.package_name,
                        requested_version=spec.version,
                        status="queued",
                        lane=spec.lane,
                        org=spec.org,
                        origin=spec.origin,
                        attempts=0,
                        dedupe_key=spec.dedupe_key,
                        created_at=now,
                        updated_at=now,
                    )
                )
                created.append(audit_id)
        # Read the rows back AFTER the enqueue transaction commits, so a caller
        # that submits them cannot hand a worker an audit_id no other connection
        # can see yet.
        rows = [await self.get(audit_id) for audit_id in created]
        assert all(row is not None for row in rows), "a just-inserted row is missing"
        return [row for row in rows if row is not None]

    async def retry(self, audit_id: str, owner: str, error: str) -> bool:
        """Send a failed row BACK to the queue instead of terminalizing it.

        Returns whether this call performed the transition. Guarded on the row
        still being ``running`` and still ours, so a row that a reclaimer or a
        shutdown already finalized is left alone (rowcount 0, reported not
        asserted).

        `created_at` is bumped so the retry goes to the BACK of its lane, exactly
        as ``PanelJobQueue.fail`` did — a payload that fails fast must not spin at
        the head of the queue ahead of work that would succeed. The claim is
        released in the same statement: we are no longer executing it, and holding
        a claim over a queued row we have abandoned would keep it unclaimable for
        a whole TTL.

        `error` is recorded so the reason survives into the next attempt, but the
        status stays non-terminal and NO terminal event is appended — a retry is
        not something a consumer of the audit's event stream may see as an
        ending. That ordering matters: `verdict_reached`/`audit_error` are the
        stream's terminal frames and readers stop at the first one, so emitting
        one here and then continuing to work would strand every follower.
        """
        statement = (
            audit_sessions.update()
            .where(
                audit_sessions.c.audit_id == audit_id,
                audit_sessions.c.claimed_by == owner,
                audit_sessions.c.status == "running",
            )
            .values(
                status="queued",
                attempts=audit_sessions.c.attempts + 1,
                error=error,
                claimed_by=None,
                lease_expires_at=None,
                created_at=now_iso(),
                updated_at=now_iso(),
            )
        )
        async with self._sessions() as session, session.begin():
            return _rowcount(await session.execute(statement)) == 1

    # ----------------------------------------------------------------- claims
    # The durable work claim. These six methods ARE the ownership primitive —
    # AuditService keeps no ownership state of its own, so "who will finalize
    # this row" is answerable by any process with the connection string.

    async def claim_next(self, owner: str, *, ttl_seconds: float) -> AuditSession | None:
        """Atomically take ownership of the oldest claimable queued row.

        ``None`` means "no work for me right now" — either nothing is claimable
        or the guarded claim was lost to a concurrent claimer. Neither is an
        error, which is why this returns an Optional and asserts nothing; it is
        the same contract as ``PanelJobQueue.claim_next``, the pattern that has
        been multi-process safe in this codebase all along.

        ``with_for_update(skip_locked=True)`` renders ``FOR UPDATE SKIP LOCKED``
        on postgres — concurrent claimers never even consider the same candidate
        — and is silently omitted on sqlite, which serializes writers anyway.
        The guarded UPDATE is what makes the sqlite path correct, and a second
        line of defence on postgres.

        ORDER: lane rank, then org fairness, then FIFO. Both leading terms are
        lifted from `PanelJobQueue.claim_next` because the fold has to preserve
        what they bought — lane rank is what stops a 300-dep repo scan from
        sitting in front of a paid audit, and org fairness (fewest rows currently
        running for that org, NULL-safe) is what stops one big install starving
        every other. `_lane_rank()` renders the registry as a CASE so the ordering
        cannot disagree with the policy the rest of the code reads.
        """
        now = now_iso()
        expires = lease_deadline(ttl_seconds)
        peer = audit_sessions.alias("peer")
        running_for_org = (
            sa.select(sa.func.count())
            .select_from(peer)
            .where(
                peer.c.status == "running",
                peer.c.org.is_not_distinct_from(audit_sessions.c.org),
            )
            .scalar_subquery()
        )
        async with self._sessions() as session, session.begin():
            row = (
                (
                    await session.execute(
                        sa.select(audit_sessions)
                        .where(_claimable(now))
                        # Lane, then fairness, then FIFO with a STABLE tiebreak.
                        # `created_at` alone leaves the order undefined between
                        # rows born in the same millisecond, and those are not
                        # rare: now_iso() is millisecond precision and two
                        # successive calls measurably return the identical string.
                        .order_by(
                            _lane_rank(),
                            running_for_org,
                            audit_sessions.c.created_at,
                            audit_sessions.c.audit_id,
                        )
                        .limit(1)
                        .with_for_update(skip_locked=True)
                    )
                )
                .mappings()
                .first()
            )
            if row is None:
                return None
            rowcount = _rowcount(
                await session.execute(
                    audit_sessions.update()
                    .where(audit_sessions.c.audit_id == row["audit_id"], _claimable(now))
                    .values(claimed_by=owner, lease_expires_at=expires, updated_at=now)
                )
            )
            if rowcount != 1:
                return None  # lost the guarded claim; another claimer owns it
        return replace(
            _session(row), claimed_by=owner, lease_expires_at=expires, updated_at=now
        )

    async def renew_leases(self, owner: str, *, ttl_seconds: float) -> int:
        """Push every claim this owner holds out by a fresh TTL; returns how many.

        One statement and no in-memory list of what we own — the set of leases a
        process holds is a QUERY. That is the point of moving ownership into SQL:
        a heartbeat cannot drift out of agreement with the claims it renews.

        Deliberately does NOT touch ``updated_at``. A heartbeat is not progress
        on the audit, and bumping the column every interval would destroy its
        only useful reading ("when did this row last actually change").
        """
        statement = (
            audit_sessions.update()
            .where(
                audit_sessions.c.claimed_by == owner,
                audit_sessions.c.status.in_(("queued", "running")),
            )
            .values(lease_expires_at=lease_deadline(ttl_seconds))
        )
        async with self._sessions() as session, session.begin():
            return _rowcount(await session.execute(statement))

    async def release_lease(self, audit_id: str, owner: str) -> bool:
        """Drop this owner's claim on a row WITHOUT touching its status.

        Owner-guarded, so it can never release a claim someone else holds. A
        rowcount of 0 is NORMAL — the row may already have been finalized, which
        clears the lease inside the same transaction — so this reports rather
        than asserts.
        """
        statement = (
            audit_sessions.update()
            .where(
                audit_sessions.c.audit_id == audit_id,
                audit_sessions.c.claimed_by == owner,
            )
            .values(claimed_by=None, lease_expires_at=None, updated_at=now_iso())
        )
        async with self._sessions() as session, session.begin():
            return _rowcount(await session.execute(statement)) == 1

    async def leased_by(self, owner: str) -> list[AuditSession]:
        """Every non-terminal row this owner still claims — exactly what
        ``AuditService.close`` has to dispose of before it returns."""
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    sa.select(audit_sessions).where(
                        audit_sessions.c.claimed_by == owner,
                        audit_sessions.c.status.in_(("queued", "running")),
                    )
                )
            ).mappings()
            return [_session(row) for row in rows]

    async def orphaned_running(
        self, *, exclude_owner: str | None = None
    ) -> list[AuditSession]:
        """``running`` rows that no LIVE claim covers — their owner died mid-run.

        A lease that has not expired is excluded whether it is ours or another
        node's, so a reclaimer can never take work somebody is still doing.

        ``exclude_owner`` drops rows a given incarnation claims even if that
        claim has LAPSED, and a periodic sweeper must pass its own id. A lapsed
        self-claim means our heartbeat starved (a blocked event loop, an
        unreachable database) while a worker of ours may still be executing the
        row — terminalizing it there is how a sweep turns a slow audit into
        ``finalize: matched 0 non-terminal rows`` inside our own ``_execute``.
        Our own orphans are repaired at boot instead, where a fresh incarnation
        id makes "claimed by me" impossible by construction.
        """
        now = now_iso()
        conditions = [
            audit_sessions.c.status == "running",
            _not_demo(),
            _lease_dead(now),
        ]
        if exclude_owner is not None:
            conditions.append(
                sa.or_(
                    audit_sessions.c.claimed_by.is_(None),
                    audit_sessions.c.claimed_by != exclude_owner,
                )
            )
        async with self._sessions() as session:
            rows = (
                await session.execute(sa.select(audit_sessions).where(*conditions))
            ).mappings()
            return [_session(row) for row in rows]

    async def queue_position(self, audit_id: str, created_at: str) -> int:
        """1-based position among durable queued rows, ordered exactly as
        ``claim_next`` orders them (created_at, then audit_id — the tiebreak is
        needed because millisecond ties are common).

        Replaces the old ``asyncio.Queue.qsize()``: the wait queue is now the set
        of queued rows, so its length is a count and a position is a ranked
        count. 0 means the row is no longer queued, i.e. it has already started.
        """
        async with self._sessions() as session:
            return (
                await session.execute(
                    sa.select(sa.func.count())
                    .select_from(audit_sessions)
                    .where(
                        audit_sessions.c.status == "queued",
                        _not_demo(),
                        sa.or_(
                            audit_sessions.c.created_at < created_at,
                            sa.and_(
                                audit_sessions.c.created_at == created_at,
                                audit_sessions.c.audit_id <= audit_id,
                            ),
                        ),
                    )
                )
            ).scalar_one()

    async def mark_running(self, audit_id: str) -> bool:
        # Guarded queued->running transition. Returns whether THIS call won it.
        # A rowcount of 0 means the row was closed/reset/already-running between
        # dequeue and here — the worker must skip it, so this is NOT an assert.
        statement = (
            audit_sessions.update()
            .where(
                audit_sessions.c.audit_id == audit_id,
                audit_sessions.c.status == "queued",
            )
            .values(status="running", updated_at=now_iso())
        )
        async with self._sessions() as session, session.begin():
            rowcount = _rowcount(await session.execute(statement))
        return rowcount == 1

    async def reset_to_queued(self, audit_id: str) -> None:
        # Guarded error->queued transition, clearing the terminal payload. Makes a
        # claimed-but-errored paid audit genuinely retryable (submit re-runs it).
        statement = (
            audit_sessions.update()
            .where(
                audit_sessions.c.audit_id == audit_id,
                audit_sessions.c.status == "error",
            )
            .values(status="queued", error=None, report=None, updated_at=now_iso())
        )
        async with self._sessions() as session, session.begin():
            rowcount = _rowcount(await session.execute(statement))
        assert rowcount == 1, (
            f"reset_to_queued({audit_id}): matched {rowcount} error rows "
            "(row missing or not in error state)"
        )

    async def set_package_path(self, audit_id: str, path: str) -> None:
        await self._update(audit_id, package_path=path)

    async def set_file_contents(self, audit_id: str, files: dict[str, str]) -> None:
        # Must not touch package_path — that would tag a real audit as a demo replay.
        await self._update(audit_id, file_contents=files)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[AsyncSession]:
        """One open transaction for composing a session-row write with another
        store's write (e.g. kit_stream append(session=...)) so both commit —
        or roll back — together."""
        async with self._sessions() as session, session.begin():
            yield session

    async def finalize(
        self,
        audit_id: str,
        report: dict[str, Any] | None,
        error: str | None = None,
        *,
        session: AsyncSession | None = None,
    ) -> None:
        statement = (
            audit_sessions.update()
            .where(
                audit_sessions.c.audit_id == audit_id,
                audit_sessions.c.status.in_(("queued", "running")),
            )
            .values(
                report=report,
                error=error,
                status="error" if error else "done",
                # INVARIANT: the claim is released BY the terminal transition, in
                # the SAME statement — never by a follow-up write. A terminal row
                # therefore never carries a claim, so no reclaimer can pick it up
                # and no shutdown has to unwind it.
                #
                # This is the whole reason it lives here rather than in the
                # caller. The path from this commit to `fut.set_result()` contains
                # NO suspension point, and that is the only thing making "a
                # completed audit whose caller is told it was interrupted"
                # unreachable. MEASURED at 071b9a9: injecting ONE `await` after
                # this commit — exactly what `await release_lease(...)` would be —
                # produced a `done` row with a durable `verdict_reached` whose
                # future raised AuditIncompleteError('shutdown'). Releasing the
                # claim here costs zero new awaits.
                claimed_by=None,
                lease_expires_at=None,
                updated_at=now_iso(),
            )
        )
        if session is not None:
            rowcount = _rowcount(await session.execute(statement))
        else:
            async with self._sessions() as own, own.begin():
                rowcount = _rowcount(await own.execute(statement))
        # INVARIANT: finalize transitions exactly one non-terminal (queued|running)
        # row -> done|error. A missing or already-terminal row is a lifecycle bug —
        # raise loudly, never a silent no-op or a done->error overwrite. The guard
        # includes 'queued' so close/recovery can finalize a never-run queued row.
        assert rowcount == 1, (
            f"finalize({audit_id}): matched {rowcount} non-terminal rows "
            "(row missing or already terminal)"
        )

    async def _update(self, audit_id: str, **values: Any) -> None:
        values["updated_at"] = now_iso()
        async with self._sessions() as session, session.begin():
            await session.execute(
                audit_sessions.update()
                .where(audit_sessions.c.audit_id == audit_id)
                .values(**values)
            )

    async def payment(self, provider: str, key: str) -> dict[str, Any] | None:
        async with self._sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(payment_claims).where(
                            payment_claims.c.provider == provider,
                            payment_claims.c.payment_key == key,
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
        return dict(row) if row is not None else None

    async def claim_payment(
        self,
        provider: str,
        key: str,
        package_name: str,
        version: str,
        requester: str | None = None,
    ) -> tuple[AuditSession, bool]:
        """Atomically bind a payment proof to exactly one audit session."""
        now = now_iso()
        audit_id = str(uuid4())
        try:
            async with self._sessions() as session, session.begin():
                await session.execute(
                    audit_sessions.insert().values(
                        audit_id=audit_id,
                        package_name=package_name,
                        requested_version=version,
                        status="queued",
                        created_at=now,
                        updated_at=now,
                    )
                )
                await session.execute(
                    payment_claims.insert().values(
                        provider=provider,
                        payment_key=key,
                        audit_id=audit_id,
                        package_name=package_name,
                        version=version,
                        requester=requester,
                        created_at=now,
                    )
                )
        except IntegrityError:
            existing = await self.payment(provider, key)
            if existing is None:
                raise
            claimed = await self.get(existing["audit_id"])
            assert claimed is not None
            return claimed, False
        claimed = await self.get(audit_id)
        assert claimed is not None
        return claimed, True

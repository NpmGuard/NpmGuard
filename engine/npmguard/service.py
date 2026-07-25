from __future__ import annotations

import asyncio
import contextlib
import os
import socket
from dataclasses import dataclass, replace
from typing import Any
from uuid import uuid4

import structlog

from kit_spine import now_iso
from kit_stream import StreamService

from .errors import AuditIncompleteError, NpmGuardError, QueueFullError
from .events import AuditEmitter, audit_channel
from .persistence import AuditSession, AuditSessionStore
from .pipeline import AuditPipeline
from .report_store import UnversionedReportError, save_report

log = structlog.get_logger("npmguard.audit")

CLOSE_DEADLINE_SECONDS = 10.0

# The claim TTL must EXCEED the whole shutdown budget, because that budget is
# ADDITIVE and this node keeps working through it. Measured (§4.4), SIGTERM to
# exit: 0.10s uvicorn pre-drain + up to the FULL --timeout-graceful-shutdown for
# connection drain (2.00s measured with a client still connected) + only THEN the
# lifespan shutdown, i.e. audits.close(shutdown_deadline_seconds), default 10.0s
# + 0.22s dispose. Worst case ~12.3s with the shipped defaults. If a claim could
# lapse inside that window, a reclaimer would pick up work this node is still
# finalizing — a genuine double execution, and one a process-local ownership map
# structurally could not have had. 120s leaves ~10x headroom over the default and
# ~4x over a deployment that raised the close deadline to 30s.
LEASE_TTL_SECONDS = 120.0
# TTL/4: three consecutive renewals may be lost before a live claim looks dead.
LEASE_HEARTBEAT_SECONDS = 30.0
# The claim poll is only the FALLBACK path. In-process submits wake a parked
# worker immediately (``_wake``), so this bounds latency solely for work this
# process did not create: a row left queued by a previous incarnation, or (once
# there is more than one node) a row another node enqueued.
CLAIM_POLL_SECONDS = 1.0
# The orphan sweep. Repair latency for a crashed owner's row is at most the TTL
# (when its claim lapses) plus one of these, which is what lets startup recovery
# key on the CLAIM instead of on `status` alone — see `_recover`.
RECLAIM_SWEEP_SECONDS = 30.0
# How long close() lets the background loops notice `_halt` and exit at a
# no-resources boundary before cancelling them. They only ever wait on an event or
# run one short statement, so this is generous; it exists so the cancel is a
# backstop rather than the mechanism (N-10).
BACKGROUND_HALT_SECONDS = 2.0


def _instance_id() -> str:
    """An id for THIS incarnation of the process, not for the host or the PID.

    The random suffix is load-bearing. Claim recovery rests on "a claim stamped
    by someone who is not me is a claim I may reclaim", and a restarted process
    that reused a PID on the same host would otherwise be mistaken for its own
    predecessor — so it would decline to recover the very rows it must recover.
    """
    return f"{socket.gethostname()[:24]}:{os.getpid()}:{uuid4().hex[:8]}"


def _claimant_is_locally_dead(claimed_by: str) -> bool:
    """True when the claim names a process ON THIS HOST that no longer exists.

    The lease answers "is this claim stale?" everywhere, but slowly — it cannot
    say anything until the TTL elapses. On the machine that minted the claim the
    same question has an immediate and exact answer, because the id carries the
    pid: ask the kernel. That is what lets boot recovery repair a SIGKILLed
    predecessor's audits the instant the engine comes back, instead of leaving a
    paid audit ``running`` (and its SSE client waiting) for a further TTL.

    Answers False for every claim it cannot decide — a different host, an
    unparseable id, or a pid that still exists. The fallback is always the lease,
    so the cost of an undecidable claim is latency, never a wrong reclaim.

    PID REUSE cuts the safe way here. If an unrelated process has taken the dead
    engine's pid we answer "alive" and defer to the lease, which is a slow repair
    of a row that needed repairing. The dangerous inverse — calling a LIVE engine
    dead — needs its pid to have vanished while it is still executing, which is
    not a state a running process can be in.
    """
    host, _, rest = claimed_by.partition(":")
    pid_text, _, _ = rest.partition(":")
    if host != socket.gethostname()[:24] or not pid_text.isdigit():
        return False  # not ours to judge — the lease decides
    try:
        os.kill(int(pid_text), 0)
    except ProcessLookupError:
        return True  # the claimant is gone
    except PermissionError:
        return False  # exists, owned by another user
    return False


@dataclass(frozen=True)
class SubmitResult:
    audit_id: str
    queue_position: int
    future: asyncio.Future[dict[str, Any]]
    created: bool


class AuditService:
    """Sole owner of audit execution, where ownership is a DURABLE CLAIM.

    Every session-creation path funnels through ``submit`` (directly or via
    ``admit``). Admission is bounded by ``reserve`` on the durable ``queued``
    count (``queue_size``); execution is bounded by a fixed pool of
    ``max_concurrent`` workers, each holding at most one claim.

    **The wait queue is the set of ``queued`` rows.** There is no in-memory queue
    and no in-memory ownership map. A worker takes work with ``claim_next``,
    which stamps ``claimed_by``/``lease_expires_at`` on the row; a single
    heartbeat renews every claim this instance holds; ``finalize`` releases the
    claim in the same statement that makes the row terminal. So:

        status == 'running'   =>  some incarnation claimed this row and is
                                  responsible for finalizing it
        its claim has lapsed  =>  that incarnation is gone, and the row is
                                  recoverable BY SOMEONE OTHER THAN IT

    The second line is what a ``dict[str, Future]`` could not express. It made
    "an owned worker task will finalize this row" mean owned *by this process*,
    so the single-capacity-owner invariant was really a single-PROCESS
    invariant, and a dead process's rows could only ever be repaired by its own
    successor (AUDIT_CORE_EXPLAINED §4.6 enumerates the consequences).

    ``_waiters`` is what remains of ``_pending``, and it is **not ownership**: it
    maps audit_id to the future a caller *in this process* is awaiting. A future
    cannot be a durable fact, so this map cannot disappear — but it no longer
    decides who executes anything. It has exactly two jobs: hand the same future
    to a duplicate ``submit`` (the webhook-vs-stream and double-paid-replay
    races), and guarantee ``close`` leaves no caller hanging.

    STILL ONE NODE. Shared report storage, a node registry and work stealing are
    out of scope. What is in scope is that the *interface* is now the durable
    one, because retrofitting ownership out of a process-local dict later is a
    rewrite — and that every path which decides an audit is abandoned now decides
    it from the claim (``_claim_is_dead``), so adding a second node changes the
    deployment, not this class.
    """

    def __init__(
        self,
        pipeline: AuditPipeline,
        sessions: AuditSessionStore,
        stream: StreamService,
        *,
        queue_size: int = 50,
        max_concurrent: int | None = None,
        lease_ttl_seconds: float = LEASE_TTL_SECONDS,
        heartbeat_seconds: float = LEASE_HEARTBEAT_SECONDS,
        claim_poll_seconds: float = CLAIM_POLL_SECONDS,
        reclaim_sweep_seconds: float = RECLAIM_SWEEP_SECONDS,
        instance_id: str | None = None,
    ) -> None:
        self.pipeline = pipeline
        self.sessions = sessions
        self.stream = stream
        self.queue_size = queue_size
        self.max_concurrent = max_concurrent or 1
        self.lease_ttl_seconds = lease_ttl_seconds
        self.heartbeat_seconds = heartbeat_seconds
        self.claim_poll_seconds = claim_poll_seconds
        self.reclaim_sweep_seconds = reclaim_sweep_seconds
        self.instance_id = instance_id or _instance_id()
        # NOT an ownership map — see the class docstring. Local result-waiters
        # only: audit_id -> the future a caller in THIS process awaits.
        self._waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._workers: list[asyncio.Task[None]] = []
        # The lease heartbeat and the orphan sweep. Both outlive the pool by one
        # step at shutdown (close step 3 explains why), so they are tracked apart
        # from the workers rather than alongside them.
        self._background: list[asyncio.Task[None]] = []
        # Two stop signals, one per phase of close(). `_stop` retires the pool and
        # the orphan sweep at step 1; `_halt` retires the heartbeat at step 3,
        # after in-flight work has finished, so a claim keeps being renewed for as
        # long as somebody here is still finalizing it.
        self._stop = asyncio.Event()
        self._halt = asyncio.Event()
        # Set by submit so a parked worker claims immediately instead of waiting
        # out claim_poll_seconds; also set by close so shutdown never pays a poll.
        self._wake = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._halt.clear()
        await self._recover()
        self._workers = [
            asyncio.create_task(self._worker(), name=f"npmguard-audit-worker-{index}")
            for index in range(self.max_concurrent)
        ]
        self._background = [
            asyncio.create_task(
                self._heartbeat_loop(), name="npmguard-audit-lease-heartbeat"
            ),
            asyncio.create_task(self._reclaim_loop(), name="npmguard-audit-reclaim-sweep"),
        ]

    async def reserve(self) -> None:
        """Capacity gate — no side effects. Every admission path calls this
        BEFORE create/claim, so a refusal never leaves a row or consumes a
        payment proof."""
        if await self.sessions.queued_count() >= self.queue_size:
            raise QueueFullError()

    async def admit(self, package_name: str, version: str | None = None) -> SubmitResult:
        """FREE/CRE/dev entry: reserve -> create(queued) -> submit. A refusal
        (QueueFull) creates no row."""
        await self.reserve()
        session = await self.sessions.create(package_name, version)
        return await self.submit(session)

    async def submit(self, session: AuditSession) -> SubmitResult:
        """The single owner entry every path reaches. Idempotent, audit_id-keyed.

        Registration happens with NO await between the ``_waiters`` check and the
        assignment — asyncio's single thread makes that atomic against a
        concurrent submit of the same audit_id, so both the webhook-vs-stream
        race and a double paid-replay of an errored claim resolve to one waiter.
        """
        aid = session.audit_id
        loop = asyncio.get_running_loop()

        if aid in self._waiters:  # a caller here is already awaiting this audit
            return SubmitResult(
                aid, await self._position(session), self._waiters[aid], created=False
            )
        if session.status == "done":  # terminal, no-op
            fut: asyncio.Future[dict[str, Any]] = loop.create_future()
            fut.set_result(session.report or {})
            return SubmitResult(aid, 0, fut, created=False)

        # Fresh 'queued' (create/claim) or a recoverable 'error' replay. REGISTER
        # with NO await between the `_waiters` check above and this assignment, so
        # a concurrent submit of the SAME audit_id dedups here. (The old order
        # awaited reset_to_queued BEFORE registering, so two errored replays could
        # both reach it and the loser's guarded reset asserted on a rowcount of 0
        # → a spurious 500 on a valid retry.)
        fut = loop.create_future()
        self._waiters[aid] = fut
        if session.status == "error":
            # The reset IS the enqueue now: `claim_next` only considers 'queued'
            # rows, so an 'error' row is structurally unclaimable and the old
            # commit-before-put_nowait ordering hazard (a worker dequeuing a
            # still-'error' id and dropping the claim) cannot arise. The
            # registration above already deduped concurrent replays, so exactly
            # one caller reaches this guarded reset (rowcount is always 1).
            await self.sessions.reset_to_queued(aid)
        position = await self._position(session)
        await AuditEmitter(aid, self.stream).emit("audit_enqueued", {"queuePosition": position})
        self._wake.set()  # a parked worker claims now rather than at the next poll
        return SubmitResult(aid, position, fut, created=True)

    async def _position(self, session: AuditSession) -> int:
        return await self.sessions.queue_position(session.audit_id, session.created_at)

    async def _worker(self) -> None:
        # INVARIANT: this loop only exits BETWEEN claims, never inside a DB
        # session. A worker cancelled while parked in `claim_next` dies holding a
        # checked-out connection that dispose() can never reclaim — measured as
        # one leak per worker per shutdown on the panel pool, which is why close()
        # asks (`_stop`) before it cancels.
        while not self._stop.is_set():
            claimed = await self.sessions.claim_next(
                self.instance_id, ttl_seconds=self.lease_ttl_seconds
            )
            if claimed is None:
                await self._idle()
                continue
            await self._run_claimed(claimed)

    async def _run_claimed(self, claimed: AuditSession) -> None:
        aid = claimed.audit_id
        try:
            if not await self.sessions.mark_running(aid):
                # Lost the guarded queued->running transition: the row was
                # finalized or reset between the claim and here. Hand the claim
                # back rather than holding it for a TTL over work we will not do.
                await self.sessions.release_lease(aid, self.instance_id)
                return
            # No re-SELECT and no `assert row is not None`: the row we execute is
            # exactly the row we claimed, and mark_running returning True already
            # establishes its status. Re-reading it to re-check a guarantee made
            # one line earlier costs a round trip and proves nothing.
            result = await self._execute(replace(claimed, status="running"))
        except Exception as exc:
            self._settle(aid, exception=exc)
        else:
            self._settle(aid, result=result)

    def _settle(
        self,
        audit_id: str,
        *,
        result: dict[str, Any] | None = None,
        exception: BaseException | None = None,
    ) -> None:
        # Resolve the local waiter if there is one, then drop it. An UNRESOLVED
        # waiter is deliberately LEFT in place (a CancelledError from close() rips
        # through _execute without reaching here at all) so close() resolves it —
        # no orphaned future, no caller left hanging.
        fut = self._waiters.get(audit_id)
        if fut is None:
            return
        if not fut.done():
            if exception is not None:
                fut.set_exception(exception)
            else:
                fut.set_result(result or {})
        self._waiters.pop(audit_id, None)

    async def _idle(self) -> None:
        """Park until there is plausibly work, or stop() is asked, or the poll
        elapses. A plain sleep would make shutdown wait out a full poll interval,
        which is exactly what tempts a caller into cancelling a worker mid-query.
        """
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(self.claim_poll_seconds):
                await self._wake.wait()
        self._wake.clear()

    async def _heartbeat_loop(self) -> None:
        """Renew every claim this instance holds, until close() asks us to halt.

        One task and one statement for the whole pool: the set of claims we hold
        is a QUERY (``claimed_by == instance_id``), not a list we maintain, so the
        heartbeat cannot drift out of agreement with what we actually own.

        Waits on ``_halt`` and NOT on ``_stop``, and that is the whole reason the
        two events exist separately. ``_stop`` is set at the top of ``close()``,
        when the pool is asked to wind down but real work is still executing for
        up to the shutdown deadline — a heartbeat that exited there would stop
        renewing the claim on an audit this process is still finalizing, which
        under a shortened TTL or a lengthened close deadline is how a peer comes
        to reclaim live work. (The draft cancelled this task at close step 3 and
        its comment said exactly that; the loop it cancelled had already returned
        at step 1, so the reasoning was right and the code did not implement it.)
        """
        while not self._halt.is_set():
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(self.heartbeat_seconds):
                    await self._halt.wait()
                    return
            renewed = await self.sessions.renew_leases(
                self.instance_id, ttl_seconds=self.lease_ttl_seconds
            )
            if renewed:
                log.debug("audit leases renewed", count=renewed, instance=self.instance_id)

    async def reclaim_expired(self) -> int:
        """Recover work whose owner died: ``running`` rows no LIVE claim covers.

        A ``running`` row cannot be resumed from its midpoint (a Docker container
        or an LLM call was in flight), so it becomes an explicit retryable 0031.
        A ``queued`` row with a lapsed claim needs nothing at all: ``claim_next``
        already treats a dead claim as unclaimed, so it is simply picked up again,
        unterminalized. That asymmetry is the never-drop rule expressed in the
        claim itself.

        NEVER reclaims a row THIS instance claims, and that exclusion is what
        makes running this on a timer safe. The draft this came from declined to
        drive it at all, reasoning that at one node a sweep "could only ever
        reclaim rows this same process owns — turning a stalled audit into a
        double execution". The reasoning is right and the conclusion does not
        follow: the dangerous row is precisely the self-claimed one (a worker of
        ours is still on it, so terminalizing it makes our own ``finalize`` meet
        an already-terminal row), and that row is excludable by name. What is
        left after the exclusion is work belonging to an incarnation that is not
        us and has stopped renewing — which is the definition of an orphan.

        Note what reclaiming does and does not do: it 0031s the row, it does not
        launch anything. Even a wrongly-reclaimed row is a false interruption, not
        a second container — the double execution would need ``claim_next`` to
        hand the same row to two workers, and it cannot.
        """
        message = "Audit interrupted by engine restart"
        reclaimed = 0
        for session in await self.sessions.orphaned_running(exclude_owner=self.instance_id):
            await self._finish(
                session.audit_id,
                error=message,
                event_type="audit_error",
                payload={"error": message, "code": "NPMGUARD-0031", "retryable": True},
            )
            reclaimed += 1
        return reclaimed

    async def _reclaim_loop(self) -> None:
        """Sweep for orphans on a timer, so a lapsed claim is repaired within a
        TTL rather than at the next restart.

        This is what pays for ``_recover`` recovering on the claim instead of on
        ``status`` alone. Without it, an audit whose owner crashed while holding a
        live lease would sit ``running`` until some future boot happened to look;
        with it, the worst case is ``lease_ttl_seconds`` plus one sweep interval.
        """
        while not self._stop.is_set():
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(self.reclaim_sweep_seconds):
                    await self._stop.wait()
                    return
            reclaimed = await self.reclaim_expired()
            if reclaimed:
                log.warning(
                    "reclaimed orphaned audits", count=reclaimed, instance=self.instance_id
                )

    async def _recover(self) -> None:
        """Never leave pre-restart sessions looking live forever, and never drop
        a queued claim.

        A hard process stop cannot safely resume a Docker/LLM phase from its
        midpoint, so interrupted ``running`` rows become an explicit, retryable
        0031 in the durable log.

        Startup recovers on the CLAIM (``reclaim_expired``), not on ``running()``.
        The draft this came from swept every non-demo ``running`` row here and
        argued that under one-engine-process-per-database any such row is orphaned
        by definition — true of the rows, and false of the interface. A boot that
        terminalizes rows by status alone cannot tell a dead predecessor's work
        from a live peer's, so the second engine process to start declares the
        first one's in-flight paid audit "interrupted by engine restart" and the
        real owner's terminal transaction then meets an already-terminal row
        (``finalize: matched 0 non-terminal rows``, escaping through ``_execute``).
        That is the 5dbf25a bug class at multi-instance scale, and it is what
        ``tests/e2e/test_service_claims.py`` P1 pins. R-2 exists to make ownership
        a durable fact; a recovery path that ignores the fact would leave the
        durable interface true only as long as nobody used it.

        The draft's objection to recovering on the claim was that a row whose
        owner crashed one second ago would stay ``running`` until its lease
        lapsed, and it is a real cost — measured, not hypothetical: with a
        lease-only rule, ``test_lifecycle`` S31/S32 hang, because a SIGKILLed
        engine's audit keeps a live claim across the restart and the client that
        is watching its SSE stream waits out the whole TTL for a 0031 that used to
        arrive at boot. Two things pay for it, and neither is a weakening of the
        claim:

        * ON THIS HOST the claim is decidable NOW — it carries the pid, so a
          predecessor that no longer exists is recognised immediately
          (``_claimant_is_locally_dead``). This covers every single-node restart,
          which is every restart today.
        * EVERYWHERE ELSE the lease still decides, and ``_reclaim_loop`` sweeps on
          a timer, so the worst case is one TTL rather than "until the next
          restart".

        What is deliberately NOT recovered is a claim that is live and not ours:
        another engine is executing that audit right now.

        Durable ``queued`` rows need NO action: being ``queued`` IS being
        enqueued now, so a worker claims them as soon as the pool spins up. That
        deletes the old detached-future re-enqueue entirely — and with it the
        possibility of a queued row whose recovery this process forgot to stage.
        Demo replays are excluded throughout (``persistence._not_demo``, the
        ``package_path`` tag).
        """
        message = "Audit interrupted by engine restart"
        for session in await self.sessions.running():
            if not self._claim_is_dead(session):
                continue  # somebody else is executing this right now
            await self._finish(
                session.audit_id,
                error=message,
                event_type="audit_error",
                payload={"error": message, "code": "NPMGUARD-0031", "retryable": True},
            )

    def _claim_is_dead(self, session: AuditSession) -> bool:
        """Nobody owes this ``running`` row a terminal state any more.

        Three ways to be dead, checked in order of certainty:

        * NO CLAIM AT ALL. A row that reached ``running`` was claimed by whoever
          started it, and ``finalize`` clears the claim only by making the row
          terminal — so ``running`` with no claim means the claim was dropped by
          something that then died, or the row predates the claim columns
          entirely (every pre-0008 row reads this way, which is exactly right).
        * THE LEASE HAS LAPSED. The universal rule, and the only one available
          across hosts.
        * THE CLAIMANT IS A DEAD PROCESS ON THIS HOST. Immediate and exact where
          it applies; see ``_claimant_is_locally_dead``.

        A claim held by THIS incarnation is never dead: at boot that is
        impossible (the id is freshly minted), and anywhere else it means a
        worker of ours is on the row.
        """
        if session.claimed_by is None or session.lease_expires_at is None:
            return True
        if session.claimed_by == self.instance_id:
            return False
        return (
            session.lease_expires_at < now_iso()
            or _claimant_is_locally_dead(session.claimed_by)
        )

    async def close(self, deadline: float = CLOSE_DEADLINE_SECONDS) -> None:
        """Bounded shutdown.

        Post-condition, on RETURN: this instance holds no claim at all, no row it
        claimed is left ``running``, and no local waiter is unresolved.

        "Holds no claim" is the addition, and it is what keeps a reclaimer off
        work we were still finalizing: every claim is either terminalized (it was
        ``running``) or released (it was ``queued``) before we return, so there is
        nothing left for anybody to reclaim. Never-started ``queued`` rows are
        LEFT ``queued`` — released, not finalized — so a worker picks them up
        again; a graceful shutdown must not drop a claimed paid audit that a crash
        would have preserved.

        A process death *inside* close() leaves rows ``running`` with a claim,
        by design: the claim lapses and the repair is identical to the crash path.
        """
        # 1. ASK the pool to stop, and wake every parked worker at once so no
        # worker spends shutdown asleep in a poll. Ask before cancelling: a worker
        # cancelled inside `claim_next` leaks its pooled connection.
        self._stop.set()
        self._wake.set()

        # 2. Give work already in flight up to `deadline` to finish NATURALLY.
        # Waiting on the WORKERS rather than on local futures is what covers a
        # restart-recovered audit, which by definition has no local caller — the
        # old code had to stage a detached future for exactly this reason. Each
        # worker exits its loop as soon as its current claim settles, so an idle
        # pool costs nothing here. asyncio.wait returns at the deadline; it does
        # not raise.
        if self._workers:
            await asyncio.wait(self._workers, timeout=deadline)

        # 3. Retire the background loops, THEN cancel whatever is left.
        #
        # The heartbeat halts HERE and not in step 1: during step 2 real work is in
        # flight and its claim must keep being renewed, or a long audit under a
        # long deadline would lose its own claim mid-flight. After this point
        # nothing is executing, so a heartbeat that outlived the pool would keep
        # advertising a claim over work nobody is doing — the precise inversion
        # that makes a reclaimer wait forever.
        #
        # ASKED before cancelled, for the same reason the pool is: `renew_leases`
        # and the sweep both run inside a DB session, and a task cancelled in one
        # dies holding a pooled connection dispose() can never reclaim.
        self._halt.set()
        if self._background:
            await asyncio.wait(self._background, timeout=BACKGROUND_HALT_SECONDS)
        for task in (*self._workers, *self._background):
            task.cancel()
        await asyncio.gather(*self._workers, *self._background, return_exceptions=True)
        self._workers = []
        self._background = []

        # 4. Dispose every claim this instance still holds. Read from the DB, not
        # from memory: the claim is the ownership fact, so this cannot miss a row
        # some bookkeeping forgot to record.
        for held in await self.sessions.leased_by(self.instance_id):
            await self._shutdown_finalize(held.audit_id)

        # 5. Resolve every remaining local waiter so no caller hangs and no
        # exception goes unretrieved.
        for aid, fut in list(self._waiters.items()):
            if not fut.done():
                fut.set_exception(AuditIncompleteError("shutdown", "engine stopped"))
            self._waiters.pop(aid, None)

    async def _shutdown_finalize(self, audit_id: str) -> None:
        # Only a RUNNING row (a Docker/LLM phase already mid-flight that a hard
        # stop cannot safely resume) is finalized to a retryable 0031 here. A
        # QUEUED row keeps its status and only loses its claim, so a worker picks
        # it up again — graceful shutdown must not drop a claimed paid audit that
        # a crash would have preserved.
        session = await self.sessions.get(audit_id)
        if session is None or session.status != "running":
            # INVARIANT: this guard reads the COMMITTED ROW STATUS and must never
            # become "do I hold the claim on it". It is the only thing keeping
            # finalize's `assert rowcount == 1` from firing on a row a cancelled
            # worker already finalized, and it rests on _finish being ONE
            # transaction. MEASURED at 071b9a9 by replacing exactly this check
            # with a claim-based one under a forced cancellation after the
            # terminal commit: `AssertionError: finalize(...): matched 0
            # non-terminal rows` escaped close() itself — which in the real
            # lifespan means the LLM client, the notifier and the DB engine are
            # never disposed, because they are all awaited after this call.
            #
            # Releasing the claim is unconditional and needs no branch: on a
            # terminal row finalize already cleared it, so this matches 0 rows and
            # is a no-op; on a queued row it is the release that must happen.
            await self.sessions.release_lease(audit_id, self.instance_id)
            return
        message = "Audit interrupted by engine shutdown"
        await self._finish(
            audit_id,
            error=message,
            event_type="audit_error",
            payload={"error": message, "code": "NPMGUARD-0031", "retryable": True},
        )

    async def _finish(
        self,
        audit_id: str,
        *,
        event_type: str,
        payload: dict[str, Any],
        report: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        # INVARIANT: the non-terminal->terminal row transition and the terminal
        # event (verdict_reached | audit_error) commit in ONE transaction. No
        # consumer can observe a terminal frame for a non-terminal row; a failed
        # append rolls the row back, where restart recovery repairs it — never a
        # terminal row with no terminal event, never a suppressed emit stranding
        # a follower.
        async with self.sessions.transaction() as db:
            await self.sessions.finalize(audit_id, report, error, session=db)
            await self.stream.append(audit_channel(audit_id), event_type, payload, session=db)

    async def _execute(self, session: AuditSession) -> dict[str, Any]:
        emitter = AuditEmitter(session.audit_id, self.stream)
        try:
            result = await self.pipeline.run(
                session.package_name,
                audit_id=session.audit_id,
                version=session.requested_version,
                emitter=emitter,
            )
            try:
                report = result.report.model_dump(mode="json", exclude_none=False)
                # Before the terminal frame, like the report file: whatever
                # verdict_reached implies exists must already be there. Left NULL when
                # empty so api.audit_file still falls back to disk.
                if result.files:
                    await self.sessions.set_file_contents(session.audit_id, result.files)
                # INVARIANT: terminal order is report-file, THEN row+event. The
                # report is durable on disk before the row leaves 'running',
                # and verdict_reached commits atomically with running->done —
                # a client acting on the terminal frame always finds the
                # persisted report.
                try:
                    save_report(
                        session.package_name, session.requested_version or "latest", result.report
                    )
                except UnversionedReportError as exc:
                    # INVARIANT: a COMPLETED audit is never discarded. Reaching
                    # here means the verdict was computed, the graph resolved and
                    # the evidence sealed — the only thing missing is the
                    # (name, version) key of the SECONDARY store (the public
                    # listing + CLI short-circuit cache). The durable record is
                    # audit_sessions.report keyed by audit_id, which is what
                    # GET /audit/{id}/report and the terminal SSE frame serve, so
                    # the verdict still reaches every consumer of THIS audit.
                    # Letting the refusal propagate (it used to escape as a bare
                    # ValueError → NPMGUARD-9999, retryable=False, HTTP 500)
                    # suppressed a finished — possibly DANGEROUS — verdict over a
                    # filing key. The file is skipped, never faked: a latest.json
                    # alias must not exist. Loud, because an unversioned package
                    # silently missing from data/reports/ is its own gap.
                    log.error(
                        "report file skipped: no concrete version",
                        audit_id=session.audit_id,
                        package_name=session.package_name,
                        requested_version=session.requested_version,
                        reason=str(exc),
                    )
                await self._finish(
                    session.audit_id,
                    report=report,
                    event_type="verdict_reached",
                    payload={
                        "verdict": result.report.verdict,
                        "rationale": result.report.rationale,
                        "counts": result.report.counts.model_dump(mode="json"),
                        "confirmedCount": result.report.counts.confirmed,
                    },
                )
            finally:
                # unconditional: a save/finalize failure must not leak the workspace
                result.cleanup()
            return report
        except Exception as exc:
            message = str(exc) or type(exc).__name__
            code = exc.code if isinstance(exc, NpmGuardError) else "NPMGUARD-9999"
            retryable = exc.retryable if isinstance(exc, NpmGuardError) else False
            await self._finish(
                session.audit_id,
                error=message,
                event_type="audit_error",
                payload={"error": message, "code": code, "retryable": retryable},
            )
            log.exception(
                "audit failed",
                audit_id=session.audit_id,
                package_name=session.package_name,
                code=code,
            )
            raise

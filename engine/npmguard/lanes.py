"""Queue lanes — the one place a lane's dispatch policy is written down.

A lane is not a queue, a pipeline, a docker budget or a verdict format. It is
three numbers attached to a class of work that all shares the SAME durable queue
and the SAME execution gate:

  ``rank``          claim order between lanes. Lower goes first, so paid work is
                    never behind a 300-dep repo scan.
  ``bounded``       whether ``queue_size`` refuses an enqueue on this lane.
  ``max_attempts``  how many times a failure is retried before the row goes
                    terminal.

Adding a lane must not add an executor or a docker budget (§8b). That is why this
module holds data and no behaviour: `AuditService` reads `bounded` and
`max_attempts`, `AuditSessionStore.claim_next` reads `rank`, and there is nowhere
else for a lane to grow a second implementation of anything.

WHY `bounded` IS PER-LANE. `queue_size` answers "is there room for somebody who
is waiting on a result" — a paying customer at `/audit/stream`, a signed-in user
watching a public scan. The panel's scan lanes have no such caller: a repo scan
enqueues every cache-missing dependency at once and reads progress from the
verdict index later, so the durable queue IS its buffer. This is exactly what
`panel_jobs` did as an unbounded outer queue in front of the bounded inner one;
folding the two into one queue keeps the property and drops the second hop.

WHY `max_attempts` IS PER-LANE. A paid audit's failure is a fact its payer must
see, immediately and marked retryable — replaying it is the caller's decision,
and a silent re-run would spend another audit's worth of docker and model budget
against one payment (N-1 adjacent: never spend more than the proof bought). A
scan dependency's failure is nobody's decision; a flaky registry fetch that
permanently marks a dep ERROR in a rollup is a worse answer than trying again.
"""

from __future__ import annotations

from dataclasses import dataclass

PAID = "paid"
PANEL = "panel"
WATCH = "watch"
BENCH = "bench"
PUBLIC = "public"


@dataclass(frozen=True)
class Lane:
    name: str
    rank: int
    bounded: bool
    max_attempts: int


# Ranks are spaced so a future lane can land between two without a migration.
LANES: dict[str, Lane] = {
    # Somebody paid and is watching the stream. First in line, refused rather
    # than queued past the bound, never silently re-run.
    PAID: Lane(PAID, rank=10, bounded=True, max_attempts=1),
    # A signed-in user's public repo scan. Bounded (the sign-in is the abuse
    # ceiling, this is the cost ceiling — D-1) and ranked BELOW paid so it can
    # never starve paid work (F-F6).
    PUBLIC: Lane(PUBLIC, rank=20, bounded=True, max_attempts=1),
    # Panel scan dependencies. Unbounded absorber, auto-retried.
    PANEL: Lane(PANEL, rank=30, bounded=False, max_attempts=3),
    # Registry-watch audits: same treatment as a scan dep, no org.
    WATCH: Lane(WATCH, rank=40, bounded=False, max_attempts=3),
    # The ops bench runner. Unbilled and unattended, so it yields to everything
    # else; its runner already treats QueueFull as backpressure, and being
    # unbounded means it no longer has to.
    BENCH: Lane(BENCH, rank=50, bounded=False, max_attempts=1),
}

DEFAULT_LANE = PAID


def lane(name: str) -> Lane:
    """The policy for ``name``.

    Asserts rather than defaulting. A lane string that is not in the registry is
    a wiring mistake at an enqueue site, and the failure mode of guessing is
    silent: work would inherit whichever policy the fallback happened to be, on a
    path where the wrong answer means either refusing a paid audit or re-running
    one for free.
    """
    assert name in LANES, f"unknown lane {name!r} (known: {sorted(LANES)})"
    return LANES[name]


__all__ = [
    "BENCH",
    "DEFAULT_LANE",
    "LANES",
    "PAID",
    "PANEL",
    "PUBLIC",
    "WATCH",
    "Lane",
    "lane",
]

"""The derived projector: ``expected × observed → outcome → rates``.

PURE. Nothing in this module reads a database, a file, or a clock. It consumes
:class:`~npmguard.contract.models.BenchRunItem` observations and pinned
:class:`~npmguard.bench.corpus.Entry` expectations and returns numbers. That is
what makes a scoring-rule change a re-projection of all history instead of an
invalidation of it (F-G2), and it is the single rule of this domain that must not
be undone: **no judgement is ever stored**. v1 stored ``{"DANGEROUS":
"detected", "SAFE": "missed"}`` at write time (`bench.py:132`), and when the
report schema moved its rows became unreadable rather than re-projectable.

Implements methodology v2 §4.2 (the 8-value taxonomy, D-6), §4.5 (ABSTAINED vs
VOID keyed on the stable ``NpmGuardError`` code), §5.2–§5.4 (entry-level `n`, the
reliable/optimistic band, Wilson lower bound) and §3.4.3 / B-13 (pooling across
an ``engineSha`` boundary is refused, not documented).
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum

from ..contract import models as contract
from .corpus import Entry

# ---------------------------------------------------------------------------
# §4.5 — what a no-verdict observation counts as
# ---------------------------------------------------------------------------

# Keyed on the stable NpmGuardError code (errors.py), never on the message. The
# message is prose that changes with a refactor; the code is contractually stable
# forever ("a code without a producer is deleted, not declared").
#
# ABSTAINED = the engine ran and honestly could not conclude. It stays in the
# detection denominator, so a fragile engine cannot buy a good score by failing
# more often (§4.5, and never relax this).
ABSTAINING_CODES = frozenset(
    {
        "NPMGUARD-0031",  # AuditIncompleteError — hypotheses deferred, none confirmed.
        "NPMGUARD-0030",  # AuditTimeoutError — a phase exceeded the engine's OWN budget.
    }
)

# Everything else is VOID: the observation failed to be made, and it is excluded
# from every numerator and denominator while being counted and named. Listed for
# the reader rather than consulted — the classifier's rule is "not abstaining ⟹
# void", so a code added to errors.py tomorrow is VOID by default. That default
# is the safe direction: a new failure mode silently entering the DENOMINATOR
# would understate detection, while entering the exclusion list is loudly visible
# as a rising void count that §4.5's 5% gate refuses to publish.
VOIDING_CODES = frozenset(
    {
        "NPMGUARD-0020",  # DockerUnavailableError — sandbox infrastructure.
        "NPMGUARD-0040",  # QueueFullError — admission pressure from the harness itself.
        "NPMGUARD-0001",  # PackageNotFoundError — a corpus bug, not a measurement.
        # PackageTooLargeError — the engine refused the INPUT before any model call,
        # so no detection was attempted. Naming it here rather than leaving it to the
        # default, because it is the one code whose bucket is genuinely arguable: a
        # refusal IS the tool's configured behaviour (like a phase timeout, which
        # abstains), but unlike a timeout it measures the CORPUS — an entry over the
        # bound is over it on every run and for every model, so filing it as an
        # abstention would move a fixed property of the corpus into the tool's
        # capability rate and make the denominator depend on a knob.
        "NPMGUARD-0003",
        "NPMGUARD-9999",  # an unclassified crash.
    }
)

# The harness's own patience is not the engine's answer (§7.4). Produced by the
# runner, never by the engine, so it cannot collide with an NPMGUARD code.
HARNESS_TIMEOUT_CODE = "BENCH-CLIENT-TIMEOUT"

# Methodology §4.5's publishability gate: above this share of attempted
# observations, a run reports its exclusions INSTEAD of rates.
MAX_VOID_SHARE = 0.05


class Outcome(StrEnum):
    """§4.2 — the per-observation outcome. Eight values, exhaustive, disjoint."""

    CAUGHT_PROVED = "CAUGHT_PROVED"
    CAUGHT_STRUCTURAL = "CAUGHT_STRUCTURAL"
    MISSED = "MISSED"
    CLEARED = "CLEARED"
    FALSE_ALARM_PROVED = "FALSE_ALARM_PROVED"
    FALSE_ALARM_STRUCTURAL = "FALSE_ALARM_STRUCTURAL"
    ABSTAINED = "ABSTAINED"
    VOID = "VOID"


CAUGHT = frozenset({Outcome.CAUGHT_PROVED, Outcome.CAUGHT_STRUCTURAL})
FALSE_ALARM = frozenset({Outcome.FALSE_ALARM_PROVED, Outcome.FALSE_ALARM_STRUCTURAL})


class EntryBucket(StrEnum):
    """§4.2 — the per-ENTRY bucket. The entry is the unit of analysis (B-4)."""

    UNOBSERVED = "UNOBSERVED"
    CAUGHT_ALWAYS = "CAUGHT_ALWAYS"
    CAUGHT_SOMETIMES = "CAUGHT_SOMETIMES"
    MISSED_ALWAYS = "MISSED_ALWAYS"
    ABSTAINED_ALWAYS = "ABSTAINED_ALWAYS"
    NEVER_CAUGHT_MIXED = "NEVER_CAUGHT_MIXED"
    CLEARED_ALWAYS = "CLEARED_ALWAYS"
    CLEARED_SOMETIMES = "CLEARED_SOMETIMES"
    FALSE_ALARM_ALWAYS = "FALSE_ALARM_ALWAYS"
    MIXED = "MIXED"


class BenchPoolingError(Exception):
    """B-13: two observations were about to be pooled across an ``engineSha``
    boundary. Raised, not warned — see :func:`pooled_engine_sha`."""


def error_code(error: str | None, code: str | None) -> str | None:
    """The classifying code for a no-verdict observation.

    ``code`` is the durable ``audit_error`` frame's code (``service.py:332``);
    ``error`` is the message. The message is accepted only to distinguish "no
    failure recorded at all" from "failed with an unreadable cause" — it is never
    pattern-matched, which is precisely what v1 did
    (``re.search(r"time(?:d)? out|timeout", …)``, `bench.py:131`) and how a
    provider hiccup became a benchmark result.
    """
    if code:
        return code
    return "NPMGUARD-9999" if error else None


def classify(entry: Entry, item: contract.BenchRunItem, code: str | None = None) -> Outcome:
    """One observation → one outcome. §4.2, and the three impossible states.

    ``code`` is the observation's error code when it did not conclude.
    """
    verdict, confirmed, dealbreaker = item.verdict, item.confirmedCount, item.dealbreaker

    # The three states the ENGINE makes unreachable, asserted rather than
    # branched. Each names its producer, because a fired assert means the engine,
    # the contract and the runner disagree — and a benchmark that averages over
    # that disagreement is worthless.
    assert not (verdict == "DANGEROUS" and confirmed == 0 and dealbreaker is None), (
        f"{entry.fixture_name}: DANGEROUS with no confirmation and no dealbreaker. "
        "DANGEROUS has exactly two producers — graph.py derive_graph_verdict "
        "(counts.confirmed > 0) and the pipeline's inventory dealbreaker "
        "short-circuit. There is no third path."
    )
    assert not (verdict == "SAFE" and confirmed > 0), (
        f"{entry.fixture_name}: SAFE with {confirmed} confirmed hypotheses. "
        "graph.py: confirmed > 0 ⟹ DANGEROUS."
    )
    assert not (verdict is not None and item.auditId is None), (
        f"{entry.fixture_name}: verdict {verdict!r} with no auditId. "
        "shared/src/bench.ts:117-118 — auditId is null only when the attempt "
        "never reached an audit."
    )

    if verdict is None:
        # §3.2 invariant 3: "couldn't check" cannot become a verdict, so the
        # observable for an incomplete audit is verdict == null — never a report
        # with DEFERRED hypotheses, which pipeline.py refuses to produce.
        return (
            Outcome.ABSTAINED
            if error_code(item.error, code) in ABSTAINING_CODES
            else Outcome.VOID
        )
    if entry.expected_verdict == "DANGEROUS":
        if verdict == "DANGEROUS":
            # §4.4: a dealbreaker catch is a DISJOINT mechanism, not a weak tier
            # of a proved one — it returns before any hypothesis exists.
            return Outcome.CAUGHT_PROVED if confirmed >= 1 else Outcome.CAUGHT_STRUCTURAL
        return Outcome.MISSED
    if verdict == "SAFE":
        return Outcome.CLEARED
    return Outcome.FALSE_ALARM_PROVED if confirmed >= 1 else Outcome.FALSE_ALARM_STRUCTURAL


def bucket(entry: Entry, outcomes: Sequence[Outcome]) -> EntryBucket:
    """The N observations of one entry → one entry bucket (§4.2).

    VOIDs are dropped FIRST: an observation that failed to be made is not
    evidence either way, and an entry with nothing left is ``UNOBSERVED`` rather
    than a miss.
    """
    live = [outcome for outcome in outcomes if outcome is not Outcome.VOID]
    if not live:
        return EntryBucket.UNOBSERVED
    if entry.expected_verdict == "DANGEROUS":
        caught = sum(outcome in CAUGHT for outcome in live)
        if caught == len(live):
            return EntryBucket.CAUGHT_ALWAYS
        if caught:
            # The bucket v1 could not express, and the direct measurement of what
            # a user experiences: "caught on some runs and not others".
            return EntryBucket.CAUGHT_SOMETIMES
        if all(outcome is Outcome.MISSED for outcome in live):
            return EntryBucket.MISSED_ALWAYS
        if all(outcome is Outcome.ABSTAINED for outcome in live):
            return EntryBucket.ABSTAINED_ALWAYS
        return EntryBucket.NEVER_CAUGHT_MIXED
    cleared = sum(outcome is Outcome.CLEARED for outcome in live)
    if cleared == len(live):
        return EntryBucket.CLEARED_ALWAYS
    if cleared:
        return EntryBucket.CLEARED_SOMETIMES
    if all(outcome in FALSE_ALARM for outcome in live):
        return EntryBucket.FALSE_ALARM_ALWAYS
    if all(outcome is Outcome.ABSTAINED for outcome in live):
        return EntryBucket.ABSTAINED_ALWAYS
    return EntryBucket.MIXED


# ---------------------------------------------------------------------------
# §5.1 / §5.4 — Wilson, and why a rate never travels without its denominator
# ---------------------------------------------------------------------------

Z_975 = 1.959964  # the 97.5% quantile of N(0,1)


@dataclass(frozen=True, slots=True)
class Rate:
    """``k/n`` with its Wilson 95% interval. There is deliberately no
    constructor that takes a bare ``p``: §5.4 requires every published rate to
    carry its denominator, and a type that cannot represent a denominator-less
    rate enforces that better than a review comment can. ``n == 0`` yields
    ``point is None`` — an empty corpus renders "no corpus", never "0%" (N-14).
    """

    k: int
    n: int

    @property
    def point(self) -> float | None:
        return self.k / self.n if self.n else None

    @property
    def interval(self) -> tuple[float, float] | None:
        """Wilson score interval. Preferred over Wald (`p̂ ± z√(p̂(1−p̂)/n)`),
        which produces malformed intervals near 0 and 1 — exactly the regime a
        strong auditor lives in."""
        if not self.n:
            return None
        p, n = self.k / self.n, self.n
        z2 = Z_975**2
        centre = p + z2 / (2 * n)
        spread = Z_975 * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
        denominator = 1 + z2 / n
        return (
            max(0.0, (centre - spread) / denominator),
            min(1.0, (centre + spread) / denominator),
        )

    @property
    def lower(self) -> float | None:
        """The headline number (B-5). A bound cannot overclaim, and a small `n`
        yields a weak bound even at a perfect score — which is what makes corpus
        size self-motivating rather than an argument."""
        interval = self.interval
        return None if interval is None else interval[0]

    def as_dict(self) -> dict[str, object]:
        interval = self.interval
        return {
            "k": self.k,
            "n": self.n,
            "point": self.point,
            "lower": None if interval is None else interval[0],
            "upper": None if interval is None else interval[1],
        }


def percentile(values: Sequence[int], percent: int) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil(percent / 100 * len(ordered)) - 1)
    return ordered[index]


# ---------------------------------------------------------------------------
# The run-level projection
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EntryResult:
    """One corpus entry as the projector sees it: its expectation, its N
    observations, and the bucket they aggregate to."""

    entry: Entry
    outcomes: tuple[Outcome, ...]
    bucket: EntryBucket
    audit_ids: tuple[str | None, ...]

    @property
    def flipped(self) -> bool:
        return self.bucket in {EntryBucket.CAUGHT_SOMETIMES, EntryBucket.CLEARED_SOMETIMES}


@dataclass(frozen=True)
class RunMetrics:
    """Everything §5.3 and §7.1 publish, derived from observations alone."""

    engine_sha: str
    results: tuple[EntryResult, ...] = ()
    # Malware side (§5.3)
    detection_reliable: Rate = Rate(0, 0)
    detection_optimistic: Rate = Rate(0, 0)
    miss_rate: Rate = Rate(0, 0)
    abstention_rate: Rate = Rate(0, 0)
    never_caught_mixed: int = 0
    # Negative-control side
    specificity: Rate = Rate(0, 0)
    false_alarm_rate: Rate = Rate(0, 0)
    # §4.4 — mandatory companions to the detection tile
    proof_share: Rate = Rate(0, 0)
    dealbreaker_share: Rate = Rate(0, 0)
    # §4.5 — the exclusions, counted and named
    void_count: int = 0
    void_causes: dict[str, int] = field(default_factory=dict)
    attempted: int = 0
    unobserved: int = 0
    # §5.5 — stability
    unanimity: Rate = Rate(0, 0)
    flips: tuple[str, ...] = ()
    runs_per_entry: int = 0
    # §7.1 — cost and latency
    latency_p50: int | None = None
    latency_p95: int | None = None
    latency_p99: int | None = None
    tokens_prompt: int | None = None
    tokens_completion: int | None = None
    token_cost_usd: float | None = None

    @property
    def void_share(self) -> float | None:
        return self.void_count / self.attempted if self.attempted else None

    @property
    def publishable(self) -> bool:
        """§4.5: a run whose VOID rate exceeds 5% of attempted observations is
        not a result, it is a broken run to re-do. The page renders the
        exclusions INSTEAD of rates (§9 rule 5)."""
        share = self.void_share
        return share is not None and share <= MAX_VOID_SHARE

    @property
    def stability_measured(self) -> bool:
        """At N=1 the reliable and optimistic bands are the SAME measurement, and
        the report must say so rather than implying a stability observation that
        was not made (§5.2)."""
        return self.runs_per_entry >= 2


def _sum_or_none(values: Iterable[int | None]) -> int | None:
    """Null when ANY contributor is unknown — never 0 as a stand-in
    (`shared/src/bench.ts:106-109`). A total that silently omits an unobserved
    part is worse than an absent total: a reader cannot tell it is partial."""
    total = 0
    for value in values:
        if value is None:
            return None
        total += value
    return total


def project(
    engine_sha: str,
    rows: Sequence[tuple[Entry, Sequence[contract.BenchRunItem]]],
    codes: dict[tuple[str, int], str] | None = None,
    costs: Sequence[float | None] = (),
) -> RunMetrics:
    """Project one run's observations into its published numbers.

    ONE run — one ``engineSha`` — by signature. Pooling several runs is
    :func:`pooled_engine_sha`'s job and it refuses across a boundary (B-13).

    ``codes`` maps ``(fixtureName, runIndex) → NpmGuardError code`` for the
    observations that did not conclude. Keyed on the OBSERVATION, not on the
    ``auditId``: an attempt that was never admitted has no audit id at all, and
    keying on one silently downgraded its recorded cause to "unclassified" — which
    is the difference between a named corpus bug and an anonymous crash.
    ``costs`` is the per-audit USD spend, one entry per attempted observation,
    ``None`` where the provider did not report it.
    """
    codes = codes or {}
    results: list[EntryResult] = []
    caught_observations: Counter[Outcome] = Counter()
    void_causes: Counter[str] = Counter()
    attempted = 0
    durations: list[int] = []

    for entry, items in rows:
        outcomes: list[Outcome] = []
        for item in items:
            attempted += 1
            code = codes.get((entry.fixture_name, item.runIndex))
            outcome = classify(entry, item, code)
            outcomes.append(outcome)
            if outcome in CAUGHT:
                caught_observations[outcome] += 1
            if outcome is Outcome.VOID:
                void_causes[error_code(item.error, code) or "unrecorded"] += 1
            if item.durationMs is not None:
                durations.append(item.durationMs)
        results.append(
            EntryResult(
                entry=entry,
                outcomes=tuple(outcomes),
                bucket=bucket(entry, outcomes),
                audit_ids=tuple(item.auditId for item in items),
            )
        )

    buckets = Counter(result.bucket for result in results)
    malware = [r for r in results if r.entry.expected_verdict == "DANGEROUS"]
    controls = [r for r in results if r.entry.expected_verdict == "SAFE"]

    # §5.3's denominators: entries with at least ONE non-VOID observation.
    # UNOBSERVED entries are outside n by construction and reported separately.
    n_mal = sum(1 for r in malware if r.bucket is not EntryBucket.UNOBSERVED)
    n_neg = sum(1 for r in controls if r.bucket is not EntryBucket.UNOBSERVED)
    reliable = buckets[EntryBucket.CAUGHT_ALWAYS]
    sometimes = buckets[EntryBucket.CAUGHT_SOMETIMES]

    # INVARIANT (§5.3): the five malware buckets partition n_mal. Asserted rather
    # than trusted because it is the one identity that catches a taxonomy edit
    # made in only one of the two places (`classify` and `bucket`) — the failure
    # it guards against is a rate whose numerator and denominator disagree, which
    # renders as a plausible number.
    assert (
        reliable
        + sometimes
        + buckets[EntryBucket.MISSED_ALWAYS]
        + buckets[EntryBucket.ABSTAINED_ALWAYS]
        + buckets[EntryBucket.NEVER_CAUGHT_MIXED]
        == n_mal
    ), (
        "malware entry buckets do not partition n_mal — "
        f"{dict(buckets)} over n_mal={n_mal}"
    )

    caught_total = sum(caught_observations.values())
    live_entries = [r for r in results if r.bucket is not EntryBucket.UNOBSERVED]
    return RunMetrics(
        engine_sha=engine_sha,
        results=tuple(results),
        detection_reliable=Rate(reliable, n_mal),
        detection_optimistic=Rate(reliable + sometimes, n_mal),
        miss_rate=Rate(buckets[EntryBucket.MISSED_ALWAYS], n_mal),
        abstention_rate=Rate(buckets[EntryBucket.ABSTAINED_ALWAYS], n_mal),
        never_caught_mixed=buckets[EntryBucket.NEVER_CAUGHT_MIXED],
        specificity=Rate(buckets[EntryBucket.CLEARED_ALWAYS], n_neg),
        false_alarm_rate=Rate(
            buckets[EntryBucket.FALSE_ALARM_ALWAYS] + buckets[EntryBucket.CLEARED_SOMETIMES],
            n_neg,
        ),
        proof_share=Rate(caught_observations[Outcome.CAUGHT_PROVED], caught_total),
        dealbreaker_share=Rate(caught_observations[Outcome.CAUGHT_STRUCTURAL], caught_total),
        void_count=sum(void_causes.values()),
        void_causes=dict(void_causes),
        attempted=attempted,
        unobserved=buckets[EntryBucket.UNOBSERVED],
        unanimity=Rate(
            sum(1 for r in live_entries if not r.flipped and r.bucket is not EntryBucket.MIXED),
            len(live_entries),
        ),
        flips=tuple(r.entry.fixture_name for r in results if r.flipped),
        runs_per_entry=max((len(r.outcomes) for r in results), default=0),
        latency_p50=percentile(durations, 50),
        latency_p95=percentile(durations, 95),
        latency_p99=percentile(durations, 99),
        tokens_prompt=_sum_or_none(
            item.tokensPrompt for _, items in rows for item in items
        ),
        tokens_completion=_sum_or_none(
            item.tokensCompletion for _, items in rows for item in items
        ),
        token_cost_usd=(
            None if any(cost is None for cost in costs) or not costs else sum(costs)
        ),
    )


def pooled_engine_sha(runs: Iterable[RunMetrics]) -> str:
    """The one ``engineSha`` a set of runs may be pooled under — or a refusal.

    B-13, made structural. Three landed commits (``ced29f2``, ``b1b0a43``,
    ``67f830f``) each changed what the engine can SEE, so an observation recorded
    before them is not comparable to one recorded after: a pre-fix ``MISSED`` is
    evidence about a renderer, not about detection. The corpus measurement that
    forced this rule moved 4,140 → 4,616 rendered rows mid-measurement because a
    peer was editing ``evidence.py``.

    The guard is deliberately STRICTER than "same fidelity epoch": pooling
    requires an IDENTICAL sha. An epoch table would need a git ancestry query at
    read time and would rot as commits land, whereas equality needs nothing and
    cannot be wrong. A caller who genuinely wants two engine versions in one view
    must render them side by side, which is what the methodology asks for
    ("the run report must name the boundary rather than averaging over it").
    """
    shas = sorted({run.engine_sha for run in runs})
    if len(shas) > 1:
        raise BenchPoolingError(
            "refusing to pool bench observations across an engineSha boundary: "
            f"{shas}. A fidelity fix between them changes what the engine can "
            "observe, so a pre-fix MISSED is not evidence of a detection failure "
            "(methodology §3.4.3, B-13). Render the runs side by side."
        )
    if not shas:
        raise BenchPoolingError("refusing to pool zero runs: there is no engineSha to name")
    return shas[0]


__all__ = [
    "ABSTAINING_CODES",
    "CAUGHT",
    "FALSE_ALARM",
    "HARNESS_TIMEOUT_CODE",
    "MAX_VOID_SHARE",
    "VOIDING_CODES",
    "Z_975",
    "BenchPoolingError",
    "EntryBucket",
    "EntryResult",
    "Outcome",
    "Rate",
    "RunMetrics",
    "bucket",
    "classify",
    "error_code",
    "percentile",
    "pooled_engine_sha",
    "project",
]

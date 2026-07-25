# CLASS MAP — bench.projector: `expected x observed -> outcome -> rates`
# (seam: PURE. Every class below is a function call with no DB, no file, no clock.
#  That is the point of the module: the scoring rule is a projection, so when it
#  changes it re-projects all history instead of invalidating it. v1 stored the
#  judgement and its rows became unreadable.)
#
# classify — ONE CLASS PER OUTCOME VALUE, all eight of D-6's taxonomy (§4.2):
#   C1  CAUGHT_PROVED           expected DANGEROUS, verdict DANGEROUS, confirmed>=1
#   C2  CAUGHT_STRUCTURAL       ... confirmed==0 with a dealbreaker (a DISJOINT
#                               mechanism, not a weak tier — pipeline returns
#                               before any hypothesis exists)
#   C3  MISSED                  expected DANGEROUS, verdict SAFE
#   C4  CLEARED                 expected SAFE, verdict SAFE
#   C5  FALSE_ALARM_PROVED      expected SAFE, verdict DANGEROUS, confirmed>=1
#   C6  FALSE_ALARM_STRUCTURAL  ... confirmed==0 with a dealbreaker
#   C7  ABSTAINED               no verdict, cause is an engine capability limit
#                               (0031 incomplete / 0030 phase timeout)
#   C8  VOID                    no verdict, cause is infra/harness/corpus
#   C8b VOID by DEFAULT for an unknown code — a new failure mode must not enter
#       the denominator silently
#   C8c the two codes retired in b9b805d (0010 LLMUnavailable, 0050 SessionLimit)
#       have no producer; provider exhaustion arrives as 0031 and the surviving
#       admission bound is 0040
#   C9  a client-side timeout is VOID, never ABSTAINED — the harness measuring its
#       own patience is not the tool's answer (§7.4)
#   C10 the code is read from the stable error CODE, never pattern-matched out of
#       the message the way v1 did
# The three states the ENGINE makes unreachable, asserted not branched:
#   C11 DANGEROUS with no confirmation and no dealbreaker raises
#   C12 SAFE with confirmed>0 raises
#   C13 a verdict with auditId None raises
# bucket — N observations of one entry -> one entry bucket (B-4: the entry is the
# unit of analysis, so replication splits catches instead of inflating n):
#   C14 all caught -> CAUGHT_ALWAYS
#   C15 caught + missed -> CAUGHT_SOMETIMES (the bucket v1 could not express)
#   C16 all missed -> MISSED_ALWAYS
#   C17 all abstained -> ABSTAINED_ALWAYS
#   C18 missed + abstained, none caught -> NEVER_CAUGHT_MIXED
#   C19 VOIDs are dropped FIRST, so a caught+void entry is CAUGHT_ALWAYS
#   C20 every observation VOID -> UNOBSERVED (outside n by construction)
#   C21 negative controls, symmetrically: CLEARED_ALWAYS / CLEARED_SOMETIMES /
#       FALSE_ALARM_ALWAYS / MIXED
# Rate + Wilson (§5.1/§5.4):
#   C22 the interval matches the published arithmetic at (20,20) and (14,20)
#   C23 n=0 -> point/interval None: an empty corpus renders "no corpus", not 0%
#   C24 the lower bound rises with n at a fixed p — what makes corpus size
#       self-motivating (20/20 -> 83.9%, 60/60 -> 94.0%)
#   C25 a Rate cannot be built from a bare p (no such constructor exists)
# project — the run-level projection:
#   C26 rates over a mixed corpus, with exact denominators (§5.3)
#   C27 the malware buckets partition n_mal (the asserted identity)
#   C28 proof_share + dealbreaker_share == 1 over caught OBSERVATIONS
#   C29 ABSTAINED stays in the detection denominator; VOID leaves every one
#   C30 void > 5% of attempted -> not publishable (§4.5's hard gate)
#   C31 latency percentiles over observed durations only
#   C32 tokens/cost are null when ANY contributor is unknown — never 0 as a
#       stand-in (`shared/src/bench.ts:106-109`)
#   C33 at N=1 stability is NOT measured, and the report must say so
#   C34 flips are named, so a skeptic gets the list not the rate
# Pooling (B-13, made structural):
#   C35 two runs on the same engineSha pool
#   C36 two runs across an engineSha boundary REFUSE — raised, not warned
#   C37 pooling zero runs refuses (there is no engineSha to name)

import pytest

from npmguard.bench.corpus import Entry
from npmguard.bench.projector import (
    HARNESS_TIMEOUT_CODE,
    BenchPoolingError,
    EntryBucket,
    Outcome,
    Rate,
    RunMetrics,
    bucket,
    classify,
    percentile,
    pooled_engine_sha,
    project,
)
from npmguard.contract import models as contract


def _entry(expected: str = "DANGEROUS", name: str = "test-pkg-fixture") -> Entry:
    return Entry(
        id=1,
        corpus_id=2,
        fixture_name=name,
        package_name="pkg",
        version="1.0.0",
        category="datadog-compromised",
        expected_verdict=expected,
        discovery_date="2025-09-16",
        rationale=None,
        source_id=None,
    )


def _item(
    verdict: str | None = None,
    *,
    confirmed: int = 0,
    dealbreaker: str | None = None,
    error: str | None = None,
    audit_id: str | None = "audit-1",
    duration: int | None = None,
    prompt: int | None = None,
    completion: int | None = None,
) -> contract.BenchRunItem:
    return contract.BenchRunItem(
        runId=1,
        entryId=1,
        runIndex=0,
        auditId=audit_id,
        verdict=verdict,
        durationMs=duration,
        error=error,
        confirmedCount=confirmed,
        dealbreaker=dealbreaker,
        tokensPrompt=prompt,
        tokensCompletion=completion,
    )


# --------------------------------------------------------------------------
# classify — one class per outcome value
# --------------------------------------------------------------------------


def test_caught_proved() -> None:
    """C1: flagged, with at least one hypothesis confirmed by running it."""
    assert classify(_entry(), _item("DANGEROUS", confirmed=2)) is Outcome.CAUGHT_PROVED


def test_caught_structural() -> None:
    """C2: flagged by an inventory dealbreaker before any hypothesis existed.
    Reported separately and never folded into "proved": it is near-free (no LLM,
    no sandbox), so a corpus rich in shell-pipe install scripts would show
    excellent recall at almost no cost (§4.4)."""
    outcome = classify(_entry(), _item("DANGEROUS", dealbreaker="shell-pipe"))
    assert outcome is Outcome.CAUGHT_STRUCTURAL


def test_missed() -> None:
    """C3: a false negative at DISPATCH coverage — every suspicion ran and
    terminally resolved. NOT "fully evaluated" (§3.2.1)."""
    assert classify(_entry(), _item("SAFE")) is Outcome.MISSED


def test_cleared() -> None:
    """C4: a correct clean verdict on a negative control."""
    assert classify(_entry("SAFE"), _item("SAFE")) is Outcome.CLEARED


def test_false_alarm_proved() -> None:
    """C5: the judge cited dynamic evidence of malice in a benign package — the
    most serious failure mode in the taxonomy."""
    outcome = classify(_entry("SAFE"), _item("DANGEROUS", confirmed=1))
    assert outcome is Outcome.FALSE_ALARM_PROVED


def test_false_alarm_structural() -> None:
    """C6: a dealbreaker heuristic fired on a benign package. A different bug from
    C5 — this one needs tuning, that one is cited evidence for absent malice."""
    outcome = classify(_entry("SAFE"), _item("DANGEROUS", dealbreaker="missing-install-script"))
    assert outcome is Outcome.FALSE_ALARM_STRUCTURAL


@pytest.mark.parametrize("code", ["NPMGUARD-0031", "NPMGUARD-0030"])
def test_abstained(code: str) -> None:
    """C7: the engine ran, formed suspicions, tried to resolve them, and honestly
    reports it could not. A real capability limit, so it belongs in the published
    denominator."""
    item = _item(None, error="phase 'flag' timed out")
    assert classify(_entry(), item, code) is Outcome.ABSTAINED


@pytest.mark.parametrize("code", ["NPMGUARD-0020", "NPMGUARD-0040", "NPMGUARD-0001"])
def test_void(code: str) -> None:
    """C8: docker, admission pressure, an unresolvable fixture. The observation
    failed to be made; it says nothing about the tool."""
    assert classify(_entry(), _item(None, error="boom"), code) is Outcome.VOID


def test_unknown_code_is_void_not_abstained() -> None:
    """C8b: a code this projector has never seen defaults to VOID. The safe
    direction: a new failure mode entering the DENOMINATOR would understate
    detection silently, while entering the exclusions shows up as a rising void
    count that §4.5's 5% gate refuses to publish."""
    assert classify(_entry(), _item(None, error="?"), "NPMGUARD-0099") is Outcome.VOID


@pytest.mark.parametrize("retired", ["NPMGUARD-0010", "NPMGUARD-0050"])
def test_retired_codes_have_no_producer(retired: str) -> None:
    """C8c: the draft's §4.5 table maps 0010 (LLMUnavailableError) and 0050
    (SessionLimitError) — both DELETED in b9b805d and reserved-never-recycled.
    Provider exhaustion now arrives as AuditIncompleteError (0031, ABSTAINED) and
    the surviving admission bound is QueueFullError (0040, VOID). Pinned as a test
    rather than a comment because a retired code reaching this projector means
    something is fabricating one."""
    from npmguard import errors

    live = {
        cls.code
        for cls in vars(errors).values()
        if isinstance(cls, type) and issubclass(cls, errors.NpmGuardError)
    }
    assert retired not in live
    # It still classifies (VOID by default) rather than crashing a whole run.
    assert classify(_entry(), _item(None, error="x"), retired) is Outcome.VOID


def test_client_timeout_is_void() -> None:
    """C9: the runner giving up first is a harness artifact. A run whose failures
    are client timeouts is measuring its own patience."""
    item = _item(None, error="runner gave up after 5400000ms")
    assert classify(_entry(), item, HARNESS_TIMEOUT_CODE) is Outcome.VOID


def test_cause_comes_from_the_code_not_the_message() -> None:
    """C10: v1 read `re.search(r"time(?:d)? out|timeout", error)` and turned a
    provider hiccup into a benchmark result. A message that SAYS timeout with a
    docker code is VOID; a message that says nothing with 0030 is ABSTAINED."""
    assert classify(_entry(), _item(None, error="timed out"), "NPMGUARD-0020") is Outcome.VOID
    assert classify(_entry(), _item(None, error="boom"), "NPMGUARD-0030") is Outcome.ABSTAINED


def test_dangerous_without_confirmation_or_dealbreaker_raises() -> None:
    """C11: DANGEROUS has exactly two producers (a confirmed hypothesis, or the
    inventory dealbreaker short-circuit). There is no third path, so this is an
    engine/contract/runner disagreement and a benchmark that averages over it is
    worthless."""
    with pytest.raises(AssertionError, match="exactly two producers"):
        classify(_entry(), _item("DANGEROUS"))


def test_safe_with_confirmations_raises() -> None:
    """C12: confirmed > 0 implies DANGEROUS in derive_graph_verdict."""
    with pytest.raises(AssertionError, match="confirmed > 0"):
        classify(_entry(), _item("SAFE", confirmed=1))


def test_verdict_without_audit_id_raises() -> None:
    """C13: auditId is null only when the attempt never reached an audit."""
    with pytest.raises(AssertionError, match="never reached an audit"):
        classify(_entry(), _item("SAFE", audit_id=None))


# --------------------------------------------------------------------------
# bucket — the entry is the unit
# --------------------------------------------------------------------------


def test_bucket_caught_always() -> None:
    """C14."""
    outcomes = [Outcome.CAUGHT_PROVED, Outcome.CAUGHT_STRUCTURAL]
    assert bucket(_entry(), outcomes) is EntryBucket.CAUGHT_ALWAYS


def test_bucket_caught_sometimes() -> None:
    """C15: the direct, honest measurement of what a user experiences — "this
    package is caught on some runs and not others". v1 spent its whole N=3
    replication budget and averaged this signal away."""
    outcomes = [Outcome.CAUGHT_PROVED, Outcome.MISSED]
    assert bucket(_entry(), outcomes) is EntryBucket.CAUGHT_SOMETIMES


def test_bucket_missed_always() -> None:
    """C16."""
    assert bucket(_entry(), [Outcome.MISSED, Outcome.MISSED]) is EntryBucket.MISSED_ALWAYS


def test_bucket_abstained_always() -> None:
    """C17."""
    outcomes = [Outcome.ABSTAINED, Outcome.ABSTAINED]
    assert bucket(_entry(), outcomes) is EntryBucket.ABSTAINED_ALWAYS


def test_bucket_never_caught_mixed() -> None:
    """C18: reported explicitly rather than folded into either rate — it is
    neither a clean miss nor a clean abstention."""
    outcomes = [Outcome.MISSED, Outcome.ABSTAINED]
    assert bucket(_entry(), outcomes) is EntryBucket.NEVER_CAUGHT_MIXED


def test_bucket_drops_voids_first() -> None:
    """C19: a void is not evidence either way, so it cannot turn a caught entry
    into a flaky one."""
    outcomes = [Outcome.CAUGHT_PROVED, Outcome.VOID]
    assert bucket(_entry(), outcomes) is EntryBucket.CAUGHT_ALWAYS


def test_bucket_all_void_is_unobserved() -> None:
    """C20: nothing left to score. Outside n, counted separately with causes."""
    assert bucket(_entry(), [Outcome.VOID, Outcome.VOID]) is EntryBucket.UNOBSERVED


@pytest.mark.parametrize(
    ("outcomes", "expected"),
    [
        ([Outcome.CLEARED, Outcome.CLEARED], EntryBucket.CLEARED_ALWAYS),
        ([Outcome.CLEARED, Outcome.FALSE_ALARM_PROVED], EntryBucket.CLEARED_SOMETIMES),
        (
            [Outcome.FALSE_ALARM_PROVED, Outcome.FALSE_ALARM_STRUCTURAL],
            EntryBucket.FALSE_ALARM_ALWAYS,
        ),
        ([Outcome.FALSE_ALARM_PROVED, Outcome.ABSTAINED], EntryBucket.MIXED),
    ],
)
def test_bucket_negative_controls(outcomes: list[Outcome], expected: EntryBucket) -> None:
    """C21: the taxonomy is symmetric. Negative controls are what make the recall
    number non-gameable — a tool that flags everything scores 100% recall."""
    assert bucket(_entry("SAFE"), outcomes) is expected


# --------------------------------------------------------------------------
# Rate + Wilson
# --------------------------------------------------------------------------


def test_wilson_matches_the_published_arithmetic() -> None:
    """C22: the two figures the methodology publishes — 20/20 -> >=83.9%, and
    p=0.70 at n=20 -> [48.1%, 85.5%]."""
    perfect = Rate(20, 20)
    assert perfect.point == 1.0
    assert round(perfect.lower * 1000) == 839
    fourteen = Rate(14, 20)
    lower, upper = fourteen.interval
    assert (round(lower * 1000), round(upper * 1000)) == (481, 855)


def test_rate_with_no_denominator_has_no_number() -> None:
    """C23: N-14 — an empty corpus renders an explicit "no corpus", never 0%."""
    empty = Rate(0, 0)
    assert empty.point is None and empty.interval is None and empty.lower is None
    assert empty.as_dict()["lower"] is None


def test_lower_bound_makes_corpus_size_self_motivating() -> None:
    """C24: a perfect score at n=20 bounds at 83.9%; at n=60 at 94.0%. Nobody has
    to be argued into expanding the corpus — the headline number does it."""
    assert round(Rate(20, 20).lower * 1000) == 839
    assert round(Rate(60, 60).lower * 1000) == 940
    assert Rate(60, 60).lower > Rate(20, 20).lower


def test_rate_cannot_be_constructed_from_a_bare_probability() -> None:
    """C25: §5.4 requires the denominator to travel with the rate, and a type that
    cannot represent a denominator-less rate enforces that better than a review
    comment. Pinned so a "convenience" constructor cannot be added quietly."""
    with pytest.raises(TypeError):
        Rate(0.83)  # type: ignore[call-arg]


def test_percentile_of_nothing_is_none() -> None:
    assert percentile([], 95) is None
    assert percentile([10, 20, 30, 40], 50) == 20


# --------------------------------------------------------------------------
# project
# --------------------------------------------------------------------------


def _corpus_rows() -> list[tuple[Entry, list[contract.BenchRunItem]]]:
    """2 malware caught always, 1 malware flaky, 1 malware missed, 1 malware
    abstained, 2 controls cleared, 1 control false-alarming."""
    malware = [_entry(name=f"test-pkg-mal-{i}") for i in range(5)]
    controls = [_entry("SAFE", name=f"test-pkg-neg-{i}") for i in range(3)]
    return [
        (malware[0], [_item("DANGEROUS", confirmed=1, duration=100)] * 2),
        (malware[1], [_item("DANGEROUS", dealbreaker="shell-pipe", duration=200)] * 2),
        (malware[2], [_item("DANGEROUS", confirmed=1, duration=300), _item("SAFE", duration=400)]),
        (malware[3], [_item("SAFE", duration=500)] * 2),
        (malware[4], [_item(None, error="deferred"), _item(None, error="deferred")]),
        (controls[0], [_item("SAFE", duration=10)] * 2),
        (controls[1], [_item("SAFE", duration=20)] * 2),
        (controls[2], [_item("DANGEROUS", confirmed=1, duration=30)] * 2),
    ]


def _codes() -> dict[tuple[str, int], str]:
    """The abstaining entry's two observations, keyed by (fixtureName, runIndex) —
    the OBSERVATION's identity, which exists even when no audit was admitted."""
    return {("test-pkg-mal-4", 0): "NPMGUARD-0031", ("test-pkg-mal-4", 1): "NPMGUARD-0031"}


def test_rates_have_exact_denominators() -> None:
    """C26: n = ENTRIES, per §5.3's denominators."""
    metrics = project("sha", _corpus_rows(), codes=_codes())
    assert (metrics.detection_reliable.k, metrics.detection_reliable.n) == (2, 5)
    assert (metrics.detection_optimistic.k, metrics.detection_optimistic.n) == (3, 5)
    assert (metrics.miss_rate.k, metrics.miss_rate.n) == (1, 5)
    assert (metrics.abstention_rate.k, metrics.abstention_rate.n) == (1, 5)
    assert (metrics.specificity.k, metrics.specificity.n) == (2, 3)
    assert (metrics.false_alarm_rate.k, metrics.false_alarm_rate.n) == (1, 3)


def test_malware_buckets_partition_the_denominator() -> None:
    """C27: the asserted identity. A numerator and denominator that disagree
    render as a plausible number, which is the worst kind of wrong."""
    metrics = project("sha", _corpus_rows(), codes=_codes())
    total = (
        metrics.detection_reliable.k
        + (metrics.detection_optimistic.k - metrics.detection_reliable.k)
        + metrics.miss_rate.k
        + metrics.abstention_rate.k
        + metrics.never_caught_mixed
    )
    assert total == metrics.detection_reliable.n == 5


def test_proof_and_dealbreaker_share_sum_to_one() -> None:
    """C28: over caught OBSERVATIONS, not entries. Detection without the
    dealbreaker share is uninterpretable."""
    metrics = project("sha", _corpus_rows(), codes=_codes())
    assert metrics.proof_share.point + metrics.dealbreaker_share.point == 1.0
    assert metrics.dealbreaker_share.k == 2  # the two shell-pipe observations


def test_abstentions_stay_in_the_denominator_and_voids_do_not() -> None:
    """C29: the crux of B-3. Moving abstentions out of the denominator would let a
    fragile engine buy an excellent score by failing more often; leaving voids in
    would blame the tool for the weather."""
    entry = _entry()
    abstained = project(
        "sha", [(entry, [_item(None, error="x")])],
        codes={("test-pkg-fixture", 0): "NPMGUARD-0031"},
    )
    assert (abstained.detection_reliable.k, abstained.detection_reliable.n) == (0, 1)
    voided = project(
        "sha", [(entry, [_item(None, error="x")])],
        codes={("test-pkg-fixture", 0): "NPMGUARD-0020"},
    )
    assert voided.detection_reliable.n == 0
    assert voided.unobserved == 1 and voided.void_causes == {"NPMGUARD-0020": 1}


def test_a_void_heavy_run_is_not_publishable() -> None:
    """C30: §4.5's hard gate. A run whose VOID rate exceeds 5% of attempted
    observations is not a result; it is a broken run to re-do, and the report says
    so INSTEAD of reporting rates."""
    rows = _corpus_rows()
    rows.append((_entry(name="test-pkg-mal-9"), [_item(None, error="docker")]))
    metrics = project("sha", rows, codes={**_codes(), ("test-pkg-mal-9", 0): "NPMGUARD-0020"})
    assert metrics.void_share > 0.05
    assert not metrics.publishable
    good = project("sha", _corpus_rows(), codes=_codes())
    assert good.void_count == 0 and good.publishable


def test_latency_percentiles_use_observed_durations_only() -> None:
    """C31: an audit that produced no report has no observed duration rather than
    a wrong one, so it does not enter the distribution."""
    rows = [(_entry(), [_item("SAFE", duration=100), _item(None, error="x")])]
    metrics = project("sha", rows, codes={("test-pkg-fixture", 1): "NPMGUARD-0031"})
    assert metrics.latency_p50 == metrics.latency_p95 == 100


def test_tokens_and_cost_are_null_when_any_part_is_unknown() -> None:
    """C32: never 0 as a stand-in. A total that silently omits an unobserved part
    is worse than an absent total, because a reader cannot tell it is partial."""
    known = [(_entry(), [_item("SAFE", prompt=10, completion=1)])]
    assert project("sha", known, costs=[0.5]).tokens_prompt == 10
    assert project("sha", known, costs=[0.5]).token_cost_usd == 0.5
    partial = [(_entry(), [_item("SAFE", prompt=10, completion=1), _item("SAFE")])]
    assert project("sha", partial, costs=[0.5, None]).tokens_prompt is None
    assert project("sha", partial, costs=[0.5, None]).token_cost_usd is None
    assert project("sha", known, costs=[]).token_cost_usd is None


def test_at_one_run_per_entry_stability_is_not_measured() -> None:
    """C33: at N=1 the reliable and optimistic bands are the SAME measurement, and
    the report must say so rather than implying a stability observation nobody
    made."""
    single = project("sha", [(_entry(), [_item("DANGEROUS", confirmed=1)])])
    assert single.runs_per_entry == 1 and not single.stability_measured
    assert single.detection_reliable.k == single.detection_optimistic.k
    assert project("sha", _corpus_rows(), codes=_codes()).stability_measured


def test_flips_are_named_not_just_counted() -> None:
    """C34: the flip list is the first thing a skeptic should be shown."""
    metrics = project("sha", _corpus_rows(), codes=_codes())
    assert metrics.flips == ("test-pkg-mal-2",)
    assert (metrics.unanimity.k, metrics.unanimity.n) == (7, 8)


# --------------------------------------------------------------------------
# B-13 — pooling across an engineSha boundary is structurally impossible
# --------------------------------------------------------------------------


def test_runs_on_one_engine_sha_pool() -> None:
    """C35."""
    runs = [RunMetrics(engine_sha="abc"), RunMetrics(engine_sha="abc")]
    assert pooled_engine_sha(runs) == "abc"


def test_pooling_across_an_engine_sha_boundary_is_refused() -> None:
    """C36: raised, not documented. An author's own fidelity measurement moved
    4,140 -> 4,616 rendered rows mid-run because a peer was editing evidence.py; a
    fidelity number without its engineSha is not a measurement, and a pre-fix
    MISSED is evidence about a renderer rather than about detection."""
    runs = [RunMetrics(engine_sha="before"), RunMetrics(engine_sha="after")]
    with pytest.raises(BenchPoolingError, match="engineSha boundary"):
        pooled_engine_sha(runs)


def test_pooling_nothing_is_refused() -> None:
    """C37: there is no engineSha to name, so there is no measurement."""
    with pytest.raises(BenchPoolingError, match="zero runs"):
        pooled_engine_sha([])

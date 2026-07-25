# CLASS MAP — the WIRE CONTRACT itself: what the authored Zod makes
# unrepresentable, and what it no longer declares at all.
# (seam: `npmguard.contract.models` — the GENERATED module — and
#  `shared/contract/contract.schema.json`, the language-neutral artifact it is
#  generated from. Read as data, never hand-edited. These tests exist because a
#  contract invariant that only lives in a `.refine()` is invisible to the engine,
#  which is the PRODUCER of every payload here.)
#
# Axes: is a dishonest state representable × does a declared value have a producer
#   C1 BenchRate — `point is None ⟺ n == 0`, unrepresentable otherwise, in BOTH
#      directions. An empty corpus cannot render as 0%, and a rate cannot arrive
#      without its denominator.
#   C2 BenchRunMetrics — the three POOLING identifiers (engineSha, datasetVersion,
#      manifestSha) are required, so a payload that could be silently averaged with
#      another does not parse
#   C3 BenchCoverage — nullable, and its non-null shape is EXACTLY what the
#      projector's `FidelityCounts.as_dict()` produces. The type has a producer even
#      though the route sends null today; that is the difference between "not wired
#      yet" and "declared with nothing behind it".
#   C4 the deleted island — Finding / Proof / TriageResult / Confidence / ProofKind /
#      Capability / FocusArea / AttackPathway are absent from the generated module
#      AND from the contract artifact, and the retired `TEST_CONFIRMED` string
#      reaches nothing executable. The falsification, recorded so a re-introduction
#      fails a test rather than a review.
#   C5 codegen parity — every OBJECT `$defs` entry is bound as a class in the
#      generated module, every unbound one is an enum-or-union root that
#      `--collapse-root-models` inlines by design, and D-6's two new vocabularies
#      survive codegen value-for-value (the failure that mangled `TriageHypothesis`)
#   C6 ValidationFailed — the 400 body's declared key set, with pydantic's own
#      `type`/`input` absent from an issue by construction

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from npmguard.bench.fidelity import FidelityCounts
from npmguard.contract import models as contract

CONTRACT_PATH = (
    Path(contract.__file__).resolve().parents[3] / "shared" / "contract" / "contract.schema.json"
)

DELETED = (
    "Finding",
    "Proof",
    "TriageResult",
    "Confidence",
    "ProofKind",
    "Capability",
    "FocusArea",
    "AttackPathway",
)

MEASURED = {"k": 1, "n": 2, "point": 0.5, "lower": 0.1, "upper": 0.9}
EMPTY = {"k": 0, "n": 0, "point": None, "lower": None, "upper": None}


@pytest.fixture(scope="module")
def artifact() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def _metrics(**overrides) -> dict:
    payload = {
        "runId": 1,
        "engineSha": "cafe1234",
        "datasetVersion": "1.0",
        "manifestSha": "beef",
        "observedModels": [],
        "runsPerEntry": 1,
        "stabilityMeasured": False,
        "publishable": True,
        "detection": {"reliable": EMPTY, "optimistic": EMPTY},
        "missRate": EMPTY,
        "abstentionRate": EMPTY,
        "neverCaughtMixed": 0,
        "specificity": EMPTY,
        "falseAlarmRate": EMPTY,
        "proofShare": EMPTY,
        "dealbreakerShare": EMPTY,
        "attempted": 0,
        "voidCount": 0,
        "voidShare": None,
        "voidCauses": {},
        "unobservedEntries": 0,
        "unanimity": EMPTY,
        "flips": [],
        "latencyMs": {"p50": None, "p95": None, "p99": None},
        "tokensPrompt": None,
        "tokensCompletion": None,
        "tokenCostUsd": None,
        "coverage": None,
        "coveragePredicate": "bench-fidelity-1",
        "ledger": [],
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# C1 — the rate domain
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rate", "why"),
    [
        ({**EMPTY, "point": 0.0}, "n == 0 with a point: an empty corpus rendering as 0%"),
        (
            {**EMPTY, "point": 0.0, "lower": 0.0, "upper": 0.0},
            "n == 0 with a whole interval: the same claim, dressed up",
        ),
        ({**MEASURED, "point": None}, "n > 0 with no point: a measurement that was made"),
        ({"point": 0.5, "lower": 0.1, "upper": 0.9}, "a rate with NO denominator at all"),
        ({**MEASURED, "n": 0}, "a point over a zero denominator"),
        ({**MEASURED, "point": 1.4}, "a 'rate' outside [0, 1]"),
    ],
)
def test_a_dishonest_rate_does_not_parse(rate, why) -> None:
    """C1: `point is None ⟺ n == 0` is enforced by the TYPE, not by a review comment.

    `BenchRate` is `BenchMeasuredRate | BenchEmptyRate` and the two members have no
    common inhabitant: measured requires `n >= 1` with three real statistics, empty
    pins `k`/`n` to the literal 0 with all three null. So the two dishonesty classes
    §5.4 cares about are UNREPRESENTABLE rather than merely discouraged — an empty
    corpus cannot render "0%", and a consumer cannot receive a `point` without its
    `n`, which is what makes "a tile takes (k, n), never a bare p" enforceable.

    Checked on the generated PYTHON, deliberately: the engine is the producer, and an
    invariant expressed only as a Zod `.refine()` would be invisible here — JSON
    Schema cannot carry a refinement, so it would never survive codegen.
    """
    with pytest.raises(ValidationError):
        contract.BenchRunMetrics.model_validate(_metrics(missRate=rate))


def test_the_rate_union_still_admits_every_honest_rate() -> None:
    """C1: the other half — the union is restrictive, not merely narrow.

    KNOWN GAP, stated rather than left implied: `k > n` still parses. It is a
    cross-field comparison, which JSON Schema cannot express and which therefore
    cannot survive codegen — so it is enforced upstream instead, by `projector.Rate`
    having no constructor that takes a bare `point` and computing `k/n` itself.
    """
    assert contract.BenchRunMetrics.model_validate(_metrics(missRate={**MEASURED, "k": 3}))
    measured = contract.BenchRunMetrics.model_validate(_metrics(missRate=MEASURED)).missRate
    assert (measured.k, measured.n, measured.point) == (1, 2, 0.5)
    empty = contract.BenchRunMetrics.model_validate(_metrics(missRate=EMPTY)).missRate
    assert (empty.k, empty.n) == (0, 0)
    assert empty.point is None and empty.lower is None and empty.upper is None
    # A perfect score over a real denominator is still a MEASURED rate — the union
    # must not treat `point == 1.0` or `k == 0` as the empty case.
    for edge in ({"k": 2, "n": 2, "point": 1.0, "lower": 0.34, "upper": 1.0},
                 {"k": 0, "n": 2, "point": 0.0, "lower": 0.0, "upper": 0.66}):
        assert contract.BenchRunMetrics.model_validate(_metrics(missRate=edge)).missRate.n == 2


# ---------------------------------------------------------------------------
# C2 — the pooling identifiers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("identifier", ["engineSha", "datasetVersion", "manifestSha"])
def test_a_metrics_payload_without_its_pooling_identifiers_fails_to_parse(identifier) -> None:
    """C2 / B-13: these are part of the MEASUREMENT, not metadata about it.

    `pooled_engine_sha` refuses to combine runs whose `engineSha` differs, because a
    fidelity fix changes what the engine can SEE and a pre-fix MISSED is evidence
    about a renderer rather than about detection. That refusal is worthless if the
    payload can be detached from the sha — a reader would then average two epochs in
    good faith and nothing in the data would stop them. Same argument for the corpus
    pair: averaging two `datasetVersion`s averages two questions.
    """
    payload = _metrics()
    del payload[identifier]
    with pytest.raises(ValidationError):
        contract.BenchRunMetrics.model_validate(payload)


# ---------------------------------------------------------------------------
# C3 — coverage
# ---------------------------------------------------------------------------


def test_coverage_is_nullable_and_its_shape_is_the_projectors(artifact) -> None:
    """C3 / B-12: `coverage` is null — never a zeroed record — while the artifact tier
    is unreachable, because zeros would claim "we measured coverage and found no
    defects", a measurement nobody made.

    The non-null shape is asserted against `FidelityCounts.as_dict()` rather than
    restated, so the declared type has a PRODUCER even though the route sends null:
    that is what separates "wired later" from the orphan schemas C4 deletes.
    """
    assert contract.BenchRunMetrics.model_validate(_metrics()).coverage is None
    produced = FidelityCounts(described_events=10, rendered_rows=8, anonymous_rows=1).as_dict()
    assert set(produced) == set(contract.BenchCoverage.model_fields)
    parsed = contract.BenchRunMetrics.model_validate(_metrics(coverage=produced)).coverage
    assert parsed is not None
    assert (parsed.describedEvents, parsed.anonymousRows) == (10, 1)
    assert parsed.predicateVersion == "bench-fidelity-1"
    # A zeroed record is a DIFFERENT statement from null, and both are expressible —
    # which is the point: the route has to choose, and it chooses null.
    zeroed = contract.BenchRunMetrics.model_validate(_metrics(coverage=FidelityCounts().as_dict()))
    assert zeroed.coverage is not None and zeroed.coverage.fidelityDefects == 0
    assert artifact["$defs"]["BenchRunMetrics"]["properties"]["coverage"]["anyOf"][-1] == {
        "type": "null"
    }


# ---------------------------------------------------------------------------
# C4 — the deleted island, and its falsification
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# C5 / C6 — codegen parity, and the declared 400 body
# ---------------------------------------------------------------------------


def test_the_validation_failed_body_declares_exactly_what_the_engine_sends() -> None:
    """C6: `api.py::_body` used to emit an undeclared `details` carrying
    `PydanticValidationError.errors()` verbatim. Zod strips unknown keys, so nothing
    broke — which is the failure worth closing: invisible to a generated consumer,
    and available to be depended on by one hand-reading JSON. Declared now in
    NpmGuard's OWN vocabulary, so a pydantic upgrade is not a wire change and
    `input` (which echoes submitted values) never leaves the process."""
    assert set(contract.ValidationFailed.model_fields) == {"error", "details"}
    assert set(contract.ValidationIssue.model_fields) == {"field", "message"}
    body = contract.ValidationFailed.model_validate(
        {"error": "Invalid request", "details": [{"field": "packageName", "message": "bad"}]}
    )
    assert body.details[0].field == "packageName"
    # The key is REQUIRED, not optional: an omitted `details` is drift, and the wire
    # rule for this repo is that every declared key is always present.
    with pytest.raises(ValidationError):
        contract.ValidationFailed.model_validate({"error": "Invalid request"})

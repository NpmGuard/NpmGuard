"""Integrity checks for the generated wire contract.

The seams are the generated Pydantic module and the language-neutral schema
artifact authored from Zod. Axes: representable rate states, required pooling
identifiers, coverage provenance, generated-model parity, validation-error shape,
and code-generation freshness.
"""

import json
import shutil
import subprocess
import tempfile
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
    for edge in (
        {"k": 2, "n": 2, "point": 1.0, "lower": 0.34, "upper": 1.0},
        {"k": 0, "n": 2, "point": 0.0, "lower": 0.0, "upper": 0.66},
    ):
        assert contract.BenchRunMetrics.model_validate(_metrics(missRate=edge)).missRate.n == 2


@pytest.mark.parametrize("identifier", ["engineSha", "datasetVersion", "manifestSha"])
def test_a_metrics_payload_without_its_pooling_identifiers_fails_to_parse(identifier) -> None:
    """C2: pooling identifiers are part of the measurement, not metadata.

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


def test_coverage_is_nullable_and_its_shape_is_the_projectors(artifact) -> None:
    """C3: absent coverage is null rather than a fabricated zero measurement.

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


def test_the_validation_failed_body_declares_exactly_what_the_engine_sends() -> None:
    """C6: validation details use NpmGuard's declared, secret-safe vocabulary."""
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


def test_the_contract_artifact_is_what_the_zod_renders_today() -> None:
    """C7: the committed schema equals output from the authored Zod contract.

    Code generation targets a temporary directory so the test cannot repair the
    artifact it checks.
    """
    if shutil.which("npm") is None:
        pytest.skip("npm unavailable — contract freshness UNVERIFIED (required before merge)")
    repo_root = CONTRACT_PATH.parents[2]
    tsx_candidates = (
        repo_root / "node_modules/.bin/tsx",
        repo_root / "shared/node_modules/.bin/tsx",
    )
    if not any(path.is_file() for path in tsx_candidates):
        pytest.skip(
            "JavaScript dependencies unavailable — contract freshness UNVERIFIED "
            "(run npm install before merge)"
        )
    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run(
            [
                "npm",
                "--silent",
                "-w",
                "@npmguard/shared",
                "run",
                "contract:export",
                "--",
                "--out",
                tmp,
            ],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=300,
        )
        assert result.returncode == 0, result.stderr
        rendered = json.loads((Path(tmp) / "contract.schema.json").read_text(encoding="utf-8"))
    committed = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    stale = {
        name
        for name in set(rendered["$defs"]) | set(committed["$defs"])
        if rendered["$defs"].get(name) != committed["$defs"].get(name)
    }
    assert not stale, (
        f"contract.schema.json is stale for {sorted(stale)} — "
        "run scripts/gen-contract.sh and commit the result"
    )

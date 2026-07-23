# CLASS MAP — in-process replay of a committed audit through the REAL orchestrator
#   (run_orchestrator + judge_evidence + render_timeline + graph verdict) over
#   IndexedReplayProvider (recorded LLM traffic) and RecordedSandbox (recorded
#   full-oracle run artifacts). No infra — runs in the DEFAULT suite.
# Axes: recorded verdict class × generation path × sandbox-artifact health
#   C1 SAFE, all suspicions refuted, clean artifacts (chalk)    — verdict SAFE, 0 unmatched
#   C2 DANGEROUS, ≥1 confirmed with cited timeline events (env) — verdict DANGEROUS,
#      recorded-confirmed set reproduces exactly, confirmed cite ⊆ timeline, consumed
#   C3 DANGEROUS, multiple confirmed (dns)                       — verdict DANGEROUS, every recorded-confirmed reproduces
#   C4 stale artifacts (unresolved-module crash) vs current defer rule (is-number)
#      — PIN/finding: current orchestrator DEFERs → SAFE-with-deferred is unreachable
# Adversarial pass: W2 — "does render_timeline over the PERSISTED (canonicalized)
#   artifact reproduce the record-time judge prompt?" No — RFC-8785 sorts keys and
#   normalizes whole floats, so the record-time timeline TEXT is committed and replayed;
#   render_timeline still supplies the (stable) event-id set. See llm_replay.RecordedSandbox.
#
# Blackbox: drives the public orchestrator seam and asserts observable effects
# (graph verdict, confirmed citations, provider consumption). No private provider
# introspection beyond the replay index's own consumption bookkeeping.

from __future__ import annotations

from pathlib import Path

import pytest

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard import orchestrator as orchestrator_module
from npmguard.audit_log import AuditLog
from npmguard.config import Settings
from npmguard.contract.models import Hypothesis
from npmguard.evidence import ArtifactStore, render_timeline
from npmguard.graph import build_graph, derive_graph_verdict
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.orchestrator import OrchestratorSummary, run_orchestrator
from tests.support.llm_replay import Bundle, IndexedReplayProvider, RecordedSandbox, load_bundle

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "llm"


async def _replay_orchestrator(
    bundle_dir: str, monkeypatch, tmp_path: Path
) -> tuple[Bundle, object, IndexedReplayProvider, OrchestratorSummary]:
    """Drive the real orchestrator over one committed bundle. Returns
    (bundle, graph, provider, summary). The judge index excludes provider_error
    exchanges: a 200-with-no-choices advances the chain to an unrecorded fallback
    slug (the corpus never captured a fallback judge attempt), so replaying it would
    diverge; every other recorded judge attempt is served content-addressed."""
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "logs"))
    bundle = load_bundle(FIXTURES / bundle_dir)

    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'replay.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)

    settings = Settings(_env_file=None)
    object.__setattr__(settings, "triage_model", bundle.models["triage"])
    object.__setattr__(settings, "investigation_model", bundle.models["investigation"])

    judge_exchanges = [
        exchange
        for exchange in bundle.exchanges_for_roles({"judge"})
        if exchange.attempt_status != "provider_error"
    ]
    provider = IndexedReplayProvider(judge_exchanges)
    llm = build_npmguard_llm(sessions, settings, provider=provider)

    hypotheses = [Hypothesis.model_validate(h) for h in bundle.hypotheses]
    graph, _, _ = build_graph(f"replay-{bundle.package}", hypotheses)
    sandbox = RecordedSandbox(bundle)

    monkeypatch.setattr(orchestrator_module, "run_experiment", sandbox.run_experiment)
    log = AuditLog(bundle.package)
    store = ArtifactStore(log.run_dir)
    try:
        summary = await run_orchestrator(
            graph,
            package_path=tmp_path,
            artifact_store=store,
            log=log,
            emitter=None,
            stated_purpose=bundle.manifest["statedPurpose"],
            global_budget_ms=6_000_000,
            settings=settings,
            llm=llm,
        )
    finally:
        await llm.aclose()
        await engine.dispose()
    return bundle, graph, provider, summary


def _assert_confirmed_cite_valid_timeline(bundle: Bundle, graph) -> None:
    confirmed = graph.filter_by_state("CONFIRMED")
    assert confirmed, "expected at least one confirmed hypothesis"
    for hypothesis in confirmed:
        artifact = bundle.sandbox[hypothesis.hypId]
        timeline = render_timeline(artifact)
        cited = set(bundle.sandbox_expected[hypothesis.hypId]["citedEvents"])
        assert cited, f"confirmed {hypothesis.hypId} recorded no cited events"
        unknown = cited - timeline.ids
        assert not unknown, f"{hypothesis.hypId} cites events absent from timeline: {sorted(unknown)}"


async def test_chalk_replays_safe(monkeypatch, tmp_path) -> None:
    """C1: a benign audit replays to SAFE with every suspicion refuted, zero
    unmatched, and every required judge exchange consumed."""
    bundle, graph, provider, summary = await _replay_orchestrator(
        "chalk@5.6.2", monkeypatch, tmp_path
    )
    verdict = derive_graph_verdict(graph)
    assert verdict.verdict == "SAFE" == bundle.expected_verdict
    assert summary.confirmed == 0
    assert summary.deferred == 0
    assert provider.unmatched == []
    provider.assert_consumed()


async def test_env_exfil_replays_dangerous_with_cited_evidence(monkeypatch, tmp_path) -> None:
    """C2: the env-exfil audit replays to DANGEROUS; the EXACT recorded-confirmed
    set reproduces (same fidelity bar as C3 — `>= 1` alone would let a recorded
    confirmation silently flip to DEFERRED), every confirmed hypothesis cites
    timeline event ids that exist in its rendered artifact, and every required
    judge exchange is consumed."""
    bundle, graph, provider, summary = await _replay_orchestrator(
        "test-pkg-env-exfil@2.0.1", monkeypatch, tmp_path
    )
    verdict = derive_graph_verdict(graph)
    assert verdict.verdict == "DANGEROUS" == bundle.expected_verdict
    recorded_confirmed = {
        hyp_id
        for hyp_id, expected in bundle.sandbox_expected.items()
        if expected["confirmed"]
    }
    replayed_confirmed = {node.hypId for node in graph.filter_by_state("CONFIRMED")}
    assert recorded_confirmed == replayed_confirmed
    assert summary.confirmed >= 1
    assert provider.unmatched == []
    provider.assert_consumed()
    _assert_confirmed_cite_valid_timeline(bundle, graph)


async def test_dns_exfil_replays_dangerous_all_confirmations(monkeypatch, tmp_path) -> None:
    """C3: the dns-exfil audit replays to DANGEROUS; every hypothesis the recording
    confirmed reproduces as CONFIRMED with valid cited timeline events."""
    bundle, graph, provider, summary = await _replay_orchestrator(
        "test-pkg-dns-exfil@0.2.1", monkeypatch, tmp_path
    )
    verdict = derive_graph_verdict(graph)
    assert verdict.verdict == "DANGEROUS" == bundle.expected_verdict
    recorded_confirmed = {
        hyp_id
        for hyp_id, expected in bundle.sandbox_expected.items()
        if expected["confirmed"]
    }
    replayed_confirmed = {node.hypId for node in graph.filter_by_state("CONFIRMED")}
    assert recorded_confirmed == replayed_confirmed
    assert provider.unmatched == []
    provider.assert_consumed()
    _assert_confirmed_cite_valid_timeline(bundle, graph)


async def test_is_number_stale_artifacts_defer_under_current_rule(monkeypatch, tmp_path) -> None:
    """C4 (finding, not a fix): the pinned is-number run's artifacts crashed on an
    unresolved-module error (a driver-path bug). The CURRENT orchestrator DEFERs an
    unresolved-module crash instead of refuting it, so this recorded-SAFE audit
    replays to all-DEFERRED — derive_graph_verdict then refuses SAFE-with-deferred.
    Pinning current behavior; the fixture is faithful, the drift is in the recording
    predating the defer rule. See PINNED.json groundTruthNote."""
    bundle, graph, provider, summary = await _replay_orchestrator(
        "is-number@7.0.0", monkeypatch, tmp_path
    )
    assert bundle.expected_verdict == "SAFE"  # curator ground truth (package is benign)
    assert summary.confirmed == 0
    assert summary.deferred == len(bundle.hypotheses)
    assert provider.unmatched == []
    with pytest.raises(AssertionError, match="unevaluated"):
        derive_graph_verdict(graph)

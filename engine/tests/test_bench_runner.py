# CLASS MAP — bench.runner: the ops runner on the unbilled lane
# (seam: the HTTP boundary, via an httpx MockTransport. No engine, no docker, no
#  git, and NO fixture is read — every class below is about what the runner does
#  BEFORE and AROUND an audit, which is where all four of its constraints live.)
#
# "Must not starve real work" (the queue is bounded and shared with paid audits):
#   C1  a full queue (NPMGUARD-0040) is BACK-PRESSURE: the runner waits and
#       retries, and does not record an observation. Recording a VOID instead would
#       let the harness's own impatience shrink the denominator
#   C2  any other refusal is recorded as an attempt with auditId None + its reason,
#       never retried forever
#   C3  a fresh audit per run index: the runner never consults an existing report,
#       so a cache hit cannot become a replicate (B-10). `--skip-existing` does not
#       exist on this command
# "Never fabricate a measurement":
#   C4  a dirty working tree is refused — engineSha would not describe the engine
#   C5  --allow-dirty is the explicit escape hatch, and it is named as such
#   C6  a mock-LLM engine is refused: no ledger row means no observed model, no
#       tokens, no cost
#   C7  an unresolvable sandbox image digest is refused (F-G5 makes it mandatory,
#       and settings.sandbox_image is a MUTABLE TAG, not an identifier)
# "The client timeout must exceed the ENGINE's envelope" (§7.4):
#   C8  the default is above the engine's ~77-minute scale-1 phase envelope, unlike
#       audit-batch's 20-minute default which would abandon a succeeding audit
#   C9  a client-side timeout is recorded with the HARNESS code, so the projector
#       buckets it VOID and never ABSTAINED
# Live malware (F-G7):
#   C10 the fixture check is `is_dir()` only — the runner never opens, copies or
#       executes a corpus fixture, and a missing one is a corpus bug that voids its
#       observations rather than a crash

import argparse
from pathlib import Path

import httpx
import pytest

from npmguard.bench import runner
from npmguard.bench.corpus import Corpus, Entry
from npmguard.bench.projector import HARNESS_TIMEOUT_CODE


def _entry(name: str) -> Entry:
    return Entry(
        id=1,
        corpus_id=1,
        fixture_name=name,
        package_name="pkg",
        version="1.0.0",
        category="datadog-compromised",
        expected_verdict="DANGEROUS",
        discovery_date=None,
        rationale=None,
        source_id=None,
    )


def _api(handler) -> runner.BenchApi:
    api = runner.BenchApi(base_url="http://engine", key="k", timeout_ms=1_000, poll_ms=1)
    api.client = httpx.AsyncClient(
        base_url="http://engine", transport=httpx.MockTransport(handler)
    )
    return api


async def test_a_full_queue_is_back_pressure_not_an_observation(monkeypatch) -> None:
    """C1: the wait queue is bounded (queue_size, default 50) and shared with paid
    audits, so 280 bench admissions fired at once would push real work into a 503.
    The refusal means "the engine is busy with real work", which is not a fact about
    the tool and must not enter any denominator."""
    calls: list[int] = []
    slept: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(
                429, json={"error": "queue full", "code": "NPMGUARD-0040", "retryable": True}
            )
        return httpx.Response(202, json={"status": "accepted", "auditId": "fresh-1"})

    async def _sleep(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr(runner.asyncio, "sleep", _sleep)
    api = _api(handler)
    try:
        assert await api.admit("test-pkg-bench-x") == "fresh-1"
    finally:
        await api.close()
    assert len(calls) == 3
    assert slept == [runner._QUEUE_FULL_BACKOFF_SECONDS] * 2


async def test_a_real_refusal_is_recorded_not_retried() -> None:
    """C2: a 402/400/500 is not back-pressure. It raises with the engine's own
    message, and `_one` records it as an attempt that never reached an audit."""
    api = _api(lambda request: httpx.Response(402, json={"error": "Payment required."}))
    try:
        with pytest.raises(runner.BenchRunnerError, match="Payment required"):
            await api.admit("test-pkg-bench-x")
    finally:
        await api.close()


async def test_the_runner_never_consults_an_existing_report() -> None:
    """C3: B-10 — a cache hit is not an observation. `POST /audit` reaches
    AuditService.admit, which always creates a new audit_sessions row, and the
    runner has no skip-existing path to short-circuit it. Asserted at the HTTP
    boundary: the only request an admission makes is the POST."""
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return httpx.Response(202, json={"auditId": "a1"})

    api = _api(handler)
    try:
        await api.admit("test-pkg-bench-x")
    finally:
        await api.close()
    assert seen == [("POST", "/audit")]
    assert "skip_existing" not in {action.dest for action in _parser()._actions}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    runner.add_arguments(parser)
    return parser


def test_a_dirty_tree_is_refused(monkeypatch) -> None:
    """C4: a fidelity or detection number taken against a working tree is not a
    measurement — the methodology's own figures moved 4,140 -> 4,616 rendered rows
    mid-run because a peer was editing evidence.py."""

    class _Result:
        def __init__(self, out: str) -> None:
            self.stdout = out
            self.stderr = ""
            self.returncode = 0

    def _run(command, **kwargs):
        return _Result("cafebabe\n" if command[1] == "rev-parse" else " M engine/foo.py\n")

    monkeypatch.setattr(runner.subprocess, "run", _run)
    with pytest.raises(runner.BenchRunnerError, match="working tree is dirty"):
        runner.engine_sha(allow_dirty=False)
    # C5: the escape hatch exists and says what it costs.
    assert runner.engine_sha(allow_dirty=True) == "cafebabe"


async def test_a_mock_llm_engine_is_refused(monkeypatch) -> None:
    """C6: with NPMGUARD_MOCK_LLM on, `llm_attempts` gets no row — so the run has no
    observed model, no token count and no cost. That is a benchmark of the mock."""
    from npmguard.config import get_settings

    monkeypatch.setenv("NPMGUARD_MOCK_LLM", "true")
    get_settings.cache_clear()
    try:
        args = _parser().parse_args(["--corpus", "0.2.0-datadog"])
        with pytest.raises(runner.BenchRunnerError, match="NPMGUARD_MOCK_LLM"):
            await runner.bench_run(args)
    finally:
        get_settings.cache_clear()


def test_an_unresolvable_sandbox_image_is_refused(monkeypatch) -> None:
    """C7: `sandbox_image` is a mutable tag (`npmguard-sandbox:v1`) and a tag can be
    rebuilt, so the runner resolves the concrete local image Id. F-G5 makes it
    non-nullable, so failing to resolve one must stop the run rather than write a
    null into a mandatory identifier — which is what the v1 TypeScript runner did."""

    class _Result:
        stdout = ""
        stderr = "No such image"
        returncode = 1

    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: _Result())
    with pytest.raises(runner.BenchRunnerError, match="mandatory run identifier"):
        runner.sandbox_image_digest("npmguard-sandbox:v1")


def test_the_client_timeout_exceeds_the_engine_envelope() -> None:
    """C8: §7.4's trap. `npmguard-ops audit-batch` defaults to 20 minutes, which is
    BELOW the engine's own ~77-minute scale-1 phase envelope, so a slow-but-
    succeeding audit is abandoned and recorded as a failure the engine never had."""
    engine_envelope_ms = 77 * 60 * 1_000
    assert engine_envelope_ms < runner.DEFAULT_TIMEOUT_MS
    assert _parser().parse_args(["--corpus", "x"]).timeout_ms == runner.DEFAULT_TIMEOUT_MS
    # And N defaults to B-8's answer: 2 is the cheapest N that can observe a
    # disagreement, and higher N actively worsens the published bound.
    assert _parser().parse_args(["--corpus", "x"]).runs == 2
    assert _parser().parse_args(["--corpus", "x"]).concurrency == 1


async def test_a_client_timeout_is_recorded_with_the_harness_code() -> None:
    """C9: the runner giving up is a harness artifact, so it carries a BENCH- code
    that cannot collide with an NPMGUARD one and that the projector buckets VOID.
    Filing it as ABSTAINED would blame the tool for the runner's patience."""
    recorded: list[object] = []

    class _Store:
        async def record(self, run_id, attempt):
            recorded.append(attempt)

    class _Api:
        timeout_ms = 1_000

        async def admit(self, package_name):
            return "a1"

        async def wait(self, audit_id):
            return False

    import asyncio

    await runner._one(_Api(), _Store(), 1, _entry("test-pkg-bench-x"), 0, asyncio.Semaphore(1))
    assert recorded[0].code == HARNESS_TIMEOUT_CODE
    assert recorded[0].audit_id == "a1"
    assert "gave up" in recorded[0].error


def test_a_missing_fixture_is_detected_without_reading_it(tmp_path: Path, monkeypatch) -> None:
    """C10: corpus fixtures are LIVE MALWARE from the Datadog corpus. The runner
    decides "is this entry runnable" from `is_dir()` alone — it never opens, copies
    or executes one, and `sandbox/` is deliberately not an npm workspace so a
    fixture install cannot reach the repo root. The engine's own resolver copies it
    into a private workdir and the sandbox executes it there, or nowhere."""
    fixtures = tmp_path / "test-fixtures"
    (fixtures / "test-pkg-bench-present").mkdir(parents=True)
    monkeypatch.setattr(runner, "FIXTURES_DIR", fixtures)
    corpus = Corpus(
        id=1,
        name="unit",
        version="1.0",
        source="datadog",
        dataset_version="1.0-unit",
        manifest_sha="deadbeef",
        generated_at="2026-07-25T00:00:00Z",
        path=tmp_path / "unit.json",
        entries=(_entry("test-pkg-bench-present"), _entry("test-pkg-bench-absent")),
    )
    missing = runner._missing_fixtures(corpus)
    assert [entry.fixture_name for entry in missing] == ["test-pkg-bench-absent"]
    # No read happened: the present fixture directory is still empty.
    assert list((fixtures / "test-pkg-bench-present").iterdir()) == []

"""Benchmark-runner policy at its HTTP and process boundaries.

HTTP uses `MockTransport`; git and Docker commands are replaced at their process
seams. No corpus fixture is read. Axes: admission outcome, reproducibility
identifiers, timeout ownership, and fixture presence.
"""

import argparse
from pathlib import Path
from typing import cast

import httpx
import pytest

from npmguard.bench import runner
from npmguard.bench.corpus import Corpus, Entry
from npmguard.bench.projector import HARNESS_TIMEOUT_CODE
from npmguard.bench.runner import BenchApi
from npmguard.bench.store import Attempt, BenchRunStore
from tests.support.optional import present


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
    api.client = httpx.AsyncClient(base_url="http://engine", transport=httpx.MockTransport(handler))
    return api


async def test_a_full_queue_is_back_pressure_not_an_observation(monkeypatch) -> None:
    """C1: queue-full responses wait and retry instead of becoming observations."""
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
        assert await api.admit("test-pkg-bench-x", "/fixtures/test-pkg-bench-x") == "fresh-1"
    finally:
        await api.close()
    assert len(calls) == 3
    assert len(slept) == 2
    assert all(seconds > 0 for seconds in slept)


async def test_a_real_refusal_is_recorded_not_retried() -> None:
    """C2: a non-capacity refusal raises with the engine's message."""
    api = _api(lambda request: httpx.Response(402, json={"error": "Payment required."}))
    try:
        with pytest.raises(runner.BenchRunnerError, match="Payment required"):
            await api.admit("test-pkg-bench-x", "/fixtures/test-pkg-bench-x")
    finally:
        await api.close()


async def test_the_runner_never_consults_an_existing_report() -> None:
    """C3: admission always requests a fresh audit and never reads a report."""
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return httpx.Response(202, json={"auditId": "a1"})

    api = _api(handler)
    try:
        await api.admit("test-pkg-bench-x", "/fixtures/test-pkg-bench-x")
    finally:
        await api.close()
    assert seen == [("POST", "/audit")]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    runner.add_arguments(parser)
    return parser


def test_a_dirty_tree_is_refused(monkeypatch) -> None:
    """C4/C5: dirty source is refused unless the operator marks it unpublishable."""

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
    """C6: a mock model cannot produce a publishable benchmark."""
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
    """C7: a run is refused when its sandbox bytes cannot be identified."""

    class _Result:
        stdout = ""
        stderr = "No such image"
        returncode = 1

    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: _Result())
    with pytest.raises(runner.BenchRunnerError, match="mandatory run identifier"):
        runner.sandbox_image_digest("npmguard-sandbox:v1")


def test_the_client_timeout_exceeds_the_engine_envelope() -> None:
    """C8: the client default covers the measured scale-1 engine envelope."""
    engine_envelope_ms = 77 * 60 * 1_000
    assert engine_envelope_ms < runner.DEFAULT_TIMEOUT_MS
    assert _parser().parse_args(["--corpus", "x"]).timeout_ms == runner.DEFAULT_TIMEOUT_MS
    assert _parser().parse_args(["--corpus", "x"]).runs == 2
    assert _parser().parse_args(["--corpus", "x"]).concurrency == 1


async def test_a_client_timeout_is_recorded_with_the_harness_code() -> None:
    """C9: a client timeout is recorded as a harness failure, not a tool result."""
    recorded: list[Attempt] = []

    class _Store:
        async def record(self, run_id: int, attempt: Attempt) -> None:
            recorded.append(attempt)

    class _Api:
        timeout_ms = 1_000

        async def admit(self, package_name, local_path):
            return "a1"

        async def wait(self, audit_id):
            return False

    import asyncio

    await runner._one(
        cast(BenchApi, _Api()),
        cast(BenchRunStore, _Store()),
        1,
        _entry("test-pkg-bench-x"),
        0,
        asyncio.Semaphore(1),
    )
    assert recorded[0].code == HARNESS_TIMEOUT_CODE
    assert recorded[0].audit_id == "a1"
    assert "gave up" in present(recorded[0].error)


def test_a_missing_fixture_is_detected_without_reading_it(tmp_path: Path, monkeypatch) -> None:
    """C10: fixture admission checks directory presence without reading malware."""
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
    assert list((fixtures / "test-pkg-bench-present").iterdir()) == []

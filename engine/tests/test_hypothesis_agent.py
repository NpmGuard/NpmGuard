# CLASS MAP — agentic hypothesis generation + generator fallback + DB substitution
# (seams: ScriptedLlm/ToolCallStep behind build_npmguard_llm; real sqlite via
#  create_all — C10 proves create_all ≡ the shipped alembic migrations, the kit
#  substitution rule that legitimizes every create_all DB in this suite;
#  dry_run_load conftest no-op, re-patched where the gate is the class)
# Axes: tool-loop outcome (armed / rejected+retried / never-finalized / nudged /
#       budget-exhausted), dry-run gate verdict, fallback policy, schema parity
#   C1 propose → validated tool loop → finalize arms a compilable experiment
#   C2 invalid finalize target rejected with precise feedback; retry arms
#   C3 dry-run load failure fed back into the loop; corrected retry arms
#   C4 loop never finalizes (model keeps answering) → honest AuditIncompleteError
#   C5 model answers with setup done but no finalize → ONE bounded nudge names the
#      gap; a finalize inside the nudge window still arms
#   C6 step budget exhausts with the model still tool-calling → incomplete, no arm
#   C7 fallback: primary cannot arm → secondary generates
#   C8 fallback: primary arms → secondary never consulted
#   C9 fallback: BudgetExhausted is terminal — never retried on the secondary
#  C10 create_all ≡ alembic upgrade head (autogenerate diff empty on BOTH
#      sides; drift reconciled by migration 0004)
# TODO (A1 2026-07-23): phase-1 propose failure (model chain exhausted DURING
#   propose, before any agent turn) has no class — needs a kit provider seam
#   that fails the propose slug specifically; not scriptable with ScriptedLlm's
#   per-role step lists without faking the seam. Add when kit exposes it.
# Adversarial pass: 2026-07-23/W6 — added the nudge/budget boundary classes and
# the migration-substitution proof the audit flagged as unmet.
import json
import os
import subprocess
import sys
from pathlib import Path

from kit_llm import ScriptedLlm, ToolCallStep
from kit_llm.errors import BudgetExhausted
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.contract.models import EntryPoints, Hypothesis, RunError
from npmguard.errors import AuditIncompleteError
from npmguard.hypothesis_agent import (
    FallbackHypothesisGenerator,
    HypothesisProposal,
    TwoPhaseHypothesisGenerator,
)
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.phases import Flag, PackageIntent

_INTENT = PackageIntent(statedPurpose="fixture", expectedCapabilities=[], rationale="manifest")
_FLAG = Flag(file="index.js", lines=["2-2"], why="reads a sensitive npm token")
_ENTRY = EntryPoints(install=[], runtime=["index.js"], bin=[])


def _package(tmp_path):
    package = tmp_path / "package"
    package.mkdir()
    (package / "package.json").write_text(
        json.dumps({"name": "fixture", "main": "index.js"}), encoding="utf-8"
    )
    (package / "index.js").write_text(
        "module.exports = () => {\nconst token = process.env.NPM_TOKEN;\nreturn token;\n};\n",
        encoding="utf-8",
    )
    return package


async def _llm(tmp_path, provider):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'agent.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    return build_npmguard_llm(sessions, Settings(_env_file=None), provider=provider), engine


async def test_two_phase_arms_via_validated_tool_loop(tmp_path) -> None:
    """C1: phase 1 proposes; phase 2 builds each tool through the validated tool
    loop and finalizes an armed trigger (the dry-run load gate is a conftest
    no-op at this tier — C3 re-patches it to prove the gate's own behavior)."""
    proposal = HypothesisProposal(
        description="exfiltrates NPM_TOKEN",
        kind="env_exfil",
        gating=None,
        severity="high",
        triggerTargetIntent="index.js",
        plannedTools=["setEnv"],
        rationale="plant the token, run the entry point",
    )
    provider = ScriptedLlm(
        {
            "propose": [proposal],
            "agent": [
                ToolCallStep([("setEnv", {"vars": [{"name": "NPM_TOKEN", "value": "canary"}]})]),
                ToolCallStep([("finalize", {"target": "index.js"})]),
                "done",
            ],
        }
    )
    llm, engine = await _llm(tmp_path, provider)
    result = await TwoPhaseHypothesisGenerator(llm, Settings(_env_file=None)).generate(
        _FLAG,
        package_path=_package(tmp_path),
        intent=_INTENT,
        entry_points=_ENTRY,
        hypothesis_id="hyp-0001",
        created_at="2026-07-22T00:00:00Z",
        audit_id="audit-agent",
    )
    assert isinstance(result, Hypothesis)
    assert result.claim.kind == "env_exfil"
    assert [call.tool for call in result.experiment] == ["setEnv", "trigger"]
    assert result.experiment[-1].args["target"] == "index.js"
    await llm.aclose()
    await engine.dispose()


async def test_two_phase_oracle_rejects_bad_target_then_recovers(tmp_path) -> None:
    """C2: a finalize with an invalid, non-JS target is rejected with precise
    feedback; the model's corrected retry arms."""
    proposal = HypothesisProposal(
        description="exfiltrates NPM_TOKEN",
        kind="env_exfil",
        gating=None,
        severity="high",
        triggerTargetIntent="nope.js",
        plannedTools=[],
        rationale="run it",
    )
    provider = ScriptedLlm(
        {
            "propose": [proposal],
            "agent": [
                ToolCallStep([("finalize", {"target": "does-not-exist.js"})]),  # rejected
                ToolCallStep([("finalize", {"target": "index.js"})]),  # corrected
                "done",
            ],
        }
    )
    llm, engine = await _llm(tmp_path, provider)
    result = await TwoPhaseHypothesisGenerator(llm, Settings(_env_file=None)).generate(
        _FLAG,
        package_path=_package(tmp_path),
        intent=_INTENT,
        entry_points=_ENTRY,
        hypothesis_id="hyp-0001",
        created_at="2026-07-22T00:00:00Z",
        audit_id="audit-agent",
    )
    assert [call.tool for call in result.experiment] == ["trigger"]
    await llm.aclose()
    await engine.dispose()


async def test_two_phase_dry_run_load_failure_is_repaired_in_loop(tmp_path, monkeypatch) -> None:
    """C3: a first finalize whose payload does not load is rejected with the load error;
    the model's corrected retry passes the dry-run and arms."""
    calls = {"n": 0}

    async def _load_check(*_args, **_kwargs):
        calls["n"] += 1
        return RunError(kind="CrashError", detail="Cannot find module 'src/x.js'") if calls["n"] == 1 else None

    monkeypatch.setattr("npmguard.hypothesis_agent.dry_run_load", _load_check)
    proposal = HypothesisProposal(
        description="invoke via a driver", kind="env_exfil", gating=None, severity="high",
        triggerTargetIntent="custom driver", plannedTools=[], rationale="drive it",
    )
    provider = ScriptedLlm(
        {
            "propose": [proposal],
            "agent": [
                ToolCallStep([("finalize", {"target": "index.js", "driverCode": "require('src/x.js')"})]),
                ToolCallStep([("finalize", {"target": "index.js", "driverCode": "require('./index.js')"})]),
                "done",
            ],
        }
    )
    llm, engine = await _llm(tmp_path, provider)
    result = await TwoPhaseHypothesisGenerator(llm, Settings(_env_file=None)).generate(
        _FLAG, package_path=_package(tmp_path), intent=_INTENT, entry_points=_ENTRY,
        hypothesis_id="hyp-0001", created_at="t", audit_id="a",
    )
    assert calls["n"] == 2  # the gate ran twice: rejected, then accepted
    assert result.experiment[-1].tool == "trigger"
    await llm.aclose()
    await engine.dispose()


async def test_two_phase_without_finalize_fails_as_incomplete(tmp_path) -> None:
    """C4: if the loop never finalizes, the hypothesis is honestly incomplete."""
    proposal = HypothesisProposal(
        description="x", kind="telemetry", gating=None, severity="low",
        triggerTargetIntent="index.js", plannedTools=[], rationale="",
    )
    provider = ScriptedLlm({"propose": [proposal], "agent": ["I give up"]})
    llm, engine = await _llm(tmp_path, provider)
    try:
        await TwoPhaseHypothesisGenerator(llm, Settings(_env_file=None)).generate(
            _FLAG, package_path=_package(tmp_path), intent=_INTENT, entry_points=_ENTRY,
            hypothesis_id="h1", created_at="t", audit_id="a",
        )
        raise AssertionError("expected AuditIncompleteError")
    except AuditIncompleteError as exc:
        assert "hypothesize" in str(exc)
    await llm.aclose()
    await engine.dispose()


class _Armed:
    def __init__(self, tag: str) -> None:
        self.tag = tag

    async def generate(self, flag, **kwargs) -> Hypothesis:
        return Hypothesis(
            hypId="h", description=self.tag, claim={"kind": "env_exfil", "gating": None},
            focusFiles=[flag.file], focusLines=[], experiment=[], severity="low",
            state="OPEN", createdBy="hypothesize", createdAt="t",
        )


class _Fails:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc
        self.called = False

    async def generate(self, flag, **kwargs) -> Hypothesis:
        self.called = True
        raise self.exc


async def test_agent_nudge_recovers_a_stopped_model(tmp_path) -> None:
    """C5: the model answers with the bait set up but the trigger never called;
    the single bounded nudge names the gap and the finalize it elicits arms."""
    proposal = HypothesisProposal(
        description="exfiltrates NPM_TOKEN", kind="env_exfil", gating=None, severity="high",
        triggerTargetIntent="index.js", plannedTools=["setEnv"], rationale="plant then run",
    )
    provider = ScriptedLlm(
        {
            "propose": [proposal],
            "agent": [
                ToolCallStep([("setEnv", {"vars": [{"name": "NPM_TOKEN", "value": "canary"}]})]),
                "all set up, stopping here",  # answered without finalize → nudge
                ToolCallStep([("finalize", {"target": "index.js"})]),
                "done",
            ],
        }
    )
    llm, engine = await _llm(tmp_path, provider)
    result = await TwoPhaseHypothesisGenerator(llm, Settings(_env_file=None)).generate(
        _FLAG, package_path=_package(tmp_path), intent=_INTENT, entry_points=_ENTRY,
        hypothesis_id="hyp-0001", created_at="t", audit_id="a",
    )
    assert [call.tool for call in result.experiment] == ["setEnv", "trigger"]
    assert result.experiment[-1].args["target"] == "index.js"
    await llm.aclose()
    await engine.dispose()


async def test_agent_step_budget_exhaustion_is_incomplete(tmp_path) -> None:
    """C6: a model that tool-calls forever exhausts max_steps in the main drive
    AND the nudge window — the result is an honest incomplete, never a
    fabricated trigger."""
    proposal = HypothesisProposal(
        description="never finishes", kind="env_exfil", gating=None, severity="low",
        triggerTargetIntent="index.js", plannedTools=["setEnv"], rationale="loops",
    )
    endless_setup = ToolCallStep(
        [("setEnv", {"vars": [{"name": "NPM_TOKEN", "value": "canary"}]})]
    )
    provider = ScriptedLlm({"propose": [proposal], "agent": [endless_setup]})  # repeats forever
    llm, engine = await _llm(tmp_path, provider)
    try:
        await TwoPhaseHypothesisGenerator(llm, Settings(_env_file=None)).generate(
            _FLAG, package_path=_package(tmp_path), intent=_INTENT, entry_points=_ENTRY,
            hypothesis_id="hyp-0001", created_at="t", audit_id="a",
        )
        raise AssertionError("expected AuditIncompleteError")
    except AuditIncompleteError as exc:
        assert "without a compiled trigger" in str(exc)
    await llm.aclose()
    await engine.dispose()


async def test_fallback_uses_secondary_when_primary_cannot_arm() -> None:
    """C7: AuditIncompleteError from the primary hands off to the secondary."""
    secondary = _Armed("from-secondary")
    gen = FallbackHypothesisGenerator(_Fails(AuditIncompleteError("hypothesize", "no arm")), secondary)
    result = await gen.generate(_FLAG)
    assert result.description == "from-secondary"


async def test_fallback_prefers_primary_when_it_arms() -> None:
    """C8: an armed primary means the secondary is never consulted."""
    secondary = _Fails(AssertionError("secondary must not run"))
    gen = FallbackHypothesisGenerator(_Armed("from-primary"), secondary)
    result = await gen.generate(_FLAG)
    assert result.description == "from-primary"
    assert secondary.called is False


async def test_fallback_never_retries_on_budget_exhaustion() -> None:
    """C9: spend exhaustion is terminal — the secondary must not double the bill."""
    secondary = _Fails(AssertionError("secondary must not run on budget exhaustion"))
    gen = FallbackHypothesisGenerator(_Fails(BudgetExhausted("spent")), secondary)
    try:
        await gen.generate(_FLAG)
        raise AssertionError("expected BudgetExhausted to propagate")
    except BudgetExhausted:
        pass
    assert secondary.called is False


def test_create_all_matches_alembic_migrations(tmp_path) -> None:
    """C10: the create_all schema this suite runs on is equivalent to the shipped
    alembic chain (kit substitution rule): both diffs are EMPTY — no missing
    tables, columns, indexes, or column-type drift either way. Migration 0004
    reconciled the kit_llm capture-column widening this test once pinned."""
    # Table registration happens on import (same list alembic/env.py uses).
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine

    import kit_llm  # noqa: F401
    import kit_stream  # noqa: F401
    import npmguard.persistence  # noqa: F401

    def diff_of(sqlite_path: Path) -> list:
        engine = create_engine(f"sqlite:///{sqlite_path}")
        try:
            with engine.connect() as connection:
                return compare_metadata(MigrationContext.configure(connection), metadata)
        finally:
            engine.dispose()

    engine_root = Path(__file__).resolve().parents[1]
    migrated = tmp_path / "migrated.sqlite3"
    # Subprocess: alembic env.py reads NPMGUARD_DATABASE_URL via the lru_cached
    # get_settings; a fresh process sidesteps the cache and any test-local env.
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=engine_root,
        env={
            **dict(os.environ),
            "NPMGUARD_DATABASE_URL": f"sqlite+aiosqlite:///{migrated}",
        },
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, f"alembic upgrade head failed:\n{result.stderr}"

    assert diff_of(migrated) == []

    created = tmp_path / "created.sqlite3"
    engine = create_engine(f"sqlite:///{created}")
    try:
        metadata.create_all(engine)
    finally:
        engine.dispose()
    assert diff_of(created) == []

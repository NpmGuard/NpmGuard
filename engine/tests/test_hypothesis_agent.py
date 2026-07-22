import json

from kit_llm import ScriptedLlm, ToolCallStep
from kit_llm.errors import BudgetExhausted
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.contract.models import EntryPoints, Hypothesis
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
    """Phase 1 proposes; phase 2 builds each tool through the real oracle and
    finalizes a compilable trigger."""
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
    result = await TwoPhaseHypothesisGenerator(llm).generate(
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
    """A finalize with an invalid, non-JS target is rejected with precise
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
    result = await TwoPhaseHypothesisGenerator(llm).generate(
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


async def test_two_phase_without_finalize_fails_as_incomplete(tmp_path) -> None:
    """If the loop never finalizes, the hypothesis is honestly incomplete."""
    proposal = HypothesisProposal(
        description="x", kind="telemetry", gating=None, severity="low",
        triggerTargetIntent="index.js", plannedTools=[], rationale="",
    )
    provider = ScriptedLlm({"propose": [proposal], "agent": ["I give up"]})
    llm, engine = await _llm(tmp_path, provider)
    try:
        await TwoPhaseHypothesisGenerator(llm).generate(
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


async def test_fallback_uses_secondary_when_primary_cannot_arm() -> None:
    secondary = _Armed("from-secondary")
    gen = FallbackHypothesisGenerator(_Fails(AuditIncompleteError("hypothesize", "no arm")), secondary)
    result = await gen.generate(_FLAG)
    assert result.description == "from-secondary"


async def test_fallback_prefers_primary_when_it_arms() -> None:
    secondary = _Fails(AssertionError("secondary must not run"))
    gen = FallbackHypothesisGenerator(_Armed("from-primary"), secondary)
    result = await gen.generate(_FLAG)
    assert result.description == "from-primary"
    assert secondary.called is False


async def test_fallback_never_retries_on_budget_exhaustion() -> None:
    secondary = _Fails(AssertionError("secondary must not run on budget exhaustion"))
    gen = FallbackHypothesisGenerator(_Fails(BudgetExhausted("spent")), secondary)
    try:
        await gen.generate(_FLAG)
        raise AssertionError("expected BudgetExhausted to propagate")
    except BudgetExhausted:
        pass
    assert secondary.called is False

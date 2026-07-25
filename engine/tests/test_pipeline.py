# CLASS MAP — AuditPipeline.run boundary behavior: workdir ownership + the scaled
# phase budget.
# (seams: npmguard.pipeline.resolve_package → a prepared tmp package inside a tmp
#  "workdir"; ScriptedLlm behind build_npmguard_llm; the real sqlite session store;
#  npmguard.pipeline.FLAG_TIMEOUT_MS as the named budget boundary. NO docker: the
#  fixture package declares no runtime dependencies, so provision_dependencies
#  short-circuits before it would reach for the daemon.)
# Axes: outcome (success / timeout / disk error / DB error / broken manifest) ×
#       what must be left behind (workdir present ⇔ a result owns it)
#   C1 the flag PhaseLog's sourceFiles are EXACTLY phases.flag_source_files —
#      the same set run_flag reads (noise excluded), not "every source file"
#   C2 the scaled flag budget is computed over that same set: with 21 readable
#      sources and 41 noise files the reported timeout is base×1.025, never
#      base×2.05 (what the unfiltered 62-file list would buy)
#   C3 success → the workdir SURVIVES run(); AuditResult.cleanup() removes it
#      (the pairing that makes C4/C5/C6's absence assertions meaningful)
#   C4 log.write("resolve.json") fails (disk) → no workdir left behind. This
#      write used to sit OUTSIDE the pipeline's cleanup handler.
#   C5 sessions.set_package_path fails (DB) → same. Same pre-try window.
#   C6 malformed package.json → AuditIncompleteError(stage=inventory), NO report
#      returned (the audit cannot reach a verdict), workdir removed
# Blackbox: asserts only run()'s return value, the exception it raises, and the
# filesystem. The budget is observed through AuditTimeoutError's reported ms —
# the only place the engine publishes it.
from __future__ import annotations

import asyncio
import json
import re
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from kit_llm import LlmClient, ScriptedLlm
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard import pipeline as pipeline_module
from npmguard.audit_log import AuditLog
from npmguard.config import Settings
from npmguard.errors import AuditIncompleteError, AuditTimeoutError
from npmguard.inventory import analyze_inventory
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.persistence import AuditSessionStore
from npmguard.phases import flag_source_files
from npmguard.pipeline import AuditPipeline
from npmguard.resolve import ResolvedPackage

MANIFEST = json.dumps({"name": "pkg-under-test", "version": "3.1.4", "main": "index.js"})
CLEAN_SOURCE = "module.exports = 1;\n"
PHASE_DEADLINE_SECONDS = 30  # generous outer bound; a lost timeout would hang forever
SCALED_FLAG_BASE_MS = 400  # patched budget; the two candidate scales below
SCALE_FOR_21_READABLE = 1.025  # 1 + (21-20)×0.025 — the FLAG set
SCALE_FOR_ALL_62_SOURCES = 2.05  # 1 + (62-20)×0.025 — every source file, noise included


def _script(**extra: list[Any]) -> ScriptedLlm:
    return ScriptedLlm(
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
            **extra,
        }
    )


class _HangingFlagProvider(ScriptedLlm):
    """Serves intent from the script, then blocks forever on every flag call, so
    the flag phase's own budget is the only thing that can end it."""

    async def complete(self, request):
        if request.role == "flag":
            await asyncio.Event().wait()  # resolves only via cancellation
        return await super().complete(request)

    async def stream(self, request, on_token):
        if request.role == "flag":
            await asyncio.Event().wait()
        return await super().stream(request, on_token)


@pytest.fixture
async def build(tmp_path, monkeypatch):
    """Builds a pipeline over a package materialized in a private tmp workdir,
    exactly as resolve_package would hand one over."""
    opened: list[tuple[AsyncEngine, LlmClient]] = []

    async def _build(files: dict[str, str], provider) -> SimpleNamespace:
        monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "logs"))
        engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'pipeline.sqlite3'}")
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
        factory = make_session_factory(engine)
        sessions = AuditSessionStore(factory)
        settings = Settings(_env_file=None)
        llm = build_npmguard_llm(factory, settings, provider=provider)
        opened.append((engine, llm))

        workdir = tmp_path / "work"
        package = workdir / "package"
        package.mkdir(parents=True)
        for name, content in files.items():
            target = package / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

        async def _resolve(package_name: str, version: str | None = None) -> ResolvedPackage:
            return ResolvedPackage(path=package, workdir=workdir)

        monkeypatch.setattr(pipeline_module, "resolve_package", _resolve)
        session = await sessions.create("pkg-under-test", None)
        return SimpleNamespace(
            pipeline=AuditPipeline(settings, llm, sessions),
            sessions=sessions,
            workdir=workdir,
            package=package,
            audit_id=session.audit_id,
        )

    yield _build
    for engine, llm in opened:
        await llm.aclose()
        await engine.dispose()


async def _run(rig: SimpleNamespace):
    async with asyncio.timeout(PHASE_DEADLINE_SECONDS):
        return await rig.pipeline.run("pkg-under-test", audit_id=rig.audit_id)


NOISY_PACKAGE = {
    "package.json": MANIFEST,
    "index.js": CLEAN_SOURCE,
    "setup.js": CLEAN_SOURCE,
    # Read: code some model must see. A shipped shell script an install hook can
    # name, and an extensionless `#!node` program of the shape 13 of 94 real `bin`
    # targets ship (typescript's bin/tsc, rollup, esbuild, acorn, uuid).
    "install.sh": "echo installing\n",
    "bin/tool": "#!/usr/bin/env node\nconsole.log(1)\n",
    # Not read: generated declarations, in all three spellings. `.cts`/`.mts` map to
    # `ts`, so `.d.cts`/`.d.mts` were classified SOURCE and sent to a FLAG model as
    # if they were code — 1,515 such files over 834 installed packages, 4.2% of the
    # whole FLAG corpus, for output a declaration file cannot produce.
    "index.d.ts": "export declare const x: number;\n",
    "index.d.cts": "export declare const y: number;\n",
    "index.d.mts": "export declare const z: number;\n",
    # Not read: an extensionless file with no usable shebang, and one naming an
    # interpreter no FLAG prompt has been validated on. `unknown` is what keeps a
    # DECLARED entry point of that shape a reported coverage gap.
    "LICENSE": "MIT License\n",
    "tools/build.py": "print(1)\n",
    "test/helper.js": CLEAN_SOURCE,
    "tests/other.js": CLEAN_SOURCE,
    "__tests__/unit.js": CLEAN_SOURCE,
    "__mocks__/fs.js": CLEAN_SOURCE,
    "lib/index.test.js": CLEAN_SOURCE,
    "lib/index.spec.ts": CLEAN_SOURCE,
    "lib/index.spec.d.mts": "export {};\n",
}


async def test_flag_trace_names_exactly_the_files_flag_reads(build) -> None:
    """C1: the flag phase's recorded sourceFiles (the list the budget is scaled
    over) equals phases.flag_source_files equals the files that produced a
    FileSummary — one set, three observations. Every noise class ships in this
    package: .d.ts / .d.cts / .d.mts, test/, tests/, __tests__/, __mocks__/,
    *.test.*, *.spec.*. And both directions are pinned, because "exactly" is the
    claim: a shipped `.sh` and an extensionless `#!node` program ARE read (a declared
    entry point that reaches no model is a coverage gap wearing a green badge), while
    a `.py`, an extensionless licence and a declaration file are not."""
    rig = await build(NOISY_PACKAGE, _script())
    result = await _run(rig)

    expected = {file.path for file in flag_source_files(await analyze_inventory(rig.package))}
    # The shipped program, in every spelling a model reads — nothing else.
    assert expected == {"index.js", "setup.js", "install.sh", "bin/tool"}
    flag_phase = next(phase for phase in result.report.trace if phase.phase == "flag")
    assert {entry["path"] for entry in flag_phase.input["sourceFiles"]} == expected
    assert {summary.file for summary in result.report.fileSummaries} == expected
    assert result.report.verdict == "SAFE"  # zero flags → the early SAFE return
    result.cleanup()


async def test_flag_budget_scales_over_the_flag_set_only(build, monkeypatch) -> None:
    """C2: 21 readable sources + 41 noise files. The flag budget must be scaled
    for the 21, not for all 62. Observed through the timeout the engine reports
    (int-truncated, so compared against the same truncation)."""
    files = {"package.json": MANIFEST}
    files.update({f"lib/s{index}.js": CLEAN_SOURCE for index in range(21)})
    files.update({f"test/n{index}.js": CLEAN_SOURCE for index in range(14)})
    files.update({f"src/n{index}.spec.js": CLEAN_SOURCE for index in range(14)})
    files.update({f"types/n{index}.d.ts": "export {};\n" for index in range(13)})
    rig = await build(files, _HangingFlagProvider(_script().scripts))
    inventory = await analyze_inventory(rig.package)
    assert len(flag_source_files(inventory)) == 21
    assert len([f for f in inventory.files if f.fileType in {"js", "ts"}]) == 62

    monkeypatch.setattr(pipeline_module, "FLAG_TIMEOUT_MS", SCALED_FLAG_BASE_MS)
    with pytest.raises(AuditTimeoutError) as excinfo:
        await _run(rig)
    assert excinfo.value.stage == "flag"
    match = re.fullmatch(r'Phase "flag" timed out after (\d+)ms', str(excinfo.value))
    assert match is not None, str(excinfo.value)
    reported = int(match[1])
    assert reported == int(SCALED_FLAG_BASE_MS * SCALE_FOR_21_READABLE)
    assert reported < int(SCALED_FLAG_BASE_MS * SCALE_FOR_ALL_62_SOURCES)


async def test_success_hands_the_workdir_to_the_result(build) -> None:
    """C3: run() returns with the extracted package still on disk — the caller
    (AuditService._execute) owns cleanup — and AuditResult.cleanup() removes the
    whole private workdir. Without this pairing, C4-C6's absence proofs would
    also pass if run() simply deleted everything always."""
    rig = await build({"package.json": MANIFEST, "index.js": CLEAN_SOURCE}, _script())
    result = await _run(rig)
    assert rig.workdir.is_dir()
    result.cleanup()
    assert not rig.workdir.exists()


async def test_resolve_log_write_failure_leaves_no_workdir(build, monkeypatch) -> None:
    """C4: a disk error writing the resolve PhaseLog — the step that used to run
    OUTSIDE the pipeline's cleanup handler — removes the extracted package
    instead of orphaning it in the tmpdir until the host reaps /tmp."""
    rig = await build({"package.json": MANIFEST, "index.js": CLEAN_SOURCE}, _script())

    def _boom(self: AuditLog, name: str, data: object):
        raise OSError("no space left on device")

    monkeypatch.setattr(AuditLog, "write", _boom)
    with pytest.raises(OSError, match="no space left"):
        await _run(rig)
    assert not rig.workdir.exists()


async def test_set_package_path_failure_leaves_no_workdir(build, monkeypatch) -> None:
    """C5: the other half of the same pre-try window — a DB error recording the
    package path also leaves nothing behind."""
    rig = await build({"package.json": MANIFEST, "index.js": CLEAN_SOURCE}, _script())

    async def _boom(audit_id: str, path: str) -> None:
        raise RuntimeError("database is locked")

    monkeypatch.setattr(rig.sessions, "set_package_path", _boom)
    with pytest.raises(RuntimeError, match="database is locked"):
        await _run(rig)
    assert not rig.workdir.exists()


async def test_malformed_manifest_never_reaches_a_verdict(build) -> None:
    """C6: a package.json that does not parse ends the audit at the inventory
    phase with a located, retryable 0031. No report is returned, so no verdict —
    SAFE or otherwise — can be derived from a package whose manifest, scripts,
    entry points and dependencies were never read."""
    rig = await build({"package.json": "{ \"name\": \"broken\",", "index.js": CLEAN_SOURCE}, _script())
    with pytest.raises(AuditIncompleteError) as excinfo:
        await _run(rig)
    assert excinfo.value.stage == "inventory"
    assert excinfo.value.code == "NPMGUARD-0031"
    assert excinfo.value.retryable is True
    assert not rig.workdir.exists()

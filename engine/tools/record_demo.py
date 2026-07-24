"""Produce the two deterministic demo recordings under ``engine/demo-data/``.

Both recordings are contract-faithful to the DEV Python engine wire format
(engine-contract §3/§6): only event types the engine actually emits, the dev
``verdict_reached`` shape, and a schemaVersion-2 ``AuditReport``. Neither uses
docker.

- SAFE (chalk): a REAL end-to-end capture. Boots the real uvicorn engine
  (harness) against the in-process mock LLM (``scripted_safe_roles``) + the
  committed registry stub, then dumps the exact wire frames, the served source
  files, and the finalized report.

- DANGEROUS (test-pkg-env-exfil): a HYBRID capture. The orchestrator portion is
  driven for REAL over the committed env-exfil replay bundle (the slice-replay
  tier: ``IndexedReplayProvider`` + ``RecordedSandbox``, no docker), yielding
  authentic ``hypothesis_resolved`` frames, the real graph verdict, and the real
  schemaVersion-2 report. The pre-orchestrator frames (audit_started ->
  triage_complete -> graph_built) are reconstructed from the committed
  hypotheses + package sources, following the committed SSE skeleton's exact
  event-TYPE order (``tests/fixtures/sse/test-pkg-env-exfil.skeleton.json``).

Run: ``uv run python -m tools.record_demo [--safe] [--dangerous]`` (default: both).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

ENGINE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ENGINE_ROOT.parent
DEMO_DATA_DIR = ENGINE_ROOT / "demo-data"

# Event envelope fields the demo replay re-stamps on its own — never persist them.
_ENVELOPE_DROP = {"auditId", "seq"}


def _iso(base: datetime, step: int, *, ms: int = 250) -> str:
    return (base + timedelta(milliseconds=ms * step)).isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------
# SAFE: real end-to-end capture (chalk) via the e2e harness + mock LLM.
# --------------------------------------------------------------------------


def _tarball_sources(tgz: Path) -> dict[str, str]:
    """Extract text sources from an npm tarball, keyed by path minus the leading
    ``package/`` prefix (so keys match the engine's file_list paths). Binary
    members are skipped."""
    import tarfile

    sources: dict[str, str] = {}
    with tarfile.open(tgz) as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            handle = archive.extractfile(member)
            if handle is None:
                continue
            try:
                text = handle.read().decode("utf-8")
            except UnicodeDecodeError:
                continue
            sources[member.name.removeprefix("package/")] = text
    return sources


async def record_safe() -> dict[str, Any]:
    from tests.e2e.llm_mock import MockLlmClient, create_mock_app, scripted_safe_roles
    from tests.support.harness import ENGINE_ROOT as _ENGINE_ROOT
    from tests.support.sse import collect_frames, event_types, find_frame, terminal_frame
    from tests.support.stubs import RegistryStub, StubServer

    registry_fixtures = _ENGINE_ROOT / "tests" / "fixtures" / "registry"
    chalk_tgz = registry_fixtures / "chalk" / "chalk-5.6.2.tgz"
    spool = Path(tempfile.mkdtemp(prefix="demo-safe-spool-"))
    workdir = Path(tempfile.mkdtemp(prefix="demo-safe-engine-"))

    with StubServer(create_mock_app(spool)) as mock_server, RegistryStub() as registry:
        registry.load_dir(registry_fixtures)
        mock = MockLlmClient(mock_server.base_url)
        mock.load(scripted_roles=scripted_safe_roles())

        from tests.support.harness import EngineHarness

        engine = EngineHarness(
            workdir=workdir, llm_url=mock.v1_url, registry_url=registry.base_url
        )
        engine.start()
        try:
            started = engine.start_audit("chalk", version="5.6.2")
            audit_id = started["auditId"]
            frames = await collect_frames(engine.base_url, audit_id, deadline=120.0)

            terminal = terminal_frame(frames)
            assert terminal is not None and terminal.type == "verdict_reached", event_types(frames)
            assert terminal.data["verdict"] == "SAFE", terminal.data

            # Serve the source files the file_list advertised (non-binary only).
            # The live audit cleans up its extracted tarball, so the file bytes
            # come from the same committed tarball the engine just resolved.
            tarball_sources = _tarball_sources(chalk_tgz)
            files: dict[str, str] = {}
            file_list = find_frame(frames, "file_list")
            assert file_list is not None and file_list.data is not None
            for record in file_list.data["files"]:
                if record.get("isBinary"):
                    continue
                path = record["path"]
                if path in tarball_sources:
                    files[path] = tarball_sources[path]

            report = _poll_report(engine.base_url, audit_id)
            events = [
                {key: value for key, value in frame.data.items() if key not in _ENVELOPE_DROP}
                for frame in frames
                if frame.data is not None
            ]
        finally:
            engine.close()

    assert report["schemaVersion"] == 2 and report["verdict"] == "SAFE", report
    return {
        "packageName": "chalk",
        "version": "5.6.2",
        "events": events,
        "files": files,
        "report": report,
    }


def _poll_report(base_url: str, audit_id: str, *, attempts: int = 60) -> dict[str, Any]:
    import time

    import httpx

    for _ in range(attempts):
        response = httpx.get(f"{base_url}/audit/{audit_id}/report", timeout=15)
        if response.status_code == 200:
            return response.json()
        time.sleep(0.25)
    raise RuntimeError(f"report never finalized for {audit_id}")


# --------------------------------------------------------------------------
# DANGEROUS: real orchestrator over the env-exfil replay bundle + reconstruction.
# --------------------------------------------------------------------------


class _CapturingEmitter:
    """Duck-typed AuditEmitter: records (type, payload) instead of streaming."""

    def __init__(self) -> None:
        self.captured: list[tuple[str, dict[str, Any]]] = []

    async def emit(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self.captured.append((event_type, dict(payload or {})))


async def _run_env_exfil_orchestrator(tmp_path: Path):
    """Drive the REAL orchestrator over the committed env-exfil bundle (no docker).

    Mirrors tests/slice/test_replay_slices._replay_orchestrator but wires a
    capturing emitter so the authentic hypothesis_resolved frames are recorded.
    Returns (bundle, graph, resolved_frames)."""
    import os

    os.environ.setdefault("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "logs"))

    from kit_spine import make_engine, make_session_factory
    from kit_spine.db import metadata
    from npmguard import orchestrator as orchestrator_module
    from npmguard.audit_log import AuditLog
    from npmguard.config import Settings
    from npmguard.contract.models import Hypothesis
    from npmguard.evidence import ArtifactStore
    from npmguard.graph import build_graph
    from npmguard.llm_runtime import build_npmguard_llm
    from npmguard.orchestrator import run_orchestrator
    from tests.support.llm_replay import IndexedReplayProvider, RecordedSandbox, load_bundle

    bundle = load_bundle(ENGINE_ROOT / "tests" / "fixtures" / "llm" / "test-pkg-env-exfil@2.0.1")

    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'replay.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)

    settings = Settings(_env_file=None)
    object.__setattr__(settings, "triage_model", bundle.models["triage"])
    object.__setattr__(settings, "investigation_model", bundle.models["investigation"])

    judge_exchanges = [
        exchange
        for exchange in bundle.exchanges_for_roles({"judge"})
        if exchange.attempt_status != "provider_error"
    ]
    provider = IndexedReplayProvider(judge_exchanges)
    llm = build_npmguard_llm(sessions, settings, provider=provider)

    hypotheses = [Hypothesis.model_validate(h) for h in bundle.hypotheses]
    graph, _, _ = build_graph(f"replay-{bundle.package}", hypotheses)
    sandbox = RecordedSandbox(bundle)
    orchestrator_module.run_experiment = sandbox.run_experiment  # one-shot process

    log = AuditLog(bundle.package)
    store = ArtifactStore(log.run_dir)
    emitter = _CapturingEmitter()
    try:
        await run_orchestrator(
            graph,
            package_path=tmp_path,
            artifact_store=store,
            log=log,
            emitter=emitter,
            stated_purpose=bundle.manifest["statedPurpose"],
            global_budget_ms=6_000_000,
            settings=settings,
            llm=llm,
        )
    finally:
        await llm.aclose()
        await engine.dispose()

    resolved = [payload for event_type, payload in emitter.captured if event_type == "hypothesis_resolved"]
    return bundle, graph, resolved


def _env_exfil_sources() -> dict[str, str]:
    src = REPO_ROOT / "sandbox" / "test-fixtures" / "test-pkg-env-exfil"
    return {
        name: (src / name).read_text(encoding="utf-8")
        for name in ("index.js", "setup.js", "package.json")
    }


async def record_dangerous() -> dict[str, Any]:
    from npmguard.contract.models import FileRecord, FileSummary, FileVerdict, Metadata, PhaseLog
    from npmguard.graph import derive_graph_verdict

    tmp_path = Path(tempfile.mkdtemp(prefix="demo-env-exfil-"))
    bundle, graph, resolved_frames = await _run_env_exfil_orchestrator(tmp_path)

    verdict = derive_graph_verdict(graph)
    assert verdict.verdict == "DANGEROUS", verdict
    assert len(resolved_frames) == len(bundle.hypotheses) == 14, (
        len(resolved_frames),
        len(bundle.hypotheses),
    )

    files = _env_exfil_sources()
    package_json = json.loads(files["package.json"])
    hyps = bundle.hypotheses  # committed order hyp-0001..hyp-0014

    # File-level shape used by file_list / inventory_meta / file_verdict frames.
    file_records = [
        FileRecord(path="index.js", fileType="javascript", sizeBytes=len(files["index.js"]),
                   permissions="0644", isBinary=False),
        FileRecord(path="setup.js", fileType="javascript", sizeBytes=len(files["setup.js"]),
                   permissions="0644", isBinary=False),
        FileRecord(path="package.json", fileType="json", sizeBytes=len(files["package.json"]),
                   permissions="0644", isBinary=False),
    ]

    def _hyp_lines(target: str) -> str | None:
        ranges = [
            fl["range"]
            for hyp in hyps
            for fl in (hyp.get("focusLines") or [])
            if fl["file"] == target
        ]
        return ",".join(ranges) or None

    setup_verdict = FileVerdict(
        file="setup.js",
        capabilities=["ENV_VARS", "CREDENTIAL_THEFT", "NETWORK", "FILESYSTEM"],
        suspiciousPatterns=[
            hyp["description"] for hyp in hyps if "setup.js" in (hyp.get("focusFiles") or [])
        ],
        suspiciousLines=_hyp_lines("setup.js"),
        summary="preinstall script harvests sensitive env vars + credential files and POSTs them to a remote host.",
        riskContribution=10,
    )
    index_verdict = FileVerdict(
        file="index.js",
        capabilities=["ENV_VARS", "FILESYSTEM"],
        suspiciousPatterns=[
            hyp["description"] for hyp in hyps if "index.js" in (hyp.get("focusFiles") or [])
        ],
        suspiciousLines=_hyp_lines("index.js"),
        summary="config loader reads process.env and a local .env file; no outbound path observed.",
        riskContribution=3,
    )

    # ---- payload queues keyed by event type; the skeleton order drives dequeue.
    stated_purpose = bundle.manifest["statedPurpose"]
    phases = ["resolve", "inventory", "intent-extraction", "flag", "hypothesize", "orchestrator"]
    phase_durations = {
        "resolve": 1400.0, "inventory": 320.0, "intent-extraction": 2100.0,
        "flag": 5200.0, "hypothesize": 8600.0, "orchestrator": 41800.0,
    }
    # 16 file_analyzing frames: 2 in flag (per source file), 14 in hypothesize (per armed flag).
    hypothesize_files = [(hyp.get("focusFiles") or ["index.js"])[0] for hyp in hyps]
    file_analyzing_files = ["setup.js", "index.js", *hypothesize_files]

    queues: dict[str, list[dict[str, Any]]] = {
        "audit_started": [{"packageName": bundle.package}],
        "phase_started": [{"phase": phase} for phase in phases],
        "phase_completed": [
            {"phase": phase, "durationMs": phase_durations[phase]} for phase in phases
        ],
        "dependencies_provisioned": [
            {"installed": True, "packageCount": 0, "skipped": None, "error": None}
        ],
        "file_list": [{"files": [record.model_dump(mode="json") for record in file_records]}],
        "inventory_meta": [
            {
                "scripts": package_json.get("scripts", {}),
                "dependencies": {},
                "entryPoints": {"install": ["setup.js"], "runtime": ["index.js"], "bin": []},
                "metadata": Metadata(
                    name=package_json.get("name"),
                    version=package_json.get("version"),
                    description=package_json.get("description"),
                    license=package_json.get("license"),
                ).model_dump(mode="json"),
            }
        ],
        "intent_extracted": [
            {"statedPurpose": stated_purpose, "expectedCapabilities": ["FILESYSTEM"]}
        ],
        "file_analyzing": [{"file": name} for name in file_analyzing_files],
        "triage_progress": [
            {"current": 1, "total": 2, "file": "setup.js"},
            {"current": 2, "total": 2, "file": "index.js"},
        ],
        "hypothesis_emitted": [
            {
                "hypId": hyp["hypId"],
                "claim": hyp["claim"]["kind"],
                "severity": hyp.get("severity") or "medium",
                "file": (hyp.get("focusFiles") or ["index.js"])[0],
            }
            for hyp in hyps
        ],
        "file_verdict": [
            {"verdict": setup_verdict.model_dump(mode="json")},
            {"verdict": index_verdict.model_dump(mode="json")},
        ],
        "triage_complete": [
            {
                "hypothesisCount": len(hyps),
                "hypotheses": [
                    {
                        "hypId": hyp["hypId"],
                        "claim": hyp["claim"]["kind"],
                        "severity": hyp.get("severity") or "medium",
                        "description": hyp["description"],
                    }
                    for hyp in hyps
                ],
            }
        ],
        "graph_built": [{"nodeCount": graph.size, "addedCount": graph.size, "mergedCount": 0}],
        "hypothesis_resolved": list(resolved_frames),  # authentic, dispatch order
        "verdict_reached": [
            {
                "verdict": verdict.verdict,
                "rationale": verdict.rationale,
                "counts": verdict.counts.model_dump(mode="json"),
                "confirmedCount": verdict.counts.confirmed,
            }
        ],
    }

    skeleton = json.loads(
        (ENGINE_ROOT / "tests" / "fixtures" / "sse" / "test-pkg-env-exfil.skeleton.json").read_text(
            encoding="utf-8"
        )
    )
    base = datetime(2026, 1, 1, tzinfo=UTC)
    events: list[dict[str, Any]] = []
    cursor: dict[str, int] = {}
    for step, event_type in enumerate(skeleton["eventTypes"]):
        index = cursor.get(event_type, 0)
        cursor[event_type] = index + 1
        payload = queues[event_type][index]
        events.append({"type": event_type, "timestamp": _iso(base, step), **payload})

    # Report: built by the real pipeline helper over the real resolved graph.
    from npmguard.pipeline import _report

    trace = [
        PhaseLog(phase=phase, durationMs=phase_durations[phase], input={}, output={})
        for phase in phases
    ]
    file_summaries = [
        FileSummary(
            file="setup.js",
            summary=setup_verdict.summary,
            capabilities=setup_verdict.capabilities,
        ),
        FileSummary(
            file="index.js",
            summary=index_verdict.summary,
            capabilities=index_verdict.capabilities,
        ),
    ]
    report = _report(graph, file_summaries, trace).model_dump(mode="json", exclude_none=False)
    assert report["schemaVersion"] == 2 and report["verdict"] == "DANGEROUS", report

    return {
        "packageName": bundle.package,
        "version": bundle.package_version,
        "events": events,
        "files": files,
        "report": report,
    }


# --------------------------------------------------------------------------


def _write(recording: dict[str, Any]) -> Path:
    DEMO_DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DEMO_DATA_DIR / f"{recording['packageName']}.json"
    path.write_text(json.dumps(recording, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


async def _amain(do_safe: bool, do_dangerous: bool) -> None:
    if do_safe:
        safe = await record_safe()
        path = _write(safe)
        terminal = safe["events"][-1]
        print(f"[safe]      wrote {path}  verdict={terminal.get('verdict')}  events={len(safe['events'])}")
    if do_dangerous:
        dangerous = await record_dangerous()
        path = _write(dangerous)
        terminal = dangerous["events"][-1]
        print(
            f"[dangerous] wrote {path}  verdict={terminal.get('verdict')}  "
            f"events={len(dangerous['events'])}  confirmed={dangerous['report']['counts']['confirmed']}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="record deterministic demo replays")
    parser.add_argument("--safe", action="store_true", help="only the SAFE recording")
    parser.add_argument("--dangerous", action="store_true", help="only the DANGEROUS recording")
    args = parser.parse_args()
    do_safe = args.safe or not args.dangerous
    do_dangerous = args.dangerous or not args.safe
    asyncio.run(_amain(do_safe, do_dangerous))


if __name__ == "__main__":
    main()

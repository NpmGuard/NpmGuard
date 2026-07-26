"""Produce the two deterministic demo recordings under ``engine/demo-data/``.

Both are captured end to end from the real uvicorn engine against a mock LLM, so
every frame is a frame some audit really emitted. Nothing here reconstructs a
frame, and that is a hard rule rather than a preference: these recordings are the
product's flagship replays, and a viewer walking a verdict back to its evidence
has no way to tell a reconstructed step from a recorded one.

- SAFE (chalk): scripted zero-flag roles + the committed registry stub. No
  sandbox — a clean package never reaches one.

- DANGEROUS (test-pkg-env-exfil): the committed replay bundle supplies the real
  intent / flag / hypothesis chain, the sandbox runs LIVE under docker, and a
  content-aware scripted judge cites ids it reads off the live timeline.
  **Requires docker.**

Run: ``uv run python -m tools.record_demo [--safe] [--dangerous]`` (default: both).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
from pathlib import Path
from typing import Any

from npmguard.contract.kinds import HYPOTHESIS_EVENT_ORDER
from npmguard.events import REPLAY_FORMAT

ENGINE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ENGINE_ROOT.parent
DEMO_DATA_DIR = ENGINE_ROOT / "demo-data"

# Event envelope fields the demo replay re-stamps on its own — never persist them.
_ENVELOPE_DROP = {"auditId", "seq"}


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
            assert terminal.payload["verdict"] == "SAFE", terminal.data

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
# DANGEROUS: a REAL end-to-end audit — recorded triage chain, LIVE docker.
# --------------------------------------------------------------------------
#
# This used to be a hybrid: the orchestrator ran for real over recorded sandbox
# artifacts and everything before it was reconstructed from a skeleton. Format 2
# closed that off. A `hypothesis_resolved` cites timeline ids, and the ids in the
# committed bundle's stored timeline TEXT address rows a live render no longer
# produces — the text predates several renderer fixes (syscall outcomes, buffer
# clauses, the socket-target correction), each of which changed a collapse key
# and therefore the row numbering. Those citations resolve to the wrong rows, and
# a verdict pointing at the wrong evidence is the one thing this recording must
# never do.
#
# So the DANGEROUS flagship is now captured the same way `test_verdicts.py::S2`
# proves the path: the bundle supplies the real intent / flag / hypothesis chain
# (14 authentic hypotheses with their claims, descriptions and focus ranges), the
# sandbox runs LIVE under docker, and a content-aware scripted judge cites ids it
# reads out of the live timeline. Every frame is then a frame some audit really
# emitted, and a citation resolves to the row it names.
#
# Requires docker and takes as long as 14 full-oracle experiments take.

# What the judge should point at. Matched against the live timeline's own rows,
# so it selects among events that happened and never introduces one: the exfil
# host the fixture posts to, and any row the renderer marked as carrying a
# planted canary out of the process.
_EXFIL_ROW = r"carries planted env|POST |http .*(exfil|169\.254\.169\.254)"


def _env_exfil_sources() -> dict[str, str]:
    src = REPO_ROOT / "sandbox" / "test-fixtures" / "test-pkg-env-exfil"
    return {
        name: (src / name).read_text(encoding="utf-8")
        for name in ("index.js", "setup.js", "package.json")
    }


async def record_dangerous() -> dict[str, Any]:
    from tests.e2e.llm_mock import MockLlmClient, create_mock_app
    from tests.support.harness import EngineHarness
    from tests.support.sse import collect_frames, event_types, terminal_frame
    from tests.support.stubs import RegistryStub, StubServer

    bundle_dir = ENGINE_ROOT / "tests" / "fixtures" / "llm" / "test-pkg-env-exfil@2.0.1"
    manifest = json.loads((bundle_dir / "manifest.json").read_text(encoding="utf-8"))
    package, version = manifest["package"], manifest["packageVersion"]

    spool = Path(tempfile.mkdtemp(prefix="demo-danger-spool-"))
    workdir = Path(tempfile.mkdtemp(prefix="demo-danger-engine-"))

    with StubServer(create_mock_app(spool)) as mock_server, RegistryStub() as registry:
        # The fixture reaches the audit the way production reaches a package:
        # published to a registry and resolved by name. The engine reads no
        # meaning into a package name, so a fixture nothing serves is a 404.
        registry.serve_package_dir(REPO_ROOT / "sandbox" / "test-fixtures" / package)
        mock = MockLlmClient(mock_server.base_url)
        mock.load(
            bundle_dirs=[str(bundle_dir)],
            scripted_roles={
                "judge": {
                    "kind": "judge",
                    "malicious": True,
                    "cite_matching": _EXFIL_ROW,
                    "max_cited": 4,
                    "reason": (
                        "Confirmed: the planted credentials were read and left the "
                        "process on the cited events."
                    ),
                },
                "hypothesis": {"kind": "hypothesis", "claim_kind": "env_exfil"},
            },
        )
        # Recorded judge/propose/agent exchanges go deliberately unconsumed — a
        # live timeline embeds runIds and wall-clock, so it cannot match a
        # recorded judge prompt. That is exactly why the judge is scripted here.
        mock.teardown_checks = False

        engine = EngineHarness(
            workdir=workdir,
            llm_url=mock.v1_url,
            registry_url=registry.base_url,
            triage_model=manifest["models"]["triage"],
            investigation_model=manifest["models"]["investigation"],
        )
        engine.start()
        try:
            started = engine.start_audit(package, version=version)
            audit_id = started["auditId"]
            frames = await collect_frames(engine.base_url, audit_id, deadline=2400.0)

            terminal = terminal_frame(frames)
            assert terminal is not None and terminal.type == "verdict_reached", event_types(frames)
            assert terminal.payload["verdict"] == "DANGEROUS", terminal.data
            assert terminal.payload["counts"]["confirmed"] >= 1, terminal.data

            report = _poll_report(engine.base_url, audit_id)
            events = [
                {key: value for key, value in frame.data.items() if key not in _ENVELOPE_DROP}
                for frame in frames
                if frame.data is not None
            ]
        finally:
            engine.close()

    _assert_format_2(events)
    assert report["schemaVersion"] == 2 and report["verdict"] == "DANGEROUS", report
    return {
        "packageName": package,
        "version": version,
        "events": events,
        "files": _env_exfil_sources(),
        "report": report,
    }


def _assert_format_2(events: list[dict[str, Any]]) -> None:
    """The recording carries a complete causal chain, not a progress log.

    Checked at RECORD time because a recording is what the gallery, the e2e specs
    and the contract tests all read: a chain that quietly lost a boundary here
    would be indistinguishable from an engine that stopped emitting one, and the
    replay would animate a hypothesis that resolves out of nowhere.
    """
    # Found by type, not by position: the single-owner queue emits an
    # `audit_enqueued` lifecycle frame at submit, so `audit_started` is second on
    # a real stream.
    started = next(event for event in events if event["type"] == "audit_started")
    assert started["replayVersion"] == REPLAY_FORMAT, started

    # Three legal chains:
    #   full six          — reached the sandbox;
    #   emitted+resolved  — deferred before dispatch (analysis budget);
    #   emitted only      — merged into another node at graph build, so it never
    #                       ran. Legal ONLY if `graph_built` names where it went;
    #                       otherwise it is a suspicion that vanished.
    full = list(HYPOTHESIS_EVENT_ORDER)
    undispatched = [full[0], full[-1]]
    merged_into = {
        merge["hypId"]: merge["into"]
        for event in events
        if event["type"] == "graph_built"
        for merge in event["merges"]
    }
    seen: dict[str, list[str]] = {}
    for event in events:
        if (hyp_id := event.get("hypId")) is not None:
            seen.setdefault(hyp_id, []).append(event["type"])
    assert seen, "recording contains no hypothesis at all"
    for hyp_id, chain in seen.items():
        if chain == [full[0]]:
            assert hyp_id in merged_into, f"{hyp_id} was announced and then vanished"
            assert merged_into[hyp_id] in seen, (hyp_id, merged_into[hyp_id])
            continue
        assert chain in (full, undispatched), (hyp_id, chain)
    assert any(chain == full for chain in seen.values()), "no hypothesis reached the sandbox"

    cited = [
        event
        for event in events
        if event["type"] == "hypothesis_resolved" and event["state"] == "CONFIRMED"
    ]
    assert cited, "the DANGEROUS flagship must confirm something"
    for event in cited:
        assert event["citedEventIds"], event["hypId"]
        # Every cited id resolves to a row the frontend can show. This is the
        # property the old hybrid recording could not hold.
        resolved = {item["eventId"] for item in event["citedObservations"]}
        assert resolved == set(event["citedEventIds"]), (event["hypId"], resolved)


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

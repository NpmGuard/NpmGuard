# CLASS MAP — DemoService: what the committed recordings load as, what a viewer
# receives during a replay, how the pacing knob behaves, and the row the replay
# finalises. Nothing covered this module before. Phase 5 promotes the demo path to
# a product surface (a replay gallery whose purpose is to be credible evidence),
# so the unit is deliberately "what a gallery viewer observes", not the internals.
# Units: DemoService(sessions, stream).recordings and .start(name) -> the durable
#        event log (drained through sse_events, the same generator the SSE route
#        serves) + the audit_sessions row.
# (seams: a throwaway sqlite DB behind AuditSessionStore + StreamService with the
#  polling notifier — no HTTP, no engine process. npmguard.demo.REPO_ROOT for the
#  loader classes: the demo-data directory is resolved from it at construction and
#  there is no injection point. For the pacing classes the MODULE IS RELOADED,
#  because DEMO_SPEED is read from the environment at import time — the env var is
#  the only real seam, so a test that moved a module attribute instead would prove
#  the attribute is honoured while saying nothing about the knob. Both seams are
#  named here rather than buried in a helper. C16 wraps the store's finalize to
#  observe write ordering at that collaborator's own boundary.)
#
# CURATED DATA — engine/demo-data/test-pkg-env-exfil.json is a HYBRID (§24.1), and
# no test in this file asserts any curated value as ENGINE TRUTH. Replay classes
# assert equality WITH THE RECORDING, because verbatim replay is the contract; C13
# pins the divergences AS divergences, computing what the engine emits from the
# engine's own code over the same committed source tree, so a re-record turns C13
# red and it is deleted rather than rotting into a specification.
#   faithful (byte-identical to prod audit b184aed2…): report.verdict, rationale,
#     counts, confirmedHypIds, all 14 hypotheses incl. experiment + evidenceRefs,
#     every resolution.reason; and — measured in C13 — the file set and sizeBytes
#   curated, contradicting engine output:
#     file_list[].fileType "javascript"     engine emits "js" (EXTENSION_TYPE_MAP)
#     file_list[].permissions "0644"        engine emits "644" (format(mode, "o")),
#                                           a divergence §24.1 does not list
#     file_verdict[index.js].risk 3         the code computes 8 (max severity over
#                                           that file's six hypotheses is "high")
#     dependencies_provisioned installed    engine returns installed=False,
#       =true / skipped=null                 skipped="no runtime dependencies"
#     report.trace[].input/.output {}       populated summaries (durationMs round)
#     intent_extracted.expectedCapabilities curated one-liner list, and
#     report.fileSummaries[]                 curated summaries — NOT asserted
#                                            against engine truth here: both need
#                                            a live model, so C13 pins only what
#                                            can be recomputed offline
#
# Axes: recording (DANGEROUS 68-frame / SAFE 30-frame / absent / unloadable) ×
#       what the viewer receives (frames, envelope, row, queue visibility) ×
#       pacing (0 / finite / negative / non-numeric, floor, cap) ×
#       what a future caller could do with the recorded report (§24.1's trap)
#
# LOAD
#   C1  both committed recordings load, keyed by packageName — the list the
#       /demo/packages surface serves
#   C2  an unknown package raises KeyError naming it, and creates NO row
#   C3  FINDING (pin): a recording that is unreadable, not JSON, not an object, or
#       missing a required key is skipped with only a log line — the sibling
#       recordings still load and the gallery silently loses an entry
# REPLAY — what the viewer receives
#   C4  every recorded frame is re-emitted, in order, with its payload VERBATIM
#       (the recorded event minus the four envelope keys), for the 68-frame
#       DANGEROUS recording
#   C5  the envelope is re-stamped, never replayed: auditId is the new audit id,
#       seq is dense from 0, and the recorded 2026-01-01 timestamps are dropped in
#       favour of the log's own — a viewer sees live time
#   C6  the row is finalised with the recorded report VERBATIM (status done,
#       verdict DANGEROUS, counts.confirmed 1, confirmedHypIds ["hyp-0008"], 14
#       hypotheses) — nothing is regenerated
#   C7  the SAFE recording replays identically (30 frames, verdict SAFE), so no
#       class above is a property of one file
#   C8  the demo row is tagged by file_contents, which holds the recorded sources,
#       so running() / queued() / queued_count() all exclude it: a replay never
#       eats a real audit's queue slot and restart recovery never 0031s it
# PACING — NPMGUARD_DEMO_SPEED
#   C9  0 -> the throttle is skipped entirely: 7.3 s of recorded pacing replays
#       inside INSTANT_CEILING
#   C10 a finite speed DIVIDES the throttle: the same recording at speed 6 sleeps
#       past SLOW_FLOOR, an order of magnitude beyond the speed-0 ceiling
#   C11 a negative value is clamped to 0 by max(0.0, …) — never a negative sleep
#   C12 FINDING (pin): a NON-NUMERIC value raises ValueError at IMPORT, with a
#       message naming neither the knob nor the module, and npmguard.api imports
#       this module — so a typo in the demo knob stops the engine from booting
#   C13 the two throttle bounds: MIN_TYPE_DELAY floors a sub-millisecond recorded
#       gap (frames cannot fly past unreadably) and MAX_DELAY_MS caps a 10-minute
#       recorded gap (a long pause in a recording cannot stall the gallery)
# THE HYBRID, AND THE TRAP IT SETS
#   C14 the curated-vs-engine divergence pin described above, computed from the
#       engine's own code over the committed test-pkg-env-exfil source tree
#   C15 the save_report trap (§24.1): every trace[].output is {}, so
#       extract_report_version returns None for the recorded report; a caller that
#       routed it through save_report with "latest" (or no version) raises
#       UnversionedReportError, and one that passes a version writes the report
#       under the caller's GUESS — the recording's own top-level `version` is not
#       even loaded into DemoRecording, so there is nothing honest to pass.
#       Nothing breaks today only because DemoService finalises the row itself
#   C16 FINDING (pin): the recorded verdict_reached is durable BEFORE the report
#       row is written — the inverse of the real path's invariant (AuditService.
#       _finish: report on disk, then row + terminal event in one transaction). A
#       gallery that fetches the report when the terminal frame arrives can see a
#       non-terminal row
# Adversarial pass: 2026-07-25/demo — "which dimension is missing?" -> the
# recording-count axis (C7: every replay class ran on one file), the queue-
# visibility axis (C8), and write ORDERING as distinct from write content (C16).
from __future__ import annotations

import asyncio
import importlib
import json
import os
import shutil
import stat
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard import demo as demo_module
from npmguard import report_store
from npmguard.config import REPO_ROOT, Settings
from npmguard.deps import provision_dependencies
from npmguard.events import sse_events
from npmguard.inventory import EXTENSION_TYPE_MAP, classify_files
from npmguard.persistence import AuditSessionStore
from npmguard.pipeline import SEVERITY_SCORE

DEMO_DATA = REPO_ROOT / "engine" / "demo-data"
DANGEROUS_RECORDING = DEMO_DATA / "test-pkg-env-exfil.json"
SAFE_RECORDING = DEMO_DATA / "chalk.json"
# The source tree the DANGEROUS recording is an audit OF. Read and copied only —
# a hand-authored fixture, not a bench-dd malware sample, and never installed.
EXFIL_SOURCES = REPO_ROOT / "sandbox" / "test-fixtures" / "test-pkg-env-exfil"
ENVELOPE_KEYS = ("type", "auditId", "timestamp", "seq")
SPEED_ENV = "NPMGUARD_DEMO_SPEED"

REPLAY_DEADLINE_SECONDS = 60.0  # generous outer bound; a stalled replay must not hang
POLL_SECONDS = 0.005
# Pacing bounds. The recorded human throttle for chalk.json sums to 7.32 s at
# speed 1, so these two windows are ~25x apart and cannot overlap; a sleep can
# only ever overshoot, never undershoot, so the floor is the safe direction.
INSTANT_CEILING = 0.4
DIVIDED_SPEED = 6
SLOW_FLOOR = 0.8
# Two-sided on purpose: 7.32/6 = 1.22 s measured, so a ceiling of 4 s still
# falsifies "the knob was ignored" (which is 7.32 s) with 3x of slack for a slow
# machine. Sleeps only ever overshoot, so only the ceiling is CI-sensitive.
DIVIDED_CEILING = 4.0


def _recording(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _payload(event: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in event.items() if key not in ENVELOPE_KEYS}


async def _frames(stream: StreamService, audit_id: str) -> list[dict[str, Any]]:
    """Every durable frame for an audit, as the SSE route would serve it."""
    frames = []
    async for frame in sse_events(audit_id, stream, follow=False):
        line = next(part for part in frame.splitlines() if part.startswith("data: "))
        frames.append(json.loads(line.removeprefix("data: ")))
    return frames


class _OrderObservingStore(AuditSessionStore):
    """A store that records which frames were already durable when finalize ran."""

    def __init__(self, factory, stream: StreamService) -> None:
        super().__init__(factory)
        self._stream = stream
        self.frames_at_finalize: list[dict[str, Any]] | None = None

    async def finalize(self, audit_id, report, error=None, *, session=None) -> None:
        self.frames_at_finalize = await _frames(self._stream, audit_id)
        await super().finalize(audit_id, report, error, session=session)


@pytest.fixture
async def rig(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'demo.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    stream = StreamService(factory, PollingNotifier())
    sessions = _OrderObservingStore(factory, stream)
    yield SimpleNamespace(sessions=sessions, stream=stream)
    await engine.dispose()


@pytest.fixture
def at_speed():
    """Re-import npmguard.demo with NPMGUARD_DEMO_SPEED set, and hand back the
    module. DEMO_SPEED is a module constant read from the environment at import,
    so this is the seam the knob actually has; the original binding is restored
    afterwards by restoring the variable and reloading once more."""
    original = os.environ.get(SPEED_ENV)

    def _reload(value: str | None) -> Any:
        if value is None:
            os.environ.pop(SPEED_ENV, None)
        else:
            os.environ[SPEED_ENV] = value
        return importlib.reload(demo_module)

    yield _reload
    if original is None:
        os.environ.pop(SPEED_ENV, None)
    else:
        os.environ[SPEED_ENV] = original
    importlib.reload(demo_module)


async def _replay(rig, module=demo_module, *, package: str) -> SimpleNamespace:
    """Start a replay and wait, bounded, for the row to go terminal."""
    service = module.DemoService(rig.sessions, rig.stream)
    started = time.monotonic()
    handle = await service.start(package)
    audit_id = handle["auditId"]
    async with asyncio.timeout(REPLAY_DEADLINE_SECONDS):
        while True:
            row = await rig.sessions.get(audit_id)
            if row is not None and row.status in ("done", "error"):
                break
            await asyncio.sleep(POLL_SECONDS)
    elapsed = time.monotonic() - started
    # The row turns terminal INSIDE the replay task, so the task itself can still
    # be a tick from done. Join it by its published name (DemoService names the
    # task after the audit) so no test ends with a live task the loop must destroy.
    live = [task for task in asyncio.all_tasks() if task.get_name() == f"npmguard-demo-{audit_id}"]
    if live:
        await asyncio.wait(live, timeout=REPLAY_DEADLINE_SECONDS)
    return SimpleNamespace(
        audit_id=audit_id,
        row=row,
        elapsed=elapsed,
        frames=await _frames(rig.stream, audit_id),
        service=service,
    )


def _write_recordings(root: Path, files: dict[str, str]) -> Path:
    directory = root / "engine" / "demo-data"
    directory.mkdir(parents=True)
    for name, body in files.items():
        (directory / name).write_text(body, encoding="utf-8")
    return root


# --------------------------------------------------------------------------- #
# Load
# --------------------------------------------------------------------------- #


def test_committed_recordings_load_keyed_by_package_name(rig) -> None:
    """C1: the gallery's index. Both committed recordings load, and each carries
    the three things a replay needs: frames, sources, and a report."""
    service = demo_module.DemoService(rig.sessions, rig.stream)
    assert set(service.recordings) == {"chalk", "test-pkg-env-exfil"}
    for name, recording in service.recordings.items():
        assert recording.package_name == name
        assert recording.events and recording.files and recording.report


async def test_unknown_package_raises_and_creates_no_row(rig) -> None:
    """C2: the route's 404 path. No row is created, so an unknown name cannot
    leave a queued session behind."""
    service = demo_module.DemoService(rig.sessions, rig.stream)
    with pytest.raises(KeyError) as excinfo:
        await service.start("not-a-recording")
    assert "not-a-recording" in str(excinfo.value)
    assert await rig.sessions.queued_count() == 0


@pytest.mark.parametrize(
    ("name", "body"),
    [
        ("not-json.json", "{"),
        ("not-an-object.json", "[]"),
        ("missing-report.json", '{"packageName": "x", "events": [], "files": {}}'),
    ],
)
def test_a_broken_recording_is_skipped_and_siblings_still_load(
    rig, tmp_path, monkeypatch, name: str, body: str
) -> None:
    """C3: FINDING, pinned rather than blessed. _load swallows OSError / KeyError /
    TypeError / JSONDecodeError per file, so a malformed gallery entry vanishes
    with nothing but a log line — on a product surface, an operator sees a missing
    demo rather than an error. The sibling still loading is the other half: one bad
    file must not take the gallery down."""
    good = json.dumps(
        {"packageName": "good", "events": [], "files": {"a.js": "1"}, "report": {"verdict": "SAFE"}}
    )
    monkeypatch.setattr(
        demo_module, "REPO_ROOT", _write_recordings(tmp_path, {name: body, "good.json": good})
    )
    service = demo_module.DemoService(rig.sessions, rig.stream)
    assert set(service.recordings) == {"good"}


# --------------------------------------------------------------------------- #
# Replay — what the viewer receives
# --------------------------------------------------------------------------- #


async def test_replay_emits_every_recorded_frame_in_order_verbatim(rig, at_speed) -> None:
    """C4: the contract is verbatim replay, so this asserts equality WITH THE
    RECORDING for all 68 frames — including the curated payload values, which are
    faithfully replayed lies (see the class map's curated table and C13)."""
    module = at_speed("0")
    recorded = _recording(DANGEROUS_RECORDING)
    result = await _replay(rig, module, package="test-pkg-env-exfil")
    assert [frame["type"] for frame in result.frames] == [
        event["type"] for event in recorded["events"]
    ]
    assert [_payload(frame) for frame in result.frames] == [
        _payload(event) for event in recorded["events"]
    ]


async def test_replay_restamps_the_envelope_and_drops_recorded_timestamps(rig, at_speed) -> None:
    """C5: seq/auditId/timestamp belong to THIS replay, not to the recording. A
    viewer therefore sees live time; the recorded 2026-01-01 instants only drive
    the pacing and never reach the wire."""
    module = at_speed("0")
    recorded = _recording(DANGEROUS_RECORDING)
    result = await _replay(rig, module, package="test-pkg-env-exfil")
    assert [frame["seq"] for frame in result.frames] == list(range(len(recorded["events"])))
    assert {frame["auditId"] for frame in result.frames} == {result.audit_id}
    recorded_stamps = {event["timestamp"] for event in recorded["events"]}
    assert not recorded_stamps & {frame["timestamp"] for frame in result.frames}


async def test_replay_finalises_the_row_with_the_recorded_report(rig, at_speed) -> None:
    """C6: nothing is regenerated — the row's report is the recorded object, whose
    verdict/counts/hypotheses are the faithful half of the hybrid."""
    module = at_speed("0")
    recorded = _recording(DANGEROUS_RECORDING)
    result = await _replay(rig, module, package="test-pkg-env-exfil")
    assert result.row.status == "done"
    assert result.row.error is None
    assert result.row.report == recorded["report"]
    assert result.row.report["verdict"] == "DANGEROUS"
    assert result.row.report["counts"]["confirmed"] == 1
    assert result.row.report["confirmedHypIds"] == ["hyp-0008"]
    assert len(result.row.report["hypotheses"]) == 14


async def test_safe_recording_replays_the_same_way(rig, at_speed) -> None:
    """C7: the second recording, so the classes above are properties of the
    replayer and not of one file. A SAFE demo ends on the same terminal frame."""
    module = at_speed("0")
    recorded = _recording(SAFE_RECORDING)
    result = await _replay(rig, module, package="chalk")
    assert len(result.frames) == len(recorded["events"]) == 30
    assert [_payload(frame) for frame in result.frames] == [
        _payload(event) for event in recorded["events"]
    ]
    assert result.frames[-1]["type"] == "verdict_reached"
    assert result.row.report["verdict"] == "SAFE"


async def test_demo_row_is_invisible_to_the_audit_queue(rig, at_speed) -> None:
    """C8: file_contents IS NOT NULL is the de-facto demo tag, and it holds the
    recorded sources a viewer browses. So a replay is excluded from queued() /
    running() / queued_count() — it cannot consume a real audit's admission slot,
    and restart recovery cannot sweep it into a 0031 or re-run the real pipeline
    on it."""
    module = at_speed("0")
    recorded = _recording(DANGEROUS_RECORDING)
    result = await _replay(rig, module, package="test-pkg-env-exfil")
    assert result.row.file_contents == recorded["files"]
    assert result.row.package_path == "__demo__"
    assert await rig.sessions.queued_count() == 0
    assert await rig.sessions.queued() == []
    assert await rig.sessions.running() == []


# --------------------------------------------------------------------------- #
# Pacing — NPMGUARD_DEMO_SPEED
# --------------------------------------------------------------------------- #


async def test_speed_zero_skips_the_throttle_entirely(rig, at_speed) -> None:
    """C9: the e2e/Playwright setting. chalk.json carries 7.32 s of recorded human
    pacing at speed 1; at 0 the whole replay lands inside INSTANT_CEILING."""
    module = at_speed("0")
    result = await _replay(rig, module, package="chalk")
    assert len(result.frames) == 30
    assert result.elapsed < INSTANT_CEILING


async def test_a_finite_speed_divides_the_throttle(rig, at_speed) -> None:
    """C10: the knob is a divisor, not a switch — asserted from BOTH sides, since a
    floor alone is also satisfied by a replay that ignores the knob and throttles at
    speed 1 (measured: that mutation passes a floor-only assertion)."""
    module = at_speed(str(DIVIDED_SPEED))
    result = await _replay(rig, module, package="chalk")
    assert SLOW_FLOOR < result.elapsed < DIVIDED_CEILING


async def test_a_negative_speed_is_clamped_to_zero(rig, at_speed) -> None:
    """C11: max(0.0, …) — a negative divisor would otherwise mean a negative sleep
    (a ValueError from asyncio.sleep) or an inverted throttle."""
    module = at_speed("-4")
    result = await _replay(rig, module, package="chalk")
    assert result.elapsed < INSTANT_CEILING


def test_a_non_numeric_speed_breaks_the_import(at_speed) -> None:
    """C12: FINDING, pinned. float() runs on the raw environment string at module
    scope, so `NPMGUARD_DEMO_SPEED=fast` raises at IMPORT with a message that names
    neither the knob nor the module — and npmguard.api imports this module, so the
    engine cannot boot. A knob whose bad value is a crash should be parsed where a
    bad value can be reported."""
    import npmguard.api  # noqa: F401  (the import chain being asserted)

    assert "npmguard.demo" in sys.modules
    with pytest.raises(ValueError) as excinfo:
        at_speed("fast")
    assert "could not convert string to float" in str(excinfo.value)
    assert SPEED_ENV not in str(excinfo.value)


@pytest.mark.parametrize(
    ("kind", "speed", "events", "lower", "upper"),
    [
        # agent_reasoning floors at 800 ms; the recorded gap is 1 ms. At speed 4
        # the floor is 200 ms, while the recorded delta alone would be 0.25 ms.
        ("floor", "4", [("agent_reasoning", "00.000"), ("agent_reasoning", "00.001")], 0.1, None),
        # A 600 s recorded gap caps at MAX_DELAY_MS (4 s). At speed 40 that is
        # 100 ms; uncapped it would be 15 s, so the upper bound falsifies the cap.
        ("cap", "40", [("file_list", "00.000"), ("file_list", "10:00.000")], 0.02, 1.0),
    ],
)
async def test_throttle_floor_and_cap(
    rig, at_speed, tmp_path, monkeypatch, kind, speed, events, lower, upper
) -> None:
    """C13: the two bounds that make a replay watchable. The floor keeps frames
    from flying past faster than a human reads; the cap keeps a long pause in a
    recording from stalling the gallery. Both are observed as elapsed time over a
    two-frame recording, at a scaled speed so the test costs milliseconds."""
    recording = {
        "packageName": "paced",
        "events": [
            {"type": kind_, "timestamp": f"2026-01-01T00:{stamp}Z", "files": []}
            for kind_, stamp in events
        ],
        "files": {"a.js": "1"},
        "report": {"verdict": "SAFE"},
    }
    module = at_speed(speed)
    monkeypatch.setattr(
        module, "REPO_ROOT", _write_recordings(tmp_path, {"paced.json": json.dumps(recording)})
    )
    result = await _replay(rig, module, package="paced")
    assert len(result.frames) == 2
    assert result.elapsed > lower
    if upper is not None:
        assert result.elapsed < upper


# --------------------------------------------------------------------------- #
# The hybrid, and the trap it sets
# --------------------------------------------------------------------------- #


def test_recorded_file_frames_diverge_from_what_the_engine_emits(tmp_path) -> None:
    """C14: the divergence pin (§24.1), computed rather than quoted. classify_files
    and provision_dependencies are run over the committed source tree the recording
    is an audit OF, so the "engine would produce" column is the engine's own
    output, not a claim from a document. DELETE THIS TEST when the recording is
    re-recorded — it exists to make the hybrid visible, so it must go red then.
    Faithful here: the file set and every sizeBytes. Divergent: fileType
    ("javascript" vs "js") and permissions ("0644" vs "644" — §24.1 does not list
    the second one)."""
    recorded = _recording(DANGEROUS_RECORDING)
    frame = next(event for event in recorded["events"] if event["type"] == "file_list")
    recorded_files = {entry["path"]: entry for entry in frame["files"]}

    package = tmp_path / "package"
    shutil.copytree(EXFIL_SOURCES, package)
    engine_files = {record.path: record for record in classify_files(package)}

    assert set(recorded_files) == set(engine_files)
    for path, record in engine_files.items():
        assert recorded_files[path]["sizeBytes"] == record.sizeBytes  # faithful
    assert {entry["fileType"] for entry in recorded_files.values()} == {"javascript", "json"}
    assert {record.fileType for record in engine_files.values()} == {"js", "json"}
    assert EXTENSION_TYPE_MAP[".js"] == "js"
    assert {entry["permissions"] for entry in recorded_files.values()} == {"0644"}
    assert {record.permissions for record in engine_files.values()} == {
        format(stat.S_IMODE(0o644), "o")
    }
    assert {record.permissions for record in engine_files.values()} == {"644"}


async def test_recorded_dependency_frame_diverges_from_what_the_engine_emits(tmp_path) -> None:
    """C14b: the same pin for dependencies_provisioned. The package declares no
    `dependencies`, so the engine's own provisioner reports installed=False with
    skipped="no runtime dependencies" — the recording claims installed=True and no
    skip reason. No docker is reached: the empty-dependencies case short-circuits
    before the daemon."""
    recorded = _recording(DANGEROUS_RECORDING)
    frame = next(event for event in recorded["events"] if event["type"] == "dependencies_provisioned")
    assert (frame["installed"], frame["packageCount"], frame["skipped"]) == (True, 0, None)

    package = tmp_path / "package"
    shutil.copytree(EXFIL_SOURCES, package)
    provision = await provision_dependencies(package, Settings(_env_file=None))
    assert (provision.installed, provision.package_count, provision.skipped_reason) == (
        False,
        0,
        "no runtime dependencies",
    )


def test_recorded_index_risk_contribution_contradicts_the_recorded_severities() -> None:
    """C14c: §24.2, recomputed from the recording's own hypotheses through the
    engine's own SEVERITY_SCORE table. index.js's six hypotheses max out at "high"
    (8); the recorded frame says 3, which is the score for "low". A UI calibrated
    on the demo therefore under-reports a multi-severity file. Not a blessing of
    3 — the assertion is that the two disagree."""
    recorded = _recording(DANGEROUS_RECORDING)
    frame = next(
        event
        for event in recorded["events"]
        if event["type"] == "file_verdict" and event["verdict"]["file"] == "index.js"
    )
    severities = [
        hypothesis["severity"]
        for hypothesis in recorded["report"]["hypotheses"]
        if "index.js" in (hypothesis.get("focusFiles") or [])
    ]
    assert severities  # otherwise the computation below is vacuous
    computed = SEVERITY_SCORE[max(severities, key=lambda value: SEVERITY_SCORE[value])]
    assert computed == 8
    assert frame["verdict"]["riskContribution"] == 3 != computed


def test_recorded_report_has_no_extractable_version(tmp_path, monkeypatch) -> None:
    """C15: the latent trap, made visible. Every trace[].output in the recording is
    {} (curated), so the store cannot recover a version from the report:
      * extract_report_version -> None;
      * save_report with "latest" or "" raises UnversionedReportError;
      * save_report with a version SUCCEEDS, filing the recorded report under the
        caller's guess — and DemoRecording does not even load the recording's own
        top-level `version`, so a caller has nothing honest to pass.
    Nothing breaks today only because DemoService finalises the row directly and
    never calls save_report. This class fails the moment that changes."""
    recorded = _recording(DANGEROUS_RECORDING)
    report = recorded["report"]
    assert [phase["output"] for phase in report["trace"]] == [{}] * len(report["trace"])
    assert report_store.extract_report_version(report) is None

    monkeypatch.setattr(report_store, "DATA_DIR", tmp_path / "reports")
    for requested in ("latest", ""):
        with pytest.raises(report_store.UnversionedReportError):
            report_store.save_report("test-pkg-env-exfil", requested, report)
    guessed = report_store.save_report("test-pkg-env-exfil", "2.0.1", report)
    assert guessed == "2.0.1"  # the caller's version, not the report's
    assert not hasattr(demo_module.DemoRecording, "version")
    assert "version" not in demo_module.DemoRecording.__dataclass_fields__
    assert recorded["version"] == "2.0.1"  # present in the file, loaded by nothing


async def test_terminal_frame_is_durable_before_the_report_row(rig, at_speed) -> None:
    """C16: FINDING, pinned. The recorded verdict_reached is emitted inside the
    replay loop, and only then does finalize write the row — the inverse of the
    real path, where AuditService._finish makes a terminal frame imply a durable
    report. Observed at the store seam: when finalize runs, the terminal frame is
    already in the durable log. A gallery that requests the report on the terminal
    frame can therefore observe a non-terminal row."""
    module = at_speed("0")
    result = await _replay(rig, module, package="chalk")
    observed = rig.sessions.frames_at_finalize
    assert observed is not None
    assert observed[-1]["type"] == "verdict_reached"
    assert len(observed) == len(result.frames)

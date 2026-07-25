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
#       /demo/packages surface serves — each carrying the version its audit was OF
#   C2  an unknown package raises KeyError naming it, and creates NO row
#   C3  a recording that is unreadable, not JSON, not an object, or missing a
#       required key raises DemoRecordingError NAMING THE FILE, and takes the whole
#       load with it. DemoService is built in the lifespan, so the gallery is
#       all-or-nothing at boot — the treatment config.py gives a bad NPMGUARD_*
#       value. Skipping instead makes a malformed entry vanish, and an operator
#       sees a missing demo rather than an error
#   C3b INVARIANT: a recording's LAST frame is its ONLY terminal frame. No terminal
#       frame leaves the row 'running' for ever and an SSE follower hanging (
#       sse_events returns on a terminal frame); frames after it are frames no
#       follower can see. Neither is a shape the real path can produce, and C16
#       depends on this being total
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
#   C8  the demo row is tagged by package_path == DEMO_PACKAGE_PATH (file_contents
#       holds the recorded sources), so running() / queued() / queued_count() all
#       exclude it: a replay never eats a real audit's queue slot and restart
#       recovery never 0031s it
# PACING — NPMGUARD_DEMO_SPEED
#   C9  0 -> the throttle is skipped entirely: 7.3 s of recorded pacing replays
#       inside INSTANT_CEILING
#   C10 a finite speed DIVIDES the throttle: the same recording at speed 6 sleeps
#       past SLOW_FLOOR, an order of magnitude beyond the speed-0 ceiling
#   C11 a negative value is clamped to 0 by max(0.0, …) — never a negative sleep
#   C12 a NON-NUMERIC value still stops the IMPORT — npmguard.api imports this
#       module, so a bad value must kill the process rather than boot an engine
#       that cannot replay — but as a ConfigError NAMING NPMGUARD_DEMO_SPEED
#       rather than a bare `could not convert string to float: 'fast'`, which
#       names neither the knob nor the module
#   C13 the two throttle bounds: MIN_TYPE_DELAY floors a sub-millisecond recorded
#       gap (frames cannot fly past unreadably) and MAX_DELAY_MS caps a 10-minute
#       recorded gap (a long pause in a recording cannot stall the gallery)
# THE HYBRID, AND THE TRAP IT SETS
#   C14 the curated-vs-engine divergence pin described above, computed from the
#       engine's own code over the committed test-pkg-env-exfil source tree
#   C15 the save_report trap (§24.1), half closed: every trace[].output is {}, so
#       extract_report_version still returns None for the recorded report — a caller
#       routing it through save_report with "latest" raises UnversionedReportError,
#       and one passing a version files the report under whatever it passed. What
#       changes is that DemoRecording now loads the recording's own `version`, so a
#       future demo -> save_report route has an honest value to pass instead of a
#       guess — checked against the audited source tree's package.json, not blessed
#       from the recording
#   C16 the terminal frame and the report row commit TOGETHER, and the row is
#       written first inside that transaction — the real path's ordering
#       (AuditService._finish: report durable, then row + terminal event in one
#       transaction), so a gallery that fetches the report on verdict_reached always
#       finds it. Emitting every frame and only then finalising lets the terminal
#       frame be seen while the row is still 'running' with no report
#   C16b the two writes are one UNIT, not merely ordered: an append that fails rolls
#       the row back to non-terminal, where restart recovery repairs it. This is
#       what a plain finalize()-then-emit() would fail — it satisfies C16's ordering
#       while leaving a terminal row no consumer is ever told about
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
from npmguard.config import REPO_ROOT, ConfigError, Settings
from npmguard.deps import provision_dependencies
from npmguard.events import TERMINAL_EVENTS, sse_events
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


def _valid(**changes: Any) -> str:
    """The minimum a loadable recording carries: the five required keys, and a last
    frame that is terminal (C3b). Written out once here so every synthetic recording
    below states only the thing it is actually about."""
    recording: dict[str, Any] = {
        "packageName": "good",
        "version": "1.0.0",
        "events": [{"type": "verdict_reached", "timestamp": "2026-01-01T00:00:00Z"}],
        "files": {"a.js": "1"},
        "report": {"verdict": "SAFE"},
    }
    return json.dumps({**recording, **changes})


# --------------------------------------------------------------------------- #
# Load
# --------------------------------------------------------------------------- #


def test_committed_recordings_load_keyed_by_package_name(rig) -> None:
    """C1: the gallery's index. Both committed recordings load, and each carries
    the four things a replay needs: frames, sources, a report, and the version the
    audit was OF."""
    service = demo_module.DemoService(rig.sessions, rig.stream)
    assert set(service.recordings) == {"chalk", "test-pkg-env-exfil"}
    for name, recording in service.recordings.items():
        assert recording.package_name == name
        assert recording.events and recording.files and recording.report and recording.version


async def test_unknown_package_raises_and_creates_no_row(rig) -> None:
    """C2: the route's 404 path. No row is created, so an unknown name cannot
    leave a queued session behind."""
    service = demo_module.DemoService(rig.sessions, rig.stream)
    with pytest.raises(KeyError) as excinfo:
        await service.start("not-a-recording")
    assert "not-a-recording" in str(excinfo.value)
    assert await rig.sessions.queued_count() == 0


@pytest.mark.parametrize(
    ("name", "body", "cause"),
    [
        ("not-json.json", "{", "JSONDecodeError"),
        ("not-an-object.json", "[]", "TypeError"),
        ("missing-report.json", '{"packageName": "x", "events": [], "files": {}}', "KeyError"),
        ("missing-version.json", _valid(version=None).replace('"version": null, ', ""), "KeyError"),
        ("no-type.json", _valid(events=[{"timestamp": "2026-01-01T00:00:00Z"}]), "KeyError"),
    ],
)
def test_a_broken_recording_fails_the_load_and_names_the_file(
    rig, tmp_path, monkeypatch, name: str, body: str, cause: str
) -> None:
    """C3: was a FINDING (skipped with one log line, so the gallery silently lost an
    entry); now the contract. The same four causes — OSError / JSONDecodeError /
    TypeError / KeyError — are re-raised as DemoRecordingError naming the FILE and
    the cause, and one bad file takes the whole load with it: the sibling written
    alongside becomes unreachable too, because a gallery missing an exhibit is a
    broken product surface, not a warning. DemoService is constructed in the
    lifespan, so this is a boot failure — and recordings are committed files the
    suite loads, so it can only fire on a bad commit."""
    monkeypatch.setattr(
        demo_module,
        "REPO_ROOT",
        _write_recordings(tmp_path, {name: body, "sibling.json": _valid()}),
    )
    with pytest.raises(demo_module.DemoRecordingError) as excinfo:
        demo_module.DemoService(rig.sessions, rig.stream)
    message = str(excinfo.value)
    assert name in message  # located: which file
    assert cause in message  # and why


@pytest.mark.parametrize(
    "events",
    [
        pytest.param([], id="no-frames"),
        pytest.param(
            [{"type": "phase_started", "timestamp": "2026-01-01T00:00:00Z"}], id="no-terminal"
        ),
        pytest.param(
            [
                {"type": "verdict_reached", "timestamp": "2026-01-01T00:00:00Z"},
                {"type": "phase_completed", "timestamp": "2026-01-01T00:00:01Z"},
            ],
            id="terminal-not-last",
        ),
        pytest.param(
            [
                {"type": "audit_error", "timestamp": "2026-01-01T00:00:00Z"},
                {"type": "verdict_reached", "timestamp": "2026-01-01T00:00:01Z"},
            ],
            id="two-terminals",
        ),
    ],
)
def test_a_recording_must_end_with_exactly_one_terminal_frame(
    rig, tmp_path, monkeypatch, events: list[dict[str, Any]]
) -> None:
    """C3b: the invariant C16 rests on. A recording with no terminal frame never
    finalises its row (leaving it 'running', and an SSE follower waiting for a frame
    that never comes), and frames after the terminal one are frames no follower can
    receive — sse_events returns on it. Neither shape can come out of a real audit,
    so neither loads, and the refusal names the file and the offending indices."""
    monkeypatch.setattr(
        demo_module, "REPO_ROOT", _write_recordings(tmp_path, {"paced.json": _valid(events=events)})
    )
    with pytest.raises(demo_module.DemoRecordingError, match="paced.json.*terminal frames at"):
        demo_module.DemoService(rig.sessions, rig.stream)


def test_two_recordings_cannot_claim_one_package_name(rig, tmp_path, monkeypatch) -> None:
    """C3: the other silent loss in the same three lines — the index is keyed by
    packageName, so a collision simply dropped whichever file globbed first."""
    monkeypatch.setattr(
        demo_module,
        "REPO_ROOT",
        _write_recordings(tmp_path, {"a.json": _valid(), "b.json": _valid()}),
    )
    with pytest.raises(demo_module.DemoRecordingError, match="already occupies"):
        demo_module.DemoService(rig.sessions, rig.stream)


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
    """C8: package_path == DEMO_PACKAGE_PATH is the demo tag, and file_contents holds
    the recorded sources a viewer browses. So a replay is excluded from queued() /
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
    """C12: a NON-NUMERIC value still stops the IMPORT — npmguard.api imports this
    module, so a bad config must kill the process rather than boot an engine that
    cannot replay — but now as a ConfigError NAMING `NPMGUARD_DEMO_SPEED`, where it
    used to be `could not convert string to float: 'fast'`, naming neither the knob
    nor the module. No longer a FINDING: the knob is declared in config.py and
    parsed there, so pydantic's field-level message is rewritten to name the
    environment variable an operator actually set."""
    import npmguard.api  # noqa: F401  (the import chain being asserted)

    assert "npmguard.demo" in sys.modules
    with pytest.raises(ConfigError) as excinfo:
        at_speed("fast")
    # Still a ValueError subclass, so any caller that broadly catches parse
    # failures at boot keeps working.
    assert isinstance(excinfo.value, ValueError)
    assert SPEED_ENV in str(excinfo.value)
    assert "could not convert string to float" not in str(excinfo.value)


@pytest.mark.parametrize(
    ("kind", "speed", "events", "lower", "upper"),
    [
        # agent_reasoning floors at 800 ms; the recorded gap is 1 ms. At speed 4
        # the floor is 200 ms, while the recorded delta alone would be 0.25 ms.
        (
            "floor",
            "4",
            [
                ("agent_reasoning", "00.000"),
                ("agent_reasoning", "00.001"),
                ("verdict_reached", "00.002"),
            ],
            0.1,
            None,
        ),
        # A 600 s recorded gap caps at MAX_DELAY_MS (4 s). At speed 40 that is
        # 100 ms; uncapped it would be 15 s, so the upper bound falsifies the cap.
        (
            "cap",
            "40",
            [
                ("file_list", "00.000"),
                ("file_list", "10:00.000"),
                ("verdict_reached", "10:00.001"),
            ],
            0.02,
            1.0,
        ),
    ],
)
async def test_throttle_floor_and_cap(
    rig, at_speed, tmp_path, monkeypatch, kind, speed, events, lower, upper
) -> None:
    """C13: the two bounds that make a replay watchable. The floor keeps frames
    from flying past faster than a human reads; the cap keeps a long pause in a
    recording from stalling the gallery. Both are observed as elapsed time over a
    three-frame recording, at a scaled speed so the test costs milliseconds. The
    last frame is the terminal one every recording must end with (C3b), one
    millisecond after the frame being measured, so it adds only its own floor
    (800 ms / speed — 200 ms and 20 ms) and cannot reach either bound."""
    recording = _valid(
        packageName="paced",
        events=[
            {"type": kind_, "timestamp": f"2026-01-01T00:{stamp}Z", "files": []}
            for kind_, stamp in events
        ],
    )
    module = at_speed(speed)
    monkeypatch.setattr(module, "REPO_ROOT", _write_recordings(tmp_path, {"paced.json": recording}))
    result = await _replay(rig, module, package="paced")
    assert len(result.frames) == len(events)
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


def test_recorded_report_has_no_extractable_version(rig, tmp_path, monkeypatch) -> None:
    """C15: the trap, and the half of it that is now closed. Every trace[].output in
    the recording is {} (curated), so the store still cannot recover a version from
    the report itself:
      * extract_report_version -> None;
      * save_report with "latest" or "" raises UnversionedReportError;
      * save_report with a version SUCCEEDS, filing the report under whatever the
        caller passed — the store cannot tell an honest version from a guess.
    What changed is that there is now something honest to pass: DemoRecording loads
    the recording's own `version`. Checked against the package.json of the source
    tree the recording is an audit OF, so this asserts AGREEMENT with the audited
    package rather than blessing a curated value — a re-record that moved the
    version would have to move both."""
    recorded = _recording(DANGEROUS_RECORDING)
    report = recorded["report"]
    assert [phase["output"] for phase in report["trace"]] == [{}] * len(report["trace"])
    assert report_store.extract_report_version(report) is None

    monkeypatch.setattr(report_store, "DATA_DIR", tmp_path / "reports")
    for requested in ("latest", ""):
        with pytest.raises(report_store.UnversionedReportError):
            report_store.save_report("test-pkg-env-exfil", requested, report)
    guessed = report_store.save_report("test-pkg-env-exfil", "9.9.9-a-guess", report)
    assert guessed == "9.9.9-a-guess"  # the caller's version, not the report's

    recording = demo_module.DemoService(rig.sessions, rig.stream).recordings["test-pkg-env-exfil"]
    audited = json.loads((EXFIL_SOURCES / "package.json").read_text(encoding="utf-8"))
    assert recording.version == audited["version"]
    assert report_store.save_report("test-pkg-env-exfil", recording.version, report) == "2.0.1"


async def test_the_report_row_is_durable_no_later_than_the_terminal_frame(rig, at_speed) -> None:
    """C16: was a FINDING (every frame emitted, then finalize — so the terminal frame
    could be durable while the row was still 'running' with no report, and a gallery
    that fetches on verdict_reached could get nothing). Now the real path's ordering:
    finalize runs INSIDE the transaction that appends the terminal frame, before the
    append. Observed at the store seam — when finalize runs, every non-terminal frame
    is already durable and the terminal one is not — plus the end state: the frame is
    there and the row is done, so nothing was merely dropped."""
    module = at_speed("0")
    result = await _replay(rig, module, package="chalk")
    observed = rig.sessions.frames_at_finalize
    assert observed is not None
    assert [frame["type"] for frame in observed] == [
        frame["type"] for frame in result.frames[:-1]
    ]
    assert not [frame for frame in observed if frame["type"] in TERMINAL_EVENTS]
    assert result.frames[-1]["type"] == "verdict_reached"
    assert result.row.status == "done" and result.row.report is not None


async def test_a_failed_terminal_append_rolls_the_report_row_back(
    rig, at_speed, monkeypatch
) -> None:
    """C16b: the two writes are one unit, not two ordered ones. With the append
    failing, the row must not be terminal and must hold no report — a terminal row
    whose terminal event never landed strands every follower for ever, since
    sse_events only returns on that event. kit_stream's append(session=…) joins the
    caller's transaction precisely so this rolls back. A finalize()-then-emit()
    ordering fix satisfies C16 and fails here.
    (A demo row left non-terminal is NOT repaired by restart recovery — the
    package_path demo tag deliberately hides it from queued()/running() — so what this
    buys is only the direction of the failure: a replay that visibly stops, never a
    terminal frame promising a report that is not there.)"""
    module = at_speed("0")
    service = module.DemoService(rig.sessions, rig.stream)
    original = rig.stream.append

    async def failing_append(channel, type, data=None, *, session=None):
        if type in TERMINAL_EVENTS:
            raise RuntimeError("stream is down")
        return await original(channel, type, data, session=session)

    monkeypatch.setattr(rig.stream, "append", failing_append)
    handle = await service.start("chalk")
    audit_id = handle["auditId"]
    task = next(
        task for task in asyncio.all_tasks() if task.get_name() == f"npmguard-demo-{audit_id}"
    )
    with pytest.raises(RuntimeError, match="stream is down"):
        await asyncio.wait_for(task, REPLAY_DEADLINE_SECONDS)

    monkeypatch.setattr(rig.stream, "append", original)
    row = await rig.sessions.get(audit_id)
    assert row is not None
    assert row.status not in ("done", "error")
    assert row.report is None
    frames = await _frames(rig.stream, audit_id)
    assert frames and not [frame for frame in frames if frame["type"] in TERMINAL_EVENTS]

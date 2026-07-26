# CLASS MAP — DemoService: what the committed recordings load as, what a viewer
# receives, and the row a seeded recording finalises. The demo path is a product
# surface (a replay gallery whose purpose is to be credible evidence), so the unit
# is "what a gallery viewer observes".
# Units: DemoService(sessions, stream).recordings and .start(name) -> the durable
#        event log (drained through sse_events, the same generator the SSE route
#        serves) + the audit_sessions row.
#
# Seams: a throwaway sqlite DB behind AuditSessionStore + StreamService with the
#  polling notifier — no HTTP, no engine process. `npmguard.demo.REPO_ROOT` for the
#  loader classes: the demo-data directory is resolved from it at construction and
#  there is no injection point.
#
# Axes: recording (DANGEROUS / SAFE / absent / unloadable) ×
#       what the viewer receives (frames, envelope, row, queue visibility) ×
#       what a future caller could do with the recorded report
#
# Three facts the tests below turn on that are not visible at any one of them:
#  - A broken recording takes the WHOLE load with it, named. DemoService is built
#    in the lifespan, so the gallery is all-or-nothing at boot — the treatment
#    config.py gives a bad NPMGUARD_* value. Skipping the file instead made a
#    malformed entry vanish, and an operator saw a missing demo rather than an error.
#  - A recording's LAST frame is its ONLY terminal frame. No terminal frame leaves
#    the row 'running' for ever and an SSE follower hanging (sse_events returns on a
#    terminal frame); frames after it are frames no follower can see. Neither shape
#    is producible by the real path, and the commit-ordering class depends on this
#    being total.
#  - The report row and the terminal frame commit TOGETHER, row first, which is the
#    real path's ordering (AuditService._finish). A gallery fetching the report on
#    verdict_reached therefore always finds it. Emitting every frame and only then
#    finalising the row let the terminal frame be seen while the row was still
#    'running' with no report.
from __future__ import annotations

import asyncio
import json
import shutil
import stat
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
# Seeding is a handful of inserts. The ceiling is two orders of magnitude above
# that and still an order below the shortest pause a recording carries, so it
# falsifies "a sleep came back" without being CI-sensitive.
INSTANT_CEILING = 0.4


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


async def _replay(rig, module=demo_module, *, package: str) -> SimpleNamespace:
    """Seed a recording and read back what a viewer would receive.

    No waiting and no polling: `start` returns once the whole tape is durable, so
    the row is already terminal. `elapsed` is kept because "seeding costs no wall
    clock" is now a property worth asserting.
    """
    service = module.DemoService(rig.sessions, rig.stream)
    started = time.monotonic()
    handle = await service.start(package)
    audit_id = handle.auditId
    elapsed = time.monotonic() - started
    row = await rig.sessions.get(audit_id)
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


async def test_replay_emits_every_recorded_frame_in_order_verbatim(rig) -> None:
    """C4: the contract is verbatim replay, so this asserts equality WITH THE
    RECORDING for all 68 frames — including the curated payload values, which are
    faithfully replayed lies (see the class map's curated table and C13)."""
    recorded = _recording(DANGEROUS_RECORDING)
    result = await _replay(rig, package="test-pkg-env-exfil")
    assert [frame["type"] for frame in result.frames] == [
        event["type"] for event in recorded["events"]
    ]
    assert [_payload(frame) for frame in result.frames] == [
        _payload(event) for event in recorded["events"]
    ]


async def test_replay_restamps_the_envelope_and_drops_recorded_timestamps(rig) -> None:
    """C5: seq/auditId/timestamp belong to THIS replay, not to the recording. A
    viewer therefore sees live time; the recorded 2026-01-01 instants only drive
    the pacing and never reach the wire."""
    recorded = _recording(DANGEROUS_RECORDING)
    result = await _replay(rig, package="test-pkg-env-exfil")
    assert [frame["seq"] for frame in result.frames] == list(range(len(recorded["events"])))
    assert {frame["auditId"] for frame in result.frames} == {result.audit_id}
    recorded_stamps = {event["timestamp"] for event in recorded["events"]}
    assert not recorded_stamps & {frame["timestamp"] for frame in result.frames}


async def test_replay_finalises_the_row_with_the_recorded_report(rig) -> None:
    """C6: nothing is regenerated — the row's report IS the recorded object.

    Internal consistency rather than pinned totals: a re-record moves how many
    hypotheses confirmed, and a test that pins the number goes red for a reason
    that is not a defect. What must hold on every capture is that the counts, the
    confirmed ids and the hypothesis list agree with each other."""
    recorded = _recording(DANGEROUS_RECORDING)
    result = await _replay(rig, package="test-pkg-env-exfil")
    assert result.row.status == "done"
    assert result.row.error is None
    assert result.row.report == recorded["report"]

    report = result.row.report
    assert report["verdict"] == "DANGEROUS"
    confirmed = [
        hypothesis["hypId"]
        for hypothesis in report["hypotheses"]
        if hypothesis["state"] == "CONFIRMED"
    ]
    assert confirmed, "a DANGEROUS verdict rests on at least one confirmed hypothesis"
    assert sorted(report["confirmedHypIds"]) == sorted(confirmed)
    assert report["counts"]["confirmed"] == len(confirmed)
    assert report["counts"]["total"] == len(report["hypotheses"])


async def test_safe_recording_replays_the_same_way(rig) -> None:
    """C7: the second recording, so the classes above are properties of the
    replayer and not of one file. A SAFE demo ends on the same terminal frame."""
    recorded = _recording(SAFE_RECORDING)
    result = await _replay(rig, package="chalk")
    assert len(result.frames) == len(recorded["events"]) == 30
    assert [_payload(frame) for frame in result.frames] == [
        _payload(event) for event in recorded["events"]
    ]
    assert result.frames[-1]["type"] == "verdict_reached"
    assert result.row.report["verdict"] == "SAFE"


async def test_demo_row_is_invisible_to_the_audit_queue(rig) -> None:
    """C8: package_path == DEMO_PACKAGE_PATH is the demo tag, and file_contents holds
    the recorded sources a viewer browses. So a replay is excluded from queued() /
    running() / queued_count() — it cannot consume a real audit's admission slot,
    and restart recovery cannot sweep it into a 0031 or re-run the real pipeline
    on it."""
    recorded = _recording(DANGEROUS_RECORDING)
    result = await _replay(rig, package="test-pkg-env-exfil")
    assert result.row.file_contents == recorded["files"]
    assert result.row.package_path == "__demo__"
    assert await rig.sessions.queued_count() == 0
    assert await rig.sessions.queued() == []
    assert await rig.sessions.running() == []


# --------------------------------------------------------------------------- #
# Seeding — the whole tape, at once
# --------------------------------------------------------------------------- #


async def test_the_whole_tape_is_durable_when_start_returns(rig) -> None:
    """C9: `start` seeds every frame before it answers, so a caller that connects
    on the returned id can never race the writer. The old replay spawned a paced
    background task, which meant "the audit exists" and "the audit is readable"
    were different moments."""
    service = demo_module.DemoService(rig.sessions, rig.stream)
    handle = await service.start("chalk")
    frames = await _frames(rig.stream, handle.auditId)
    assert len(frames) == len(_recording(SAFE_RECORDING)["events"])
    row = await rig.sessions.get(handle.auditId)
    assert row is not None and row.status == "done"


async def test_seeding_leaves_no_background_task_behind(rig) -> None:
    """C10: there is no replay task. A gallery that opens ten demos should not be
    holding ten sleeping coroutines, and a server-side sleep is exactly what a
    pausable, seekable client replay cannot use."""
    before = {task.get_name() for task in asyncio.all_tasks()}
    service = demo_module.DemoService(rig.sessions, rig.stream)
    handle = await service.start("chalk")
    leaked = [
        task.get_name()
        for task in asyncio.all_tasks()
        if task.get_name() not in before and handle.auditId in task.get_name()
    ]
    assert leaked == []


async def test_seeding_a_long_recording_costs_no_wall_clock(rig, tmp_path, monkeypatch) -> None:
    """C11: pacing is gone rather than merely fast. A recording whose frames are ten
    minutes apart seeds in the same time as one whose frames are milliseconds apart,
    because the recorded timestamps are DATA the client reads — never a schedule the
    server sleeps against."""
    recording = _valid(
        packageName="paced",
        events=[
            {"type": "file_list", "timestamp": "2026-01-01T00:00:00.000Z", "files": []},
            {"type": "file_list", "timestamp": "2026-01-01T00:10:00.000Z", "files": []},
            {"type": "verdict_reached", "timestamp": "2026-01-01T00:20:00.000Z"},
        ],
    )
    monkeypatch.setattr(
        demo_module, "REPO_ROOT", _write_recordings(tmp_path, {"paced.json": recording})
    )
    result = await _replay(rig, package="paced")
    assert len(result.frames) == 3
    assert result.elapsed < INSTANT_CEILING


# --------------------------------------------------------------------------- #
# Fidelity — the recording IS an audit
# --------------------------------------------------------------------------- #
#
# These replace the divergence pins (C14a–c). Those existed to make a HYBRID
# recording's curated values visible — a `file_list` claiming fileType
# "javascript" where the engine emits "js", a `dependencies_provisioned` claiming
# an install that never ran, a risk score contradicting its own severities — and
# their own docstrings said to delete them when the recording was re-recorded.
# It has been: both recordings are now end-to-end captures from the real engine.
#
# So the class flips direction. Where it once pinned divergence AS divergence, it
# now asserts agreement, and against the engine's own code over the same
# committed source tree rather than against a quoted document.


def test_the_recorded_file_frame_is_what_the_engine_emits(tmp_path) -> None:
    """C14: `file_list` agrees with `classify_files` over the source tree the
    recording is an audit OF — path set, sizes, fileType and permissions. Computed
    from the engine, so a change to either side has to move both."""
    recorded = _recording(DANGEROUS_RECORDING)
    frame = next(event for event in recorded["events"] if event["type"] == "file_list")
    recorded_files = {entry["path"]: entry for entry in frame["files"]}

    package = tmp_path / "package"
    shutil.copytree(EXFIL_SOURCES, package)
    engine_files = {record.path: record for record in classify_files(package)}

    assert set(recorded_files) == set(engine_files)
    for path, record in engine_files.items():
        assert recorded_files[path]["sizeBytes"] == record.sizeBytes
        assert recorded_files[path]["fileType"] == record.fileType
    assert EXTENSION_TYPE_MAP[".js"] == "js"
    assert {entry["permissions"] for entry in recorded_files.values()} == {
        format(stat.S_IMODE(0o644), "o")
    }


async def test_the_recorded_dependency_frame_is_what_the_engine_emits(tmp_path) -> None:
    """C14b: the same, for `dependencies_provisioned`. The package declares no
    runtime dependencies, so the engine reports installed=False with a skip reason —
    and now so does the recording. No docker is reached: the empty case
    short-circuits before the daemon."""
    recorded = _recording(DANGEROUS_RECORDING)
    frame = next(
        event for event in recorded["events"] if event["type"] == "dependencies_provisioned"
    )

    package = tmp_path / "package"
    shutil.copytree(EXFIL_SOURCES, package)
    provision = await provision_dependencies(package, Settings(_env_file=None))
    assert (frame["installed"], frame["packageCount"], frame["skipped"]) == (
        provision.installed,
        provision.package_count,
        provision.skipped_reason,
    )


def test_the_recorded_risk_score_is_what_the_severities_compute() -> None:
    """C14c: a file's `riskContribution` is the engine's SEVERITY_SCORE over the max
    severity of the hypotheses pointing at it. The hybrid recording said 3 for a
    file whose six hypotheses maxed at "high" (8), so a UI calibrated on the demo
    under-reported a multi-severity file. Recomputed here from the recording's own
    hypotheses, so the demo can no longer teach a wrong calibration."""
    recorded = _recording(DANGEROUS_RECORDING)
    for frame in recorded["events"]:
        if frame["type"] != "file_verdict":
            continue
        file = frame["verdict"]["file"]
        severities = [
            hypothesis["severity"]
            for hypothesis in recorded["report"]["hypotheses"]
            if file in (hypothesis.get("focusFiles") or [])
        ]
        if not severities:
            continue
        computed = SEVERITY_SCORE[max(severities, key=lambda value: SEVERITY_SCORE[value])]
        assert frame["verdict"]["riskContribution"] == computed, file


def test_the_recorded_report_carries_a_recoverable_version(rig, tmp_path, monkeypatch) -> None:
    """C15: the trap, now closed at the source.

    `save_report` cannot tell an honest version from a guess — it accepts whatever
    the caller passes and refuses only "latest"/"". The hybrid recording made that
    reachable, because every `trace[].output` in it was `{}` and
    `extract_report_version` therefore returned None. A real capture carries the
    resolve phase's real output, so the version is recoverable FROM THE REPORT and
    agrees with the package.json of the tree the recording is an audit of."""
    recorded = _recording(DANGEROUS_RECORDING)
    report = recorded["report"]
    audited = json.loads((EXFIL_SOURCES / "package.json").read_text(encoding="utf-8"))

    assert report_store.extract_report_version(report) == audited["version"]

    monkeypatch.setattr(report_store, "DATA_DIR", tmp_path / "reports")
    # The report now OUTRANKS the caller, which is the whole repair: "latest" and
    # a wrong guess both file under the version the audit really resolved, so a
    # caller can no longer misfile a report by passing the wrong string.
    for requested in ("latest", "", "9.9.9-a-guess"):
        assert report_store.save_report("test-pkg-env-exfil", requested, report) == "2.0.1"

    # And the refusal still stands where it is still the only guard: a report with
    # no concrete version anywhere must never be persisted as a `latest` alias.
    versionless = {**report, "trace": [{**phase, "output": {}} for phase in report["trace"]]}
    assert report_store.extract_report_version(versionless) is None
    with pytest.raises(report_store.UnversionedReportError):
        report_store.save_report("test-pkg-env-exfil", "latest", versionless)

    recording = demo_module.DemoService(rig.sessions, rig.stream).recordings["test-pkg-env-exfil"]
    assert recording.version == audited["version"]


async def test_the_report_row_is_durable_no_later_than_the_terminal_frame(rig) -> None:
    """C16: was a FINDING (every frame emitted, then finalize — so the terminal frame
    could be durable while the row was still 'running' with no report, and a gallery
    that fetches on verdict_reached could get nothing). Now the real path's ordering:
    finalize runs INSIDE the transaction that appends the terminal frame, before the
    append. Observed at the store seam — when finalize runs, every non-terminal frame
    is already durable and the terminal one is not — plus the end state: the frame is
    there and the row is done, so nothing was merely dropped."""
    result = await _replay(rig, package="chalk")
    observed = rig.sessions.frames_at_finalize
    assert observed is not None
    assert [frame["type"] for frame in observed] == [frame["type"] for frame in result.frames[:-1]]
    assert not [frame for frame in observed if frame["type"] in TERMINAL_EVENTS]
    assert result.frames[-1]["type"] == "verdict_reached"
    assert result.row.status == "done" and result.row.report is not None


async def test_a_failed_terminal_append_rolls_the_report_row_back(rig, monkeypatch) -> None:
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
    service = demo_module.DemoService(rig.sessions, rig.stream)
    original = rig.stream.append
    create = rig.sessions.create
    created: list[str] = []

    async def recording_create(*args, **kwargs):
        session = await create(*args, **kwargs)
        created.append(session.audit_id)
        return session

    async def failing_append(channel, type, data=None, *, session=None):
        if type in TERMINAL_EVENTS:
            raise RuntimeError("stream is down")
        return await original(channel, type, data, session=session)

    monkeypatch.setattr(rig.sessions, "create", recording_create)
    monkeypatch.setattr(rig.stream, "append", failing_append)
    # Seeding is awaited now, so the failure reaches the caller of `start`
    # directly instead of dying inside a background task nobody joins. The row
    # exists by then — `start` creates it before seeding — so its id has to come
    # off the create call rather than off a return value there never is.
    with pytest.raises(RuntimeError, match="stream is down"):
        await service.start("chalk")

    monkeypatch.setattr(rig.stream, "append", original)
    (audit_id,) = created
    row = await rig.sessions.get(audit_id)
    assert row is not None
    assert row.status not in ("done", "error")
    assert row.report is None
    frames = await _frames(rig.stream, audit_id)
    assert frames and not [frame for frame in frames if frame["type"] in TERMINAL_EVENTS]

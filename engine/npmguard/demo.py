from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from kit_stream import StreamService

from .config import REPO_ROOT
from .contract.models import StartAuditResponse
from .events import ENVELOPE_KEYS, TERMINAL_EVENTS, AuditEmitter, audit_channel
from .persistence import DEMO_PACKAGE_PATH, AuditSessionStore

# There is no pacing here, and the absence is the design. A recording is seeded
# whole and instantly; how fast a viewer watches it is a client decision, because
# the client is the only side that can pause, seek, restart and change speed. A
# server-side sleep offers none of those and makes every replay start over.


@dataclass(frozen=True)
class DemoRecording:
    package_name: str
    # The version the recorded audit was OF. Read from the recording rather than
    # inferred, because the recorded report cannot supply it: every trace[].output
    # in the committed recordings is {}, so report_store.extract_report_version
    # returns None — and save_report then REFUSES "latest" while ACCEPTING any
    # explicit version, filing the report under whatever the caller guessed. A
    # demo -> save_report route therefore needs an honest version to pass, and
    # this is it (test_demo.py C15).
    version: str
    events: list[dict[str, Any]]
    files: dict[str, str]
    report: dict[str, Any]


class DemoRecordingError(RuntimeError):
    """A committed demo recording could not be loaded, or could not be replayed
    the way a real audit ends.

    Raised rather than logged. It was one `log.warning` per file, so a malformed
    recording simply vanished from `/demo/packages` — defensible for an internal
    fixture loader, but Phase 5 promotes that list to a replay gallery whose whole
    purpose is to be credible evidence, and a missing exhibit there is a broken
    product surface rather than a line in a log nobody reads. DemoService is
    constructed in the engine's lifespan, so this stops the boot with the FILE and
    the cause named — the same treatment config.py gives a bad NPMGUARD_* value.
    The blast radius is bounded by where recordings come from: committed files that
    the test suite loads, so this can only fire on a bad commit, and boot is the
    cheapest place to find out.
    """


REQUIRED_KEYS = ("packageName", "version", "events", "files", "report")


def _load_recording(path: Path) -> DemoRecording:
    """One recording, or a DemoRecordingError naming the file and the cause."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        recording = DemoRecording(
            package_name=payload["packageName"],
            version=payload["version"],
            events=payload["events"],
            files=payload["files"],
            report=payload["report"],
        )
        terminal = [
            index
            for index, event in enumerate(recording.events)
            if event["type"] in TERMINAL_EVENTS
        ]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        # Every cause — unreadable file, JSON that is not an object, missing key —
        # reaches the caller located by path rather than swallowed.
        raise DemoRecordingError(
            f"demo recording {path} is unusable ({exc!r}); required keys are "
            f"{', '.join(REQUIRED_KEYS)}"
        ) from exc
    # INVARIANT: a recording's LAST frame is its only terminal frame. _replay commits
    # the row and that frame in one transaction, so this is what makes "row terminal
    # <=> terminal frame durable" total: a recording with no terminal frame would
    # leave its row non-terminal for ever (a demo row is born 'queued' and recovery
    # deliberately ignores it) with an SSE follower waiting on a frame that never
    # comes, and frames AFTER the terminal one are frames no follower can receive —
    # sse_events returns on it. Neither is a shape the real path can produce, so
    # neither may reach a replay.
    if terminal != [len(recording.events) - 1]:
        raise DemoRecordingError(
            f"demo recording {path} has terminal frames at {terminal} of "
            f"{len(recording.events)} events — a replay must END with exactly one "
            f"of {sorted(TERMINAL_EVENTS)}, as every real audit does"
        )
    return recording


class DemoService:
    def __init__(self, sessions: AuditSessionStore, stream: StreamService) -> None:
        self.sessions = sessions
        self.stream = stream
        self.recordings = self._load()

    @staticmethod
    def _load() -> dict[str, DemoRecording]:
        """The gallery index, keyed by packageName. Every *.json in demo-data must
        load, or the boot fails naming the file. Sorted so which one fails first is
        deterministic; Path.glob on a missing directory yields nothing, so a
        deployment that ships no demo-data simply has no gallery."""
        directory = REPO_ROOT / "engine" / "demo-data"
        recordings: dict[str, DemoRecording] = {}
        for path in sorted(directory.glob("*.json")):
            recording = _load_recording(path)
            # Two files claiming one packageName is the same silent loss as a
            # recording that fails to parse: the index is keyed by it, so the
            # loser is simply not in the gallery.
            if recording.package_name in recordings:
                raise DemoRecordingError(
                    f"demo recording {path} claims packageName "
                    f"{recording.package_name!r}, which another recording in "
                    f"{directory} already occupies"
                )
            recordings[recording.package_name] = recording
        return recordings

    async def start(self, package_name: str) -> StartAuditResponse:
        recording = self.recordings.get(package_name)
        if recording is None:
            raise KeyError(f'No demo recording for "{package_name}"')
        # package_path is the demo tag (persistence._not_demo); file_contents is just
        # the recorded sources a viewer browses.
        session = await self.sessions.create(
            package_name, file_contents=recording.files, package_path=DEMO_PACKAGE_PATH
        )
        # Awaited, not spawned: seeding is a handful of inserts with no pacing, so
        # the response can honestly say the stream is already there. A background
        # task would reintroduce the window a subscriber could win.
        await self._seed(session.audit_id, recording)
        return StartAuditResponse(auditId=session.audit_id, packageName=package_name)

    async def _seed(self, audit_id: str, recording: DemoRecording) -> None:
        """Write the whole recording into the durable log, immediately.

        No pacing. A replay's tempo is a PRESENTATION decision and it belongs to
        the client, which is the only side that can pause, seek, change speed or
        step — none of which a server-side sleep can offer, because the frame a
        viewer wants to look at again is one the server already sent.

        Seeding at once also makes a demo behave exactly like any other finished
        audit: the durable stream is complete from the first read, so
        `GET /audit/{id}/events` replays it from `seq` 0 the same way it replays a
        real one, and a reconnect resumes from the same cursor.
        """
        emitter = AuditEmitter(audit_id, self.stream)
        for event in recording.events:
            # ENVELOPE_KEYS, not a local literal: these four are exactly the fields
            # _wire_event stamps back on, and a payload carrying one would shadow the
            # envelope's own value (events.py asserts it at both ends).
            payload = {key: value for key, value in event.items() if key not in ENVELOPE_KEYS}
            if event["type"] in TERMINAL_EVENTS:
                # INVARIANT: the row's report is durable no later than the terminal
                # frame — the same ordering AuditService._finish gives a real audit,
                # for the same reason, and _load_recording guarantees this runs
                # exactly once, on the last frame. Finalizing AFTER the frames would
                # let a gallery that fetches the report on verdict_reached find a row
                # still 'running' with no report. Appended straight to the stream
                # rather than through the emitter so it JOINS this transaction: both
                # writes commit together or neither does, exactly as _finish does it.
                async with self.sessions.transaction() as db:
                    await self.sessions.finalize(audit_id, recording.report, session=db)
                    await self.stream.append(
                        audit_channel(audit_id), event["type"], payload, session=db
                    )
            else:
                await emitter.emit(event["type"], payload)

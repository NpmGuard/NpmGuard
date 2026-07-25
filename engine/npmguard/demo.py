from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from kit_stream import StreamService

from .config import REPO_ROOT, Settings
from .events import ENVELOPE_KEYS, TERMINAL_EVENTS, AuditEmitter, audit_channel
from .persistence import DEMO_PACKAGE_PATH, AuditSessionStore

MIN_DELAY_MS = 10
MAX_DELAY_MS = 4_000
MIN_TYPE_DELAY = {
    "phase_started": 400,
    "file_analyzing": 600,
    "file_verdict": 300,
    "agent_thinking": 500,
    "agent_tool_call": 400,
    "agent_tool_result": 500,
    "agent_reasoning": 800,
    "finding_discovered": 600,
    "triage_complete": 500,
    "verdict_reached": 800,
    "verify_test_result": 700,
}
# Playwright/e2e divides the human throttle by this (0 ⇒ emit instantly); prod unset ⇒ 1.0.
#
# Read through Settings, so `NPMGUARD_DEMO_SPEED=fast` is a ConfigError NAMING the
# variable instead of `ValueError: could not convert string to float: 'fast'` from a
# bare `float()` on the raw string — and npmguard.api imports this module, so that
# bare ValueError stopped the engine booting. Still at module scope and still a
# fresh `Settings()` rather than the cached `get_settings()`: this constant is the
# knob's only seam (tests set the variable and reload the module), and a cached
# singleton would make the reload a no-op.
#
# The `max(0.0, …)` clamp stays because it is pinned behaviour (test_demo.py C11),
# but a negative divisor is an incoherent value, not a value to normalise:
# `demo_speed: float = Field(default=1, ge=0)` in config.py would refuse it at boot
# and let this line be `Settings().demo_speed`. That change is one line here plus
# one there, and it turns C11 red — so it belongs with an edit to test_demo.py.
DEMO_SPEED = max(0.0, Settings().demo_speed)


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
        self._tasks: set[asyncio.Task[None]] = set()

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

    async def start(self, package_name: str) -> dict[str, str]:
        recording = self.recordings.get(package_name)
        if recording is None:
            raise KeyError(f'No demo recording for "{package_name}"')
        # package_path is the demo tag (persistence._not_demo); file_contents is just
        # the recorded sources a viewer browses.
        session = await self.sessions.create(
            package_name, file_contents=recording.files, package_path=DEMO_PACKAGE_PATH
        )
        task = asyncio.create_task(
            self._replay(session.audit_id, recording), name=f"npmguard-demo-{session.audit_id}"
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return {"auditId": session.audit_id, "packageName": package_name}

    async def _replay(self, audit_id: str, recording: DemoRecording) -> None:
        emitter = AuditEmitter(audit_id, self.stream)
        previous: datetime | None = None
        for event in recording.events:
            current = _timestamp(event.get("timestamp"))
            if previous is not None and current is not None:
                delta = int((current - previous).total_seconds() * 1_000)
                delay = min(
                    MAX_DELAY_MS, max(MIN_TYPE_DELAY.get(event["type"], MIN_DELAY_MS), delta)
                )
                if DEMO_SPEED > 0:
                    await asyncio.sleep(delay / 1_000 / DEMO_SPEED)
                # DEMO_SPEED == 0 → emit as fast as possible (skip the sleep entirely)
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
            previous = current or previous


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

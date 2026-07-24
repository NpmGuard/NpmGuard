from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import structlog

from kit_stream import StreamService

from .config import REPO_ROOT
from .events import AuditEmitter
from .persistence import AuditSessionStore

log = structlog.get_logger("npmguard.demo")
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
DEMO_SPEED = max(0.0, float(os.environ.get("NPMGUARD_DEMO_SPEED", "1")))


@dataclass(frozen=True)
class DemoRecording:
    package_name: str
    events: list[dict[str, Any]]
    files: dict[str, str]
    report: dict[str, Any]


class DemoService:
    def __init__(self, sessions: AuditSessionStore, stream: StreamService) -> None:
        self.sessions = sessions
        self.stream = stream
        self.recordings = self._load()
        self._tasks: set[asyncio.Task[None]] = set()

    @staticmethod
    def _load() -> dict[str, DemoRecording]:
        candidates = (REPO_ROOT / "engine" / "demo-data",)
        directory = next((path for path in candidates if path.exists()), None)
        if directory is None:
            return {}
        recordings: dict[str, DemoRecording] = {}
        for path in directory.glob("*.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                recording = DemoRecording(
                    package_name=payload["packageName"],
                    events=payload["events"],
                    files=payload["files"],
                    report=payload["report"],
                )
                recordings[recording.package_name] = recording
            except (OSError, KeyError, TypeError, json.JSONDecodeError):
                log.warning("invalid demo recording", file=str(path))
        return recordings

    async def start(self, package_name: str) -> dict[str, str]:
        recording = self.recordings.get(package_name)
        if recording is None:
            raise KeyError(f'No demo recording for "{package_name}"')
        # Create the demo-tagged row atomically: file_contents IS NOT NULL is the
        # de-facto demo tag, so running()/queued()/queued_count() exclude it and
        # restart recovery never 0031s or re-runs the real pipeline on a replay.
        session = await self.sessions.create(
            package_name, file_contents=recording.files, package_path="__demo__"
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
            payload = {
                key: value
                for key, value in event.items()
                if key not in {"type", "auditId", "timestamp", "seq"}
            }
            await emitter.emit(event["type"], payload)
            previous = current or previous
        await self.sessions.finalize(audit_id, recording.report)


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

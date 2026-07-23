"""Bounded waits for post-terminal persistence probes.

The engine emits the terminal SSE event BEFORE it finalizes the session and
saves the report file (service.py: pipeline.run() emits verdict_reached, then
sessions.finalize(), then save_report(); _fail_interrupted emits before it
finalizes too). A client that saw the terminal frame can therefore beat the
durable write. Every probe of post-terminal STATE (report file on disk, the
/audit/:id/report route leaving 202) must poll bounded — these helpers are the
single place that encodes that rule. Observed for real: S29 flaked 1-in-2 on
`persisted.is_file()` right after the terminal frame (A2 verify pass).
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

REPORT_PERSIST_TIMEOUT_SECONDS = 15.0
REPORT_POLL_SECONDS = 0.05
HTTP_TIMEOUT_SECONDS = 30.0


def wait_report_file(path: Path, timeout: float = REPORT_PERSIST_TIMEOUT_SECONDS) -> dict:
    """Poll (bounded) until the report file exists and parses; return it."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                pass  # mid-write; retry within the bound
        time.sleep(REPORT_POLL_SECONDS)
    raise AssertionError(f"report file {path} not written within {timeout}s")


def wait_audit_report(
    base_url: str, audit_id: str, timeout: float = REPORT_PERSIST_TIMEOUT_SECONDS
) -> httpx.Response:
    """Poll GET /audit/:id/report (bounded) until it leaves 202 status=running.

    The route serves 202 until sessions.finalize() lands — which happens AFTER
    the terminal event is emitted. Returns the first non-202 response (200
    report / 500 error / 404), for the caller to assert on.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = httpx.get(
            f"{base_url}/audit/{audit_id}/report", timeout=HTTP_TIMEOUT_SECONDS
        )
        if response.status_code != 202:
            return response
        time.sleep(REPORT_POLL_SECONDS)
    raise AssertionError(f"audit {audit_id} report still 202 running after {timeout}s")

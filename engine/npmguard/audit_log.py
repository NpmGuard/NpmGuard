import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from .config import Settings


def _json_value(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_none=False)
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


class AuditLog:
    """One directory per pipeline EXECUTION: everything that run wrote, and the
    content-addressed artifacts it sealed (`ArtifactStore` is rooted here).

    INVARIANT: the name carries the `audit_id`, so every blob under it is joinable
    back to the run that produced it — `<audit_log_dir>/*_<audit_id>/artifacts/…`,
    one glob, no side table. It was `<timestamp>_<package>`, keyed by two things that
    identify neither the run nor anything else in the system: `audit_sessions.report`,
    the SSE stream, the LLM capture context and `evidenceRefs[].hash` are all keyed by
    `audit_id`, so the sealed artifact tier was reachable from a report only by
    searching every run directory on the host. `tools/export_fixtures.py` carries a
    HAND-MAINTAINED `audit-logs-dir-to-audit-id.json` for exactly that reason, and
    the bench's per-run render-fidelity coverage publishes `null` instead of a number
    (`npmguard/bench/fidelity.py`).

    The timestamp and package STAY, and the audit_id is a suffix rather than the whole
    name, because one `audit_id` can execute this pipeline more than once: an errored
    audit is re-submittable (`persistence.reset_to_queued`, "a recoverable 'error'
    replay"), and `write` numbers from 01 on every construction — so a bare
    `<audit_id>` directory would have the retry overwrite the failed attempt's phase
    files, which are the ones worth reading. Chronological `sorted()`/`ls` ordering is
    preserved by keeping the stamp first.
    """

    def __init__(self, package_name: str, audit_id: str) -> None:
        stamp = datetime.now(UTC).isoformat().replace(":", "-").replace(".", "-")
        # One sanitizer for both: `package_name` is caller-supplied (an npm name off
        # the wire) and `audit_id` is a uuid4 from the session row in production but a
        # literal in tests, and neither may contribute a path separator to a directory
        # this constructor then mkdirs.
        safe = re.sub(r"[^a-zA-Z0-9_-]", "_", package_name)
        run = re.sub(r"[^a-zA-Z0-9_-]", "_", audit_id)
        # Resolved per AuditLog, i.e. per audit, so `NPMGUARD_AUDIT_LOG_DIR` stays the
        # seam tests move this directory through — hence `Settings()` rather than the
        # cached `get_settings()`. Through Settings so the value is validated
        # absolute: a relative root silently follows the process cwd, which for the
        # engine is whatever systemd/uvicorn/pytest started it in.
        root = Settings().audit_log_dir
        self.audit_id = audit_id
        self.run_dir = root / f"{stamp}_{safe}_{run}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self._counter = 0

    def write(self, name: str, data: Any) -> Path:
        self._counter += 1
        path = self.run_dir / f"{self._counter:02d}_{name}"
        data = _json_value(data)
        content = data if isinstance(data, str) else json.dumps(data, indent=2, ensure_ascii=False)
        path.write_text(content, encoding="utf-8")
        return path

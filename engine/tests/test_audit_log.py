# CLASS MAP — AuditLog run-dir writer (seam: NPMGUARD_AUDIT_LOG_DIR env knob,
# read per-construction — pointed at tmp_path so no repo residue)
# Axes: payload shape handed to write()
#   C1 nested pydantic model lists serialize to plain JSON on disk
# UNENFORCED here: run-dir naming/ordering and string-payload passthrough are
# exercised implicitly by the orchestrator/pipeline suites, not pinned as classes.
# Adversarial pass: 2026-07-23/W6 — REPO_ROOT monkeypatch replaced with the
# public env knob.
import json

from npmguard.audit_log import AuditLog
from npmguard.phases import Flag


def test_audit_log_serializes_nested_model_lists(tmp_path, monkeypatch) -> None:
    """C1: a list of models round-trips to plain JSON under the env-pointed root."""
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "audit-logs"))
    log = AuditLog("package")

    path = log.write("flags.json", [Flag(file="index.js", lines=["1-1"], why="test")])

    assert path.is_relative_to(tmp_path / "audit-logs")
    assert json.loads(path.read_text(encoding="utf-8")) == [
        {"file": "index.js", "lines": ["1-1"], "why": "test"}
    ]

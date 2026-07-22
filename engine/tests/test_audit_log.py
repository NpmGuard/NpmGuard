import json

from npmguard import audit_log
from npmguard.audit_log import AuditLog
from npmguard.phases import Flag


def test_audit_log_serializes_nested_model_lists(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(audit_log, "REPO_ROOT", tmp_path)
    log = AuditLog("package")

    path = log.write("flags.json", [Flag(file="index.js", lines=["1-1"], why="test")])

    assert json.loads(path.read_text(encoding="utf-8")) == [
        {"file": "index.js", "lines": ["1-1"], "why": "test"}
    ]

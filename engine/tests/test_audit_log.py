# CLASS MAP — AuditLog run-dir writer (seam: NPMGUARD_AUDIT_LOG_DIR env knob,
# read per-construction — pointed at tmp_path so no repo residue)
# Axes: payload shape handed to write() × what the run dir's NAME makes findable
#   C1 nested pydantic model lists serialize to plain JSON on disk
#   C2 the run dir names its audit_id, so a sealed artifact is joinable back to the
#      run that produced it from the audit_id ALONE — one glob, no side table.
#      This is the fact the rest of the system is keyed on: audit_sessions.report,
#      the SSE stream, the LLM capture context and evidenceRefs[].hash are all
#      audit_id-keyed. A directory named <timestamp>_<package> alone identifies
#      neither, which is why tools/export_fixtures.py ships a HAND-MAINTAINED
#      audit-logs-dir-to-audit-id.json and npmguard/bench publishes
#      `coverage: null` rather than a number
#   C3 two executions of the SAME audit_id get DIFFERENT directories. An errored
#      audit is re-submittable (persistence.reset_to_queued, "a recoverable 'error'
#      replay") and write() numbers from 01 on every construction, so a bare
#      <audit_id> directory would have the retry overwrite the failed attempt's
#      phase files — which are the ones worth reading. This is why the audit_id is a
#      SUFFIX on the timestamped name rather than the whole name
#   C4 neither component can contribute a path separator: a package name off the
#      wire and an audit_id both go through the same sanitizer, so the directory
#      stays inside the configured root
# UNENFORCED here: string-payload passthrough and write() ordering are exercised
# implicitly by the orchestrator/pipeline suites, not pinned as classes.
# C3 is the pairing that stops C2 being satisfied by a directory named <audit_id>
# and nothing else: C1 alone passed with the audit_id absent from the artifact name,
# so the joinability this layout exists for was pinned by nothing.
import json

from npmguard.audit_log import AuditLog
from npmguard.evidence import ArtifactStore
from npmguard.phases import Flag

# The smallest artifact `write_artifact` accepts — this file is about WHERE a
# sealed blob lands, not what is in it.
_ARTIFACT_DRAFT = {
    "runId": "run-1",
    "triggerUsed": {"kind": "entrypoint", "target": "index.js", "argv": [], "stdin": None},
    "setupApplied": {"env": {}, "plantFiles": []},
    "observe": {"kernel": True, "network": True, "fsDiff": True, "node": True, "inspector": True},
    "budget": {"wallMs": 20000},
    "wallMs": 1.0,
    "exitCode": 0,
    "timedOut": False,
    "events": [],
    "eventSummary": {"counts": {}, "totalEvents": 0, "streams": [], "truncated": False},
    "error": None,
    "createdAt": "2026-07-20T00:00:00Z",
}


def test_audit_log_serializes_nested_model_lists(tmp_path, monkeypatch) -> None:
    """C1: a list of models round-trips to plain JSON under the env-pointed root."""
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "audit-logs"))
    log = AuditLog("package", "audit-42")

    path = log.write("flags.json", [Flag(file="index.js", lines=["1-1"], why="test")])

    assert path.is_relative_to(tmp_path / "audit-logs")
    assert json.loads(path.read_text(encoding="utf-8")) == [
        {"file": "index.js", "lines": ["1-1"], "why": "test"}
    ]


def test_a_sealed_artifact_is_findable_from_the_audit_id_alone(tmp_path, monkeypatch) -> None:
    """C2: the join the artifact tier needs. Given only an audit_id and the log root
    — which is all a stored report gives a consumer — the blob a digest names is
    located by one glob. Asserted through ArtifactStore, the real writer rooted at
    run_dir, rather than through the directory name, because the name is a means and
    the reachable blob is the property."""
    root = tmp_path / "audit-logs"
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(root))
    audit_id = "3f2b9c10-0000-4000-8000-000000000001"
    log = AuditLog("@scope/pkg", audit_id)

    digest = ArtifactStore(log.run_dir).write_artifact(_ARTIFACT_DRAFT)

    found = list(root.glob(f"*_{audit_id}/artifacts/{digest}.runartifact.json"))
    assert len(found) == 1, sorted(path.name for path in root.iterdir())
    assert digest in found[0].read_text(encoding="utf-8")
    # The timestamp and package survive in the name, so `sorted()`/`ls` still order
    # runs chronologically and a human can still see what was audited. The package's
    # `@` and `/` are sanitized to `_`, which is what makes the `_`-separated suffix
    # unambiguous to the glob above.
    name = found[0].parent.parent.name
    assert name.endswith(f"_scope_pkg_{audit_id}")
    assert name.startswith("2026-")  # the timestamp still leads, so ls -1 is ordered


def test_a_re_run_of_one_audit_id_does_not_overwrite_the_first_attempt(
    tmp_path, monkeypatch
) -> None:
    """C3: the reason the audit_id is a suffix and not the whole directory name. Two
    AuditLogs for one audit_id — what a re-submitted errored audit produces — keep
    both attempts' phase files. Under a bare `<audit_id>` root the second execution's
    `01_resolve.json` would land on top of the first's, and the failed attempt is
    exactly the one worth reading."""
    root = tmp_path / "audit-logs"
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(root))
    audit_id = "retried-audit"

    first = AuditLog("package", audit_id)
    first_path = first.write("resolve.json", {"attempt": 1})
    second = AuditLog("package", audit_id)
    second_path = second.write("resolve.json", {"attempt": 2})

    assert first.run_dir != second.run_dir
    assert json.loads(first_path.read_text(encoding="utf-8")) == {"attempt": 1}
    assert json.loads(second_path.read_text(encoding="utf-8")) == {"attempt": 2}
    # Both are still joinable to the one audit_id, which is what makes the glob in
    # C2 a glob rather than a lookup — a resolver takes the newest.
    assert len(list(root.glob(f"*_{audit_id}"))) == 2


def test_neither_name_component_can_escape_the_log_root(tmp_path, monkeypatch) -> None:
    """C4: a package name is caller-supplied (an npm name off the wire) and an
    audit_id is a uuid4 in production but a literal everywhere else, so both go
    through one sanitizer before naming a directory this constructor then mkdirs."""
    root = tmp_path / "audit-logs"
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(root))

    log = AuditLog("../../etc/passwd", "../../../root")

    assert log.run_dir.resolve().is_relative_to(root.resolve())
    assert log.run_dir.parent == root
    assert log.write("x.json", {}).resolve().is_relative_to(root.resolve())

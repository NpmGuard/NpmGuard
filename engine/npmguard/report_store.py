import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, get_args

import structlog

from .config import Settings
from .contract import models as contract

# Through Settings, not `os.environ`, so `NPMGUARD_DATA_DIR=reports` is a named boot
# rejection (`must be an absolute path`) instead of a report store that silently
# follows the process cwd — the same reason audit_log.py reads its root that way.
# Still a module constant resolved at IMPORT, which is the seam eight test modules
# already re-point (`monkeypatch.setattr(report_store, "DATA_DIR", …)`) and which
# tests/conftest.py's residue guard depends on: the knob must be set before the first
# import of this module, and the guard asserts exactly that.
DATA_DIR = (Settings().data_dir / "reports").resolve()

log = structlog.get_logger("npmguard.report_store")

# The verdict domain, DERIVED from the generated contract rather than restated, so
# it cannot drift from `AuditReport.verdict` and widens automatically if the audit
# core is ever given a fourth conclusion. Restating it as a literal here would be
# the hand-mirrored second copy N-12 exists to abolish.
REPORT_VERDICTS: frozenset[str] = frozenset(
    get_args(contract.AuditReport.model_fields["verdict"].annotation)
)
REPORT_SCHEMA_VERSIONS: frozenset[int] = frozenset(
    get_args(contract.AuditReport.model_fields["schemaVersion"].annotation)
)
if not REPORT_VERDICTS or not REPORT_SCHEMA_VERSIONS:
    # A raise, at import: an empty domain would silently reject every report and
    # turn this store into the fabricated empty list N-3 names as the canonical
    # violation. `assert` would let `python -O` do exactly that.
    raise AssertionError(
        "AuditReport.verdict / .schemaVersion is not a Literal, so the readable "
        "domain cannot be derived from the generated contract"
    )


def _readable(report: Any, source: Path) -> bool:
    """Whether ``report`` is one this store may hand out.

    INVARIANT: every report leaving this module carries a `schemaVersion` and a
    `verdict` the generated contract declares — so no route can put a foreign shape
    on a wire, including routes that do not exist yet. This is the read boundary
    rather than a per-route filter on purpose: `/packages` and
    `/package/{name}/report` both read straight through here, and screening them one
    at a time is how the next reader gets forgotten.

    The threat is concrete, not hypothetical. `data/reports/` is shared BYTE FOR BYTE
    with the TS lineage at `origin/main` (`report-store.ts` resolves the identical
    path, and this checkout's own `event-stream/4.0.1.json` was written by it). That
    lineage writes an unversioned report whose body is `findings`/`proofs`/
    `capabilities`/`runtimeEvidence`, and runs every one through
    `normalizeReportVerdict`, which OVERWRITES `verdict` with a 4-state
    `assessAuditReport().classification`. Both halves reach a client as a defect: a
    `"verdict": "SUSPECT"` is a value the frontend has no branch for, and an
    in-domain verdict on a schemaVersion-1 body is worse — it passes a verdict check
    and then fails the client's contract parse on the FIRST missing v2 field
    (`counts`), which bricks that package's page for as long as the file sits there.
    Screening the version is what makes the whole class unreachable rather than just
    the verdict half of it.

    Treated as unreadable rather than fatal, matching how this module already treats
    a corrupt file: one foreign report must not 500 the whole package list. Logged,
    because N-3 forbids a silently fabricated absence.
    """
    if not isinstance(report, dict):
        version, verdict = None, None
    else:
        version, verdict = report.get("schemaVersion"), report.get("verdict")
    if version in REPORT_SCHEMA_VERSIONS and verdict in REPORT_VERDICTS:
        return True
    log.warning(
        "ignoring report outside the readable domain",
        path=str(source),
        schemaVersion=version,
        verdict=verdict,
        expectedSchemaVersions=sorted(REPORT_SCHEMA_VERSIONS),
        expectedVerdicts=sorted(REPORT_VERDICTS),
    )
    return False


class UnversionedReportError(ValueError):
    """No concrete version, so this store has no honest key for the report.

    A `ValueError` subclass because that is what this refusal has always raised,
    but a NAMED one: `save_report` refusing to invent a `latest.json` alias and
    `_under_data_dir` refusing a path escape are opposite kinds of refusal, and
    the one caller that must treat them differently (`AuditService._execute`,
    which recovers from the first and must never swallow the second) cannot tell
    them apart from a bare `ValueError`.
    """


def _under_data_dir(target: Path) -> Path:
    resolved = target.resolve()
    if not resolved.is_relative_to(DATA_DIR):
        raise ValueError("Report path escapes data directory")
    return resolved


def _report_dir(package_name: str) -> Path:
    return _under_data_dir(DATA_DIR / package_name)


def _report_path(package_name: str, version: str) -> Path:
    return _under_data_dir(_report_dir(package_name) / f"{version}.json")


def _as_dict(report: Any) -> dict[str, Any]:
    if hasattr(report, "model_dump"):
        return report.model_dump(mode="json", exclude_none=False)
    if isinstance(report, dict):
        return report
    raise TypeError("report must be a dict or Pydantic model")


def extract_report_version(report: Any) -> str | None:
    value = _as_dict(report) if not isinstance(report, dict) else report
    for phase in value.get("trace", []):
        if phase.get("phase") != "inventory":
            continue
        version = (phase.get("output") or {}).get("metadata", {}).get("version")
        return version if isinstance(version, str) and version else None
    return None


def save_report(package_name: str, requested_version: str, report: Any) -> str:
    value = _as_dict(report)
    real_version = extract_report_version(value) or requested_version
    if not real_version or real_version == "latest":
        raise UnversionedReportError(
            f"Cannot save report for {package_name}: no concrete version in report or request"
            " — a latest.json alias must never be persisted"
        )
    directory = _report_dir(package_name)
    directory.mkdir(parents=True, exist_ok=True)
    path = _report_path(package_name, real_version)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    if requested_version and requested_version not in (real_version, "latest"):
        _report_path(package_name, requested_version).unlink(missing_ok=True)
    return real_version


def load_report(package_name: str, version: str | None = None) -> tuple[dict[str, Any], str] | None:
    directory = _report_dir(package_name)
    if not directory.exists():
        return None
    if version == "latest":  # valid request input; never a stored filename
        version = None
    if version:
        exact = _report_path(package_name, version)
        try:
            report = json.loads(exact.read_text(encoding="utf-8"))
            if _readable(report, exact):
                return report, version
        except (OSError, json.JSONDecodeError):
            pass  # missing or corrupt: the exact hit is only a fast path — scan instead
        for file in directory.glob("*.json"):
            try:
                report = json.loads(_under_data_dir(file).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if extract_report_version(report) == version and _readable(report, file):
                return report, version
        return None
    files = sorted(directory.glob("*.json"), key=lambda file: file.stat().st_mtime, reverse=True)
    for file in files:
        try:
            report = json.loads(_under_data_dir(file).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not _readable(report, file):
            continue
        return report, extract_report_version(report) or file.stem
    return None


def _public(package_name: str) -> bool:
    return not (
        package_name.startswith("test-pkg-")
        or package_name.startswith("test-package")
        or "-bench-" in package_name
    )


def list_reports() -> list[dict[str, Any]]:
    if not DATA_DIR.exists():
        return []
    summaries: list[dict[str, Any]] = []
    for file in DATA_DIR.rglob("*.json"):
        package_name = file.parent.relative_to(DATA_DIR).as_posix()
        if not _public(package_name):
            continue
        try:
            report = json.loads(_under_data_dir(file).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not _readable(report, file):
            continue
        summaries.append(
            {
                "packageName": package_name,
                "version": extract_report_version(report) or file.stem,
                "verdict": report["verdict"],
                "auditedAt": datetime.fromtimestamp(file.stat().st_mtime, tz=UTC)
                .isoformat()
                .replace("+00:00", "Z"),
            }
        )
    return sorted(summaries, key=lambda row: row["auditedAt"], reverse=True)

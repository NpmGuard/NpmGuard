import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import REPO_ROOT

DATA_DIR = (REPO_ROOT / "data" / "reports").resolve()


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
    real_version = extract_report_version(value) or requested_version or "latest"
    directory = _report_dir(package_name)
    directory.mkdir(parents=True, exist_ok=True)
    _report_path(package_name, real_version).write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    if requested_version and requested_version not in (real_version, "latest"):
        _report_path(package_name, requested_version).unlink(missing_ok=True)
    return real_version


def load_report(package_name: str, version: str | None = None) -> tuple[dict[str, Any], str] | None:
    directory = _report_dir(package_name)
    if not directory.exists():
        return None
    if version:
        exact = _report_path(package_name, version)
        if exact.exists():
            return json.loads(exact.read_text(encoding="utf-8")), version
        for file in directory.glob("*.json"):
            try:
                report = json.loads(_under_data_dir(file).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if extract_report_version(report) == version:
                return report, version
        return None
    files = sorted(directory.glob("*.json"), key=lambda file: file.stat().st_mtime, reverse=True)
    if not files:
        return None
    latest = files[0]
    report = json.loads(_under_data_dir(latest).read_text(encoding="utf-8"))
    return report, extract_report_version(report) or latest.stem


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
        if not report.get("verdict"):
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

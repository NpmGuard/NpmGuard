from __future__ import annotations

import json
import math
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import REPO_ROOT

RESULTS_DIR = (REPO_ROOT / "bench" / "results").resolve()
MAX_RUNS = 20
SAFE_FILENAME = re.compile(r"^[A-Za-z0-9_.-]+\.json$")


def _safe_path(filename: str) -> Path:
    if SAFE_FILENAME.fullmatch(filename) is None:
        raise ValueError("Invalid benchmark result filename")
    path = (RESULTS_DIR / filename).resolve()
    if not path.is_relative_to(RESULTS_DIR):
        raise ValueError("Benchmark result path escapes results directory")
    return path


def _strings(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _counts(rows: list[dict[str, Any]], key: str) -> dict[str, int]:
    return dict(Counter(row[key] for row in rows if row.get(key)))


def _percentile(values: list[int], percent: int) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil(percent / 100 * len(ordered)) - 1)
    return ordered[index]


def _common(
    filename: str,
    source: str,
    updated_at: str,
    rows: list[dict[str, Any]],
    payload: dict[str, Any],
) -> dict[str, Any]:
    durations = [row["durationMs"] for row in rows if row["durationMs"] > 0]
    return {
        "file": filename,
        "source": source,
        "updatedAt": updated_at,
        "startedAt": payload.get("startedAt"),
        "completedAt": payload.get("completedAt") or payload.get("finishedAt"),
        "watchlist": payload.get("watchlist"),
        "datasetVersion": payload.get("datasetVersion"),
        "engineSha": payload.get("engineSha"),
        "modelId": payload.get("modelId"),
        "packageCount": payload.get("packageCount")
        if isinstance(payload.get("packageCount"), int)
        else None,
        "limit": payload.get("limit") if isinstance(payload.get("limit"), int) else None,
        "resultLimit": payload.get("resultLimit")
        if isinstance(payload.get("resultLimit"), int)
        else None,
        "dryRun": payload.get("dryRun") is True,
        "counts": payload.get("counts")
        if isinstance(payload.get("counts"), dict)
        else _counts(rows, "status"),
        "verdictCounts": dict(Counter((row.get("verdict") or row["status"]) for row in rows)),
        "categoryCounts": _counts(rows, "category"),
        "totalRows": len(rows),
        "avgDurationMs": round(sum(durations) / len(durations)) if durations else None,
        "p95DurationMs": _percentile(durations, 95),
        "slowest": sorted(rows, key=lambda row: row["durationMs"], reverse=True)[:8],
        "rows": rows,
    }


def _public(filename: str, payload: dict[str, Any], updated_at: str) -> dict[str, Any] | None:
    results = payload.get("results")
    if not isinstance(results, list):
        return None
    rows = []
    for row in results:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("packageName"), str)
            or not isinstance(row.get("status"), str)
        ):
            continue
        rows.append(
            {
                "source": "public",
                "packageName": row["packageName"],
                "version": row.get("latestVersion") or row.get("version"),
                "fixtureName": None,
                "category": "public",
                "status": row["status"],
                "verdict": row.get("verdict"),
                "durationMs": row.get("durationMs")
                if isinstance(row.get("durationMs"), int | float)
                else 0,
                "error": row.get("error"),
                "capabilities": [],
                "proofKinds": [],
                "verifiedCapabilities": [],
                "confirmedProofs": 0,
                "runIndex": None,
            }
        )
    updated = (
        payload.get("updatedAt")
        or payload.get("finishedAt")
        or payload.get("startedAt")
        or updated_at
    )
    return _common(filename, "public", updated, rows, payload)


def _fixture_version(name: str) -> str | None:
    marker = name.rfind("-v")
    return name[marker + 2 :] or None if marker >= 0 else None


def _run_status(run: dict[str, Any]) -> str:
    error = run.get("error")
    if error:
        return "timeout" if re.search(r"time(?:d)? out|timeout", str(error), re.I) else "failed"
    return {"DANGEROUS": "detected", "SAFE": "missed"}.get(run.get("verdict"), "unknown")


def _datadog(filename: str, payload: dict[str, Any], updated_at: str) -> dict[str, Any] | None:
    results = payload.get("results")
    if not isinstance(results, list):
        return None
    rows = []
    for item in results:
        if not isinstance(item, dict) or not isinstance(item.get("fixtureName"), str):
            continue
        name = item["fixtureName"]
        runs = (
            item.get("runs")
            if isinstance(item.get("runs"), list) and item["runs"]
            else [{"error": "No run result"}]
        )
        for index, run in enumerate(runs):
            if not isinstance(run, dict):
                continue
            proofs = _strings(run.get("proofKinds"))
            rows.append(
                {
                    "source": "datadog",
                    "packageName": name,
                    "version": _fixture_version(name),
                    "fixtureName": name,
                    "category": "datadog-compromised"
                    if "-dd-c-" in name
                    else "datadog-malicious-intent",
                    "status": _run_status(run),
                    "verdict": run.get("verdict") if isinstance(run.get("verdict"), str) else None,
                    "durationMs": run.get("durationMs")
                    if isinstance(run.get("durationMs"), int | float)
                    else 0,
                    "error": run.get("error"),
                    "capabilities": _strings(run.get("capabilities")),
                    "proofKinds": proofs,
                    "verifiedCapabilities": _strings(run.get("verifiedCapabilities")),
                    "confirmedProofs": proofs.count("TEST_CONFIRMED"),
                    "runIndex": index + 1 if len(runs) > 1 else None,
                }
            )
    updated = payload.get("completedAt") or payload.get("startedAt") or updated_at
    return _common(filename, "datadog", updated, rows, payload)


def _read(filename: str) -> dict[str, Any] | None:
    path = _safe_path(filename)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return None
    updated = (
        datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).isoformat().replace("+00:00", "Z")
    )
    results = payload.get("results")
    first = results[0] if isinstance(results, list) and results else None
    if isinstance(first, dict) and isinstance(first.get("fixtureName"), str):
        return _datadog(filename, payload, updated)
    return _public(filename, payload, updated)


def list_benchmark_runs() -> dict[str, Any]:
    if not RESULTS_DIR.exists():
        return {"runs": [], "resultsDir": str(RESULTS_DIR)}
    files = sorted(
        (path for path in RESULTS_DIR.iterdir() if path.suffix == ".json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )[:MAX_RUNS]
    runs = []
    for path in files:
        try:
            run = _read(path.name)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if run is not None:
            runs.append(run)
    return {"runs": runs, "resultsDir": str(RESULTS_DIR)}

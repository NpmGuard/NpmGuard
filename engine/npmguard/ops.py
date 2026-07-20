from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sys
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from .config import REPO_ROOT

DEFAULT_API = "http://127.0.0.1:8000"


def _package_path(package_name: str) -> str:
    return "/".join(quote(part, safe="") for part in package_name.split("/"))


def _read_list(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8").strip()
    values = (
        json.loads(text)
        if text.startswith("[")
        else [line.split("#", 1)[0].strip() for line in text.splitlines()]
    )
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise ValueError(f"{path} must contain a JSON string array or newline-delimited names")
    return list(dict.fromkeys(value for value in values if value))


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def _spec(value: str) -> tuple[str, str | None]:
    marker = value.find("@", value.find("/") + 1) if value.startswith("@") else value.rfind("@")
    return (value[:marker], value[marker + 1 :] or None) if marker > 0 else (value, None)


class Api:
    def __init__(self, base_url: str, cre_key: str | None) -> None:
        self.client = httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=60)
        self.cre_key = cre_key

    async def close(self) -> None:
        await self.client.aclose()

    async def report(self, package_name: str, version: str | None = None) -> dict[str, Any] | None:
        response = await self.client.get(
            f"/package/{_package_path(package_name)}/report",
            params={"version": version} if version else None,
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    async def summary(self, package_name: str, version: str | None = None) -> dict[str, Any] | None:
        response = await self.client.get("/packages", headers={"accept": "application/json"})
        response.raise_for_status()
        return next(
            (
                row
                for row in response.json().get("packages", [])
                if row.get("packageName") == package_name
                and (not version or row.get("version") == version)
            ),
            None,
        )

    async def resolve_latest(self, package_name: str) -> str:
        response = await self.client.get(
            f"/resolve/{_package_path(package_name)}", params={"version": "latest"}
        )
        response.raise_for_status()
        version = response.json().get("version")
        if not isinstance(version, str):
            raise RuntimeError(f"resolve returned no version for {package_name}")
        return version

    async def enqueue(self, package_name: str, version: str | None) -> str:
        if not self.cre_key:
            raise RuntimeError("NPMGUARD_CRE_API_KEY is required")
        response = await self.client.post(
            "/audit",
            headers={"x-api-key": self.cre_key},
            json={"packageName": package_name, **({"version": version} if version else {})},
        )
        payload = (
            response.json()
            if response.headers.get("content-type", "").startswith("application/json")
            else {}
        )
        if response.is_error:
            raise RuntimeError(
                f"audit enqueue failed ({response.status_code}): "
                f"{payload.get('message') or payload.get('error') or response.text}"
            )
        audit_id = payload.get("auditId")
        if not isinstance(audit_id, str):
            raise RuntimeError("audit enqueue returned no auditId")
        return audit_id

    async def wait_for_audit(
        self, audit_id: str, *, timeout_ms: int, poll_ms: int
    ) -> dict[str, Any] | None:
        deadline = time.monotonic() + timeout_ms / 1_000
        while time.monotonic() < deadline:
            response = await self.client.get(f"/audit/{quote(audit_id, safe='')}/report")
            if response.status_code == 202:
                await asyncio.sleep(poll_ms / 1_000)
                continue
            payload = (
                response.json()
                if response.headers.get("content-type", "").startswith("application/json")
                else {}
            )
            if response.is_error:
                raise RuntimeError(payload.get("message") or payload.get("error") or response.text)
            return payload
        return None

    async def wait_for_report(
        self,
        package_name: str,
        version: str | None,
        *,
        timeout_ms: int,
        poll_ms: int,
        previous_audited_at: str | None = None,
    ) -> dict[str, Any] | None:
        deadline = time.monotonic() + timeout_ms / 1_000
        while time.monotonic() < deadline:
            if previous_audited_at:
                current = await self.summary(package_name, version)
                if current and current.get("auditedAt") != previous_audited_at:
                    return {"report": current, "version": current.get("version")}
            else:
                report = await self.report(package_name, version)
                if report:
                    return report
            await asyncio.sleep(poll_ms / 1_000)
        return None


async def audit_batch(args: argparse.Namespace) -> int:
    specs = list(args.packages)
    if args.file:
        specs.extend(await asyncio.to_thread(_read_list, args.file))
    if not specs:
        raise ValueError("provide package specs or --file")
    api = Api(args.api, os.environ.get("NPMGUARD_CRE_API_KEY"))
    results = []
    try:
        for package_name, version in map(_spec, specs):
            started = time.monotonic()
            label = package_name + (f"@{version}" if version else "")
            try:
                existing = await api.report(package_name, version)
                if args.skip_existing and existing:
                    row = existing.get("report", {})
                    print(f"[audit:batch] skip {label}: {row.get('verdict', 'UNKNOWN')}")
                    results.append(
                        {
                            "packageName": package_name,
                            "version": version,
                            "status": "skipped",
                            "verdict": row.get("verdict"),
                            "reportVersion": existing.get("version"),
                            "durationMs": round((time.monotonic() - started) * 1_000),
                        }
                    )
                    continue
                print(f"[audit:batch] enqueue {label}")
                audit_id = await api.enqueue(package_name, version)
                session_report = await api.wait_for_audit(
                    audit_id, timeout_ms=args.timeout_ms, poll_ms=args.poll_ms
                )
                if session_report is None:
                    raise TimeoutError(f"audit timed out after {args.timeout_ms}ms")
                complete = await api.report(package_name, version) or {
                    "report": session_report,
                    "version": version,
                }
                report = complete.get("report", {})
                results.append(
                    {
                        "packageName": package_name,
                        "version": version,
                        "status": "completed",
                        "verdict": report.get("verdict"),
                        "reportVersion": complete.get("version"),
                        "durationMs": round((time.monotonic() - started) * 1_000),
                    }
                )
                print(f"[audit:batch] done {label}: {report.get('verdict', 'UNKNOWN')}")
            except Exception as exc:
                status = "timeout" if isinstance(exc, TimeoutError) else "failed"
                print(f"[audit:batch] {status} {label}: {exc}", file=sys.stderr)
                results.append(
                    {
                        "packageName": package_name,
                        "version": version,
                        "status": status,
                        "error": str(exc),
                        "durationMs": round((time.monotonic() - started) * 1_000),
                    }
                )
    finally:
        await api.close()
    print(json.dumps({"results": results}, indent=2))
    return int(any(row["status"] in {"failed", "timeout"} for row in results))


async def audit_latest(args: argparse.Namespace) -> int:
    packages = await asyncio.to_thread(_read_list, args.watchlist)
    key = os.environ.get("NPMGUARD_CRE_API_KEY")
    if not args.dry_run and not key:
        raise RuntimeError("NPMGUARD_CRE_API_KEY is required")
    api = Api(args.api, key)
    results: list[dict[str, Any]] = []
    enqueued = 0
    started_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")

    def payload() -> dict[str, Any]:
        return {
            "startedAt": started_at,
            "updatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "api": args.api,
            "watchlist": str(args.watchlist),
            "packageCount": len(packages),
            "limit": args.limit,
            "resultLimit": args.result_limit,
            "dryRun": args.dry_run,
            "timeoutMs": args.timeout_ms,
            "pollMs": args.poll_ms,
            "delayMs": args.delay_ms,
            "counts": dict(Counter(row["status"] for row in results)),
            "results": results,
        }

    try:
        for package_name in packages:
            if args.result_limit is not None and len(results) >= args.result_limit:
                break
            started = time.monotonic()
            try:
                version = await api.resolve_latest(package_name)
                existing = await api.report(package_name, version)
                if existing:
                    verdict = existing.get("report", {}).get("verdict")
                    results.append(
                        {
                            "packageName": package_name,
                            "latestVersion": version,
                            "status": "already-audited",
                            "verdict": verdict,
                            "durationMs": round((time.monotonic() - started) * 1_000),
                        }
                    )
                elif args.dry_run:
                    results.append(
                        {
                            "packageName": package_name,
                            "latestVersion": version,
                            "status": "would-audit",
                            "durationMs": round((time.monotonic() - started) * 1_000),
                        }
                    )
                elif args.limit is not None and enqueued >= args.limit:
                    continue
                else:
                    audit_id = await api.enqueue(package_name, version)
                    enqueued += 1
                    session_report = await api.wait_for_audit(
                        audit_id, timeout_ms=args.timeout_ms, poll_ms=args.poll_ms
                    )
                    if session_report is None:
                        raise TimeoutError(f"audit timed out after {args.timeout_ms}ms")
                    verdict = session_report.get("verdict")
                    results.append(
                        {
                            "packageName": package_name,
                            "latestVersion": version,
                            "status": "completed",
                            "verdict": verdict,
                            "durationMs": round((time.monotonic() - started) * 1_000),
                        }
                    )
                print(f"[audit:latest] {results[-1]['status']} {package_name}@{version}")
            except Exception as exc:
                status = "timeout" if isinstance(exc, TimeoutError) else "failed"
                results.append(
                    {
                        "packageName": package_name,
                        "status": status,
                        "error": str(exc),
                        "durationMs": round((time.monotonic() - started) * 1_000),
                    }
                )
                print(f"[audit:latest] {status} {package_name}: {exc}", file=sys.stderr)
            finally:
                if args.out:
                    await asyncio.to_thread(_write_json, args.out, payload())
                if args.delay_ms:
                    await asyncio.sleep(args.delay_ms / 1_000)
    finally:
        await api.close()
    final = payload()
    if args.out:
        await asyncio.to_thread(_write_json, args.out, final)
    print(json.dumps(final, indent=2))
    return int(any(row["status"] in {"failed", "timeout"} for row in results))


def bench_check(args: argparse.Namespace) -> int:
    if args.file:
        path = args.file
    else:
        files = sorted(
            args.results_dir.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True
        )
        if not files:
            raise ValueError(f"No benchmark JSON files found in {args.results_dir}")
        path = files[0]
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("results")
    if not isinstance(rows, list):
        raise ValueError(f"{path} is not an audit-latest result file")
    counts = Counter(row.get("status", "unknown") for row in rows)
    verdicts = Counter(row.get("verdict") or row.get("status", "unknown") for row in rows)
    durations = sorted(
        row["durationMs"] for row in rows if isinstance(row.get("durationMs"), int | float)
    )
    p95 = (
        durations[max(0, min(len(durations) - 1, math.ceil(0.95 * len(durations)) - 1))]
        if durations
        else None
    )
    violations = []
    checks = (
        (len(rows) < args.min_rows, f"rows {len(rows)} < {args.min_rows}"),
        (
            counts["timeout"] > args.max_timeouts,
            f"timeouts {counts['timeout']} > {args.max_timeouts}",
        ),
        (counts["failed"] > args.max_failed, f"failed {counts['failed']} > {args.max_failed}"),
        (
            verdicts["DANGEROUS"] > args.max_dangerous,
            f"dangerous {verdicts['DANGEROUS']} > {args.max_dangerous}",
        ),
        (p95 is not None and p95 > args.max_p95_ms, f"p95Ms {p95} > {args.max_p95_ms}"),
    )
    violations.extend(message for failed, message in checks if failed)
    result = {
        "ok": not violations,
        "file": str(path),
        "startedAt": payload.get("startedAt"),
        "rows": len(rows),
        "counts": dict(counts),
        "verdictCounts": dict(verdicts),
        "p95Ms": p95,
        "violations": violations,
    }
    print(
        json.dumps(result, indent=2)
        if args.json
        else f"[bench:check] {'ok' if result['ok'] else 'failed'} {path}\n[bench:check] rows={len(rows)} safe={verdicts['SAFE']} dangerous={verdicts['DANGEROUS']} timeout={counts['timeout']} failed={counts['failed']} p95Ms={p95 or '-'}"
        + (f"\n[bench:check] violations: {'; '.join(violations)}" if violations else "")
    )
    return int(bool(violations))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="npmguard-ops")
    commands = root.add_subparsers(dest="command", required=True)
    batch = commands.add_parser("audit-batch")
    batch.add_argument("packages", nargs="*")
    batch.add_argument("--api", default=os.environ.get("NPMGUARD_API_URL", DEFAULT_API))
    batch.add_argument("--file", type=Path)
    batch.add_argument("--timeout-ms", type=int, default=1_200_000)
    batch.add_argument("--poll-ms", type=int, default=5_000)
    batch.add_argument("--no-skip", action="store_false", dest="skip_existing")
    latest = commands.add_parser("audit-latest")
    latest.add_argument("--api", default=os.environ.get("NPMGUARD_API_URL", DEFAULT_API))
    latest.add_argument(
        "--watchlist",
        type=Path,
        default=REPO_ROOT / "engine" / "config" / "watchlist-packages.json",
    )
    latest.add_argument("--limit", type=int)
    latest.add_argument("--result-limit", type=int)
    latest.add_argument("--timeout-ms", type=int, default=1_200_000)
    latest.add_argument("--poll-ms", type=int, default=5_000)
    latest.add_argument("--delay-ms", type=int, default=0)
    latest.add_argument("--out", type=Path)
    latest.add_argument("--dry-run", action="store_true")
    check = commands.add_parser("bench-check")
    check.add_argument("--file", type=Path)
    check.add_argument("--results-dir", type=Path, default=REPO_ROOT / "bench" / "results")
    check.add_argument("--min-rows", type=int, default=1)
    check.add_argument("--max-timeouts", type=int, default=0)
    check.add_argument("--max-failed", type=int, default=0)
    check.add_argument("--max-dangerous", type=int, default=0)
    check.add_argument("--max-p95-ms", type=int, default=600_000)
    check.add_argument("--json", action="store_true")
    return root


def main() -> None:
    args = parser().parse_args()
    try:
        code = (
            bench_check(args)
            if args.command == "bench-check"
            else asyncio.run(
                audit_batch(args) if args.command == "audit-batch" else audit_latest(args)
            )
        )
    except Exception as exc:
        print(f"[npmguard-ops] {exc}", file=sys.stderr)
        code = 1
    raise SystemExit(code)


if __name__ == "__main__":
    main()

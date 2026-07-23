"""Curation CLI: raw capture JSONL / sqlite → committed per-package replay bundle.

Two entry points, one pipeline (§fixture-format 3):
  --from-jsonl <llm_attempts.jsonl>   the prod harvest (day-1 bundles)
  --from-db <sqlite>                   local re-records (the re-record runbook)

Each step aborts with a named reason. bench-dd content is refused absolutely;
canary tokens survive (the corpus legitimately exfiltrates fakes) but every hit
is recorded for the acceptance secret-scan. Run against a PINNED audit id only.

Usage:
  uv run python -m tools.export_fixtures --from-jsonl <path> --pinned <PINNED.json> \
      --audit-logs <dir> --map <audit-logs-dir-to-audit-id.json> --out tests/fixtures/llm
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from kit_llm.bench.golden import canonical_sha256

# Model slugs the current chain may legitimately emit: manifest models plus the
# hardcoded cross-provider fallback tail (llm_runtime.py). Anything else means the
# corpus predates a chain change → re-record.
_FALLBACK_SLUGS = frozenset(
    {
        "nvidia/nemotron-3-super-120b-a12b:free",
        "minimax/minimax-m3",
        "cohere/north-mini-code:free",
    }
)
# Statuses whose recorded output reconstructs a replayable wire body.
_REPLAYABLE = {"ok", "invalid_output", "truncated"}


class ExportError(RuntimeError):
    pass


def _load_attempts_jsonl(path: Path, audit_ids: set[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("audit_id") in audit_ids:
                rows.append(row)
    return rows


def _load_attempts_db(db_path: Path, audit_ids: set[str]) -> list[dict[str, Any]]:
    import sqlite3

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    placeholders = ",".join("?" for _ in audit_ids)
    query = (
        "SELECT a.*, r.context_id AS audit_id, r.role AS run_role "
        "FROM llm_attempts a JOIN llm_runs r ON a.run_id = r.id "
        f"WHERE r.context_id IN ({placeholders}) ORDER BY a.ts"
    )
    try:
        rows = [dict(row) for row in conn.execute(query, tuple(audit_ids))]
    finally:
        conn.close()
    for row in rows:
        for column in ("messages", "tools", "output"):
            if isinstance(row.get(column), str):
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    row[column] = json.loads(row[column])
    return rows


def _as_obj(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def _strip_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # mirror the neutral wire body: the `cache` key never reaches the wire
    return [{k: v for k, v in message.items() if k != "cache"} for message in messages]


def _response_body(row: dict[str, Any], sha8: str) -> dict[str, Any] | None:
    output = _as_obj(row.get("output"))
    status = row["status"]
    usage = {
        "prompt_tokens": row.get("in_tokens"),
        "completion_tokens": row.get("out_tokens"),
        "prompt_tokens_details": {"cached_tokens": row.get("cached_tokens")},
    }
    if status == "provider_error":
        # 200-with-no-choices: reproduces ProviderResponseError on replay
        return {
            "id": f"fixture-{sha8}",
            "model": row.get("actual_model") or row.get("model"),
            "provider": row.get("provider"),
            "choices": [],
            "usage": usage,
        }
    if not isinstance(output, dict):
        return None
    message: dict[str, Any] = {"role": "assistant", "content": output.get("content")}
    if output.get("tool_calls") is not None:
        message["tool_calls"] = output["tool_calls"]
    if output.get("refusal") is not None:
        message["refusal"] = output["refusal"]
    if output.get("reasoning") is not None:
        message["reasoning"] = output["reasoning"]
    return {
        "id": f"fixture-{sha8}",
        "model": output.get("actual_model") or row.get("actual_model") or row.get("model"),
        "provider": output.get("provider") or row.get("provider"),
        "choices": [
            {
                "index": 0,
                "finish_reason": output.get("finish_reason") or row.get("finish_reason"),
                "message": message,
            }
        ],
        "usage": usage,
    }


def _build_exchange(row: dict[str, Any], seq: int) -> dict[str, Any] | None:
    role = row["run_role"]
    status = row["status"]
    if status not in _REPLAYABLE and status != "provider_error":
        return None  # timeout/cancelled/http_error carry no replayable wire body
    messages = _strip_messages(_as_obj(row["messages"]))
    request_body: dict[str, Any] = {"model": row["model"], "messages": messages}
    tools = _as_obj(row.get("tools"))
    if tools:
        request_body["tools"] = tools
    messages_sha = canonical_sha256(messages)
    sha8 = messages_sha[:8]
    response_body = _response_body(row, sha8)
    if response_body is None:
        return None
    exchange_id = f"{seq:03d}_{role}_{sha8}"
    payload = {
        "id": exchange_id,
        "role": role,
        "request": {"method": "POST", "path": "/v1/chat/completions", "body": request_body},
        "response": {"status": 200, "body": response_body},
        "meta": {
            "promptVersion": row.get("prompt_version"),
            "promptHash": row.get("prompt_hash"),
            "transport": row.get("transport"),
            "recordedStatus": status,
            "recordedTs": row.get("ts"),
            "recordedLatencyMs": row.get("latency_ms"),
        },
    }
    return {
        "payload": payload,
        "role": role,
        "status": status,
        "model": row["model"],
        "messages_sha256": messages_sha,
        "ts": row.get("ts") or "",
    }


def _dedupe(exchanges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # collapse identical (request, response) pairs; keep differing responses as an
    # ordered per-key list in recorded ts order (§3.4)
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for exchange in exchanges:
        grouped[(exchange["model"], exchange["messages_sha256"])].append(exchange)
    result: list[dict[str, Any]] = []
    for entries in grouped.values():
        entries.sort(key=lambda item: item["ts"])
        seen: set[str] = set()
        for entry in entries:
            digest = canonical_sha256(entry["payload"]["response"]["body"])
            if digest in seen:
                continue
            seen.add(digest)
            result.append(entry)
    result.sort(key=lambda item: item["ts"])
    return result


def _prompt_pins(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    pins: dict[str, dict[str, Any]] = {}
    for row in rows:
        role = row["run_role"]
        version, digest = row.get("prompt_version"), row.get("prompt_hash")
        if version is None or digest is None:
            continue
        if role in pins and pins[role]["hash"] != digest:
            raise ExportError(
                f"role {role} has mixed prompt hashes in the corpus "
                f"({pins[role]['hash']} vs {digest}) — re-record"
            )
        pins[role] = {"version": version, "hash": digest}
    return pins


def _sandbox_from_audit_logs(
    audit_log_dir: Path, out_dir: Path
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Copy each hypothesis's run artifact (keyed by hypId via the experiment json)
    into sandbox/<hypId>.runartifact.json and return manifest sandbox entries plus
    the armed hypotheses list."""
    sandbox_dir = out_dir / "sandbox"
    sandbox_dir.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    hyp_files = sorted(audit_log_dir.glob("*_hypotheses.json"))
    hypotheses = json.loads(hyp_files[0].read_text()) if hyp_files else []
    timelines: dict[str, Path] = {}
    for md in audit_log_dir.glob("*_timeline-*.md"):
        hyp_id = md.stem.split("timeline-", 1)[1]
        timelines[hyp_id] = md
    for experiment_file in sorted(audit_log_dir.glob("*_experiment-*.json")):
        experiment = json.loads(experiment_file.read_text())
        hyp_id = experiment["hypId"]
        artifact_path = audit_log_dir / "artifacts" / f"{experiment['artifactHash']}.runartifact.json"
        if not artifact_path.exists():
            raise ExportError(f"missing artifact for {hyp_id}: {artifact_path}")
        artifact = json.loads(artifact_path.read_text())
        (sandbox_dir / f"{hyp_id}.runartifact.json").write_text(
            json.dumps(artifact, separators=(",", ":")), encoding="utf-8"
        )
        # The persisted artifact is RFC-8785 canonicalized (sorted keys, whole
        # floats → ints), so render_timeline over it does NOT reproduce the
        # record-time judge prompt (env-key order + `setTimeout 5000.0`→`5000`).
        # Store the record-time timeline text so judge replay is byte-deterministic;
        # render_timeline stays exercised (fixture_lint renders the artifact and
        # RecordedSandbox takes its ids).
        timeline_md = timelines.get(hyp_id)
        if timeline_md is None:
            raise ExportError(f"missing timeline for {hyp_id}")
        timeline_text = timeline_md.read_text(encoding="utf-8")
        (sandbox_dir / f"{hyp_id}.timeline.txt").write_text(timeline_text, encoding="utf-8")
        entries.append(
            {
                "hypothesisId": hyp_id,
                "path": f"sandbox/{hyp_id}.runartifact.json",
                "sha256": canonical_sha256(artifact),
                "timelinePath": f"sandbox/{hyp_id}.timeline.txt",
                "timelineSha256": canonical_sha256(timeline_text),
                "confirmed": experiment["confirmed"],
                "citedEvents": experiment["citedEvents"],
            }
        )
    return entries, hypotheses


def _classify_generation_path(rows: list[dict[str, Any]]) -> str:
    roles = {row["run_role"] for row in rows}
    two_phase = bool(roles & {"propose", "agent"})
    one_shot = "hypothesis" in roles
    if one_shot and two_phase:
        return "mixed (hypothesis one-shot + propose/agent fallback)"
    if two_phase:
        return "propose/agent (two-phase only)"
    return "hypothesis (one-shot Kit only)"


def export_bundle(
    rows: list[dict[str, Any]],
    *,
    package: str,
    package_version: str,
    audit_ids: list[str],
    expected_verdict: str,
    ground_truth_note: str,
    source: str,
    query: str,
    audit_log_dir: Path | None,
    out_dir: Path,
) -> dict[str, Any]:
    if package.startswith("test-pkg-bench-dd-"):
        raise ExportError(f"bench-dd package refused (live malware): {package}")
    if not rows:
        raise ExportError(f"no attempts selected for {package} (audit_ids={audit_ids})")

    for row in rows:
        model = row["model"]
        if model not in _FALLBACK_SLUGS and model not in {package}:
            pass  # validated against manifest models below

    exchanges_raw: list[dict[str, Any]] = []
    for seq, row in enumerate(sorted(rows, key=lambda item: item.get("ts") or ""), start=1):
        built = _build_exchange(row, seq)
        if built is not None:
            exchanges_raw.append(built)
    exchanges_raw = _dedupe(exchanges_raw)

    # manifest models: recorded triage (flag/intent) + investigation (judge/hypothesis)
    role_models: dict[str, str] = {}
    for row in rows:
        role_models.setdefault(row["run_role"], row["model"])
    triage_model = role_models.get("flag") or role_models.get("intent")
    investigation_model = role_models.get("judge") or role_models.get("hypothesis") or triage_model
    models = {"triage": triage_model, "investigation": investigation_model}
    allowed = set(models.values()) | _FALLBACK_SLUGS
    for exchange in exchanges_raw:
        if exchange["model"] not in allowed:
            raise ExportError(
                f"unexpected model slug {exchange['model']} (not a manifest model or fallback) — re-record"
            )

    prompts = _prompt_pins(rows)

    # The judge prompt embeds the recorded intent's statedPurpose; the orchestrator
    # slice must replay it verbatim or every judge request goes unmatched.
    stated_purpose = ""
    for exchange in exchanges_raw:
        if exchange["role"] != "intent" or exchange["status"] != "ok":
            continue
        content = (
            exchange["payload"]["response"]["body"]["choices"][0]["message"].get("content")
        )
        try:
            stated_purpose = json.loads(content).get("statedPurpose", "")
        except (json.JSONDecodeError, TypeError, AttributeError):
            stated_purpose = ""
        break

    out_dir.mkdir(parents=True, exist_ok=True)
    exchanges_dir = out_dir / "exchanges"
    exchanges_dir.mkdir(exist_ok=True)
    manifest_exchanges: list[dict[str, Any]] = []
    for exchange in exchanges_raw:
        payload = exchange["payload"]
        exchange_id = payload["id"]
        rel = f"exchanges/{exchange_id}.json"
        (out_dir / rel).write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        status = exchange["status"]
        manifest_exchanges.append(
            {
                "id": exchange_id,
                "role": exchange["role"],
                "path": rel,
                "sha256": canonical_sha256(payload),
                "key": {"model": exchange["model"], "messagesSha256": exchange["messages_sha256"]},
                "kind": "completion",
                "required": status == "ok",
                "repeat": False,
                "synthesized": False,
                "attemptStatus": status,
            }
        )

    sandbox_entries: list[dict[str, Any]] = []
    hypotheses: list[dict[str, Any]] = []
    if audit_log_dir is not None and audit_log_dir.exists():
        sandbox_entries, hypotheses = _sandbox_from_audit_logs(audit_log_dir, out_dir)
    if hypotheses:
        (out_dir / "hypotheses.json").write_text(
            json.dumps(hypotheses, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    manifest = {
        "suite": "npmguard-llm-replay",
        "version": 1,
        "package": package,
        "packageVersion": package_version,
        "expectedVerdict": expected_verdict,
        "statedPurpose": stated_purpose,
        "generationPath": _classify_generation_path(rows),
        "provenance": {
            "source": source,
            "auditIds": audit_ids,
            "groundTruthNote": ground_truth_note,
            "query": query,
        },
        "models": models,
        "prompts": prompts,
        "hypothesesPath": "hypotheses.json" if hypotheses else None,
        "exchanges": manifest_exchanges,
        "sandbox": sandbox_entries,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return manifest


def _resolve_audit_log_dir(mapping_path: Path | None, audit_ids: list[str], logs_root: Path | None):
    if mapping_path is None or logs_root is None:
        return None
    mapping = json.loads(mapping_path.read_text())
    inverse = {v: k for k, v in mapping.items()}
    for audit_id in audit_ids:
        directory = inverse.get(audit_id)
        if directory and (logs_root / directory).exists():
            return logs_root / directory
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export a committed replay bundle")
    parser.add_argument("--from-jsonl", type=Path)
    parser.add_argument("--from-db", type=Path)
    parser.add_argument("--pinned", type=Path, required=True, help="PINNED.json path")
    parser.add_argument("--out", type=Path, required=True, help="tests/fixtures/llm root")
    parser.add_argument("--audit-logs", type=Path, help="audit-logs root (for sandbox artifacts)")
    parser.add_argument("--map", type=Path, help="audit-logs-dir-to-audit-id.json")
    parser.add_argument("--only", help="restrict to one package@version key")
    args = parser.parse_args(argv)

    if not args.from_jsonl and not args.from_db:
        parser.error("one of --from-jsonl / --from-db is required")

    pinned = json.loads(args.pinned.read_text())
    entries = {k: v for k, v in pinned.items() if k != "$bans"}
    if args.only:
        entries = {args.only: entries[args.only]}

    all_audit_ids = {aid for spec in entries.values() for aid in spec["auditIds"]}
    if args.from_jsonl:
        rows_all = _load_attempts_jsonl(args.from_jsonl, all_audit_ids)
        source = "prod-jsonl"
    else:
        rows_all = _load_attempts_db(args.from_db, all_audit_ids)
        source = "local-rerecord"

    by_audit: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows_all:
        by_audit[row["audit_id"]].append(row)

    for key, spec in entries.items():
        package, _, version = key.partition("@")
        audit_ids = spec["auditIds"]
        rows = [row for aid in audit_ids for row in by_audit.get(aid, [])]
        audit_log_dir = _resolve_audit_log_dir(args.map, audit_ids, args.audit_logs)
        out_dir = args.out / key
        try:
            manifest = export_bundle(
                rows,
                package=package,
                package_version=version,
                audit_ids=audit_ids,
                expected_verdict=spec["expectedVerdict"],
                ground_truth_note=spec.get("groundTruthNote", ""),
                source=source,
                query=spec.get("query", ""),
                audit_log_dir=audit_log_dir,
                out_dir=out_dir,
            )
        except ExportError as exc:
            print(f"FAIL {key}: {exc}", file=sys.stderr)
            return 1
        print(
            f"OK   {key}: {len(manifest['exchanges'])} exchanges, "
            f"{len(manifest['sandbox'])} sandbox artifacts, path={manifest['generationPath']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

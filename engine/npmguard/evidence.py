from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import rfc8785
from pydantic import BaseModel

from .contract.models import EventSummary, EvidenceEvent, RunArtifact

TRACE_START = "__NPMGUARD_TRACE__"
TRACE_END = "__NPMGUARD_TRACE_END__"
SYSCALL_KINDS = frozenset(
    {"openat", "read", "write", "connect", "sendto", "execve", "clone", "unlink", "rename", "link"}
)


def _plain(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_none=False)
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def canonicalize(value: Any) -> str:
    """Canonical JSON with ECMAScript number/string semantics (RFC 8785)."""
    value = _plain(value)
    try:
        return rfc8785.dumps(value).decode("utf-8")
    except rfc8785.FloatDomainError as exc:
        raise ValueError(f"canonicalize: non-finite number ({exc}) is not representable") from exc
    except rfc8785.IntegerDomainError as exc:
        raise ValueError(f"canonicalize: {exc}") from exc
    except rfc8785.CanonicalizationError as exc:
        raise TypeError(f"canonicalize: {exc}") from exc


def sha256_hex(value: str | bytes) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def content_hash_of(value: Any) -> str:
    return sha256_hex(canonicalize(value))


def merkle_root(hashes: list[str]) -> str:
    if not hashes:
        return sha256_hex("")
    if len(hashes) == 1:
        return hashes[0]
    return merkle_root(
        [
            sha256_hex(
                hashes[index] + (hashes[index + 1] if index + 1 < len(hashes) else hashes[index])
            )
            for index in range(0, len(hashes), 2)
        ]
    )


class ArtifactStore:
    def __init__(self, root_dir: Path) -> None:
        self.artifacts_dir = root_dir / "artifacts"

    def _path(self, digest: str, extension: str | None = None) -> Path:
        return self.artifacts_dir / (f"{digest}.{extension}" if extension else digest)

    def write_blob(self, data: str | bytes, extension: str | None = None) -> str:
        raw = data.encode() if isinstance(data, str) else data
        digest = sha256_hex(raw)
        target = self._path(digest, extension)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_bytes(raw)
        return digest

    def read_blob(self, digest: str, extension: str | None = None) -> bytes:
        return self._path(digest, extension).read_bytes()

    def write_artifact(self, partial: dict[str, Any]) -> str:
        parsed = RunArtifact.model_validate({**partial, "contentHash": ""})
        value = parsed.model_dump(mode="json", exclude_none=False)
        digest = content_hash_of({**value, "contentHash": ""})
        value["contentHash"] = digest
        target = self._path(digest, "runartifact.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(canonicalize(value), encoding="utf-8")
        return digest

    def read_artifact(self, digest: str) -> RunArtifact:
        return RunArtifact.model_validate_json(
            self._path(digest, "runartifact.json").read_text(encoding="utf-8")
        )

    def verify_artifact(self, digest: str) -> bool:
        value = self.read_artifact(digest).model_dump(mode="json", exclude_none=False)
        value["contentHash"] = ""
        return content_hash_of(value) == digest


def parse_l4_trace(stdout: str) -> list[EvidenceEvent] | None:
    end = stdout.rfind(TRACE_END)
    if end < 0:
        return None
    start = stdout.rfind(TRACE_START, 0, end)
    if start < 0:
        return None
    try:
        raw = json.loads(stdout[start + len(TRACE_START) : end])
    except json.JSONDecodeError:
        return None
    if not isinstance(raw, list):
        return None
    events = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict) or entry.get("type") not in {
            "require",
            "fs",
            "network",
            "process",
            "env",
            "eval",
            "crypto",
            "timer",
            "script",
        }:
            continue
        kind, normalized = _normalize_l4(entry)
        events.append(
            EvidenceEvent(
                stream="L4:v8inspector" if entry["type"] == "script" else "L4:monkey",
                timestamp=index,
                pid=0,
                kind=kind,
                raw=entry,
                normalized=normalized,
            )
        )
    return events


def _normalize_l4(entry: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    event_type = entry["type"]
    if event_type == "require":
        return "require", {
            "module": str(entry.get("module", "")),
            "from": str(entry.get("from", "")),
        }
    if event_type == "fs":
        return "fs_op", {"method": str(entry.get("method", "")), "path": str(entry.get("path", ""))}
    if event_type == "network":
        return "network", {
            "method": str(entry.get("method", "GET")),
            "url": str(entry.get("url", "")),
        }
    if event_type == "process":
        return "process", {"method": str(entry.get("method", "")), "cmd": str(entry.get("cmd", ""))}
    if event_type == "env":
        return "env_access", {"key": str(entry.get("key", ""))}
    if event_type == "eval":
        return "eval", {"code": str(entry.get("code", ""))[:200]}
    if event_type == "crypto":
        return "crypto", {
            "method": str(entry.get("method", "")),
            "algo": str(entry.get("algo", "")),
        }
    if event_type == "timer":
        return "timer", {"kind": str(entry.get("kind", "")), "ms": float(entry.get("ms", 0) or 0)}
    return "script_parsed", {
        "url": str(entry.get("url", "")),
        "source": str(entry.get("source", "")),
        "len": float(entry.get("len", 0) or 0),
    }


def synthetic_event(kind: str, detail: str, timestamp: int = 0) -> EvidenceEvent:
    return EvidenceEvent(
        stream="engine",
        timestamp=timestamp,
        pid=0,
        kind=kind,
        raw=detail,
        normalized={"detail": detail},
    )


def compute_event_summary(events: list[EvidenceEvent]) -> EventSummary:
    hosts: set[str] = set()
    syscalls: set[str] = set()
    files: set[str] = set()
    dns: set[str] = set()
    for event in events:
        normalized = event.normalized or {}
        if event.kind in SYSCALL_KINDS:
            syscalls.add(event.kind)
        if event.kind == "network" and isinstance(normalized.get("url"), str):
            host = urlparse(normalized["url"]).hostname
            if host:
                hosts.add(host)
        if event.kind in {"http_request", "tls_sni"} and isinstance(normalized.get("host"), str):
            hosts.add(normalized["host"])
        if event.kind in {"write", "file_created", "file_modified"} and isinstance(
            normalized.get("path"), str
        ):
            files.add(normalized["path"])
        if event.kind == "dns_query" and isinstance(normalized.get("host"), str):
            dns.add(normalized["host"])
    return EventSummary(
        uniqueHosts=sorted(hosts),
        uniqueSyscalls=sorted(syscalls),
        filesWritten=sorted(files),
        dnsQueries=sorted(dns),
    )


def seal_run_artifact(draft: dict[str, Any]) -> RunArtifact:
    parsed = RunArtifact.model_validate({**draft, "contentHash": ""})
    value = parsed.model_dump(mode="json", exclude_none=False)
    return RunArtifact.model_validate(
        {**value, "contentHash": content_hash_of({**value, "contentHash": ""})}
    )


@dataclass(frozen=True)
class RenderedTimeline:
    text: str
    ids: frozenset[str]


def render_timeline(artifact: RunArtifact) -> RenderedTimeline:
    home = (artifact.setupApplied.env or {}).get("HOME", "/home/node")

    def shorten(value: str) -> str:
        return _truncate(("~" + value[len(home) :]) if value.startswith(home) else value)

    node = sorted(
        (event for event in artifact.events if event.stream.startswith("L4")),
        key=lambda event: event.timestamp,
    )
    clock = sorted(
        (event for event in artifact.events if not event.stream.startswith("L4")),
        key=lambda event: event.timestamp,
    )
    fds: dict[int, tuple[str, bool]] = {
        0: ("stdin", False),
        1: ("stdout", False),
        2: ("stderr", False),
    }
    node_rows = _collapse([_describe(event, shorten, fds) for event in node])
    clock_rows = _collapse([_describe(event, shorten, fds) for event in clock])
    identifiers: set[str] = set()
    counter = 0

    def identity() -> str:
        nonlocal counter
        counter += 1
        value = f"e{counter}"
        identifiers.add(value)
        return value

    node_lines = [
        f"{identity():<5} {row[1]:<8} {row[2]}{f'  [x{row[3]}]' if row[3] > 1 else ''}".rstrip()
        for row in node_rows
    ]
    clock_lines = []
    for tag, verb, target, count, first, last in clock_rows:
        start, end = first / 1e9, last / 1e9
        stamp = f"t+{start:.2f}-{end:.2f}s" if count > 1 and start != end else f"t+{start:.2f}s"
        clock_lines.append(
            f"{identity():<5} {stamp:<13} [{tag}]{' ' * max(0, 3 - len(tag))} {verb:<8} {target}{f'  [x{count}]' if count > 1 else ''}".rstrip()
        )
    trigger = artifact.triggerUsed
    env_keys = list((artifact.setupApplied.env or {}).keys())
    planted = [shorten(file.path) for file in artifact.setupApplied.plantFiles or []]
    setup = ([f"env {', '.join(env_keys)}"] if env_keys else []) + (
        [f"planted {', '.join(planted)}"] if planted else []
    )
    lines = [
        f"# Timeline — {artifact.runId} · trigger={trigger.kind}:{trigger.target}",
        f"# setup: {' · '.join(setup) if setup else '(none)'}",
    ]
    if artifact.timedOut:
        lines.append("# note: run hit the wall-clock budget (timed out)")
    if artifact.error:
        lines.append(f"# note: run error — {artifact.error.kind}: {artifact.error.detail}")
    if counter == 0:
        lines.extend(["", "(no events captured)"])
    else:
        if node_lines:
            lines.extend(["", "── [L4] node calls — logical order, no clock ──", *node_lines])
        if clock_lines:
            lines.extend(
                [
                    "",
                    "── wall-clock t+ — [L1] syscall · [L2] network · [L3] fs-diff (mtime-coarse) ──",
                    *clock_lines,
                ]
            )
    return RenderedTimeline("\n".join(lines), frozenset(identifiers))


def _collapse(rows: list[tuple[str, str, str, int]]) -> list[tuple[str, str, str, int, int, int]]:
    output: list[list[Any]] = []
    for tag, verb, target, timestamp in rows:
        if output and output[-1][:3] == [tag, verb, target]:
            output[-1][3] += 1
            output[-1][5] = timestamp
        else:
            output.append([tag, verb, target, 1, timestamp, timestamp])
    return [tuple(row) for row in output]


def _describe(
    event: EvidenceEvent, shorten, fds: dict[int, tuple[str, bool]]
) -> tuple[str, str, str, int]:
    normalized = event.normalized or {}

    def value(key: str) -> str:
        item = normalized.get(key)
        return "" if item is None else str(item)

    fd_match = re.match(r"^\w+\((-?\d+)", event.raw) if isinstance(event.raw, str) else None
    fd = int(fd_match.group(1)) if fd_match else None
    tag = {
        "L1:seccomp": "L1",
        "L2:pcap": "L2",
        "L3:fsDiff": "L3",
        "L4:monkey": "L4",
        "L4:v8inspector": "L4",
        "engine": "ENG",
    }.get(event.stream, event.stream)
    target = ""
    verb = event.kind
    if event.kind == "openat":
        verb, target = "open", shorten(value("path"))
        try:
            result_fd = int(value("ret"))
            if result_fd >= 0:
                fds[result_fd] = (target, False)
        except ValueError:
            pass
    elif event.kind in {"read", "write"}:
        verb, target = event.kind, fds.get(fd, (f"fd:{fd if fd is not None else '?'}", False))[0]
    elif event.kind in {"connect", "sendto"}:
        verb = "connect" if event.kind == "connect" else "send"
        target = (
            f"{value('addr')}:{value('port') or '?'}"
            if value("addr")
            else (fds.get(fd, ("socket", True))[0] if fd is not None else "socket")
        )
        if fd is not None:
            fds[fd] = (target, True)
    elif event.kind == "execve":
        verb, target = (
            "exec",
            f"{shorten(value('path'))} {json.dumps(normalized.get('argv')) if normalized.get('argv') else ''}".rstrip(),
        )
    elif event.kind in {"unlink", "file_created", "file_modified", "file_deleted"}:
        verb = {
            "unlink": "unlink",
            "file_created": "create",
            "file_modified": "modify",
            "file_deleted": "delete",
        }[event.kind]
        target = shorten(value("path"))
    elif event.kind in {"rename", "link"}:
        verb, target = event.kind, f"{shorten(value('from'))} → {shorten(value('to'))}"
    elif event.kind == "dns_query":
        verb, target = "dns", value("host") or value("dns")
    elif event.kind == "http_request":
        verb, target = (
            "http",
            f"{value('method') or 'GET'} {value('host')}{value('path') or value('uri')}".strip(),
        )
    elif event.kind == "tls_sni":
        verb, target = "tls", value("host") or value("sni")
    elif event.kind == "require":
        verb, target = "require", value("module")
    elif event.kind == "env_access":
        verb, target = "env", value("key")
    elif event.kind == "fs_op":
        verb, target = "fs", f"{shorten(value('path'))} ({value('method')})".strip()
    elif event.kind == "network":
        verb, target = "net", f"{value('method') or 'GET'} {shorten(value('url'))}".strip()
    elif event.kind == "process":
        verb, target = "spawn", shorten(value("cmd"))
    elif event.kind == "eval":
        verb, target = "eval", _truncate(value("code"))
    elif event.kind == "crypto":
        verb, target = "crypto", f"{value('method')} {value('algo')}".strip()
    elif event.kind == "timer":
        verb, target = "timer", f"{value('kind')} {value('ms')}".strip()
    elif event.kind == "script_parsed":
        source = re.sub(r"\s+", " ", value("source")).strip()
        length = int(float(value("len") or 0))
        marker = (
            f"  [dynamically compiled · {length}c{' · capped' if length > len(value('source')) else ''}]"
            if length
            else "  [dynamically compiled]"
        )
        verb, target = "script", _truncate(source or value("url")) + marker
    elif event.kind == "clone":
        verb = "clone"
    elif event.kind == "setup_bypass":
        verb = "bypass"
    elif event.kind == "truncated":
        verb = "truncated"
    elif event.kind == "error":
        verb, target = "error", _truncate(str(event.raw))
    return tag, verb, target, int(event.timestamp)


def _truncate(value: str, length: int = 100) -> str:
    return value[:length] + "…" if len(value) > length else value

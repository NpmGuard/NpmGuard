from __future__ import annotations

import hashlib
import json
import re
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import rfc8785
from pydantic import BaseModel

from .contract.models import EventSummary, EvidenceEvent, RunArtifact

TRACE_START = "__NPMGUARD_TRACE__"
TRACE_END = "__NPMGUARD_TRACE_END__"
# Where observation writes the L4 instrument inside the sandbox, and therefore the
# `from` value that would appear on a require the INSTRUMENT made rather than the
# package. Single source of truth: observation.py mounts it here and passes it to
# `node --require`, and parse_l4_trace refuses a trace that attributes an
# instrument require to the package.
INSTRUMENT_PATH = "/tmp/_instrument.js"
# What instrumentation-require-hook.js records as `from` when a require has no
# parent module. Node's own `-e` bootstrap lazily requires `module` this way on
# every run, so it is baseline noise — but it is never the package, which always
# requires from inside a module.
TRACE_NO_PARENT = "<root>"
# A captured request body gets more display room than a path: a credential blob's
# interesting part is rarely in the first 100 characters. The full captured prefix
# (instrument-capped) stays in the sealed artifact, and the canary match is computed
# over that prefix rather than this truncation, so a value past the cut is still named.
_BODY_RENDER_CHARS = 200
# ── The canary contract ──────────────────────────────────────────────────────────
# A canary is bait the ENGINE MINTED. `render_timeline` names a planted env var as
# "carried" by a request only when the request contains that minted token, and two
# properties make a coincidental citation IMPOSSIBLE rather than improbable:
#
#   * the token carries 128 bits from `secrets.token_hex`, drawn per plant, so no
#     preimage of it exists anywhere the package can reach — not in its own source,
#     not in a hostname, path, port, timestamp or hard-coded string. Inside the
#     container the ONLY place those bytes exist is the env var the engine planted,
#     so the token appearing in an outbound request IS the statement "this value was
#     read out of the environment and put on the wire";
#   * membership in the bait set is decided by the minted FORMAT, so a value the
#     engine did not mint cannot enter the bait set at all.
#
# What this replaces: a LENGTH floor (`len(value) >= 8`) applied to whatever the
# model happened to plant. Under it the recorded corpus's own `HOME=/home/node` and
# `MYAPP_DB_HOST=localhost` were bait, so a benign crash reporter POSTing a stack
# trace containing `/home/node` rendered `· carries planted env HOME`, and a GET
# with no body at all rendered `· carries planted env MYAPP_DB_HOST` because
# `localhost` occurs in its own URL. That clause is written to be cited, one
# CONFIRM carries the whole verdict (§18), and DANGEROUS blocks an install behind a
# GitHub check — a manufactured citation is the most expensive error this renderer
# can make. Length is not a discriminator. Provenance is.
CANARY_PREFIX = "npmguard-canary-"
_CANARY_HEX_CHARS = 32
CANARY_PATTERN = re.compile(re.escape(CANARY_PREFIX) + f"[0-9a-f]{{{_CANARY_HEX_CHARS}}}")
SYSCALL_KINDS = frozenset(
    {"openat", "read", "write", "connect", "sendto", "execve", "clone", "unlink", "rename", "link"}
)


def mint_canary() -> str:
    """A fresh, unguessable bait token for ONE planted env var.

    Minting and matching live in this module together on purpose: they are one fact
    stated once, so the format the setup plants and the format the renderer cites
    cannot drift apart into a silent loss of correlation.

    Bait is synthetic by construction and never a real secret, so it stays plaintext
    in the sealed artifact — which is what makes correlating a captured request body
    with it possible at all (planted FILE contents are recorded as hashes only, so a
    file canary is unmatchable from an artifact; see §24.8).

    A caller may embed the token inside a realistic-looking value —
    ``"npm_" + mint_canary()`` — when the package's exfil branch depends on the
    SHAPE of what it reads. The renderer matches the token alone, so the wrapper is
    free, and the wrapper is where the realism belongs: appending a canary to a
    value the program uses as CONFIGURATION (`HOME`, `CI`, a hostname) changes which
    branch it takes, which is a worse failure than no canary at all.

    Not a secret-management primitive: the token is disposable per run and never
    grants access to anything.
    """
    return CANARY_PREFIX + secrets.token_hex(_CANARY_HEX_CHARS // 2)


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


def parse_l4_trace(
    stdout: str, instrument_path: str = INSTRUMENT_PATH
) -> list[EvidenceEvent] | None:
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
        if kind == "require" and normalized["from"] == instrument_path:
            # INVARIANT: no `require` event in a trace is the instrument's own.
            # instrumentation-require-hook.js is concatenated after every fragment
            # that requires anything, so this is unreachable — and it must stay
            # unreachable, because a timeline that shows the instrument's
            # child_process/crypto requires as the package's tells the judge the
            # package reached for capabilities it never touched. Raising here
            # DEFERS the hypothesis with a located cause; it never launders a
            # misattributed timeline into a verdict.
            raise AssertionError(
                f"parse_l4_trace: require of {normalized['module']!r} attributed to the "
                f"package but made by the instrument ({instrument_path}) — the require "
                "hook was installed before the instrument's own dependencies"
            )
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
        # `body`/`bodyBytes` are always projected so the shape is uniform: bodyBytes
        # 0 means the package submitted no request body, and `len(body) < bodyBytes`
        # means the instrument's cap truncated it. An artifact recorded before body
        # capture existed also reads as 0 — the renderer says nothing in either case,
        # so neither is ever presented as evidence of an empty payload.
        return "network", {
            "method": str(entry.get("method", "GET")),
            "url": str(entry.get("url", "")),
            "body": str(entry.get("body", "")),
            "bodyBytes": int(entry.get("bodyBytes") or 0),
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
    # INVARIANT: every seed in `bait` is a token this engine minted (`mint_canary`),
    # so a seed cannot appear in a request the package did not build out of the
    # planted value. That makes the "carries planted env <KEY>" clause unfalsifiable
    # as evidence of a read-and-send, instead of a coincidence detector — see the
    # canary contract above for the two properties and the citations it used to
    # manufacture. A planted value with no minted token in it is not bait and is
    # never named: `HOME=/home/node` is *expected* here (the path shortener reads it
    # one line up), and it is exactly the value the length floor turned into a
    # citation. The engine-minted token is matched alone, so a value may carry any
    # realistic wrapper around it.
    bait = {
        key: match.group(0)
        for key, value in (artifact.setupApplied.env or {}).items()
        if (match := CANARY_PATTERN.search(value))
    }

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
    node_rows = _collapse([_describe(event, shorten, fds, bait) for event in node])
    clock_rows = _collapse([_describe(event, shorten, fds, bait) for event in clock])
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
    # A stub that answered nothing is named, because "the endpoint you were told is
    # stubbed was never contacted" is evidence about the run — and without it a
    # timeline is silent on whether the experiment's central manipulation ever fired.
    # `responseHash is None` is reachable only for artifacts produced by the stub
    # ledger: every recorded artifact carries the old plan hash, so no committed
    # timeline gains a line here (and no event id shifts either way — this is header).
    unserved = [
        stub.pattern for stub in artifact.setupApplied.stubUrls or [] if stub.responseHash is None
    ]
    setup = (
        ([f"env {', '.join(env_keys)}"] if env_keys else [])
        + ([f"planted {', '.join(planted)}"] if planted else [])
        + ([f"stubs never served: {', '.join(unserved)}"] if unserved else [])
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


def _outcome(kind: str, normalized: dict[str, Any]) -> str:
    """What the syscall RETURNED, as a clause a judge can read and cite.

    The result is frequently the whole fact. ``connect(19, 1.2.3.4:443) = 0`` is an
    established exfiltration channel and ``… = -1 ECONNREFUSED`` is a refused one;
    both used to render as the identical row, and `_collapse` then merged them into
    one ``[x2]`` — so the most incriminating distinction L1 offers was not merely
    unrendered, it was actively hidden. 113 of the 157 connects in the committed
    corpus are ``-1``.

    ``-1`` is not a synonym for failure, and that is why this cannot be left to a
    reader of the raw line: a NON-BLOCKING connect that the kernel accepted returns
    ``-1 EINPROGRESS``, i.e. it SUCCEEDED and the handshake is under way. Naming it
    as a failure would be worse than saying nothing.

    Success is the unmarked default for every other kind on purpose. Rendering a
    read's byte count or an open's fd would put a value that differs on every call
    into the collapse key, exploding 1440 corpus reads into 1440 rows without adding
    a fact — while a FAILED open (``~/.ssh/id_ed25519 [failed: ENOENT]``) states
    directly what §17.4 leaves the reader to infer from a missing `read`.
    """
    if "ret" not in normalized:
        return ""  # L2/L3/L4 and engine events: there is no syscall result to state
    ret, error = str(normalized["ret"]), normalized.get("error")
    if ret == "?":
        return "  [no result — the trace ended while this call was in flight]"
    if error == "EINPROGRESS":
        # Deliberately not phrased as "connect": the sentence is true for whatever
        # syscall the kernel accepted, so it states the fact rather than assuming the
        # only kind that can currently produce it.
        return "  [in progress: EINPROGRESS — SUCCEEDED, completing asynchronously (not a refusal)]"
    if error:
        return f"  [failed: {error}]"
    if ret.startswith("-"):
        # Reachable only for artifacts sealed before the parser kept the errno beside
        # a `-1` (every one of the 31 committed runartifacts). Saying "failed" here
        # would assert what the artifact cannot support, since EINPROGRESS is in the
        # same bucket; a rendered negative states its own coverage instead.
        return (
            "  [-1, errno not recorded — refused or async in progress]"
            if kind == "connect"
            else "  [failed: errno not recorded]"
        )
    return "  [connected]" if kind == "connect" else ""


def _describe(
    event: EvidenceEvent, shorten, fds: dict[int, tuple[str, bool]], bait: dict[str, str]
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
        # A `recvfrom` (kind "read") names the peer it read FROM in its own sockaddr,
        # and for an unconnected socket — UDP DNS, above all — that is the only place
        # the peer appears at all. Prefer it over the fd table, whose entry for a
        # descriptor that was never connect()ed is not a peer. Measured: 221 of the
        # 230 recvfrom lines in the committed corpus print an inet peer, none of which
        # any timeline has ever shown (those artifacts predate the parser reading it,
        # and are filed under kind `openat` with `{"ret": …}` and nothing else), so
        # this renders for new runs only.
        verb = event.kind
        target = (
            f"{value('addr')}:{value('port') or '?'}"
            if value("addr")
            else fds.get(fd, (f"fd:{fd if fd is not None else '?'}", False))[0]
        )
    elif event.kind in {"connect", "sendto"}:
        verb = "connect" if event.kind == "connect" else "send"
        # INVARIANT: the peer of a socket syscall is never a FILE the descriptor used
        # to hold. The fd table's second element records whether the descriptor was
        # last bound to a socket, and ignoring it let an AF_UNIX connect on a recycled
        # fd inherit the path a previous openat left there — rendering
        # "connect /etc/localtime", which is false rather than merely vague, and a
        # judge can cite a false target. `path` is the sun_path strace printed, so a
        # named unix peer renders as itself; "socket" is what remains when the run
        # genuinely offers no peer (an unnamed AF_UNIX peer, AF_NETLINK, or a
        # legacy artifact whose sockaddr was never parsed).
        #
        # Why this lands now, when test_evidence C14b pinned it as blocked: the fix
        # merges rows, and its cost was that the merge SHRANK the id space of 9 of the
        # 14 dns-exfil artifacts, invalidating recorded judge citations (hyp-0002
        # cited e246, which stopped existing). Rendering the syscall RESULT splits
        # more rows than this merges, so measured over all 31 committed runartifacts
        # no artifact's id count falls below its recorded value and every recorded
        # citation still resolves (`tools.fixture_lint` [8] green). The blocker was
        # the fixture cost, and the fixture cost is gone.
        bound = fds.get(fd) if fd is not None else None
        target = (
            f"{value('addr')}:{value('port') or '?'}"
            if value("addr")
            else shorten(value("path"))
            if value("path")
            else (bound[0] if bound and bound[1] else "socket")
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
        if value("from") == TRACE_NO_PARENT:
            # A parentless require is never the package's — it always requires from
            # inside a module. Node's `-e` bootstrap contributes exactly one
            # (`module`) per run. Named rather than dropped: dropping it would also
            # blind the timeline to an evasive `Module._load(name, null)`, and the
            # doctrine here is to make an event readable, never to filter it.
            target += "  [no requiring module — node bootstrap, not the package]"
    elif event.kind == "env_access":
        verb, target = "env", value("key")
    elif event.kind == "fs_op":
        verb, target = "fs", f"{shorten(value('path'))} ({value('method')})".strip()
    elif event.kind == "network":
        # An opaque payload is as unreadable to a judge as a bare `write(5, …)`, so
        # the same "resolve it into a sentence" rule applies: show the bounded body
        # and name which planted canaries it carries. Without this, "was the canary
        # in the exfiltrated payload?" is unanswerable and a real exfil refutes.
        verb, target = "net", f"{value('method') or 'GET'} {shorten(value('url'))}".strip()
        body, body_bytes = value("body"), int(float(value("bodyBytes") or 0))
        if body_bytes:
            preview = _truncate(re.sub(r"\s+", " ", body).strip(), _BODY_RENDER_CHARS)
            target += f"  body[{body_bytes}b] {preview}"
        carried = sorted(key for key, seed in bait.items() if seed in value("url") + body)
        if carried:
            target += f"  · carries planted env {', '.join(carried)}"
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
        # The reason is the whole content of a bypass event — a bare "bypass" row told
        # the judge that something in the setup did not hold without saying what, which
        # is worse than not mentioning it. No recorded artifact carries this kind, so
        # naming the detail costs nothing at replay.
        verb, target = "bypass", _truncate(value("detail") or str(event.raw))
    elif event.kind == "truncated":
        verb = "truncated"
    elif event.kind == "error":
        verb, target = "error", _truncate(str(event.raw))
    # The result is appended LAST, after every fd-table write above, so the table
    # keeps the bare peer/path: storing "127.0.0.1:9999  [connected]" would make a
    # later read on that descriptor render the CONNECT's outcome as its own. It goes
    # into `target` rather than beside it because that is the collapse key — which is
    # precisely how `_collapse` stops merging two calls that differ in result.
    return tag, verb, f"{target}{_outcome(event.kind, normalized)}".strip(), int(event.timestamp)


def _truncate(value: str, length: int = 100) -> str:
    return value[:length] + "…" if len(value) > length else value

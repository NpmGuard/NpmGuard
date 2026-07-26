"""The frontend-safe projection of a sandbox run.

A ``RunArtifact`` is the sealed unit of evidence and it is not shippable. Its
events carry 4 KiB strace buffers, captured request bodies, compiled script
source, and the values the experiment planted. This module is the ONE seam that
decides what a viewer may see, and every rule it applies is here rather than
spread over a renderer.

THE RULE: a display value may name WHERE something went and WHAT was touched —
host, port, path, module specifier, environment KEY — and may never carry the
bytes. A payload is described by its size, its outcome, and which planted
canaries it carried, never by its content.

That is not privacy theatre. `/audit/:id` is a public, pasteable link, and a
package under test reads whatever the sandbox hands it; a run that captured a
credential-shaped blob must be *citable* without being *readable*.

Identity is borrowed, never minted: a ``DisplayObservation`` is one
``TimelineRow``, and a row's ``event_id`` is the ``eN`` handle the judge cites.
So ``hypothesis_resolved.citedEventIds`` joins to observations exactly, and a
confirmed verdict can be walked back to the rows it rests on.
"""

from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from .contract.models import (
    DisplayObservation,
    DisplayStub,
    RunArtifact,
    RunCaptures,
    RunDisplay,
    SanitizedSetup,
    SetupApplied,
    ToolCall,
)
from .evidence import CANARY_PATTERN, TimelineRow, timeline_rows

# How many rows one `sandbox_completed` frame may carry. A bound is required —
# a chatty run produces thousands of rows and this frame is on a live wire — and
# it is stated on the payload (`omittedObservationCount`) so a truncated display
# can never read as a complete one. Sized to hold every row of the heaviest run
# in the committed corpus with room to spare, so the bound is a ceiling on
# pathology rather than a routine cut.
DISPLAY_OBSERVATION_BOUND = 60

# shared/src/evidence.ts :: ObservationSignal. Named here rather than restated at
# each use so the three tiers and the priority order below cannot drift apart.
ObservationSignal = Literal["high", "context", "error"]

# A synthetic value, wherever one is displayed. Never a blank: an empty field
# reads as "a real credential is being hidden", which is the opposite of true.
SYNTHETIC = "[synthetic secret]"

# The behaviour a judge cites. Everything else is scenery, and scenery is what a
# bound may drop.
_NETWORK_KINDS = frozenset(
    {"connect", "sendto", "dns_query", "http_request", "tls_sni", "tcp_syn", "network"}
)
_PROCESS_KINDS = frozenset({"execve", "process", "clone"})
_DYNAMIC_CODE_KINDS = frozenset({"eval", "script_parsed"})
_DESTRUCTIVE_KINDS = frozenset({"unlink", "rename", "link", "file_deleted"})
_HIGH_SIGNAL_KINDS = (
    _NETWORK_KINDS
    | _PROCESS_KINDS
    | _DYNAMIC_CODE_KINDS
    | _DESTRUCTIVE_KINDS
    | {"env_access", "crypto"}
)
# Never dropped at any bound: a run that broke or was cut short is the one fact a
# viewer must not have to infer from a shorter list.
_ALWAYS_KINDS = frozenset({"truncated", "setup_bypass", "error"})

# What makes a file read high-signal. Matched on the path a sensor recorded, so
# it fires on a read of ~/.npmrc whichever sensor saw it (L1 openat, L4 fs_op,
# L3 fs-diff). Deliberately a small, well-known list rather than a heuristic:
# a false negative costs a row at a bound nobody usually reaches, and a false
# positive fills the display with package noise.
_CREDENTIAL_PATH = re.compile(
    r"(^|/)(\.npmrc|\.netrc|\.env(\.[\w.-]+)?|\.git-credentials|credentials|"
    r"id_[a-z0-9]+|\.ssh/|\.aws/|\.docker/config\.json|\.kube/config|"
    r"keychain|wallet\.dat)",
    re.IGNORECASE,
)
_FILE_KINDS = frozenset(
    {"openat", "read", "write", "fs_op", "file_created", "file_modified", "file_deleted"}
)

# `_describe` appends every clause as `  [...]`, documented there precisely so a
# consumer can recover the bare peer/path. That recovery is what this module
# uses for the kinds whose bare target is already structural.
_CLAUSE = "  ["


def _bare(target: str) -> str:
    """The structural head of a rendered target — everything before the first
    appended clause."""
    return target.split(_CLAUSE, 1)[0].strip()


def _outcome_clauses(target: str) -> str:
    """The appended clauses of a rendered target, minus the buffer preview.

    `_outcome` emits fixed sentences and errno names — content-free and load
    bearing (`[connected]` vs `[failed: ECONNREFUSED]` is the difference between
    an established channel and a refused one). `_buffer_clause` emits captured
    bytes, and is dropped whole; what it witnessed is restated by
    `_payload_witness` from the event instead.
    """
    kept = [
        clause
        for clause in target.split(_CLAUSE)[1:]
        if not clause.startswith("buf ") and not clause.startswith("body[")
    ]
    return "".join(f"  [{clause}" for clause in kept)


def _carried_canaries(event: Any, bait: dict[str, str]) -> list[str]:
    """Which planted environment KEYS this event's payload carried.

    A lower bound, exactly as the timeline's own clause is: a payload that
    ENCODES the token (DNS exfil hex-encodes) will not match, so absence is not
    evidence that nothing was exfiltrated.
    """
    if not bait:
        return []
    normalized = event.normalized or {}
    haystack = f"{event.raw if isinstance(event.raw, str) else ''}{normalized.get('url', '')}{normalized.get('body', '')}"
    return sorted(key for key, seed in bait.items() if seed in haystack)


def _payload_witness(row: TimelineRow, bait: dict[str, str]) -> str:
    """What left the process, stated as size and correlation instead of bytes.

    This is the clause that replaces a rendered buffer or request body. It keeps
    the two facts a viewer needs — how much went out, and whether it carried
    something the engine planted — and drops the only part that could contain a
    developer's real credential.
    """
    total = 0
    carried: set[str] = set()
    for event in row.events:
        normalized = event.normalized or {}
        raw_bytes = normalized.get("bodyBytes")
        if isinstance(raw_bytes, (int, float)):
            total += int(raw_bytes)
        elif isinstance(event.raw, str) and (match := re.search(r'",\s*(\d+)', event.raw)):
            total += int(match.group(1))
        carried.update(_carried_canaries(event, bait))
    parts = []
    if total:
        parts.append(f"{total}b payload")
    if carried:
        parts.append(f"carries planted env {', '.join(sorted(carried))}")
    return f"  [{' · '.join(parts)}]" if parts else ""


def _safe_url(value: str) -> str:
    """A URL with its query and fragment removed.

    `POST localhost/exfil` is the whole point of an observation and must survive.
    `?token=ghp_live…` is a request body that happens to be spelled in the path,
    and must not.
    """
    if not value:
        return value
    try:
        parts = urlsplit(value)
    except ValueError:
        return "(unparseable url)"
    if not parts.scheme and not parts.netloc:
        return value.split("?", 1)[0].split("#", 1)[0]
    trimmed = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    return trimmed + (" ?…" if parts.query else "")


def _display_target(row: TimelineRow, bait: dict[str, str]) -> str:
    """The row's target, with package-generated content removed.

    Kinds whose bare target is already structural (a path, a peer, a module
    specifier, an environment key) pass through. The five kinds whose bare
    target IS content are rebuilt from the sensor's own fields.
    """
    event = row.events[0]
    normalized = event.normalized or {}
    kind = event.kind

    def value(key: str) -> str:
        item = normalized.get(key)
        return "" if item is None else str(item)

    if kind == "network":
        method = value("method") or "GET"
        return f"{method} {_safe_url(value('url'))}".strip()
    if kind == "http_request":
        return f"{value('method') or 'GET'} {value('host')}{_safe_url(value('path') or value('uri'))}".strip()
    if kind in _PROCESS_KINDS - {"clone"}:
        # A command LINE can carry a secret in an argument (`curl -d TOKEN=…`),
        # so only the program is named and the argument count states the rest.
        raw = value("cmd") or value("path")
        program = raw.split()[0] if raw else "(unknown)"
        argv = normalized.get("argv")
        extra = len(argv) - 1 if isinstance(argv, list) and argv else len(raw.split()) - 1
        return f"{program}{f' · {extra} arg{"" if extra == 1 else "s"}' if extra > 0 else ''}"
    if kind == "eval":
        return f"{len(value('code'))} characters compiled at runtime"
    if kind == "script_parsed":
        length = int(float(value("len") or 0)) or len(value("source"))
        source = value("url")
        return f"{length} characters compiled at runtime" + (f" · {source}" if source else "")
    return _bare(row.target)


def _signal(row: TimelineRow) -> ObservationSignal:
    kind = row.events[0].kind
    if kind in _ALWAYS_KINDS or row.events[0].stream == "engine":
        return "error"
    if kind in _HIGH_SIGNAL_KINDS:
        return "high"
    if kind in _FILE_KINDS and _CREDENTIAL_PATH.search(_bare(row.target)):
        return "high"
    return "context"


def _observation(
    row: TimelineRow, signal: ObservationSignal, bait: dict[str, str]
) -> DisplayObservation:
    event = row.events[0]
    target = _display_target(row, bait)
    clauses = _outcome_clauses(row.target) + _payload_witness(row, bait)
    summary = f"{row.verb} {target}{clauses}".strip()
    return DisplayObservation(
        eventId=row.event_id,
        atMs=round(row.first_ns / 1e6, 3),
        stream=event.stream,
        kind=event.kind,
        summary=summary,
        signal=signal,
        occurrences=row.count,
    )


def _bait(setup: SetupApplied) -> dict[str, str]:
    """The planted environment keys whose value carries a minted canary token —
    the same set, computed the same way, that `render_timeline` correlates on."""
    return {
        key: match.group(0)
        for key, item in (setup.env or {}).items()
        if (match := CANARY_PATTERN.search(item))
    }


def select_observations(
    rows: list[TimelineRow], *, bound: int = DISPLAY_OBSERVATION_BOUND, bait: dict[str, str]
) -> tuple[list[DisplayObservation], int]:
    """The bounded, deterministic display selection.

    Three tiers, in priority order, and the priority is what makes a bound safe:
    an error is never dropped, a first occurrence of high-signal behaviour is
    dropped only after every later duplicate is, and plain scenery goes first.
    Within a tier, earlier rows win — so the cut is a function of the run, not of
    when it was taken.

    Repeat high-signal behaviour is demoted rather than merged: the display then
    shows the FIRST `connect evil.test:443` and treats the ninth as scenery,
    which is what a reader needs and what `_collapse` cannot do for
    non-consecutive rows.

    Returns the selection in row order, and how many rows it left out.
    """
    seen: set[tuple[str, str]] = set()
    ranked: list[tuple[int, int, TimelineRow, ObservationSignal]] = []
    for index, row in enumerate(rows):
        signal = _signal(row)
        if signal == "high":
            key = (row.events[0].kind, _bare(row.target))
            if key in seen:
                signal = "context"
            seen.add(key)
        priority = {"error": 0, "high": 1, "context": 2}[signal]
        ranked.append((priority, index, row, signal))

    # Adjacent context: a citation reads as a sequence, not as one line torn out
    # of one. Neighbours of a kept high/error row outrank unrelated scenery.
    neighbours = {
        offset
        for priority, index, _row, _signal in ranked
        if priority <= 1
        for offset in (index - 1, index + 1)
        if 0 <= offset < len(rows)
    }
    ranked = [
        (priority if priority <= 1 else (2 if index in neighbours else 3), index, row, signal)
        for priority, index, row, signal in ranked
    ]

    kept = sorted(sorted(ranked)[:bound], key=lambda item: item[1])
    return (
        [_observation(row, signal, bait) for _p, _i, row, signal in kept],
        len(rows) - len(kept),
    )


def observations_for(artifact: RunArtifact, event_ids: list[str]) -> list[DisplayObservation]:
    """Exactly the rows a judgment cited, whatever the display bound did.

    The judge has not run when `sandbox_completed` is emitted, so a cited row can
    be one the preview left out. This is what makes "a confirmed verdict points
    at the events it rests on" total rather than usually-true: the frontend
    merges these into the run display by `eventId`.
    """
    wanted = set(event_ids)
    if not wanted:
        return []
    bait = _bait(artifact.setupApplied)
    return [
        _observation(row, _signal(row), bait)
        for row in timeline_rows(artifact)
        if row.event_id in wanted
    ]


def sanitize_setup(setup: SetupApplied) -> SanitizedSetup:
    """`SetupApplied` with every planted VALUE removed and every stub reduced to
    the fact that decides the experiment: whether it was ever contacted."""
    return SanitizedSetup(
        envKeys=sorted((setup.env or {}).keys()),
        date=setup.date,
        plantedFiles=list(setup.plantFiles or []),
        stubUrls=[
            DisplayStub(pattern=stub.pattern, served=stub.responseHash is not None)
            for stub in setup.stubUrls or []
        ],
        hostname=setup.hostname,
        locale=setup.locale,
        patchedFiles=[patch.path for patch in setup.patches or []],
        preloaded=setup.preloadHash is not None,
    )


# One argument's worth of model-authored text — a preload script, a driver, a
# patch replacement. Enough to read what the experiment did; short enough that a
# frame stays a frame.
_ARG_CHARS = 600


def _redact(value: Any) -> Any:
    if isinstance(value, str):
        cleaned = CANARY_PATTERN.sub(SYNTHETIC, value)
        return (
            cleaned
            if len(cleaned) <= _ARG_CHARS
            else f"{cleaned[:_ARG_CHARS]}… ({len(cleaned)} characters)"
        )
    if isinstance(value, dict):
        return {key: _redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def sanitize_experiment(experiment: list[ToolCall]) -> list[ToolCall]:
    """The armed tool calls, safe to display.

    These strings are the ENGINE's and the model's, never the package's — this
    is the plan, authored before anything ran. So the redaction here is narrow:
    minted canary tokens become a label, and long authored blobs are cut with
    their true length stated.
    """
    return [ToolCall(tool=call.tool, args=_redact(dict(call.args or {}))) for call in experiment]


def project_run_display(
    artifact: RunArtifact, *, run_id: str, bound: int = DISPLAY_OBSERVATION_BOUND
) -> RunDisplay:
    """One sealed run, as `sandbox_completed` may state it.

    `run_id` is the stream's identity for this run, minted before execution so
    the four experiment frames share one handle. It is passed rather than read
    off the artifact because the two can differ on a replayed fixture, and the
    frame must be internally consistent with the `experiment_started` that
    announced it.
    """
    rows = timeline_rows(artifact)
    bait = _bait(artifact.setupApplied)
    observations, omitted = select_observations(rows, bound=bound, bait=bait)
    return RunDisplay(
        runId=run_id,
        wallMs=artifact.wallMs,
        exitCode=artifact.exitCode,
        timedOut=artifact.timedOut,
        eventCount=len(artifact.events),
        eventSummary=artifact.eventSummary,
        error=artifact.error,
        setupApplied=sanitize_setup(artifact.setupApplied),
        observations=observations,
        omittedObservationCount=omitted,
        captures=RunCaptures(
            stdoutHash=artifact.stdoutHash,
            stderrHash=artifact.stderrHash,
            fsDiffHash=artifact.fsDiffHash,
            pcapHash=artifact.pcapHash,
            straceLogHash=artifact.straceLogHash,
        ),
        contentHash=artifact.contentHash,
    )

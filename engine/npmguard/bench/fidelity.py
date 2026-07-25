"""Render fidelity as CODE (B-12), because it is provably not reproducible as a
definition.

Two careful documents counted **244** and **277** anonymous rows over the *same*
4,140 rendered rows of the *same* immutable corpus. Neither was wrong; their
predicates differed on which placeholder forms and which layers count. That is a
13% spread from a static input, which is exactly the drift this whole domain
exists to prevent — so the metric ships as functions with tests pinning them to
committed artifacts, and a published caption names the predicate version, never
the prose.

**The predicate, stated narrowly, because breadth is what a reimplementation gets
wrong.** A *fidelity defect* is an event the renderer described with an anonymous
target **while that same event's own bytes carried a resolvable one**. A
``read``/``write`` on a descriptor whose ``openat`` was never captured has no
resolvable target anywhere — rendering ``fd:17`` is HONEST and must not count. The
two numbers are therefore kept separate: ``anonymousRows`` (all causes, mostly
honest) and ``fidelityDefects`` (the leak). Conflating them is how a 5.7%
anonymous-row rate gets misread as a 5.7% evidentiary leak.

**Why "the event's own bytes" and not "anywhere in the artifact".** Cross-event
credit would make the metric measure the fd table's memory rather than the
render, and the fd table is legitimately allowed to forget. Per-event scoping also
makes the recordable a pure function of one event, which is what makes it
testable.

**Resolvability is decided by the engine's own parser** (:func:`sensors._peer`),
not by a second regex in this module. A private import is the right dependency
here: the alternative is a parallel implementation of the exact thing under
measurement, which would drift silently and could never falsify the engine's
account of its own coverage — the one job §3.4 gives this tier.

Recordable 2, ``falseTargetEvents``, is not in the coherence spec's list and earns
its own counter: a vague target STARVES a judge, while a false one MISLEADS it,
which is strictly worse and cannot be recovered by a careful reader. At `67f830f`
the residual included ``connect /pkg/setup.js`` — a socket operation rendered as
the malware payload file itself.

This module reads sealed artifacts. It makes no LLM call, starts no container, and
never touches ``sandbox/test-fixtures`` (live malware, F-G7).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from ..contract.models import EvidenceEvent, RunArtifact
from ..evidence import CANARY_PATTERN, _describe, _truncate
from ..sensors import _peer

# Predicate version. Bump when a rule below changes, and publish it in the caption:
# a fidelity number is meaningless without both its `engineSha` and the predicate
# that produced it.
PREDICATE_VERSION = "bench-fidelity-1"

# The rendered forms that name no target. `socket` is `_describe`'s fallback for a
# socket syscall with no peer in its sockaddr; `fd:N` / `fd:?` is its fallback for
# a read/write on a descriptor the fd table cannot resolve.
_ANONYMOUS = re.compile(r"^(socket|fd:(-?\d+|\?))$")

# Only these kinds can be anonymous in the sense above, so only these are
# examined. Narrow by construction: an `env_access` with an empty key is a
# different defect and must not be smuggled into this number.
_SOCKET_KINDS = frozenset({"connect", "sendto"})
_FD_KINDS = frozenset({"read", "write"})
CANDIDATE_KINDS = _SOCKET_KINDS | _FD_KINDS

# `_describe` appends the syscall RESULT as a bracketed clause, and the row
# formatter later appends `[xN]`. Both are separated by two spaces, which no
# resolved target contains at its head.
_SUFFIX = "  ["


@dataclass(frozen=True, slots=True)
class FidelityCounts:
    """The per-run evidentiary-coverage record (§3.4.1 recordables 1 and 2).

    Published BESIDE every rate and gating nothing (Open item 10): a fidelity
    defect biases toward false negatives, so a non-zero count means detection is
    understated and specificity is, if anything, flattered — one threshold across
    both rates would be wrong.
    """

    described_events: int = 0
    rendered_rows: int = 0
    anonymous_rows: int = 0
    fidelity_defects: int = 0
    false_target_events: int = 0
    false_target_rows: int = 0
    predicate_version: str = PREDICATE_VERSION

    def __add__(self, other: FidelityCounts) -> FidelityCounts:
        assert self.predicate_version == other.predicate_version, (
            "refusing to sum fidelity counts from different predicate versions: "
            f"{self.predicate_version} vs {other.predicate_version}"
        )
        return FidelityCounts(
            described_events=self.described_events + other.described_events,
            rendered_rows=self.rendered_rows + other.rendered_rows,
            anonymous_rows=self.anonymous_rows + other.anonymous_rows,
            fidelity_defects=self.fidelity_defects + other.fidelity_defects,
            false_target_events=self.false_target_events + other.false_target_events,
            false_target_rows=self.false_target_rows + other.false_target_rows,
            predicate_version=self.predicate_version,
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "describedEvents": self.described_events,
            "renderedRows": self.rendered_rows,
            "anonymousRows": self.anonymous_rows,
            "fidelityDefects": self.fidelity_defects,
            "falseTargetEvents": self.false_target_events,
            "falseTargetRows": self.false_target_rows,
            "predicateVersion": self.predicate_version,
        }


@dataclass(frozen=True, slots=True)
class DescribedEvent:
    """One event and the target the renderer gave it."""

    event: EvidenceEvent
    tag: str
    verb: str
    target: str

    @property
    def bare_target(self) -> str:
        """The target with the result clause stripped — the collapse key's
        payload, which is what a judge reads as "what was touched"."""
        return self.target.split(_SUFFIX)[0].strip()


def _raw_line(event: EvidenceEvent) -> str | None:
    """An L1 event's raw strace line, or None for a non-string payload."""
    return event.raw if isinstance(event.raw, str) else None


def resolvable_target(event: EvidenceEvent) -> str | None:
    """The target present in THIS event's own bytes, or None.

    Delegates to the engine's own sockaddr parser so "resolvable" means "resolvable
    by the engine", not "resolvable by a regex this module invented". A parse that
    raises is treated as unresolvable rather than propagated: this is a measuring
    instrument, and it must be able to report a defect on a line it cannot read
    without taking the audit down with it.
    """
    line = _raw_line(event)
    if line is None:
        return None
    args = line[line.find("(") + 1 : line.rfind(")")] if "(" in line else ""
    try:
        peer = _peer(event.kind, args)
    except (AssertionError, AttributeError):
        # `_peer` asserts on an AF_INET sockaddr whose address it cannot extract —
        # a parser defect by its own definition, so the bytes DID carry a target.
        return "<unparseable sockaddr>"
    if peer.get("addr"):
        return f"{peer['addr']}:{peer.get('port') or '?'}"
    return peer.get("path") or None


def describe_events(artifact: RunArtifact) -> list[DescribedEvent]:
    """Re-render every event of a sealed artifact, keeping the event → row link.

    ``render_timeline`` returns TEXT, and ``_collapse`` merges consecutive
    identical rows, so the text cannot answer "which event produced this line".
    The loop below mirrors ``render_timeline``'s own: L4 events in logical order
    first, everything else on the wall clock second, over ONE fd table shared by
    both passes (the renderer's own choice — a descriptor opened in the L4 pass is
    visible to the clock pass) seeded with the same three standard descriptors.
    Pinned against the real renderer by a test asserting every bare target
    produced here appears in ``render_timeline(artifact).text``. Without that pin
    this would be a second renderer, which is the failure mode the module is
    about.
    """
    home = (artifact.setupApplied.env or {}).get("HOME", "/home/node")
    bait = {
        key: match.group(0)
        for key, value in (artifact.setupApplied.env or {}).items()
        if (match := CANARY_PATTERN.search(value))
    }

    def shorten(value: str) -> str:
        return _truncate(("~" + value[len(home) :]) if value.startswith(home) else value)

    fds: dict[int, tuple[str, bool]] = {
        0: ("stdin", False),
        1: ("stdout", False),
        2: ("stderr", False),
    }
    described: list[DescribedEvent] = []
    for l4 in (True, False):
        events = sorted(
            (e for e in artifact.events if e.stream.startswith("L4") is l4),
            key=lambda e: e.timestamp,
        )
        for event in events:
            tag, verb, target, _ = _describe(event, shorten, fds, bait)
            described.append(DescribedEvent(event=event, tag=tag, verb=verb, target=target))
    return described


def collapse(described: Iterable[DescribedEvent]) -> list[list[DescribedEvent]]:
    """Group events into RENDERED ROWS exactly as ``_collapse`` does: a run of
    consecutive events sharing ``(tag, verb, target)`` is one row.

    Grouping rather than counting, because "rows whose target is anonymous" must
    be counted over the FULL collapse — filtering first and collapsing after would
    merge rows that were never adjacent and undercount, which is one of the ways
    two honest readings of "anonymous rows" came out 13% apart.
    """
    rows: list[list[DescribedEvent]] = []
    previous: tuple[str, str, str] | None = None
    for item in described:
        key = (item.tag, item.verb, item.target)
        if key != previous:
            rows.append([])
            previous = key
        rows[-1].append(item)
    return rows


def is_anonymous(item: DescribedEvent) -> bool:
    return bool(_ANONYMOUS.match(item.bare_target))


def is_defect(item: DescribedEvent) -> bool:
    """Recordable 1: anonymous DESPITE a resolvable target in its own bytes."""
    if item.event.kind not in CANDIDATE_KINDS or not is_anonymous(item):
        return False
    return resolvable_target(item.event) is not None


def is_false_target(item: DescribedEvent) -> bool:
    """Recordable 2: a socket operation rendered with a filesystem path that is
    NOT in its own bytes — i.e. inherited from a recycled descriptor.

    A named AF_UNIX peer (``sun_path="/var/run/nscd/socket"``) renders its own
    path and is CORRECT, which is why the comparison is against this event's own
    resolvable target rather than against "looks like a path".
    """
    if item.event.kind not in _SOCKET_KINDS:
        return False
    target = item.bare_target
    if not target.startswith(("/", "~/")):
        return False
    own = resolvable_target(item.event)
    return own is None or own != target


def counts_for(artifact: RunArtifact) -> FidelityCounts:
    """The recordables for one sealed run artifact. Pure."""
    described = describe_events(artifact)
    rows = collapse(described)
    return FidelityCounts(
        described_events=len(described),
        rendered_rows=len(rows),
        anonymous_rows=sum(1 for row in rows if is_anonymous(row[0])),
        fidelity_defects=sum(1 for item in described if is_defect(item)),
        false_target_events=sum(1 for item in described if is_false_target(item)),
        false_target_rows=sum(1 for row in rows if is_false_target(row[0])),
    )


def counts_over(artifacts: Iterable[RunArtifact]) -> FidelityCounts:
    total = FidelityCounts()
    for artifact in artifacts:
        total = total + counts_for(artifact)
    return total


# ---------------------------------------------------------------------------
# Locating sealed artifacts for a stored audit
# ---------------------------------------------------------------------------
# The artifact tier is reachable from an `audit_id` — `audit_sessions.report` →
# `hypotheses[].evidenceRefs[].hash` → the blob — but only by SEARCH, because
# `ArtifactStore` is rooted at `AuditLog.run_dir`
# (`audit-logs/<timestamp>_<package>/artifacts/`, `audit_log.py:25-28`), which is
# keyed by timestamp and package name rather than by `audit_id`. Content
# addressing is what makes the search sound: a digest names exactly one blob, so a
# hit is unambiguous wherever it is found.
#
# This is a REPORTED gap, not a design choice: keying the artifact root by
# `audit_id` is a one-line change in `pipeline.py` (not this agent's file) and
# would make the tier a direct lookup. Until then the resolver returns None
# rather than guessing, and every coverage count is null instead of 0 — a run that
# cannot account for its coverage says so (§7.1's rule, applied to fidelity).


def artifact_digests(report: dict) -> list[str]:
    """Every sealed-artifact digest a report cites, in report order."""
    digests: list[str] = []
    for hypothesis in report.get("hypotheses") or []:
        for ref in hypothesis.get("evidenceRefs") or []:
            if ref.get("kind") == "run" and isinstance(ref.get("hash"), str):
                digests.append(ref["hash"])
    return list(dict.fromkeys(digests))


def find_artifacts(digests: Iterable[str], search_roots: Iterable[Path]) -> Iterator[RunArtifact]:
    """Load each digest from the first search root that holds it."""
    wanted = list(digests)
    roots = [root for root in search_roots if root.is_dir()]
    for digest in wanted:
        for root in roots:
            for path in root.glob(f"*/artifacts/{digest}"):
                yield RunArtifact.model_validate_json(path.read_bytes())
                break
            else:
                continue
            break


__all__ = [
    "CANDIDATE_KINDS",
    "PREDICATE_VERSION",
    "DescribedEvent",
    "FidelityCounts",
    "artifact_digests",
    "counts_for",
    "counts_over",
    "describe_events",
    "find_artifacts",
    "is_anonymous",
    "is_defect",
    "is_false_target",
    "resolvable_target",
]

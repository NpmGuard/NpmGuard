"""Named aliases for the contract's inline enums.

``models.py`` is generated, and datamodel-code-generator inlines a field's enum
as ``Annotated[Literal[...], Field(title='EventKind')]`` rather than emitting a
named type. Producers of those fields therefore have nothing to annotate their
own tables and helpers with, and every value reaches the model as a bare ``str``.

This module names them once. The aliases are *checked* against the generated
model at import, so a contract regeneration that adds or drops a kind fails here
instead of silently letting a stale alias through.
"""

from __future__ import annotations

from typing import Literal, get_args

from pydantic import BaseModel

from .models import (
    AuditEvent,
    AuditSetItem,
    BenchCorpus,
    BenchEntry,
    EvidenceEvent,
    ScanProgressFrame,
)

# shared/src/evidence.ts :: EventKind
EventKind = Literal[
    # L1 kernel syscalls
    "openat",
    "read",
    "write",
    "connect",
    "sendto",
    "execve",
    "clone",
    "unlink",
    "rename",
    "link",
    # L2 netns network
    "dns_query",
    "http_request",
    "tls_sni",
    "tcp_syn",
    # L3 fs diff
    "file_created",
    "file_modified",
    "file_deleted",
    # L4 monkey-patch (mirrors sandbox/instrumentation.ts kinds)
    "require",
    "env_access",
    "fs_op",
    "network",
    "process",
    "eval",
    "crypto",
    "timer",
    # L4 inspector
    "script_parsed",
    "debugger_paused",
    # engine synthetic
    "truncated",
    "setup_bypass",
    "error",
]

# shared/src/panel.ts :: the audit-set vocabularies.
PackageOutcome = Literal["SAFE", "ERROR", "DANGEROUS"]
JobState = Literal["queued", "running", "failed"]
SetStatus = Literal["running", "done"]

# shared/src/bench.ts :: the corpus vocabularies.
BenchVerdict = Literal["SAFE", "DANGEROUS"]
BenchCorpusSource = Literal["datadog", "negative-control", "watchlist"]

EVENT_KINDS: frozenset[str] = frozenset(get_args(EventKind))

# shared/src/events.ts :: EVENT_TYPES, read off the generated union rather than
# retyped. A name absent here has no emit site and no listener, so anything
# keyed by event type can check itself against it instead of rotting.
AUDIT_EVENT_TYPES: frozenset[str] = frozenset(
    get_args(member.model_fields["type"].annotation)[0]
    for member in get_args(AuditEvent.model_fields["root"].annotation)
)


def _field_literals(model: type[BaseModel], field: str) -> frozenset[str]:
    """The string members of a generated field's annotation, ``None`` dropped."""
    annotation = model.model_fields[field].annotation
    args = get_args(annotation)
    if any(get_args(arg) for arg in args):  # Literal[...] | None
        return frozenset(member for arg in args for member in get_args(arg))
    return frozenset(args)


for _alias, _model, _field in (
    (EventKind, EvidenceEvent, "kind"),
    (PackageOutcome, AuditSetItem, "outcome"),
    (JobState, AuditSetItem, "jobState"),
    (SetStatus, ScanProgressFrame, "status"),
    (BenchVerdict, BenchEntry, "expectedVerdict"),
    (BenchCorpusSource, BenchCorpus, "source"),
):
    _ours = frozenset(get_args(_alias))
    _theirs = _field_literals(_model, _field)
    assert _ours == _theirs, (
        f"{_alias} drifted from generated {_model.__name__}.{_field}: "
        f"alias-only={sorted(_ours - _theirs)} generated-only={sorted(_theirs - _ours)}"
    )

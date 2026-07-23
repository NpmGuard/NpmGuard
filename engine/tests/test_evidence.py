# CLASS MAP — evidence: canonical JSON, merkle, L4 parse, artifact store, timeline
# (pure functions + a filesystem ArtifactStore under tmp_path)
# Axes: value shape (order/numbers/non-finite), leaf parity, trace framing,
#       artifact integrity (round-trip/tamper/dedupe), timeline sections + collapse
#   C1 canonicalization is recursive and key-order independent
#   C2 number formatting matches ECMAScript JSON.stringify (RFC 8785)
#   C3 non-finite numbers are rejected, never silently encoded
#   C4 odd merkle leaf is duplicated, not dropped
#   C5 L4 parser uses the LAST complete trace and normalizes events
#   C6 seal_run_artifact: contentHash is self-consistent and deterministic
#   C7 ArtifactStore artifact round-trip — write → read equal, verify true
#   C8 tampered artifact file → verify_artifact false (integrity is checked, not trusted)
#   C9 blob write is content-addressed — identical content dedupes to one file
#  C10 render_timeline: sequential ids, node/clock sections, setup header,
#      consecutive-duplicate collapse [xN]
#  C11 render_timeline boundary: zero events → "(no events captured)", empty id set;
#      run error surfaces as a note
#  C12 compute_event_summary buckets hosts / syscalls / files / dns from
#      normalized events
# Adversarial pass: 2026-07-23/W6 — added the artifact-integrity and timeline
# axes (previously only the pure canonicalization half of the module was mapped).
import math

import pytest

from npmguard.contract.models import EvidenceEvent
from npmguard.evidence import (
    ArtifactStore,
    canonicalize,
    compute_event_summary,
    content_hash_of,
    merkle_root,
    parse_l4_trace,
    render_timeline,
    seal_run_artifact,
    sha256_hex,
)


def _artifact_draft(events: list[EvidenceEvent], **changes):
    draft = {
        "runId": "run-1",
        "triggerUsed": {"kind": "entrypoint", "target": "index.js", "argv": [], "stdin": None},
        "setupApplied": {"env": {"NPM_TOKEN": "CANARY"}, "plantFiles": []},
        "observe": {
            "kernel": True,
            "network": True,
            "fsDiff": True,
            "node": True,
            "inspector": True,
        },
        "budget": {"wallMs": 20000},
        "wallMs": 123.0,
        "exitCode": 0,
        "timedOut": False,
        "events": [event.model_dump(mode="json") for event in events],
        "eventSummary": compute_event_summary(events).model_dump(mode="json"),
        "error": None,
        "createdAt": "2026-07-20T00:00:00Z",
    }
    draft.update(changes)
    return draft


def _l4(kind: str, normalized: dict, timestamp: int = 0) -> EvidenceEvent:
    return EvidenceEvent(
        stream="L4:monkey", timestamp=timestamp, pid=0, kind=kind, raw={}, normalized=normalized
    )


def test_canonical_json_is_recursive_and_order_independent() -> None:
    """C1: identical values with different key orders canonicalize identically."""
    left = {"outer": {"z": 1, "a": 2}, "alpha": [3, 1, 2]}
    right = {"alpha": [3, 1, 2], "outer": {"a": 2, "z": 1}}
    assert canonicalize(left) == '{"alpha":[3,1,2],"outer":{"a":2,"z":1}}'
    assert canonicalize(left) == canonicalize(right)
    assert content_hash_of(left) == content_hash_of(right)


def test_canonical_numbers_match_ecmascript_json_stringify() -> None:
    """C2: RFC 8785 number rendering (the sandbox's JS side must agree)."""
    assert canonicalize(1e-7) == "1e-7"
    assert canonicalize(1e-6) == "0.000001"
    assert canonicalize(1e20) == "100000000000000000000"


@pytest.mark.parametrize("number", [math.nan, math.inf, -math.inf])
def test_canonical_json_rejects_non_finite_numbers(number: float) -> None:
    """C3: NaN/Inf raise instead of corrupting a content hash."""
    with pytest.raises(ValueError, match="non-finite"):
        canonicalize(number)


def test_merkle_root_duplicates_an_odd_leaf() -> None:
    """C4: odd leaf counts pair the trailing leaf with itself."""
    leaves = [sha256_hex("a"), sha256_hex("b"), sha256_hex("c")]
    expected = sha256_hex(sha256_hex(leaves[0] + leaves[1]) + sha256_hex(leaves[2] + leaves[2]))
    assert merkle_root(leaves) == expected


def test_l4_parser_uses_last_complete_trace_and_normalizes_events() -> None:
    """C5: broken earlier frames are ignored; the final frame parses and normalizes."""
    stdout = (
        "noise __NPMGUARD_TRACE__broken__NPMGUARD_TRACE_END__ more "
        '__NPMGUARD_TRACE__[{"type":"env","key":"NPM_TOKEN"},'
        '{"type":"network","method":"POST","url":"https://evil.test/x"}]'
        "__NPMGUARD_TRACE_END__ tail"
    )
    events = parse_l4_trace(stdout)
    assert events is not None
    assert [event.kind for event in events] == ["env_access", "network"]
    assert events[1].normalized["url"] == "https://evil.test/x"


def test_seal_run_artifact_hash_is_self_consistent_and_deterministic() -> None:
    """C6: the sealed hash recomputes from the sealed content, and sealing the
    same draft twice yields the same hash."""
    draft = _artifact_draft([_l4("env_access", {"key": "NPM_TOKEN"})])
    sealed = seal_run_artifact(draft)
    value = sealed.model_dump(mode="json", exclude_none=False)
    declared = value.pop("contentHash")
    assert declared == sealed.contentHash
    assert content_hash_of({**value, "contentHash": ""}) == declared
    assert seal_run_artifact(draft).contentHash == declared


def test_artifact_store_round_trip_and_verify(tmp_path) -> None:
    """C7: write_artifact → read_artifact equal content, verify_artifact true."""
    store = ArtifactStore(tmp_path)
    draft = _artifact_draft([_l4("network", {"method": "GET", "url": "https://evil.test/x"})])
    digest = store.write_artifact(draft)
    loaded = store.read_artifact(digest)
    assert loaded.contentHash == digest
    assert loaded.runId == "run-1"
    assert store.verify_artifact(digest)


def test_tampered_artifact_fails_verification(tmp_path) -> None:
    """C8: editing the stored file breaks verify_artifact — hashes are checked."""
    store = ArtifactStore(tmp_path)
    digest = store.write_artifact(_artifact_draft([]))
    path = store.artifacts_dir / f"{digest}.runartifact.json"
    path.write_text(path.read_text(encoding="utf-8").replace('"exitCode":0', '"exitCode":1'))
    assert not store.verify_artifact(digest)


def test_blob_store_is_content_addressed(tmp_path) -> None:
    """C9: identical bytes get one digest and one file; content round-trips."""
    store = ArtifactStore(tmp_path)
    first = store.write_blob("payload", extension="txt")
    second = store.write_blob("payload", extension="txt")
    assert first == second
    assert store.read_blob(first, extension="txt") == b"payload"
    assert len(list(store.artifacts_dir.iterdir())) == 1


def test_render_timeline_sections_ids_and_collapse() -> None:
    """C10: ids run e1..eN across node-then-clock sections; consecutive duplicate
    rows collapse with a [xN] marker; setup header names planted env keys."""
    events = [
        _l4("env_access", {"key": "NPM_TOKEN"}, timestamp=1),
        _l4("env_access", {"key": "NPM_TOKEN"}, timestamp=2),  # collapses into e1 [x2]
        _l4("network", {"method": "GET", "url": "https://evil.test/x"}, timestamp=3),
        EvidenceEvent(
            stream="L1:seccomp",
            timestamp=1_000_000_000,
            pid=7,
            kind="connect",
            raw='connect(7, {sin_port=htons(443)}) = 0',
            normalized={"ret": "0", "addr": "1.2.3.4", "port": 443},
        ),
    ]
    timeline = render_timeline(seal_run_artifact(_artifact_draft(events)))
    assert timeline.ids == {"e1", "e2", "e3"}
    assert "[x2]" in timeline.text  # the two identical env reads collapsed
    assert "NPM_TOKEN" in timeline.text  # node row target
    assert "1.2.3.4:443" in timeline.text  # clock row target
    assert "# setup: env NPM_TOKEN" in timeline.text
    assert "── [L4] node calls" in timeline.text
    assert "── wall-clock t+" in timeline.text


def test_render_timeline_empty_run_and_error_note() -> None:
    """C11: no events → explicit '(no events captured)' + empty citable id set;
    a run error surfaces as a note the judge can read."""
    artifact = seal_run_artifact(
        _artifact_draft([], error={"kind": "CrashError", "detail": "Cannot find module 'x'"})
    )
    timeline = render_timeline(artifact)
    assert timeline.ids == frozenset()
    assert "(no events captured)" in timeline.text
    assert "# note: run error — CrashError: Cannot find module 'x'" in timeline.text


def test_compute_event_summary_buckets_normalized_events() -> None:
    """C12: hosts from network urls + http/tls hosts, files from writes/creates,
    dns queries, and syscall kinds are each collected sorted-unique."""
    events = [
        _l4("network", {"method": "GET", "url": "https://evil.test/x"}),
        EvidenceEvent(
            stream="L2:pcap", timestamp=0, pid=0, kind="http_request",
            raw={}, normalized={"host": "api.evil.test", "method": "POST", "path": "/y"},
        ),
        EvidenceEvent(
            stream="L2:pcap", timestamp=0, pid=0, kind="dns_query",
            raw={}, normalized={"host": "exfil.evil.test"},
        ),
        EvidenceEvent(
            stream="L3:fsDiff", timestamp=0, pid=0, kind="file_created",
            raw="A /pkg/dropped.sh", normalized={"path": "/pkg/dropped.sh"},
        ),
        EvidenceEvent(
            stream="L1:seccomp", timestamp=0, pid=0, kind="connect",
            raw="connect(...)", normalized={"ret": "0"},
        ),
    ]
    summary = compute_event_summary(events)
    assert summary.uniqueHosts == ["api.evil.test", "evil.test"]
    assert summary.dnsQueries == ["exfil.evil.test"]
    assert summary.filesWritten == ["/pkg/dropped.sh"]
    assert summary.uniqueSyscalls == ["connect"]

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
#  C13 a captured request body renders bounded, with its true size, and names the
#      planted env canaries it carries; no body renders no body clause
#  C14 an L1 connect renders the peer host:port it dialled, not "socket"
# C14b …and never a FILE inherited from a recycled fd (xfail PIN — open finding,
#      the fix needs a fixture re-record; see the marker's reason)
#  C15 parse_l4_trace refuses a trace attributing an INSTRUMENT require to the
#      package; a parentless (node-bootstrap) require is named, never dropped
#  C16 a stub whose responseHash is null (nothing served) is named in the setup
#      header; a stub that served changes nothing about the header
#  C17 a setup_bypass event renders WHY the manipulation did not hold
# Adversarial pass: 2026-07-23/W6 — added the artifact-integrity and timeline
# axes (previously only the pure canonicalization half of the module was mapped).
# Evidence-fidelity pass: C13-C15 close the rendering-loss classes that made real
# malware refute — the timeline said less than the run did. The JS half of the
# same axis (what the instrument EMITS) is proven in test_instrumentation_l4.py;
# these classes prove what the renderer does with it.
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
    synthetic_event,
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


def test_captured_body_renders_bounded_and_names_planted_canaries() -> None:
    """C13: the exfil line carries the payload and names which planted env canaries
    are in it — the correlation hyp-0004 refuted for lacking ("the POST request is
    recorded but its payload is not specified"). The displayed body is truncated,
    the true submitted size is stated, and the canary match is computed over the
    whole captured prefix, so a value past the display cut is still named."""
    tail = "z" * 400
    events = [
        _l4(
            "network",
            {
                "method": "POST",
                "url": "http://localhost:9999/exfil",
                "body": '{"pad":"' + tail + '","tok":"npm_12345secrettoken"}',
                "bodyBytes": 4096,
            },
        )
    ]
    draft = _artifact_draft(
        events, setupApplied={"env": {"NPM_TOKEN": "npm_12345secrettoken", "CI": "1"}}
    )
    line = next(
        row for row in render_timeline(seal_run_artifact(draft)).text.splitlines() if " net " in row
    )
    assert "POST http://localhost:9999/exfil" in line
    assert "body[4096b]" in line  # the size the package submitted, not the kept size
    assert tail not in line  # bounded display
    assert "carries planted env NPM_TOKEN" in line  # matched past the display cut
    assert "CI" not in line.split("carries planted env")[1]  # too short to be a canary


def test_a_bodyless_network_event_renders_no_body_clause() -> None:
    """C13: absence of a body is not an empty payload. A GET (and an artifact that
    predates body capture) renders exactly as before, so nothing invites a judge to
    read "no body" as evidence the request was harmless."""
    events = [_l4("network", {"method": "GET", "url": "https://evil.test/x"})]
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    assert "net      GET https://evil.test/x" in text
    assert "body[" not in text
    assert "carries planted env" not in text


def test_connect_renders_the_peer_it_dialled() -> None:
    """C14: a connect whose normalized addr/port survived the strace parse renders
    the peer, not "socket" — the hypothesis-matching detail three judges said was
    missing ("No event matches the suspected endpoint")."""
    events = [
        EvidenceEvent(
            stream="L1:seccomp",
            timestamp=1,
            pid=9,
            kind="connect",
            raw='connect(19, {sa_family=AF_INET, sin_port=htons(9999), sin_addr=inet_addr("127.0.0.1")}, 16) = -1',
            normalized={"ret": "-1", "addr": "127.0.0.1", "port": 9999},
        )
    ]
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    assert "connect  127.0.0.1:9999" in text
    assert "socket" not in text


@pytest.mark.xfail(
    reason="OPEN FINDING: a connect on an fd last bound to a FILE inherits that "
    "file as its peer, so live timelines say 'connect /etc/localtime'. The fd table "
    "already carries the is-socket flag the fix needs, but honouring it re-collapses "
    "rows and shifts 9 of 14 recorded test-pkg-dns-exfil event ids, invalidating that "
    "bundle's judge citations — a re-record is an owner decision. The assertion below "
    "is the CORRECT contract and flips green when the fix lands.",
    strict=True,
)
def test_connect_never_claims_a_file_as_its_peer() -> None:
    """C14b: you cannot connect(2) to a file. An AF_UNIX connect on a recycled fd
    must not inherit the path a previous openat left in the fd table — a false target
    is worse than a vague one, because a judge can cite it."""
    events = [
        EvidenceEvent(
            stream="L1:seccomp",
            timestamp=1,
            pid=9,
            kind="openat",
            raw='openat(AT_FDCWD, "/etc/localtime", O_RDONLY) = 17',
            normalized={"ret": "17", "path": "/etc/localtime"},
        ),
        EvidenceEvent(
            stream="L1:seccomp",
            timestamp=2,
            pid=9,
            kind="connect",
            raw='connect(17, {sa_family=AF_UNIX, sun_path="/var/run/nscd/socket"}, 110) = -1',
            normalized={"ret": "-1", "addr": None, "port": None},
        ),
    ]
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    assert "connect  /etc/localtime" not in text
    assert "connect  socket" in text


def test_parse_l4_trace_refuses_an_instrument_require_attributed_to_the_package() -> None:
    """C15: the instrument's own dependencies must never read as the package's — a
    judge weights child_process as a capability. The ordering that guarantees it
    lives in the instrument; this is the engine-side assertion that a regression
    fails loud (→ DEFER with a located cause) instead of misattributing silently."""
    trace = (
        '__NPMGUARD_TRACE__[{"type":"require","module":"child_process",'
        '"from":"/tmp/_instrument.js"}]__NPMGUARD_TRACE_END__'
    )
    with pytest.raises(AssertionError, match="made by the instrument"):
        parse_l4_trace(trace)


def test_a_parentless_require_is_named_not_dropped() -> None:
    """C15: Node's `-e` bootstrap requires `module` with no parent module on every
    run. It is not the package's, and it is not filtered either — filtering would
    also blind the timeline to an evasive Module._load(name, null)."""
    trace = (
        '__NPMGUARD_TRACE__[{"type":"require","module":"module","from":"<root>"},'
        '{"type":"require","module":"http","from":"/pkg/setup.js"}]__NPMGUARD_TRACE_END__'
    )
    events = parse_l4_trace(trace)
    assert events is not None and len(events) == 2
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    assert "require  module  [no requiring module — node bootstrap, not the package]" in text
    assert "require  http" in text and "bootstrap" not in text.split("require  http")[1]


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


def test_a_stub_that_served_nothing_is_named_in_the_setup_header() -> None:
    """C16: a null responseHash means the proxy never answered that pattern, and the
    timeline says so. Without it a timeline is silent about whether the experiment's
    central manipulation ever fired, which is how a stub that no-opped could still
    read as a clean, complete run."""
    served = _artifact_draft(
        [],
        setupApplied={
            "env": {},
            "stubUrls": [
                {"pattern": "http://localhost:9999/exfil", "responseHash": "deadbeef"},
                {"pattern": "https://evil.example/collect", "responseHash": None},
            ],
        },
    )
    text = render_timeline(seal_run_artifact(served)).text
    assert "stubs never served: https://evil.example/collect" in text
    # the stub that DID answer is not listed as unserved
    assert "localhost:9999" not in text


def test_a_stub_that_served_leaves_the_setup_header_untouched() -> None:
    """C16: every committed artifact predates the ledger and carries a non-null
    (plan) hash, so this branch is the one they take — and it must add nothing, or
    every recorded judge prompt would drift."""
    text = render_timeline(
        seal_run_artifact(
            _artifact_draft(
                [],
                setupApplied={
                    "env": {"NPM_TOKEN": "CANARY"},
                    "stubUrls": [{"pattern": "http://localhost:9999/exfil", "responseHash": "ab"}],
                },
            )
        )
    ).text
    assert "stubs" not in text
    assert text.splitlines()[1] == "# setup: env NPM_TOKEN"


def test_a_setup_bypass_event_renders_its_reason() -> None:
    """C17: a bypass row's whole content is WHY the setup did not hold. Rendering a
    bare "bypass" told the judge that something in the manipulation failed without
    saying what, which is worse than saying nothing at all."""
    events = [synthetic_event("setup_bypass", "stubUrl pattern 'https://x/y' cannot be intercepted")]
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    assert "bypass   stubUrl pattern 'https://x/y' cannot be intercepted" in text

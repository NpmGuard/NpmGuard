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
#      MINTED canary it carries; no body renders no body clause
# C13b a request that coincidentally contains a planted value — the recorded
#      corpus's own `HOME=/home/node` and `MYAPP_DB_HOST=localhost` — is NOT
#      reported as carrying bait, while a minted canary in the same run still is
#  C14 an L1 connect renders the peer host:port it dialled, not "socket"
# C14b …and never a FILE inherited from a recycled fd; a named AF_UNIX peer
#      renders as the socket path it actually dialled
# C14c a syscall's RESULT is rendered, so `= 0`, `= -1 EINPROGRESS` (a non-blocking
#      connect that SUCCEEDED) and `= -1 ECONNREFUSED` are three distinguishable
#      rows that _collapse does not merge
# C14d a recvfrom names the peer it read FROM, and a failed socket read says so
# C14e a legacy artifact's `-1` with no recorded errno states its own coverage
#      instead of claiming a failure it cannot support
#  C15 parse_l4_trace refuses a trace attributing an INSTRUMENT require to the
#      package; a parentless (node-bootstrap) require is named, never dropped
#  C16 a stub whose responseHash is null (nothing served) is named in the setup
#      header; a stub that served changes nothing about the header
#  C17 a setup_bypass event renders WHY the manipulation did not hold
#  C18 a sealed artifact carries no field asserting a bound or a hash the run did
#      not produce (xfail PIN — deleting a sealed field rehashes every recorded
#      artifact; see the marker's reason)
# Adversarial pass: 2026-07-23/W6 — added the artifact-integrity and timeline
# axes (previously only the pure canonicalization half of the module was mapped).
# Evidence-fidelity pass: C13-C15 close the rendering-loss classes that made real
# malware refute — the timeline said less than the run did. The JS half of the
# same axis (what the instrument EMITS) is proven in test_instrumentation_l4.py;
# these classes prove what the renderer does with it.
# Manufactured-evidence pass: 2026-07-25 — the missing dimension was the
# NEGATIVE direction of C13. Every canary class asserted that a real exfil is
# named; none asserted that an ordinary string is not, and under a length floor
# two values the recorded corpus actually plants (`/home/node`, `localhost`)
# manufactured a citation for a benign request. C13b is that axis.
# Parser-input pass: 2026-07-25 — C10/C14/C14b's strace `raw` values were written
# by hand (two real forms with the errno stripped, one with no sa_family at all,
# one plausible and unverified). They now come from committed captures through
# the real `parse_strace_log`, so the sensor→renderer seam is closed end to end
# and the shapes are the producer's rather than ours.
import math
from pathlib import Path

import pytest

from npmguard.contract.models import EvidenceEvent, RunArtifact
from npmguard.evidence import (
    CANARY_PATTERN,
    ArtifactStore,
    canonicalize,
    compute_event_summary,
    content_hash_of,
    merkle_root,
    mint_canary,
    parse_l4_trace,
    render_timeline,
    seal_run_artifact,
    sha256_hex,
    synthetic_event,
)
from npmguard.sensors import parse_strace_log

SENSOR_FIXTURES = Path(__file__).parent / "fixtures" / "sensors"
# One second before the first line of each capture, so relative stamps stay positive.
CONNECT_LOG, CONNECT_RUN_START = "strace-connect-results.log", 1784984047.0
NODE_LOG, NODE_RUN_START = "strace-node.log", 1784974617.0
# The instrument keeps min(_BODY_CAP, total) bytes of a request body
# (assets/instrumentation-monkey.js), so a body whose true size exceeds the cap is
# captured at EXACTLY this length. A test asserting any other pair asserts a shape
# the producer cannot emit.
BODY_CAP = 2048


def _captured_l1(filename: str, *needles: str, run_start: float) -> list[EvidenceEvent]:
    """Real captured strace lines, parsed by the real sensor.

    The renderer consumes whatever `parse_strace_log` produces, so driving these
    classes through it closes the seam: a rendering test cannot pass against a
    normalized shape the parser never emits. Every literal below is a needle into a
    committed capture (`tests/fixtures/sensors/`, provenance in `PROVENANCE.json`) —
    never a line this file invented, which is how `sin_addr="1.2.3.4"` kept a dead
    regex green for the life of `sensors.py`.
    """
    lines = [
        line
        for line in SENSOR_FIXTURES.joinpath(filename)
        .read_text(errors="surrogateescape")
        .splitlines()
        if any(needle in line for needle in needles)
    ]
    assert len(lines) == len(needles), f"{needles} selected {len(lines)} captured lines"
    return parse_strace_log("\n".join(lines), run_start)


def _row(text: str, *needles: str) -> str:
    """The single rendered row containing every needle."""
    hits = [line for line in text.splitlines() if all(needle in line for needle in needles)]
    assert len(hits) == 1, f"{needles} matched {len(hits)} rendered rows:\n{text}"
    return hits[0]


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
        *_captured_l1(CONNECT_LOG, "ECONNREFUSED", run_start=CONNECT_RUN_START),
    ]
    timeline = render_timeline(seal_run_artifact(_artifact_draft(events)))
    assert timeline.ids == {"e1", "e2", "e3"}
    assert "[x2]" in timeline.text  # the two identical env reads collapsed
    assert "NPM_TOKEN" in timeline.text  # node row target
    assert "127.0.0.1:9999" in timeline.text  # clock row target: the captured peer
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


def test_captured_body_renders_bounded_and_names_the_minted_canary() -> None:
    """C13: the exfil line carries the payload and names which planted canary it
    carries — the correlation hyp-0004 refuted for lacking ("the POST request is
    recorded but its payload is not specified"). The displayed body is truncated, the
    true submitted size is stated, and the match runs over the whole captured prefix,
    so a canary past the display cut is still named. The planted value keeps a
    realistic `npm_` shape and the match is on the minted token alone."""
    canary = mint_canary()
    planted = f"npm_{canary}"
    # A body whose true size exceeds the instrument's cap is captured at exactly the
    # cap — the pair (len(body), bodyBytes) is not free (see BODY_CAP).
    head, tail = '{"pad":"', f'","tok":"{planted}"}}'
    body = head + "z" * (BODY_CAP - len(head) - len(tail)) + tail
    assert len(body) == BODY_CAP
    events = [
        _l4(
            "network",
            {
                "method": "POST",
                "url": "http://localhost:9999/exfil",
                "body": body,
                "bodyBytes": 4096,
            },
        )
    ]
    draft = _artifact_draft(events, setupApplied={"env": {"NPM_TOKEN": planted, "CI": "1"}})
    line = _row(render_timeline(seal_run_artifact(draft)).text, " net ")
    assert "POST http://localhost:9999/exfil" in line
    assert "body[4096b]" in line  # the size the package submitted, not the kept size
    assert body not in line and "…" in line  # bounded display, visibly cut
    assert planted not in line  # the canary itself is past the cut
    assert "carries planted env NPM_TOKEN" in line  # matched past the display cut
    assert "CI" not in line.split("carries planted env")[1]  # not minted, so not bait


def test_a_coincidental_planted_value_is_never_reported_as_carried_bait() -> None:
    """C13b: bait is what the engine MINTED, not what the model happened to plant.
    Both env values here are real, copied from the recorded corpus's own experiments,
    and under the old 8-character length floor both manufactured a citation: a benign
    crash report whose stack trace contains `/home/node` "carried planted env HOME",
    and a GET with no body at all "carried planted env MYAPP_DB_HOST" because
    `localhost` occurs in its own URL. That clause is written to be cited, one CONFIRM
    is DANGEROUS, and DANGEROUS blocks an install — so the negative direction is the
    expensive one. Paired with the positive probe in the same run, because "no clause"
    must not be provable by breaking the clause."""
    canary = mint_canary()
    crash = '{"stack":"Error: ENOENT at /home/node/app/index.js:3:11"}'
    exfil = f'{{"tok":"{canary}"}}'
    events = [
        _l4("network", {"method": "POST", "url": "https://sentry.example.com/api/store",
                        "body": crash, "bodyBytes": len(crash)}, timestamp=0),
        _l4("network", {"method": "GET", "url": "http://localhost:9999/health",
                        "body": "", "bodyBytes": 0}, timestamp=1),
        _l4("network", {"method": "POST", "url": "https://evil.test/collect",
                        "body": exfil, "bodyBytes": len(exfil)}, timestamp=2),
    ]
    draft = _artifact_draft(
        events,
        setupApplied={
            "env": {"HOME": "/home/node", "MYAPP_DB_HOST": "localhost", "NPM_TOKEN": canary}
        },
    )
    text = render_timeline(seal_run_artifact(draft)).text
    carried = [row for row in text.splitlines() if "carries planted env" in row]
    assert len(carried) == 1, f"exactly one request carried the canary:\n{text}"
    assert "evil.test/collect" in carried[0]
    assert carried[0].split("carries planted env")[1].split() == ["NPM_TOKEN"]


def test_a_minted_canary_is_unguessable_and_recognisable() -> None:
    """C13b: the two properties the clause's soundness rests on — a fresh 128-bit
    token every call (so no coincidental preimage exists inside the container), and a
    format the renderer recognises (so a value the engine did not mint cannot enter
    the bait set). Length was neither."""
    tokens = {mint_canary() for _ in range(64)}
    assert len(tokens) == 64
    for token in tokens:
        assert CANARY_PATTERN.fullmatch(token)
    for ordinary in ("/home/node", "localhost", "npm_12345secrettoken", "AKIA123456789", "1"):
        assert not CANARY_PATTERN.search(ordinary)


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
    """C14: a connect whose peer survived the strace parse renders that peer, not
    "socket" — the hypothesis-matching detail three judges said was missing ("No event
    matches the suspected endpoint")."""
    events = _captured_l1(CONNECT_LOG, "EINPROGRESS", run_start=CONNECT_RUN_START)
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    assert "connect  127.0.0.1:9999" in text
    assert "socket" not in text


def test_connect_never_claims_a_file_as_its_peer() -> None:
    """C14b: you cannot connect(2) to a file. In this captured pair a descriptor is
    recycled from a FILE to a unix socket — python opens /etc/localtime as fd 3,
    closes it, and the AF_UNIX socket it then creates gets fd 3 back — so ignoring the
    fd table's is-socket flag rendered "connect /etc/localtime". A false target is
    worse than a vague one, because a judge can cite it. The peer strace printed is
    the sun_path, so the row names the socket it actually dialled."""
    events = _captured_l1(CONNECT_LOG, "AT_FDCWD", "sun_path=", run_start=CONNECT_RUN_START)
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    assert "open     /etc/localtime" in text  # the file is still rendered as a file
    assert "connect  /etc/localtime" not in text
    assert "connect  /var/run/nscd/socket" in text


def test_the_three_connect_outcomes_are_distinguishable_and_do_not_collapse() -> None:
    """C14c: three captured connects to the SAME peer, in one capture, with the three
    results that matter: `= 0`, `= -1 EINPROGRESS` (a non-blocking connect the kernel
    ACCEPTED — it succeeded) and `= -1 ECONNREFUSED`. Without the result rendered they
    are one row, `connect 127.0.0.1:9999 [x3]`, because the result is not in the
    collapse key — so an established exfiltration channel and a refused one were the
    same evidence, and 113 of the 157 connects in the committed corpus are `-1`."""
    events = _captured_l1(
        CONNECT_LOG, "= 0", "EINPROGRESS", "ECONNREFUSED", run_start=CONNECT_RUN_START
    )
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    rows = [row for row in text.splitlines() if "connect" in row]
    assert len(rows) == 3, f"the three outcomes must not merge:\n{text}"
    assert "[x3]" not in text
    assert "[connected]" in rows[0]
    assert "EINPROGRESS" in rows[1] and "SUCCEEDED" in rows[1]
    assert "[failed: ECONNREFUSED]" in rows[2]


def test_a_recvfrom_names_its_peer_and_a_failed_socket_read_says_so() -> None:
    """C14d: a `recvfrom` carries the peer it read FROM in its own sockaddr, which for
    an unconnected socket is the only place that peer appears — 221 of them sit in the
    committed corpus recoverable from nothing else. The EAGAIN line from the same
    capture is the negative half: a socket read that returned nothing must not render
    as one that returned data."""
    events = _captured_l1(NODE_LOG, "127.0.0.53", "EAGAIN", run_start=NODE_RUN_START)
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    assert "read     127.0.0.53:53" in _row(text, "127.0.0.53")
    assert "[failed: EAGAIN]" in _row(text, "EAGAIN")


def test_a_legacy_recorded_minus_one_states_its_own_coverage() -> None:
    """C14e: the 31 committed runartifacts were sealed before the parser kept the
    errno beside a `-1`, so their connects record `ret: "-1"` and nothing else. Both a
    refusal and an async success land there, so the row states the gap rather than
    asserting a failure the artifact cannot support. This class inverts when that
    bundle is re-recorded: the errno will be present and the rows become
    `[failed: …]`/`[in progress: …]`."""
    path = (
        Path(__file__).parent
        / "fixtures/llm/test-pkg-env-exfil@2.0.1/sandbox/hyp-0009.runartifact.json"
    )
    artifact = RunArtifact.model_validate_json(path.read_text())
    assert not any(
        "error" in (event.normalized or {}) for event in artifact.events
    ), "this artifact predates errno capture — that is what the class is about"
    rows = [row for row in render_timeline(artifact).text.splitlines() if "connect " in row]
    assert any("[-1, errno not recorded — refused or async in progress]" in row for row in rows)
    # Nothing in this artifact may be reported as a failure: no errno was recorded, and
    # EINPROGRESS — a SUCCESS — is in the same `-1` bucket as ECONNREFUSED.
    assert "[failed:" not in "\n".join(rows)


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


@pytest.mark.xfail(
    reason="OPEN FINDING: `inspectorLogHash` is null in every artifact ever sealed and "
    "is structurally unfillable (the inspector's output is merged into the same stdout "
    "blob `stdoutHash` already covers), and `Budget.maxSyscalls`/`maxBytesCapture` are "
    "read by nothing while the caps that exist are unrelated (docker_exec 10MiB, "
    "deps._stream_tar 256MiB) — so a sealed artifact asserts a capture bound the run "
    "never applied. Deleting them is the fix and it is written up at "
    "shared/src/evidence.ts. The blocker is not the code: REMOVING a sealed field "
    "changes the canonical form, hence the contentHash, of every artifact ever sealed, "
    "and the orchestrator cross-checks that hash against an independent recomputation "
    "(step D) — so all 31 committed runartifacts fail it and three slice replays go "
    "red. The migration is free and mechanical rather than a paid re-record (re-seal "
    "each fixtures/llm/*/sandbox/*.runartifact.json under the new schema, update its "
    "sha256 in the bundle manifest), but editing recorded fixtures is an owner "
    "decision. The assertion below is the CORRECT contract.",
    strict=True,
)
def test_a_sealed_artifact_asserts_no_bound_or_hash_the_run_did_not_produce() -> None:
    """C18: every field of a sealed artifact is a statement about the run, so a field
    the run cannot fill is false evidence — the same class as a `responseHash` for a
    response no stub served. Asserted on the sealed value rather than the draft,
    because the sealed value is what the judge and the store see."""
    sealed = seal_run_artifact(
        _artifact_draft([], budget={"wallMs": 20000, "maxSyscalls": None, "maxBytesCapture": 1e6})
    ).model_dump(mode="json", exclude_none=False)
    assert "inspectorLogHash" not in sealed
    assert set(sealed["budget"]) == {"wallMs"}


def test_a_setup_bypass_event_renders_its_reason() -> None:
    """C17: a bypass row's whole content is WHY the setup did not hold. Rendering a
    bare "bypass" told the judge that something in the manipulation failed without
    saying what, which is worse than saying nothing at all."""
    events = [synthetic_event("setup_bypass", "stubUrl pattern 'https://x/y' cannot be intercepted")]
    text = render_timeline(seal_run_artifact(_artifact_draft(events))).text
    assert "bypass   stubUrl pattern 'https://x/y' cannot be intercepted" in text

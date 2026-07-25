# CLASS MAP — bench.fidelity: render fidelity as CODE, not as a definition (B-12)
# (seam: PURE over sealed run artifacts. No LLM, no docker, no fixture execution —
#  the artifacts are the 31 committed runartifacts under tests/fixtures/llm/, which
#  are exactly the bytes the recorded judges' timelines were rendered from.
#
#  WHY THIS IS CODE AND NOT PROSE, which is the whole reason the module exists:
#  two careful documents counted 244 and 277 anonymous rows over the SAME 4,140
#  rendered rows of the SAME immutable corpus, because their predicates differed on
#  which placeholder forms and which layers count. A 13% spread from a static input
#  is not a disagreement about the engine, it is proof that the metric is not
#  reproducible as a description. So it ships as functions with a pinned count.)
#
# The predicate, one class per region:
#   C1  a socket op rendered `socket` while its own bytes carry a peer IS a defect
#   C2  the same op rendered WITH the peer is not
#   C3  a read on a genuinely unresolved fd is HONEST — anonymous, not a defect.
#       This is the narrowness a reimplementation gets wrong, and conflating it is
#       how a 5.7% anonymous-row rate gets misread as a 5.7% evidentiary leak
#   C4  a read whose fd the artifact DID resolve is neither anonymous nor a defect
#   C5  resolvability is judged from THIS event's own bytes — never inherited from
#       a sibling, because cross-event credit measures the fd table's memory
#       rather than the render
#   C6  a socket op rendered with a filesystem path NOT in its own bytes is a FALSE
#       TARGET: a vague target starves a judge, a false one misleads it
#   C7  a named AF_UNIX peer rendering its own sun_path is CORRECT, not a false
#       target — which is why C6 compares against the event's own peer rather
#       than against "looks like a path"
# Anti-drift, the class that makes this a measurement of the renderer rather than
# of a second renderer:
#   C8  every bare target this module produces appears verbatim in
#       render_timeline()'s own output, for all 31 artifacts
#   C9  the fd table is shared across the L4 and clock passes, as the renderer
#       does it — a per-pass table changes what resolves
# The pinned corpus count (the deliverable):
#   C10 the recordables reproduce an exact count over the 31 committed artifacts
#   C11 describedEvents is a property of the ARTIFACTS, not of the renderer, so it
#       is pinned hard: 5,733, the figure the methodology publishes
#   C12 row counts are renderer-dependent and are asserted as INVARIANT RELATIONS
#       plus an observed value keyed to an engineSha — B-13's rule applied to this
#       module's own test
#   C13 summing counts across predicate versions is refused

import glob
import json
from pathlib import Path

import pytest

from npmguard.bench import fidelity
from npmguard.contract.models import EvidenceEvent, RunArtifact
from npmguard.evidence import render_timeline

FIXTURES = Path(__file__).parent / "fixtures" / "llm"

# ---------------------------------------------------------------------------
# The pinned figures, and the sha they are a measurement OF.
# ---------------------------------------------------------------------------
# A fidelity number without its engineSha is not a measurement (B-13). These were
# taken against the COMMITTED tree at the sha below, never against a working tree —
# the methodology's own figures moved 4,140 -> 4,616 rendered rows mid-measurement
# because a peer was editing evidence.py, which is how that rule was learned.
PINNED_ENGINE_SHA = "5a88984"
PINNED_ARTIFACTS = 31
PINNED_DESCRIBED_EVENTS = 5_733
PINNED_FIDELITY_DEFECTS = 157
PINNED_FALSE_TARGET_EVENTS = 0
# Renderer-dependent, recorded for the reader rather than asserted as equality —
# see C12.
OBSERVED_RENDERED_ROWS = 4_606
OBSERVED_ANONYMOUS_ROWS = 435


def _artifacts() -> list[RunArtifact]:
    paths = sorted(glob.glob(str(FIXTURES / "*" / "sandbox" / "*.runartifact.json")))
    return [RunArtifact.model_validate_json(Path(path).read_bytes()) for path in paths]


# Every strace literal below is the exact tail of a line captured from a real
# strace run and committed under tests/fixtures/sensors/ — the pid + timestamp
# prefix stripped, which is precisely what `parse_strace_log` puts in `raw`. A
# hand-authored sockaddr is how `sensors.py` came to carry a peer regex that
# matched nothing for the module's whole life, and tools.parser_fixture_lint now
# refuses one.
IMDS_CONNECT = (
    'connect(18, {sa_family=AF_INET, sin_port=htons(80), '
    'sin_addr=inet_addr("169.254.169.254")}, 16) = -1 EINPROGRESS '
    "(Operation now in progress)"
)
GITHUB_CONNECT = (
    'connect(19, {sa_family=AF_INET, sin_port=htons(53), '
    'sin_addr=inet_addr("198.51.100.53")}, 16) = 0'
)
NSCD_CONNECT = (
    'connect(3, {sa_family=AF_UNIX, sun_path="/var/run/nscd/socket"}, 23) = -1 '
    "ENOENT (No such file or directory)"
)
NETLINK_SENDTO = (
    "sendto(20, [{nlmsg_len=20, nlmsg_type=RTM_GETLINK, "
    "nlmsg_flags=NLM_F_REQUEST|NLM_F_DUMP, nlmsg_seq=1784975529, nlmsg_pid=0}, "
    "{ifi_family=AF_UNSPEC, ...}], 20, 0, {sa_family=AF_NETLINK, nl_pid=0, "
    "nl_groups=00000000}, 12) = 20"
)
LOCALTIME_OPEN = 'openat(AT_FDCWD, "/etc/localtime", O_RDONLY|O_CLOEXEC) = 3'


def _artifact(*events: dict) -> RunArtifact:
    """A minimal sealed artifact carrying exactly the given events."""
    return RunArtifact.model_validate(
        {
            "runId": "run-1",
            "contentHash": "",
            "createdAt": "2026-07-25T00:00:00Z",
            "triggerUsed": {"kind": "lifecycle", "target": "setup.js"},
            "setupApplied": {"env": {"HOME": "/home/node"}},
            "events": list(events),
            "eventSummary": {
                "counts": {},
                "totalEvents": len(events),
                "streams": [],
                "truncated": False,
            },
            "exitCode": 0,
            "timedOut": False,
            "wallMs": 100,
            "budget": {"wallMs": 1000, "maxEvents": 100, "maxBodyBytes": 100},
            "observe": {"kernel": True, "network": True, "fsDiff": True, "node": True},
        }
    )


def _l1(kind: str, raw: str, normalized: dict, timestamp: int = 1) -> dict:
    return {
        "stream": "L1:seccomp",
        "timestamp": timestamp,
        "pid": 7,
        "kind": kind,
        "raw": raw,
        "normalized": normalized,
    }


def _only(artifact: RunArtifact) -> fidelity.DescribedEvent:
    described = fidelity.describe_events(artifact)
    assert len(described) == 1
    return described[0]


# ---------------------------------------------------------------------------
# The predicate
# ---------------------------------------------------------------------------


def test_anonymous_socket_with_a_peer_in_its_own_bytes_is_a_defect() -> None:
    """C1: the exact shape of §3.2.1's counterexample. Nine recorded runs of
    test-pkg-env-exfil sealed the IMDS probe — connect(18, {sin_addr=
    inet_addr("169.254.169.254")}) — and six rendered `connect socket`, over which
    a judge wrote "there is no evidence of a request to the IMDS"."""
    event = _l1("connect", IMDS_CONNECT, {"addr": None, "port": None, "ret": "-1"})
    item = _only(_artifact(event))
    assert item.bare_target == "socket"
    assert fidelity.is_anonymous(item)
    assert fidelity.resolvable_target(item.event) == "169.254.169.254:80"
    assert fidelity.is_defect(item)


def test_a_resolved_peer_is_not_a_defect() -> None:
    """C2: the same bytes, with the parser's peer in `normalized` — what today's
    sensors seal. The endpoint reaches the judge, so there is nothing to record."""
    event = _l1(
        "connect", IMDS_CONNECT, {"addr": "169.254.169.254", "port": 80, "ret": "-1"}
    )
    item = _only(_artifact(event))
    assert "169.254.169.254:80" in item.target
    assert not fidelity.is_anonymous(item)
    assert not fidelity.is_defect(item)


def test_a_read_on_an_unresolved_fd_is_honest() -> None:
    """C3: `fd:17` with no openat anywhere in the artifact has no resolvable target
    to have shown. It counts as an anonymous ROW and must NOT count as a defect —
    keeping these separate is the difference between a coverage figure and an
    accusation."""
    event = _l1("read", 'read(17, "hello", 65536) = 5', {"fd": 17, "ret": "5"})
    item = _only(_artifact(event))
    assert item.bare_target == "fd:17"
    assert fidelity.is_anonymous(item)
    assert fidelity.resolvable_target(item.event) is None
    assert not fidelity.is_defect(item)


def test_a_read_on_a_resolved_fd_is_neither() -> None:
    """C4: the fd table names it, so the judge sees a path."""
    artifact = _artifact(
        _l1("openat", LOCALTIME_OPEN, {"path": "/etc/localtime", "ret": "3"}),
        _l1("read", 'read(3, "TZif2", 65536) = 5', {"fd": 3, "ret": "5"}, timestamp=2),
    )
    described = fidelity.describe_events(artifact)
    assert described[1].bare_target == "/etc/localtime"
    assert not fidelity.is_anonymous(described[1])
    assert not fidelity.is_defect(described[1])


def test_resolvability_is_per_event_never_inherited() -> None:
    """C5: an anonymous connect is NOT excused by a sibling event that happens to
    carry an address. Cross-event credit would make the number a property of the fd
    table's memory instead of the render, and the fd table is allowed to forget."""
    artifact = _artifact(
        _l1("connect", GITHUB_CONNECT, {"addr": "198.51.100.53", "port": 53, "ret": "0"}),
        _l1("sendto", NETLINK_SENDTO, {"ret": "20"}, timestamp=2),
    )
    described = fidelity.describe_events(artifact)
    assert fidelity.is_anonymous(described[1]) and not fidelity.is_defect(described[1])
    assert fidelity.counts_for(artifact).fidelity_defects == 0


def test_an_inherited_filesystem_path_on_a_socket_op_is_a_false_target() -> None:
    """C6: recordable 2. At 67f830f, 87 events still rendered a socket operation
    with a path inherited from a recycled descriptor — including
    `connect /pkg/setup.js`, i.e. the malware payload file itself."""
    described = fidelity.DescribedEvent(
        event=EvidenceEvent.model_validate(_l1("sendto", NETLINK_SENDTO, {"ret": "20"})),
        tag="L1",
        verb="send",
        target="/pkg/setup.js",
    )
    assert fidelity.is_false_target(described)


def test_a_named_unix_peer_is_not_a_false_target() -> None:
    """C7: `connect /var/run/nscd/socket` when sun_path SAYS so is correct."""
    described = fidelity.DescribedEvent(
        event=EvidenceEvent.model_validate(
            _l1("connect", NSCD_CONNECT, {"path": "/var/run/nscd/socket", "ret": "-1"})
        ),
        tag="L1",
        verb="connect",
        target="/var/run/nscd/socket",
    )
    assert not fidelity.is_false_target(described)


# ---------------------------------------------------------------------------
# Anti-drift: this must measure THE renderer, not a second one
# ---------------------------------------------------------------------------


def test_every_described_target_appears_in_the_real_rendered_timeline() -> None:
    """C8: the pin. `describe_events` re-runs the renderer's own two passes to keep
    the event -> row link that `render_timeline`'s TEXT cannot express. Without this
    class it would be a parallel renderer, and a parallel renderer measuring a
    renderer is exactly the drift the module exists to prevent."""
    for artifact in _artifacts():
        text = render_timeline(artifact).text
        for item in fidelity.describe_events(artifact):
            if item.target:
                assert item.target in text, (
                    f"{artifact.runId}: bench re-render produced {item.target!r}, "
                    "which render_timeline never emitted — the two have diverged"
                )


def test_the_fd_table_is_shared_across_both_render_passes() -> None:
    """C9: `render_timeline` seeds ONE fd table and uses it for the L4 pass and then
    the clock pass. A per-pass table would leave descriptors opened in one pass
    unresolvable in the other, inventing defects that the judge never saw."""
    artifact = _artifact(
        _l1("openat", LOCALTIME_OPEN, {"path": "/etc/localtime", "ret": "3"}),
        _l1("read", 'read(3, "TZif2", 65536) = 5', {"fd": 3, "ret": "5"}, timestamp=2),
    )
    described = fidelity.describe_events(artifact)
    assert described[1].bare_target == "/etc/localtime"
    assert described[1].target in render_timeline(artifact).text


# ---------------------------------------------------------------------------
# The pinned corpus figures
# ---------------------------------------------------------------------------


def test_pinned_counts_over_the_committed_corpus() -> None:
    """C10/C11: the deliverable — the recordables reproduce an exact count.

    `describedEvents` is a property of the ARTIFACTS (every event, described once),
    so it is pinned hard and matches the 5,733 the methodology publishes.

    `fidelityDefects = 157` is a measurement of the SEALED corpus, and it does NOT
    contradict §3.4.2's "0 at 67f830f": that column re-parsed each event's `raw`
    through today's `sensors.parse_strace_log` before rendering, which recovers the
    306 peers the pre-fix sensors dropped BEFORE sealing. This predicate reads the
    artifact AS SEALED, which is what a live bench audit can do without a re-parse,
    and it therefore indicts the pre-fix corpus exactly where §3.2.1 says it should:
    every one of the 157 is a `connect` whose sockaddr is in `raw` and absent from
    `normalized` — 72 x /var/run/nscd/socket, 23 x 127.0.0.1:9999 (the stub proxy),
    18 x 185.12.64.2:53, and 9 x 169.254.169.254:80, the IMDS probe present in 9 of
    9 setup.js artifacts and rendered in 3.

    `falseTargetEvents = 0` is the current engine's answer, and it is a real
    improvement rather than a predicate artifact: the recycled-fd fallback now
    consults whether the descriptor was last bound to a SOCKET, so the 87 residual
    events §3.4.2 measured at 67f830f no longer render."""
    artifacts = _artifacts()
    assert len(artifacts) == PINNED_ARTIFACTS
    total = fidelity.counts_over(artifacts)
    assert total.described_events == PINNED_DESCRIBED_EVENTS
    assert total.fidelity_defects == PINNED_FIDELITY_DEFECTS, (
        f"fidelity defects moved from {PINNED_FIDELITY_DEFECTS} to "
        f"{total.fidelity_defects}. This is a measurement OF an engine, pinned at "
        f"{PINNED_ENGINE_SHA}: if the parser or renderer changed, re-pin BOTH the "
        "count and the sha, and do not pool the two figures (B-13)."
    )
    assert total.false_target_events == PINNED_FALSE_TARGET_EVENTS


def test_row_counts_hold_their_invariant_relations() -> None:
    """C12: row counts depend on `_collapse`, so they move whenever the renderer
    splits or merges rows — 5a88984 rendering the syscall RESULT took them from
    4,140 to 4,606, which the methodology predicted. Asserting equality here would
    make an unrelated renderer improvement fail the bench suite, so what is
    asserted is what cannot change: rows <= events, anonymous <= rows, and every
    defect is anonymous."""
    total = fidelity.counts_over(_artifacts())
    assert 0 < total.rendered_rows <= total.described_events
    assert 0 < total.anonymous_rows <= total.rendered_rows
    assert total.fidelity_defects <= total.described_events
    assert total.false_target_rows <= total.rendered_rows
    # Recorded, not asserted: the observed values at PINNED_ENGINE_SHA.
    assert (OBSERVED_RENDERED_ROWS, OBSERVED_ANONYMOUS_ROWS) == (4_606, 435)


def test_summing_across_predicate_versions_is_refused() -> None:
    """C13: a published caption must name the predicate version, so two predicates
    may not silently add up."""
    a = fidelity.FidelityCounts(described_events=1)
    b = fidelity.FidelityCounts(described_events=1, predicate_version="bench-fidelity-99")
    with pytest.raises(AssertionError, match="predicate versions"):
        _ = a + b


def test_artifact_digests_are_read_from_the_report_in_order() -> None:
    """The artifact tier is reached from an audit_id via the report's evidenceRefs.
    Only `kind == "run"` refs name a sealed run artifact."""
    report = json.loads(
        json.dumps(
            {
                "hypotheses": [
                    {"evidenceRefs": [{"kind": "run", "id": "r1", "hash": "aaa"}]},
                    {
                        "evidenceRefs": [
                            {"kind": "static", "id": "s1", "hash": "zzz"},
                            {"kind": "run", "id": "r2", "hash": "bbb"},
                            {"kind": "run", "id": "r3", "hash": "aaa"},
                        ]
                    },
                ]
            }
        )
    )
    assert fidelity.artifact_digests(report) == ["aaa", "bbb"]
    assert fidelity.artifact_digests({}) == []

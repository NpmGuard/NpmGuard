# CLASS MAP — sensor parsers + pcap lifecycle barriers (the pure parsing halves of
# the L1/L2/L3 sensors; snapshot docker execs are docker-tier, and the pcap barrier
# logic is unit-tested here against a stubbed docker_exec and live at e2e).
#
# PARSER INPUT RULE (TESTING.md, "Parsers of external formats"): strace, tshark and
# find are external producers, so every input comes from tests/fixtures/sensors/ —
# output captured from the real producer and committed, its command line recorded in
# PROVENANCE.json. Nothing here asserts a line shape we invented. That is the whole
# point of the file: every parser class was once covered with input we wrote
# ourselves, and it hid four live defects at once — dropped split syscalls, a dropped
# errno, dropped mdns/llmnr packets, and dropped tab/newline paths.
#
# Axes: strace line format variants × line completeness (whole / split across
#       unfinished+resumed / status line) × syscall normalization × sockaddr family
#       (INET, INET6, UNIX, NETLINK, absent) × result (success, errno), snapshot
#       record shape, fs-diff event polarity, tshark layer naming + filter/extraction
#       agreement, pcap readiness/flush marker outcomes
#
# Measurements the invariants rest on, none of them visible at their assertion:
#  - An AF_INET/AF_INET6 sockaddr with no extractable addr:port is a PARSER DEFECT,
#    so it asserts rather than returning a value. That is the state the dead
#    sin_addr="…" regex produced on every inet connect ever captured. The formatter
#    call in that regex is MANDATORY: measured on strace 6.1 and 7.0, no flag
#    combination (-y, -yy, -v, -e abbrev=none) emits a bare sin_addr="…" — -y/-yy
#    annotate the file DESCRIPTOR and leave the sockaddr untouched.
#  - Every packet the -Y filter admitted must yield an event. Six of thirteen real
#    packets yield none, silently and indistinguishably from no traffic, when the
#    fields are looked up under hardcoded layer names — mdns, llmnr and ssdp all
#    carry them too. The filter and the extraction share one list.
#  - Unreadable tshark stdout RAISES, because tshark prints "[]" for zero packets: a
#    capture we cannot parse is missing evidence, not absent traffic.
#  - An over-cap transfer of a WHOLE capture is UNREPRESENTABLE, not merely loud.
#    PCAP_FILE lives on the /tmp tmpfs, whose size the transfer cap dominates, and
#    the transfer is raw. `base64 -w0`'s 4/3 inflation was the last way a complete
#    capture could pass the cap — 13 MB arriving as a sealed 7.5 MiB pcapHash.
#    Measured at the boundary in e2e/test_pcap_transfer.py.
#  - An absent peer address must be READABLE rather than ambiguous, so `family`
#    separates an AF_UNIX path peer, an AF_NETLINK peer, an unnamed AF_UNIX peer and
#    a genuinely NULL sockaddr from one another — and from a parse failure. `addr:
#    null` read as "no address available" and meant "the regex is wrong".
#  - SYSCALL_KIND is total over TRACED_SYSCALLS: an unmapped syscall raises rather
#    than defaulting to a fabricated 'openat'.
import json
import re
from pathlib import Path

import pytest

from npmguard import sensors
from npmguard.contract.models import EvidenceEvent
from npmguard.docker import MAX_EXEC_OUTPUT_BYTES, TMPFS_TMP, ExecResult
from npmguard.sensors import (
    PCAP_FIELDS,
    PCAP_FILTER,
    SYSCALL_KIND,
    TRACED_SYSCALLS,
    diff_snapshots,
    parse_snapshot,
    parse_strace_line,
    parse_strace_log,
    parse_tshark_json,
    wrap_with_strace,
)
from tests.support.optional import present

FIXTURES = Path(__file__).parent / "fixtures" / "sensors"
# The run start used throughout: one second before the container capture's first
# line, so relative timestamps stay positive and readable.
RUN_START = 1784975284.0


def _strace_log() -> str:
    return FIXTURES.joinpath("strace-node.log").read_text(errors="surrogateescape")


def _events_by_raw(log: str | None = None) -> dict[str, EvidenceEvent]:
    """Parsed events keyed by the leading `syscall(firstarg` of their raw line, so
    a test can name the captured line it is asserting about."""
    return {str(event.raw): event for event in parse_strace_log(log or _strace_log(), RUN_START)}


def _find(events: dict[str, EvidenceEvent], *needles: str) -> EvidenceEvent:
    """The single parsed event whose raw contains every needle."""
    hits = [event for raw, event in events.items() if all(part in raw for part in needles)]
    assert len(hits) == 1, f"{needles} matched {len(hits)} captured lines, expected 1"
    return hits[0]


def _ok(stdout: str = "") -> ExecResult:
    return ExecResult(stdout, "", 0, False)


def test_strace_wrapper_and_captured_line_formats() -> None:
    """C1: the wrapper shape, plus the three real prefix forms. The pid column in
    `-f -o file` output is space-padded and left-aligned ("11    1784975284.8 …");
    `[pid N]` is what strace writes to a terminal; no pid at all is a non-`-f`
    trace. All three lines below are captured, not composed."""
    wrapped = wrap_with_strace(["node", "index.js"])
    assert wrapped[0] == "strace"
    assert wrapped[-2:] == ["node", "index.js"]

    padded = "11    1784975284.823510 write(5, \"*\", 1) = 1"
    assert parse_strace_line(padded) == (11, 1784975284.823510, "write", '5, "*", 1', "1")
    assert parse_strace_line(padded.replace("11   ", "[pid 11]", 1).replace("[pid 11] ", "[pid 11] ")) is not None
    assert parse_strace_line("1784975284.823510 write(5, \"*\", 1) = 1") == (
        None,
        1784975284.823510,
        "write",
        '5, "*", 1',
        "1",
    )
    # strace's own bookkeeping is not a syscall, so it is not an event — but it is
    # RECOGNISED, so an unknown line shape asserts instead of vanishing.
    log = _strace_log()
    assert "+++ killed by SIGTERM +++" in log and "--- SIGTERM" in log
    kinds = {event.kind for event in parse_strace_log(log, RUN_START)}
    assert kinds <= set(SYSCALL_KIND.values())


def test_captured_log_normalizes_security_relevant_fields() -> None:
    """C2: over the committed capture — openat path, connect peer addr:port, execve
    argv, read/write fds. Replaces a version of this class that asserted
    `connect(7, {sin_port=htons(443), sin_addr="1.2.3.4"}, 16)`, a shape strace has
    never emitted; that agreement between test and code kept the peer-address
    regex dead for the module's whole life."""
    events = _events_by_raw()
    assert _find(events, 'openat(AT_FDCWD, "/etc/ld.so.cache"').normalized == {
        "ret": "3",
        "path": "/etc/ld.so.cache",
    }
    imds = _find(events, "sin_addr=inet_addr(\"169.254.169.254\")")
    assert present(imds.normalized)["addr"] == "169.254.169.254"
    assert present(imds.normalized)["port"] == 80
    assert present(imds.normalized)["fd"] == 18
    v6 = _find(events, "AF_INET6")
    assert (present(v6.normalized)["addr"], present(v6.normalized)["port"]) == ("::1", 9)
    boot = _find(events, 'execve("/usr/local/bin/node"')
    assert present(boot.normalized)["path"] == "/usr/local/bin/node"
    assert present(boot.normalized)["argv"] == ["node", "/cprobe.js"]
    assert present(_find(events, 'write(22, "hello-from-client"').normalized)["fd"] == 22
    # A DNS response's peer sockaddr: 221 recvfrom events in the committed corpus
    # carry one, and every one of them used to be discarded.
    resolver = _find(events, "recvfrom(21, \"T\\0")
    assert (present(resolver.normalized)["addr"], present(resolver.normalized)["port"]) == ("127.0.0.53", 53)


def test_syscall_split_across_two_lines_is_reassembled_not_dropped() -> None:
    """C3: strace prints `name(args… <unfinished ...>` at entry and
    `<... name resumed>…) = result` at exit whenever another thread reports in
    between. Neither half parses alone, and both were dropped — so in a 165-line
    capture of a benign probe a real `execve("/bin/echo", …)` process spawn and a
    blocking `read` were absent from the evidence entirely. The two pairs below
    are copied verbatim from that capture."""
    log = _strace_log()
    assert "<unfinished ...>" in log and "resumed>" in log
    events = _events_by_raw(log)
    spawn = _find(events, 'execve("/bin/echo"')
    assert spawn.kind == "execve"
    assert present(spawn.normalized)["argv"] == [
        "/bin/echo",
        "arg with space",
        'has\\"quote',
        "back\\\\slash",
        "tab\\there",
    ]
    assert str(spawn.raw).endswith(") = 0")
    assert "<unfinished" not in str(spawn.raw)
    blocking = _find(events, "read(33")
    assert blocking.normalized == {"ret": "0", "fd": 33}
    assert blocking.raw == 'read(33, "", 4) = 0'
    # The ENTRY timestamp is kept, not the exit's: strace stamps an uninterrupted
    # line at syscall entry, so taking the resume's time would reorder a
    # reassembled event against its neighbours. The pair below is the captured
    # `read` split — entry at .025135, resumed 7.3ms later at .032475.
    pair = [line for line in log.splitlines() if "read(33" in line or "read resumed" in line]
    assert len(pair) == 2
    rejoined = parse_strace_log("\n".join(pair) + "\n", 1784974617.0)
    assert len(rejoined) == 1
    assert rejoined[0].timestamp == round((1784974617.025135 - 1784974617.0) * 1e9)
    assert rejoined[0].timestamp != round((1784974617.032475 - 1784974617.0) * 1e9)


def test_syscall_in_flight_when_the_trace_ends_still_becomes_an_event() -> None:
    """C3b: the wall-clock budget can kill the process mid-syscall. That call DID
    happen — its packet went out — so it survives with strace's own unknown-result
    token and a visible marker, instead of being dropped as unparseable.

    NOT-A-CAPTURED-SHAPE, and deliberately admitted as such. Producing a dangling
    entry needs two things at once: another thread must report between this
    syscall's entry and exit (so strace prints the `<unfinished ...>` half), and the
    process must then die before it returns. I tried to capture it — a thread
    blocked in read on a silent socket, killed with SIGKILL — and strace emitted no
    unfinished line at all: with nothing else interleaving, the entry is never
    printed, and on death it writes `+++ killed by SIGKILL +++` instead. So the line
    below is CONSTRUCTED from a captured connect plus strace's own trailing marker.
    It is kept rather than deleted because the alternative to handling it is
    dropping the event, which is the exact failure this whole class is about, and
    because the cost of being wrong is one extra event rather than a lost one."""
    dangling = (
        "11    1784975284.859794 connect(18, {sa_family=AF_INET, sin_port=htons(9999), "
        'sin_addr=inet_addr("127.0.0.1")}, 16 <unfinished ...>\n'
    )
    events = parse_strace_log(dangling, RUN_START)
    assert len(events) == 1
    assert present(events[0].normalized)["addr"] == "127.0.0.1"
    assert present(events[0].normalized)["port"] == 9999
    assert present(events[0].normalized)["ret"] == "?"
    assert "unfinished at end of trace" in str(events[0].raw)


def test_errno_survives_so_a_successful_async_connect_is_not_a_failure() -> None:
    """C4: node's sockets are non-blocking, so a connect that WILL be established
    reports `-1 EINPROGRESS`. Keeping only "-1" made it identical to
    ECONNREFUSED — the judge could not tell an established exfil channel from a
    refused one. `raw` is now the real line minus its prefix, verbatim."""
    events = _events_by_raw()
    established = _find(events, 'sin_addr=inet_addr("127.0.0.1")}, 16) = -1')
    assert present(established.normalized)["ret"] == "-1"
    assert present(established.normalized)["error"] == "EINPROGRESS"
    assert str(established.raw).endswith("= -1 EINPROGRESS (Operation now in progress)")
    missing = _find(events, "/proc/version_signature")
    assert present(missing.normalized)["error"] == "ENOENT"
    again = _find(events, "recvfrom(21, 0x")
    assert present(again.normalized)["error"] == "EAGAIN"
    # A success carries no error key at all — present-and-None would be one more
    # ambiguous state.
    assert "error" not in present(_find(events, 'sin_addr=inet_addr("198.51.100.53")').normalized)


def test_absent_peer_address_names_which_kind_of_absence() -> None:
    """C5: `addr=None` used to mean three different things at once — a unix-domain
    peer (the address is a PATH), a genuinely NULL sockaddr, or a parse that
    silently failed. `family` separates them, which is what makes the third case
    detectable at all."""
    events = _events_by_raw()
    unix = _find(events, "AF_UNIX", "nscd")
    assert present(unix.normalized)["family"] == "AF_UNIX"
    assert present(unix.normalized)["path"] == "/var/run/nscd/socket"
    assert present(unix.normalized)["addr"] is None  # a path is not an addr:port
    netlink = _find(events, "RTM_GETLINK")
    assert present(netlink.normalized)["family"] == "AF_NETLINK"
    assert present(netlink.normalized)["addr"] is None
    # NULL sockaddr — real and correct: accept4(fd, NULL, NULL, …) and sendto on a
    # connected socket have no peer argument to read.
    accepted = _find(events, "accept4(21, NULL, NULL")
    assert present(accepted.normalized)["family"] is None
    assert present(_find(events, 'sendto(19, "{').normalized)["family"] is None


def test_inet_sockaddr_without_an_extractable_peer_is_a_parser_defect() -> None:
    """C5b — INVARIANT: an AF_INET/AF_INET6 sockaddr always carries a printable
    address and port, so failing to extract them is a bug in this parser, never an
    address-less connection. Asserting is the whole fix: the dead `sin_addr="…"`
    regex returned addr=None for every inet connect ever captured and looked
    exactly like "no address available".

    The bare `sin_addr="1.2.3.4"` form below is the shape a previous version of
    this test asserted, and the production regex had been WIDENED with an optional
    `(?:\\w+\\()?` group to accept it — a comment cited strace's -yy flag as
    justification. Measured on strace 6.1 and 7.0: -y and -yy annotate the FILE
    DESCRIPTOR (`connect(21<TCP:[2422430]>, …`) and leave the sockaddr untouched;
    -v -e abbrev=none changes nothing either. So no flag combination emits it, the
    group is gone, and this now asserts — a regex loosened to satisfy a fabricated
    fixture is the same defect as a fixture written to satisfy a wrong regex.

    NOT-A-CAPTURED-SHAPE by construction: every sockaddr below is one the producer
    CANNOT emit. That is the assertion, so committing them as fixtures would be a
    category error — a fixture claims "the real producer wrote this"."""
    for fabricated in (
        '{sa_family=AF_INET, sin_port=htons(443), sin_addr="1.2.3.4"}',
        "{sa_family=AF_INET, sin_port=htons(80), sin_addr=<unprintable>}",
        '{sa_family=AF_INET, sin_addr=inet_addr("1.2.3.4")}',  # no port
    ):
        with pytest.raises(AssertionError, match="no extractable peer"):
            parse_strace_log(
                f"11    1784975284.8 connect(18, {fabricated}, 16) = 0\n", RUN_START
            )


def test_unnamed_unix_peer_has_a_null_path_legitimately() -> None:
    """C5d: captured from a real accept4 whose client never bound a name — strace
    prints a bare `{sa_family=AF_UNIX}`. So a null path here is genuine absence,
    not a parse failure, and `family` is what says which it is. This is also the
    line that proves the rejoin handles two pids blocked at once: the fixture's
    last nine lines interleave three unfinished/resumed pairs across two pids."""
    events = _events_by_raw()
    unnamed = _find(events, "accept4(", "{sa_family=AF_UNIX}")
    assert present(unnamed.normalized)["family"] == "AF_UNIX"
    assert present(unnamed.normalized)["path"] is None
    assert present(unnamed.normalized)["ret"] == "5"
    named = _find(events, 'connect(4, {sa_family=AF_UNIX, sun_path="/tmp/tmpqjqtguta')
    assert present(named.normalized)["path"] == "/tmp/tmpqjqtguta/s.sock"
    # Both halves of all three interleaved pairs were reassembled, and neither pid
    # took the other's result.
    assert present(_find(events, 'recvfrom(5, "hi"').normalized)["fd"] == 5
    assert present(_find(events, 'sendto(4, "hi"').normalized)["fd"] == 4


def test_payload_that_begins_with_a_brace_is_not_read_as_the_peer() -> None:
    """C5c: captured verbatim — a DNS query whose first byte is 0x7b makes the
    payload argument start with '{'. Locating the sockaddr as "the first brace
    group" without skipping quoted strings would read a peer address out of
    attacker-controlled bytes."""
    events = _events_by_raw()
    payload = _find(events, 'sendto(19, "{')
    assert str(payload.raw).startswith('sendto(19, "{\\335')
    assert payload.normalized == {"ret": "47", "fd": 19, "family": None, "addr": None, "port": None}


def test_parse_snapshot_over_real_find_output_keeps_awkward_filenames() -> None:
    """C6: `find -printf` prints %p RAW. With the path first and rows newline
    delimited, a filename holding a tab or a newline produced a row the parser
    then SKIPPED — silently deleting that file from the fs-diff, which made
    `evil\\tstage2.js` a free evasion. The capture below contains all three
    awkward names; the record format now puts the path last, NUL-terminated."""
    raw = FIXTURES.joinpath("find-snapshot.bin").read_text()
    parsed = parse_snapshot(raw)
    assert "/pkg/tab\there.js" in parsed
    assert "/pkg/nl\nhere.js" in parsed
    assert '/pkg/quote"q.js' in parsed
    assert parsed["/pkg/index.js"] == (3, 1784975497.7252269)
    assert parse_snapshot("") == {}
    # A record that does not parse is a broken producer, not a file to forget.
    with pytest.raises(AssertionError, match="malformed record"):
        parse_snapshot("notanumber\t1.0\t/pkg/x\0")


def test_filesystem_diff_never_turns_deletion_into_absence() -> None:
    """C7: created, modified, and deleted paths each yield a typed event."""
    events, raw = diff_snapshots(
        {"/pkg/a": (3, 10.0), "/pkg/b": (4, 10.0)},
        {"/pkg/b": (9, 12.0), "/pkg/c": (1, 11.0)},
        10.0,
    )
    assert {event.kind for event in events} == {
        "file_created",
        "file_modified",
        "file_deleted",
    }
    assert "D\t/pkg/a" in raw


def test_parse_tshark_json_over_the_real_capture_finds_every_layer() -> None:
    """C8: the real tshark JSON nests http.request.method/uri under the request
    LINE as a key, and dns.qry.name under Queries.<question> — a flat
    hand-authored packet proves neither. It also files mDNS and LLMNR queries
    under the layer keys `mdns`/`llmnr` while still matching a `dns.qry.name`
    filter, so a hardcoded layers["dns"] lookup found nothing in them."""
    raw = FIXTURES.joinpath("tshark-node.json").read_text()
    packets = json.loads(raw)
    events = parse_tshark_json(raw)
    assert len(packets) == 13
    assert len(events) == 13  # was 7 — the six mdns/llmnr packets vanished silently
    http = [event for event in events if event.kind == "http_request"]
    assert http[0].normalized == {
        "host": "169.254.169.254",
        "method": "GET",
        "path": "/latest/meta-data/",
    }
    assert present(http[1].normalized)["method"] == "POST"
    assert present(http[1].normalized)["path"] == "/exfil?tok=SYNTH-CANARY-aaaaaaaa"
    hosts = {present(event.normalized)["host"] for event in events if event.kind == "dns_query"}
    assert "7b22656e76223a7b.s0.localhost" in hosts
    assert {"probe-host", "probe-host.local"} <= hosts  # the mdns/llmnr names
    assert [present(event.normalized)["host"] for event in events if event.kind == "tls_sni"] == [
        "api.github.com"
    ]
    # frame.time_relative is a nanosecond-precision string in real output.
    assert http[0].timestamp == 1_166_553_000


def test_every_packet_the_filter_admitted_yields_an_event() -> None:
    """C8b — INVARIANT: the display filter and the extraction read the SAME field
    list, so a selected packet that yields no event is a divergence between the
    two halves, not absent traffic. Six of thirteen real packets used to yield
    none, silently, which is indistinguishable from a quiet network — the exact
    shape that lets an exfil hypothesis be refuted for want of lost evidence.

    NOT-A-CAPTURED-SHAPE for the two negative packets: they are packets tshark's
    own filter would never have selected, constructed precisely to prove the
    divergence is caught. The positive half of this class runs over both committed
    captures."""
    assert " or ".join(PCAP_FIELDS) == PCAP_FILTER
    for field in PCAP_FIELDS:
        assert field in PCAP_FILTER
    # Both committed captures, each selected by that filter. `ssdp` is a third
    # layer key the HTTP dissector files requests under (SSDP is HTTP over UDP);
    # its method is M-SEARCH and its URI is `*`, so a "GET /" default would have
    # misreported it rather than merely blurred it.
    for name in ("tshark-node.json", "tshark-ssdp.json"):
        raw = FIXTURES.joinpath(name).read_text()
        assert len(parse_tshark_json(raw)) == len(json.loads(raw)), name
    ssdp = parse_tshark_json(FIXTURES.joinpath("tshark-ssdp.json").read_text())
    assert [event.normalized for event in ssdp] == [
        {"host": "239.255.255.250:1900", "method": "M-SEARCH", "path": "*"}
    ]
    with pytest.raises(AssertionError, match="none of"):
        parse_tshark_json('[{"_source": {"layers": {"frame": {"frame.time_relative": "0.5"}}}}]')
    # A request line is what makes a packet an http.request, so a missing method or
    # URI is a divergence, never a request to describe with invented defaults.
    with pytest.raises(AssertionError, match="no request line"):
        parse_tshark_json(
            '[{"_source": {"layers": {"frame": {"frame.time_relative": "0.5"},'
            ' "http": {"http.request": "1", "http.host": "x.test"}}}}]'
        )


def test_unreadable_tshark_output_raises_instead_of_yielding_no_traffic() -> None:
    """C9: tshark 4.0 prints "[]" for zero matching packets (verified against the
    sandbox image), so stdout that is blank or not JSON means the pipeline broke.
    Returning [] there reintroduced precisely what stop_pcap's nonzero-exit check
    exists to prevent: an empty network timeline nobody knows is empty by
    accident.

    NOT-A-CAPTURED-SHAPE: broken stdout is by definition not something the producer
    emits on a healthy run. `"[]"` and `"[\\n\\n]"` ARE its real zero-packet output,
    measured against the sandbox image's tshark 4.0.17."""
    assert parse_tshark_json("[]") == []
    assert parse_tshark_json("[\n\n]") == []
    with pytest.raises(RuntimeError, match="not JSON"):
        parse_tshark_json("")
    with pytest.raises(RuntimeError, match="not JSON"):
        parse_tshark_json("tshark: cut short in the middle of a packet")
    with pytest.raises(RuntimeError, match="not a packet list"):
        parse_tshark_json('{"_source": {}}')


def test_syscall_kind_is_total_and_inbound_network_maps_to_honest_kinds() -> None:
    """C10: every traced syscall has an explicit kind; recvfrom/accept/accept4
    collapse into their honest socket families (read / connect) with real
    normalized fields — never fabricated 'openat' opens with empty paths."""
    assert set(SYSCALL_KIND) == set(TRACED_SYSCALLS)
    events = _events_by_raw()
    assert _find(events, "recvfrom(21, \"T\\0").kind == "read"
    assert _find(events, "accept4(21, NULL, NULL").kind == "connect"
    assert _find(events, "RTM_GETADDR").kind == "sendto"
    assert all(
        str(event.raw).startswith(str(event.raw).split("(")[0] + "(")
        for event in events.values()
    )


def test_unmapped_traced_syscall_fails_loud_never_fabricates() -> None:
    """C10: a syscall outside SYSCALL_KIND is a programming error — parse raises
    instead of showing the judge a fabricated kind."""
    with pytest.raises(AssertionError, match="no evidence kind"):
        parse_strace_log("1700000001.000000 madvise(0x7f0000, 4096, 4) = 0\n", 1_700_000_000)


async def test_start_pcap_returns_only_when_tcpdump_confirms_capture(monkeypatch) -> None:
    """C11: the launch exec returning proves nothing — start_pcap polls for the
    'listening on' marker and returns only once it appears."""
    probes = 0

    async def fake(args, timeout_ms, stdin=None):
        nonlocal probes
        if "-d" in args:
            return _ok()
        probes += 1
        return _ok("READY\n" if probes >= 3 else "")

    monkeypatch.setattr(sensors, "docker_exec", fake)
    await sensors.start_pcap("c1")
    assert probes == 3  # returned exactly at the marker, not before


async def test_start_pcap_dead_tcpdump_raises_with_captured_reason(monkeypatch) -> None:
    """C11: tcpdump exiting before the marker (bad interface, perms) raises with
    its stderr — never proceeds into a dead capture."""

    async def fake(args, timeout_ms, stdin=None):
        if "-d" in args:
            return _ok()
        return _ok("DEAD\ntcpdump: any: You don't have permission\n")

    monkeypatch.setattr(sensors, "docker_exec", fake)
    with pytest.raises(RuntimeError, match="exited before capturing.*permission"):
        await sensors.start_pcap("c1")


async def test_start_pcap_deadline_expiry_raises(monkeypatch) -> None:
    """C11: no marker within the deadline → raise (SensorError → DEFER), never a
    hopeful return into an unconfirmed capture."""

    async def fake(args, timeout_ms, stdin=None):
        return _ok()

    monkeypatch.setattr(sensors, "docker_exec", fake)
    monkeypatch.setattr(sensors, "PCAP_READY_DEADLINE_SEC", 0.0)
    with pytest.raises(RuntimeError, match="did not confirm capture"):
        await sensors.start_pcap("c1")


async def test_stop_pcap_raises_when_capture_died_mid_run(monkeypatch) -> None:
    """C12: pkill matching nothing means evidence was silently lost between start
    and stop — that is an error, not an empty pcap that could refute."""

    async def fake(args, timeout_ms, stdin=None):
        assert "pkill" in args  # must fail before any collection exec
        return ExecResult("", "", 1, False)

    monkeypatch.setattr(sensors, "docker_exec", fake)
    with pytest.raises(RuntimeError, match="capture died mid-run"):
        await sensors.stop_pcap("c1")


async def test_stop_pcap_waits_for_flush_then_collects(monkeypatch) -> None:
    """C12: collection starts only after tcpdump has exited (TERM handler flushed
    and closed the dump file); pcap bytes and parsed events come back. The capture
    is fetched through read_bytes_from_container — no `base64` exec appears in the
    sequence at all, which is C12b's other half. The tshark invocation carries the
    shared PCAP_FILTER, so the filter can never drift from the fields the parser
    extracts."""
    pgrep_polls = 0
    order: list[str] = []
    filters: list[str] = []
    execs: list[str] = []
    reads: list[tuple[str, str, str | None]] = []

    async def fake(args, timeout_ms, stdin=None):
        nonlocal pgrep_polls
        joined = " ".join(args)
        execs.append(joined)
        if "pkill" in args:
            order.append("pkill")
            return _ok()
        if "pgrep" in joined:
            pgrep_polls += 1
            order.append("pgrep")
            return _ok("4242\n" if pgrep_polls < 3 else "")
        assert "tshark" in args
        order.append("tshark")
        filters.append(args[args.index("-Y") + 1])
        return _ok("[]")

    async def fake_read(container, path, *, user=None):
        order.append("read")
        reads.append((container, path, user))
        return b"PCAPBYTES"

    monkeypatch.setattr(sensors, "docker_exec", fake)
    monkeypatch.setattr(sensors, "read_bytes_from_container", fake_read)
    result = await sensors.stop_pcap("c1")
    assert result.raw_pcap == b"PCAPBYTES"
    assert result.events == []
    assert order == ["pkill", "pgrep", "pgrep", "pgrep", "read", "tshark"]
    assert filters == [PCAP_FILTER]
    # The whole capture, read as root (tcpdump writes it with -Z root).
    assert reads == [("c1", sensors.PCAP_FILE, "0")]
    assert not [command for command in execs if "base64" in command]


async def test_stop_pcap_failed_liveness_probe_is_not_exit_confirmation(monkeypatch) -> None:
    """C12: a failing probe exec (docker contention) also has empty stdout but
    proves nothing about tcpdump — the barrier must not break out and read a
    possibly-live capture; it deadlines into a raise (SensorError → DEFER)."""

    async def fake(args, timeout_ms, stdin=None):
        if "pkill" in args:
            return _ok()
        assert "pgrep" in " ".join(args)  # must never reach collection
        return ExecResult("", "error during connect: daemon busy", 1, False)

    monkeypatch.setattr(sensors, "docker_exec", fake)
    monkeypatch.setattr(sensors, "PCAP_FLUSH_DEADLINE_SEC", 0.0)
    with pytest.raises(RuntimeError, match="did not flush"):
        await sensors.stop_pcap("c1")


async def test_stop_pcap_tshark_failure_raises_not_zero_events(monkeypatch) -> None:
    """C12: a failed tshark parse is missing evidence, not absent traffic — it
    raises instead of silently returning no network events."""

    async def fake(args, timeout_ms, stdin=None):
        if "pkill" in args:
            return _ok()
        if "pgrep" in " ".join(args):
            return _ok("")
        return ExecResult("", "tshark: cut short in the middle of a packet", 2, False)

    async def fake_read(container, path, *, user=None):
        return b"PCAPBYTES"

    monkeypatch.setattr(sensors, "docker_exec", fake)
    monkeypatch.setattr(sensors, "read_bytes_from_container", fake_read)
    with pytest.raises(RuntimeError, match="tshark parse failed"):
        await sensors.stop_pcap("c1")


def test_a_whole_capture_cannot_pass_the_transfer_cap() -> None:
    """C12b: the argument that makes an over-cap whole capture UNREPRESENTABLE,
    checked where it can actually break. Two links: the capture is written to the
    mount TMPFS_TMP describes (the same container also carries a 256 MiB /pkg
    tmpfs and a 64 MiB /home/node one, so "a sensor file is bounded by the tmpfs"
    is a claim about WHICH mount), and that mount's docker option really carries a
    size the cap dominates — an unsized tmpfs defaults to half of host RAM and puts
    the cap back in charge of which evidence arrives. docker.py's import-time assert
    checks the CONSTANT; this checks the option string docker is handed, so
    size=256m with SANDBOX_TMP_MB left at 64 fails here and nowhere else."""
    assert sensors.PCAP_FILE.startswith(TMPFS_TMP.path + "/")
    size = re.search(r"\bsize=(\d+)m\b", TMPFS_TMP.options)
    assert size, f"TMPFS_TMP has no size option: {TMPFS_TMP.options}"
    assert int(size.group(1)) * 1024 * 1024 <= MAX_EXEC_OUTPUT_BYTES


def test_committed_runartifact_raws_all_reparse_through_the_current_parser() -> None:
    """C2/C5b — the falsification that makes the new asserts trustworthy rather
    than hopeful: replay every L1 `raw` in every committed runartifact (3900+ real
    captured syscall lines from production audits, including 306 inet sockaddrs
    and 72 unix ones) back through the parser. Nothing may trip an invariant, and
    every line must produce exactly one event."""
    raws = [
        event["raw"]
        for path in sorted(FIXTURES.parent.glob("llm/*/sandbox/*.runartifact.json"))
        for event in json.loads(path.read_text()).get("events", [])
        if event["stream"] == "L1:seccomp"
    ]
    assert len(raws) > 3000, "the committed corpus is the point of this test"
    for index, raw in enumerate(raws):
        events = parse_strace_log(f"11    1700000000.{index:06d} {raw}\n", 1_700_000_000.0)
        assert len(events) == 1, f"{raw[:120]!r} produced {len(events)} events"

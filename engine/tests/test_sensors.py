# CLASS MAP — sensor parsers + pcap lifecycle barriers (pure parsing halves of
# the L1/L2/L3 sensors; snapshot docker execs are e2e/docker-tier, pcap barrier
# logic is unit-tested here against a stubbed docker_exec and live at e2e tier)
# Axes: strace line format variants, syscall normalization, snapshot line shape,
#       fs-diff event polarity, tshark packet layer mix + malformed input,
#       pcap readiness/flush marker outcomes
#   C1 strace wrapper preserves the command; pid/no-pid line variants parse;
#      unfinished lines are dropped, not misparsed
#   C2 strace log normalizes security-relevant fields (paths, addr:port, argv)
#   C3 fs diff distinguishes created/modified/deleted — deletion is an event,
#      never silent absence
#   C4 parse_snapshot: valid path\tsize\tmtime rows parse; CRLF tolerated;
#      malformed rows (wrong arity, non-numeric) are skipped
#   C5 parse_tshark_json buckets dns/http/tls packets with relative-time
#      nanosecond timestamps; dns wins when layers coexist in one packet
#   C6 parse_tshark_json malformed input → [] (garbage, non-list, bad timestamp)
#   C7 SYSCALL_KIND is total over TRACED_SYSCALLS — recvfrom/accept/accept4
#      collapse to honest socket families (read/connect, exact syscall in raw);
#      an unmapped syscall raises, never fabricates 'openat'
#   C8 start_pcap readiness barrier — returns only on tcpdump's 'listening on'
#      marker; early death and deadline expiry raise (→ SensorError → DEFER),
#      never a silent dead capture
#   C9 stop_pcap — a capture that died mid-run raises; collection waits for
#      tcpdump's flush-and-exit; tshark failure raises instead of degrading to
#      zero network events
# Adversarial pass: 2026-07-23/W6 — added the pure parse_snapshot and
# parse_tshark_json partitions (previously untested).
# Invariant pass: 2026-07-23 sensor-fidelity — C7-C9 flip the pinned
# evidence-loss behaviors (sleep-armed pcap, fabricated 'openat' default) into
# asserted invariants.
import json

import pytest

from npmguard import sensors
from npmguard.docker import ExecResult
from npmguard.sensors import (
    SYSCALL_KIND,
    TRACED_SYSCALLS,
    diff_snapshots,
    parse_snapshot,
    parse_strace_line,
    parse_strace_log,
    parse_tshark_json,
    wrap_with_strace,
)


def _ok(stdout: str = "") -> ExecResult:
    return ExecResult(stdout, "", 0, False)


def test_strace_wrapper_and_variants() -> None:
    """C1: wrapper shape + pid/no-pid parse variants + unfinished-line rejection."""
    wrapped = wrap_with_strace(["node", "index.js"])
    assert wrapped[0] == "strace"
    assert wrapped[-2:] == ["node", "index.js"]
    assert parse_strace_line('[pid 99] 1700000002.500000 write(5, "data", 4) = 4') == (
        99,
        1700000002.5,
        "write",
        '5, "data", 4',
        "4",
    )
    assert parse_strace_line("1700000006.0 read(5, <unfinished ...>") is None


def test_strace_log_normalizes_security_relevant_fields() -> None:
    """C2: openat path, connect addr/port, execve argv all normalize."""
    log = (
        '1700000001.000000 openat(AT_FDCWD, "/pkg/.npmrc", O_RDONLY) = 3\n'
        '1700000002.000000 connect(7, {sin_port=htons(443), sin_addr="1.2.3.4"}, 16) = 0\n'
        '1700000003.000000 execve("/bin/sh", ["sh", "-c", "bad"], 0x7) = 0\n'
    )
    events = parse_strace_log(log, 1_700_000_000)
    assert events[0].normalized["path"] == "/pkg/.npmrc"
    assert events[1].normalized == {"ret": "0", "addr": "1.2.3.4", "port": 443}
    assert events[2].normalized["argv"] == ["sh", "-c", "bad"]


def test_filesystem_diff_never_turns_deletion_into_absence() -> None:
    """C3: created, modified, and deleted paths each yield a typed event."""
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


def test_parse_snapshot_accepts_valid_rows_and_skips_malformed() -> None:
    """C4: tab-separated rows parse; CRLF is stripped; junk rows are skipped."""
    raw = (
        "/pkg/index.js\t120\t1700000001.5\n"
        "/pkg/win.js\t7\t1700000002.0\r\n"  # CRLF
        "/pkg/short\t9\n"  # wrong arity → skipped
        "/pkg/bad\tnotanint\t1.0\n"  # non-numeric size → skipped
        "\n"
    )
    assert parse_snapshot(raw) == {
        "/pkg/index.js": (120, 1700000001.5),
        "/pkg/win.js": (7, 1700000002.0),
    }
    assert parse_snapshot("") == {}


def test_parse_tshark_json_buckets_dns_http_tls() -> None:
    """C5: dns/http/tls packets become dns_query/http_request/tls_sni events with
    relative-time ns timestamps; a packet with dns AND http yields only dns."""
    packets = [
        {
            "_source": {
                "layers": {
                    "frame": {"frame.time_relative": "0.5"},
                    "dns": {"dns.qry.name": "exfil.evil.test"},
                    "http": {"http.host": "shadowed.test"},  # dns wins
                }
            }
        },
        {
            "_source": {
                "layers": {
                    "frame": {"frame.time_relative": "1.25"},
                    "http": {
                        "http.host": "evil.test",
                        "http.request.method": "POST",
                        "http.request.uri": "/upload",
                    },
                }
            }
        },
        {
            "_source": {
                "layers": {
                    "tls": {"tls.handshake.extensions_server_name": "sni.evil.test"}
                }
            }
        },
    ]
    events = parse_tshark_json(json.dumps(packets))
    assert [event.kind for event in events] == ["dns_query", "http_request", "tls_sni"]
    assert events[0].normalized == {"host": "exfil.evil.test"}
    assert events[0].timestamp == 500_000_000  # 0.5s relative → ns
    assert events[1].normalized == {"host": "evil.test", "method": "POST", "path": "/upload"}
    assert events[2].normalized == {"host": "sni.evil.test"}
    assert events[2].timestamp == 0  # no frame layer → epoch of the run


def test_parse_tshark_json_malformed_input_yields_no_events() -> None:
    """C6: garbage json, a non-list document, and an unparseable timestamp all
    degrade to no events / zero timestamp instead of raising."""
    assert parse_tshark_json("not json at all") == []
    assert parse_tshark_json('{"_source": {}}') == []
    assert parse_tshark_json("") == []
    events = parse_tshark_json(
        '[{"_source": {"layers": {"frame": {"frame.time_relative": "abc"},'
        ' "dns": {"dns.qry.name": "x.test"}}}}]'
    )
    assert [event.kind for event in events] == ["dns_query"]
    assert events[0].timestamp == 0


def test_syscall_kind_is_total_and_inbound_network_maps_to_honest_kinds() -> None:
    """C7: every traced syscall has an explicit kind; recvfrom/accept/accept4
    collapse into their honest socket families (read / connect) with real
    normalized fields — never fabricated 'openat' opens with empty paths."""
    assert set(SYSCALL_KIND) == set(TRACED_SYSCALLS)
    log = (
        '1700000001.000000 recvfrom(5, "beacon", 6, 0, NULL, NULL) = 6\n'
        '1700000002.000000 accept4(3, {sin_port=htons(4444), sin_addr="9.9.9.9"},'
        " [16], SOCK_CLOEXEC) = 7\n"
        "1700000003.000000 accept(3, NULL, NULL) = 8\n"
    )
    events = parse_strace_log(log, 1_700_000_000)
    assert [event.kind for event in events] == ["read", "connect", "connect"]
    assert events[0].normalized == {"ret": "6", "fd": 5}
    assert events[1].normalized == {"ret": "7", "addr": "9.9.9.9", "port": 4444}
    assert all(event.raw.startswith(("recvfrom(", "accept")) for event in events)


def test_unmapped_traced_syscall_fails_loud_never_fabricates() -> None:
    """C7: a syscall outside SYSCALL_KIND is a programming error — parse raises
    instead of showing the judge a fabricated kind."""
    with pytest.raises(AssertionError, match="no evidence kind"):
        parse_strace_log("1700000001.000000 madvise(0x7f0000, 4096, 4) = 0\n", 1_700_000_000)


async def test_start_pcap_returns_only_when_tcpdump_confirms_capture(monkeypatch) -> None:
    """C8: the launch exec returning proves nothing — start_pcap polls for the
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
    """C8: tcpdump exiting before the marker (bad interface, perms) raises with
    its stderr — never proceeds into a dead capture."""

    async def fake(args, timeout_ms, stdin=None):
        if "-d" in args:
            return _ok()
        return _ok("DEAD\ntcpdump: any: You don't have permission\n")

    monkeypatch.setattr(sensors, "docker_exec", fake)
    with pytest.raises(RuntimeError, match="exited before capturing.*permission"):
        await sensors.start_pcap("c1")


async def test_start_pcap_deadline_expiry_raises(monkeypatch) -> None:
    """C8: no marker within the deadline → raise (SensorError → DEFER), never a
    hopeful return into an unconfirmed capture."""

    async def fake(args, timeout_ms, stdin=None):
        return _ok()

    monkeypatch.setattr(sensors, "docker_exec", fake)
    monkeypatch.setattr(sensors, "PCAP_READY_DEADLINE_SEC", 0.0)
    with pytest.raises(RuntimeError, match="did not confirm capture"):
        await sensors.start_pcap("c1")


async def test_stop_pcap_raises_when_capture_died_mid_run(monkeypatch) -> None:
    """C9: pkill matching nothing means evidence was silently lost between start
    and stop — that is an error, not an empty pcap that could refute."""

    async def fake(args, timeout_ms, stdin=None):
        assert "pkill" in args  # must fail before any collection exec
        return ExecResult("", "", 1, False)

    monkeypatch.setattr(sensors, "docker_exec", fake)
    with pytest.raises(RuntimeError, match="capture died mid-run"):
        await sensors.stop_pcap("c1")


async def test_stop_pcap_waits_for_flush_then_collects(monkeypatch) -> None:
    """C9: collection starts only after tcpdump has exited (TERM handler flushed
    and closed the dump file); pcap bytes and parsed events come back."""
    import base64 as b64

    pgrep_polls = 0
    order: list[str] = []

    async def fake(args, timeout_ms, stdin=None):
        nonlocal pgrep_polls
        joined = " ".join(args)
        if "pkill" in args:
            order.append("pkill")
            return _ok()
        if "pgrep" in joined:
            pgrep_polls += 1
            order.append("pgrep")
            return _ok("4242\n" if pgrep_polls < 3 else "")
        if "base64" in args:
            order.append("base64")
            return _ok(b64.b64encode(b"PCAPBYTES").decode())
        assert "tshark" in args
        order.append("tshark")
        return _ok("[]")

    monkeypatch.setattr(sensors, "docker_exec", fake)
    result = await sensors.stop_pcap("c1")
    assert result.raw_pcap == b"PCAPBYTES"
    assert result.events == []
    assert order == ["pkill", "pgrep", "pgrep", "pgrep", "base64", "tshark"]


async def test_stop_pcap_failed_liveness_probe_is_not_exit_confirmation(monkeypatch) -> None:
    """C9: a failing probe exec (docker contention) also has empty stdout but
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
    """C9: a failed tshark parse is missing evidence, not absent traffic — it
    raises instead of silently returning no network events."""
    import base64 as b64

    async def fake(args, timeout_ms, stdin=None):
        if "pkill" in args:
            return _ok()
        if "pgrep" in " ".join(args):
            return _ok("")
        if "base64" in args:
            return _ok(b64.b64encode(b"PCAPBYTES").decode())
        return ExecResult("", "tshark: cut short in the middle of a packet", 2, False)

    monkeypatch.setattr(sensors, "docker_exec", fake)
    with pytest.raises(RuntimeError, match="tshark parse failed"):
        await sensors.stop_pcap("c1")

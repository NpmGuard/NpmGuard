# CLASS MAP — sensor parsers (pure parsing halves of the L1/L2/L3 sensors;
# container ops — snapshot/pcap docker execs — are e2e/docker-tier, not here)
# Axes: strace line format variants, syscall normalization, snapshot line shape,
#       fs-diff event polarity, tshark packet layer mix + malformed input
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
# Adversarial pass: 2026-07-23/W6 — added the pure parse_snapshot and
# parse_tshark_json partitions (previously untested).
import json

from npmguard.sensors import (
    diff_snapshots,
    parse_snapshot,
    parse_strace_line,
    parse_strace_log,
    parse_tshark_json,
    wrap_with_strace,
)


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

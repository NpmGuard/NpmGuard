from npmguard.sensors import diff_snapshots, parse_strace_line, parse_strace_log, wrap_with_strace


def test_strace_wrapper_and_variants() -> None:
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

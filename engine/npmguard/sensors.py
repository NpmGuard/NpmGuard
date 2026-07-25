import asyncio
import json
import re
import shlex
from dataclasses import dataclass
from typing import Any

from .contract.models import EvidenceEvent
from .docker import docker_exec, read_bytes_from_container

DEFAULT_WATCH_PATHS = ("/pkg", "/home/node")
TRACED_SYSCALLS = (
    "openat",
    "open",
    "read",
    "write",
    "unlink",
    "unlinkat",
    "rename",
    "renameat",
    "renameat2",
    "link",
    "linkat",
    "connect",
    "sendto",
    "recvfrom",
    "accept",
    "accept4",
    "execve",
    "clone",
    "clone3",
    "fork",
    "vfork",
)
# INVARIANT: every syscall in TRACED_SYSCALLS has an EXPLICIT evidence kind —
# an unmapped traced syscall must fail loud in parse_strace_log, never surface
# to the judge under a fabricated kind. Checked at import so a TRACED_SYSCALLS
# edit cannot outrun this table. Values collapse syscall families into the
# contract's fixed EventKind vocabulary (shared/src/evidence.ts); the exact
# syscall is preserved in the event's `raw`. recvfrom is a socket read;
# accept/accept4 join connect's connection-established family (peer addr:port).
SYSCALL_KIND = {
    "open": "openat",
    "openat": "openat",
    "read": "read",
    "write": "write",
    "connect": "connect",
    "sendto": "sendto",
    "recvfrom": "read",
    "accept": "connect",
    "accept4": "connect",
    "execve": "execve",
    "clone": "clone",
    "clone3": "clone",
    "fork": "clone",
    "vfork": "clone",
    "unlink": "unlink",
    "unlinkat": "unlink",
    "rename": "rename",
    "renameat": "rename",
    "renameat2": "rename",
    "link": "link",
    "linkat": "link",
}
assert set(SYSCALL_KIND) == set(TRACED_SYSCALLS), "TRACED_SYSCALLS/SYSCALL_KIND drift"
# A line is PREFIX + BODY. `-f -o file` prints a left-aligned, space-padded pid
# column ("11    1784975284.8 openat(...)"); writing to a terminal instead gives
# "[pid 11] ..."; without -f there is no pid at all. All three are real.
STRACE_PREFIXES = (
    re.compile(r"^\[pid\s+(\d+)\]\s+(\d+\.\d+)\s+(.*)$"),
    re.compile(r"^(\d+)\s+(\d+\.\d+)\s+(.*)$"),
    re.compile(r"^(\d+\.\d+)\s+(.*)$"),
)
# The args group stays GREEDY on purpose: it makes the LAST ") = <result>" the
# split point, so a string argument containing ") = 0" cannot truncate the args.
# The result group keeps everything after "= " (e.g. "-1 ENOENT (No such file or
# directory)") — dropping the errno text made a successful async connect
# (-1 EINPROGRESS) indistinguishable from a refused one (-1 ECONNREFUSED).
STRACE_CALL = re.compile(r"^(\w+)\((.*)\)\s+=\s+((?:-?\d+|0x[0-9a-f]+|\?)(?:\s.*)?)$")
STRACE_RESULT = re.compile(r"^(-?\d+|0x[0-9a-f]+|\?)(?:\s+(E[A-Z0-9]+))?")
STRACE_UNFINISHED = re.compile(r"^(\w+)\((.*)<unfinished \.\.\.>$")
STRACE_RESUMED = re.compile(r"^<\.\.\.\s+(\w+)\s+resumed>(.*)$")
# strace's own bookkeeping lines: "--- SIGTERM {...} ---", "+++ exited with 0 +++",
# "+++ killed by SIGTERM +++". Not syscalls, so not events — but named, so that an
# unrecognised body is an assertion rather than a silent drop.
STRACE_STATUS = re.compile(r"^(?:\+\+\+|---)")
# `find -printf '%s\t%T@\t%p\0'` — the path is LAST and records are NUL-terminated,
# so a path holding a tab or a newline cannot be mistaken for a field boundary.
SNAPSHOT_RECORD = re.compile(r"^(\d+)\t(\d+\.\d+)\t(.+)$", re.DOTALL)


def wrap_with_strace(command: list[str]) -> list[str]:
    return [
        "strace",
        "-f",
        "-ttt",
        "-s",
        "4096",
        "-o",
        "/tmp/strace.log",
        "-e",
        f"trace={','.join(TRACED_SYSCALLS)}",
        *command,
    ]


def _split_prefix(line: str) -> tuple[int | None, float, str] | None:
    """(pid, epoch_seconds, body) — the pid is None only for a non-`-f` trace."""
    for expression in STRACE_PREFIXES:
        match = expression.match(line)
        if match:
            groups = match.groups()
            if len(groups) == 3:
                return int(groups[0]), float(groups[1]), groups[2]
            return None, float(groups[0]), groups[1]
    return None


def parse_strace_line(line: str) -> tuple[int | None, float, str, str, str] | None:
    """(pid, timestamp, syscall, args, result) for one COMPLETE line.

    ``result`` is everything strace printed after ``= `` — the numeric/hex/`?`
    token plus any errno text. None for a line that is not a complete syscall:
    blank, a `+++`/`---` status line, or one half of an unfinished/resumed split
    (``parse_strace_log`` splices those before calling this).
    """
    split = _split_prefix(line)
    if split is None:
        return None
    pid, timestamp, body = split
    match = STRACE_CALL.match(body)
    if match is None:
        return None
    return (pid, timestamp, match.group(1), match.group(2), match.group(3))


def _complete_lines(log: str) -> list[str]:
    """Every COMPLETE syscall line in the log, with interleaved calls spliced back
    into the single line strace would have printed had no other thread reported in
    between, and strace's own bookkeeping lines dropped.

    strace emits ``name(args… <unfinished ...>`` at syscall ENTRY and
    ``<... name resumed>…) = result`` at EXIT whenever another traced thread is
    reported between the two. Neither half parses alone — the entry carries the
    ARGUMENTS, the exit carries the RESULT — so dropping them dropped whole
    syscalls: in a 165-line capture of a benign probe, a real
    ``execve("/bin/echo", [...])`` and a blocking ``read`` vanished entirely. A
    process spawn invisible to the timeline is the false-negative this class of
    defect produces.

    The ENTRY's timestamp is kept: strace stamps an uninterrupted line at syscall
    entry, so using the exit time would reorder the reassembled event against its
    neighbours.

    INVARIANT: this classification is TOTAL. Over 281 lines of captured output from
    three real traces every line is exactly one of: a complete call, an unfinished
    entry, a resumed exit, a `+++`/`---` status line, or blank. Anything else is a
    shape we have never observed, and a silent drop is how a whole syscall family
    goes missing from the evidence — so it asserts.
    """
    # INVARIANT: a tid is inside at most one syscall at a time, so `pending` holds
    # at most one entry per pid. A second entry for a pid that already has one, or
    # a resume with nothing pending, means the pid attribution is wrong — and
    # splicing one thread's arguments onto another thread's result would fabricate
    # a syscall that never happened. Both are asserted, never guessed.
    pending: dict[int | None, tuple[str, str, str]] = {}
    output: list[str] = []
    for line in log.splitlines():
        if not line.strip():
            continue
        split = _split_prefix(line)
        assert split is not None, f"strace: line has no pid/timestamp prefix — {line[:200]!r}"
        pid, _, body = split
        if STRACE_STATUS.match(body):
            continue
        resumed = STRACE_RESUMED.match(body)
        if resumed:
            entry = pending.pop(pid, None)
            assert entry is not None, (
                f"strace: '<... {resumed.group(1)} resumed>' for pid {pid} with no "
                "unfinished entry — the log is truncated or pid attribution is wrong"
            )
            prefix, call, args = entry
            assert call == resumed.group(1), (
                f"strace: pid {pid} entered {call}() but resumed {resumed.group(1)}() — "
                "refusing to splice one syscall's arguments onto another's result"
            )
            output.append(f"{prefix}{call}({args}{resumed.group(2)}")
            continue
        unfinished = STRACE_UNFINISHED.match(body)
        if unfinished:
            assert pid not in pending, (
                f"strace: pid {pid} began {unfinished.group(1)}() while "
                f"{pending[pid][1]}() was still unfinished — a thread cannot be "
                "inside two syscalls at once"
            )
            pending[pid] = (
                line[: len(line) - len(body)],
                unfinished.group(1),
                unfinished.group(2).rstrip(),
            )
            continue
        if not STRACE_CALL.match(body):
            # No cause is named, because this parser cannot tell them apart and the
            # one it used to name is now impossible. It said "docker_exec caps stdout
            # at 10MiB, so a chatty run's log arrives as a prefix ending mid-line":
            # the cap is 64 MiB and it RAISES rather than returning a prefix, and a
            # timed-out read comes back with exit_code -1, which observation.py never
            # parses. So the TRANSFER can no longer hand this parser a torn log.
            # A torn log is still reachable from the PRODUCER side — strace writing
            # into a /tmp that hit ENOSPC leaves the file ending mid-line (measured:
            # a 64 MiB tmpfs filled by one writer ends "… = 3\nopen") — but a partial
            # last line and an unknown complete shape are indistinguishable here, so
            # the body is quoted and the diagnosis left to whoever reads it. Either
            # way this raises: refuting a hypothesis on a partial syscall record
            # would be unsound.
            raise AssertionError(f"strace: unrecognised line body — {body[:200]!r}")
        output.append(line)
    # A syscall still in flight when the trace ended (the wall-clock budget killed
    # the process mid-call) DID happen — its packet went out, its file was opened.
    # Emit it with strace's own unknown-result token so the event survives and the
    # missing return is visible, rather than dropping the evidence.
    for prefix, call, args in pending.values():
        output.append(f"{prefix}{call}({args}) = ? <unfinished at end of trace>")
    return output


def _quoted(args: str) -> list[str]:
    return re.findall(r'"((?:[^"\\]|\\.)*)"', args)


def _brace_blocks(args: str) -> list[str]:
    """Top-level ``{...}`` groups, skipping quoted strings.

    Quote-awareness is load-bearing, not defensive: a real captured
    ``sendto(19, "{\\335\\1\\0…", 47, 0, NULL, 0)`` carries a payload whose first
    byte is 0x7b, so "the first brace group" without it picks the PAYLOAD and then
    reads a peer address out of attacker-controlled bytes.
    """
    blocks: list[str] = []
    depth = 0
    start = 0
    in_string = False
    escaped = False
    for index, char in enumerate(args):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth:
            depth -= 1
            if depth == 0:
                blocks.append(args[start : index + 1])
    return blocks


def _peer(syscall: str, args: str) -> dict[str, Any]:
    """The peer a socket syscall named, read out of the sockaddr strace printed.

    ``family`` is what makes an absent address READABLE instead of ambiguous.
    ``addr=None`` used to mean three different things at once: an AF_UNIX peer
    (the address is a path), a NULL sockaddr (``accept4(fd, NULL, NULL, …)`` and
    ``sendto`` on a connected socket genuinely have no peer argument), or a parse
    that silently failed. The last of those was live for the whole life of this
    module and cost three judge refutations, so it is now impossible rather than
    invisible.
    """
    block = next((item for item in _brace_blocks(args) if "sa_family=" in item), None)
    if block is None:
        # No sockaddr argument at all. Real and correct for accept4(fd, NULL, NULL,
        # …) and for sendto/recvfrom on a connected socket (dest_addr NULL), and for
        # the -1 EAGAIN recvfrom whose arguments strace could not decode.
        return {"family": None, "addr": None, "port": None}
    family = re.search(r"sa_family=(AF_\w+)", block).group(1)
    peer: dict[str, Any] = {"family": family, "addr": None, "port": None}
    if family == "AF_UNIX":
        # sun_path="/var/run/nscd/socket", or @"name" for an abstract socket. path
        # stays None for an UNNAMED peer, which is real and captured: accepting a
        # connection from a client that never bound a name prints a bare
        # `{sa_family=AF_UNIX}` (verified — see the accept4 line in
        # tests/fixtures/sensors/strace-node.log). Genuinely absent, and now
        # distinguishable from a non-unix peer by `family`.
        path = re.search(r'sun_path=@?"((?:[^"\\]|\\.)*)"', block)
        peer["path"] = path.group(1) if path else None
        return peer
    if family not in {"AF_INET", "AF_INET6"}:
        return peer  # AF_NETLINK and friends: named, with no address to invent
    # strace ALWAYS prints the address through a formatter call —
    # sin_addr=inet_addr("1.2.3.4") for v4, inet_pton(AF_INET6, "::1", &sin6_addr)
    # for v6 — so the formatter is mandatory here, not optional. It was optional,
    # to accept a bare sin_addr="1.2.3.4", and that permissiveness existed for
    # exactly one reason: to keep a hand-authored test green. The comment defending
    # it cited `-yy`; measured on strace 6.1 and 7.0, -y and -yy annotate the FILE
    # DESCRIPTOR (`connect(21<TCP:[2422430]>, …`) and leave the sockaddr untouched,
    # and `-v -e abbrev=none` changes nothing either. A regex widened to fit a
    # fabricated fixture is the same defect as a fixture written to fit a wrong
    # regex; the assert below is what makes tightening safe.
    address = re.search(r'sin6?_addr=\w+\("([^"]+)"\)', block) or re.search(
        r'inet_pton\(AF_INET6,\s*"([^"]+)"', block
    )
    port = re.search(r"sin6?_port=htons\((\d+)\)", block)
    # INVARIANT: an AF_INET/AF_INET6 sockaddr ALWAYS carries a printable address and
    # port, so failing to extract them is a parser defect — never an address-less
    # connection. Asserting is the whole fix: the dead sin_addr="…" regex returned
    # addr=None on every inet connect ever captured and looked exactly like "no
    # address available". This fails loud (-> the hypothesis DEFERs with a located
    # cause) instead of showing a judge "connect socket" for a named endpoint.
    assert address and port, (
        f"{syscall}: {family} sockaddr with no extractable peer — strace printed "
        f"a shape this parser does not know: {block}"
    )
    return {**peer, "addr": address.group(1), "port": int(port.group(1))}


SOCKET_SYSCALLS = frozenset({"connect", "sendto", "accept", "accept4", "recvfrom"})
FD_FIRST_SYSCALLS = frozenset({"read", "write", "recvfrom", "sendto", "connect"})


def parse_strace_log(log: str, run_start_sec: float) -> list[EvidenceEvent]:
    events = []
    for line in _complete_lines(log):
        parsed = parse_strace_line(line)
        assert parsed is not None, f"parse_strace_log: _complete_lines yielded {line[:200]!r}"
        pid, timestamp, syscall, args, result = parsed
        kind = SYSCALL_KIND.get(syscall)
        if kind is None:
            raise AssertionError(
                f"parse_strace_log: syscall '{syscall}' has no evidence kind — "
                "refusing to fabricate one"
            )
        # `ret` stays the bare numeric/hex token every consumer already reads; the
        # errno strace printed next to it becomes its own field. Without it a failed
        # call and a succeeded-asynchronously call both read as "= -1".
        split_result = STRACE_RESULT.match(result)
        assert split_result, f"parse_strace_log: unparseable result {result!r} in {line[:200]!r}"
        normalized: dict[str, Any] = {"ret": split_result.group(1)}
        if split_result.group(2):
            normalized["error"] = split_result.group(2)
        quotes = _quoted(args)
        leading_int = re.match(r"^(-?\d+)", args)
        if syscall in FD_FIRST_SYSCALLS:
            # INVARIANT: these syscalls take the descriptor as argument 0, so it is
            # always printed as a leading integer — including under -y/-yy, which
            # annotate it as `21<TCP:[2422430]>` rather than replacing it. `fd=None`
            # was a branch for a shape strace cannot emit, and an unreadable fd
            # silently unnames every read/write the renderer resolves through it.
            assert leading_int, f"{syscall}: no descriptor in argument 0 — {args[:120]!r}"
            normalized["fd"] = int(leading_int.group(1))
        if syscall in {"open", "openat"}:
            normalized["path"] = quotes[0] if quotes else ""
            # openat(3, "rel/path", …) resolves against a directory fd, so the path
            # is RELATIVE and means nothing on its own. Recorded only when present,
            # so a relative path can never be read as an absolute one; node emits
            # AT_FDCWD, hence a key that normally stays absent.
            if syscall == "openat" and leading_int:
                normalized["dirfd"] = int(leading_int.group(1))
        elif syscall == "execve":
            normalized.update(path=quotes[0] if quotes else "", argv=quotes[1:])
        elif syscall in SOCKET_SYSCALLS:
            normalized.update(_peer(syscall, args))
        elif syscall in {"unlink", "unlinkat"}:
            normalized["path"] = quotes[-1] if quotes else ""
        elif syscall.startswith(("rename", "link")):
            normalized.update(
                **{"from": quotes[0] if quotes else "", "to": quotes[-1] if quotes else ""}
            )
        events.append(
            EvidenceEvent(
                stream="L1:seccomp",
                timestamp=max(0, round((timestamp - run_start_sec) * 1e9)),
                pid=pid or 0,
                kind=kind,
                # Verbatim: the real line minus its pid/timestamp prefix. `raw` is
                # the ground truth every other layer is checked against, so it may
                # not be a lossy reconstruction of itself.
                raw=f"{syscall}({args}) = {result}",
                normalized=normalized,
            )
        )
    return events


def parse_snapshot(raw: str) -> dict[str, tuple[int, float]]:
    """Parse ``_snapshot_command``'s NUL-terminated ``size\\tmtime\\tpath`` records.

    INVARIANT: every non-empty record parses. `find -printf` prints ``%p`` RAW, so
    the previous ``path\\tsize\\tmtime`` newline-delimited format was ambiguous for
    any filename containing a tab or a newline — and the parser SKIPPED those rows,
    which silently deleted such files from the fs-diff. `evil\\tstage2.js` is a
    legal filename, so that was a free evasion. With the path LAST and records
    NUL-terminated, size and mtime can no longer be confused with path bytes, an
    unparseable record is impossible, and the skip is an assertion.
    """
    output = {}
    for record in raw.split("\0"):
        if not record:
            continue  # the empty remainder after the final NUL terminator
        match = SNAPSHOT_RECORD.match(record)
        assert match, f"fs snapshot: malformed record {record[:200]!r}"
        output[match.group(3)] = (int(match.group(1)), float(match.group(2)))
    return output


def diff_snapshots(
    before: dict[str, tuple[int, float]], after: dict[str, tuple[int, float]], run_start_sec: float
) -> tuple[list[EvidenceEvent], str]:
    events, raw = [], []
    for path in sorted(after, key=lambda key: after[key][1]):
        size, mtime = after[path]
        timestamp = max(0, round((mtime - run_start_sec) * 1e9))
        if path not in before:
            events.append(
                EvidenceEvent(
                    stream="L3:fsDiff",
                    timestamp=timestamp,
                    pid=0,
                    kind="file_created",
                    raw=f"A {path}",
                    normalized={"path": path, "size": size, "mtime": mtime},
                )
            )
            raw.append(f"A\t{path}\t{size}\t{mtime}")
        elif before[path] != after[path]:
            old_size, old_mtime = before[path]
            events.append(
                EvidenceEvent(
                    stream="L3:fsDiff",
                    timestamp=timestamp,
                    pid=0,
                    kind="file_modified",
                    raw=f"M {path}",
                    normalized={
                        "path": path,
                        "sizeBefore": old_size,
                        "sizeAfter": size,
                        "mtimeBefore": old_mtime,
                        "mtimeAfter": mtime,
                    },
                )
            )
            raw.append(f"M\t{path}\t{old_size}->{size}\t{old_mtime}->{mtime}")
    for path, (size, _) in before.items():
        if path not in after:
            events.append(
                EvidenceEvent(
                    stream="L3:fsDiff",
                    timestamp=0,
                    pid=0,
                    kind="file_deleted",
                    raw=f"D {path}",
                    normalized={"path": path, "sizeBefore": size},
                )
            )
            raw.append(f"D\t{path}\t{size}")
    return events, "\n".join(raw) + ("\n" if raw else "")


def _snapshot_command(paths: tuple[str, ...], output: str) -> str:
    # `%s\t%T@\t%p\0`: numeric fields first, raw path last, records NUL-terminated.
    # See parse_snapshot — with the path first and newline-delimited records, any
    # filename containing a tab or newline produced a row the parser then skipped,
    # deleting that file from the fs-diff evidence entirely.
    safe_paths = " ".join(shlex.quote(path) for path in paths)
    return (
        f"find {safe_paths} -type f -printf '%s\\t%T@\\t%p\\0' 2>/dev/null "
        f"| sort -z > {shlex.quote(output)}"
    )


async def snapshot_pre(container: str, paths: tuple[str, ...] = DEFAULT_WATCH_PATHS) -> None:
    result = await docker_exec(
        ["exec", container, "sh", "-c", _snapshot_command(paths, "/tmp/.npmguard-fsdiff-pre")],
        15_000,
    )
    if result.exit_code:
        raise RuntimeError(f"fs-diff pre-snapshot failed: {result.stderr[:300]}")


async def snapshot_post(
    container: str, run_start_sec: float, paths: tuple[str, ...] = DEFAULT_WATCH_PATHS
) -> tuple[list[EvidenceEvent], str]:
    result = await docker_exec(
        ["exec", container, "sh", "-c", _snapshot_command(paths, "/tmp/.npmguard-fsdiff-post")],
        15_000,
    )
    if result.exit_code:
        raise RuntimeError(f"fs-diff post-snapshot failed: {result.stderr[:300]}")
    before, after = await asyncio.gather(
        docker_exec(["exec", container, "cat", "/tmp/.npmguard-fsdiff-pre"], 10_000),
        docker_exec(["exec", container, "cat", "/tmp/.npmguard-fsdiff-post"], 10_000),
    )
    return diff_snapshots(
        parse_snapshot(before.stdout), parse_snapshot(after.stdout), run_start_sec
    )


PCAP_FILE = "/tmp/npmguard-capture.pcap"
PCAP_STDERR = "/tmp/npmguard-capture.err"
PCAP_READY_DEADLINE_SEC = 15.0
PCAP_FLUSH_DEADLINE_SEC = 10.0


async def start_pcap(container: str) -> None:
    # Launch detached with tcpdump's own stderr captured to tmpfs (docker logs
    # only shows PID 1, so an exec -d crash is otherwise invisible). `exec` keeps
    # the process name 'tcpdump' for the pgrep/pkill probes below.
    result = await docker_exec(
        [
            "exec",
            "-d",
            "--user",
            "0",
            container,
            "sh",
            "-c",
            f"exec tcpdump -i any -U -Z root -w {PCAP_FILE} 2>{PCAP_STDERR}",
        ],
        10_000,
    )
    if result.exit_code:
        raise RuntimeError(f"pcap failed to launch tcpdump: {result.stderr[:300]}")
    # INVARIANT: start_pcap returns <=> tcpdump is CONFIRMED capturing — its
    # 'listening on' stderr line is the capture-ready marker. `exec -d` returning
    # proves only that the exec was created; a trigger must never fire into a
    # dead capture (silently dropping the network-evidence burst). Bounded wait
    # on tcpdump's OWN signals: the marker succeeds; a nonempty stderr with the
    # process gone fails FAST with the captured reason; otherwise time out. On
    # any failure raise (-> SensorError -> DEFER), never proceed uncaptured.
    probe = (
        f"if grep -q 'listening on' {PCAP_STDERR} 2>/dev/null; then echo READY; "
        f"elif [ -s {PCAP_STDERR} ] && ! pgrep -x tcpdump >/dev/null; then "
        f"echo DEAD; cat {PCAP_STDERR}; fi"
    )
    deadline = asyncio.get_running_loop().time() + PCAP_READY_DEADLINE_SEC
    while asyncio.get_running_loop().time() < deadline:
        check = await docker_exec(["exec", "--user", "0", container, "sh", "-c", probe], 5_000)
        out = (check.stdout or "").strip()
        if out.startswith("READY"):
            return
        if out.startswith("DEAD"):
            raise RuntimeError(f"tcpdump exited before capturing: {out[4:].strip()[:300]}")
        await asyncio.sleep(0.1)
    raise RuntimeError(
        f"tcpdump did not confirm capture ('listening on') within {PCAP_READY_DEADLINE_SEC:g}s"
    )


def _deep_field(value: Any, key: str) -> str | None:
    if isinstance(value, dict):
        if key in value:
            direct = value[key]
            if isinstance(direct, list):
                direct = direct[0] if direct else None
            return direct if isinstance(direct, str) else None
        for child in value.values():
            found = _deep_field(child, key)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _deep_field(child, key)
            if found is not None:
                return found
    return None


# INVARIANT: these three fields are the SINGLE source of both halves of the pcap
# sensor — the tshark display filter AND the extraction. They cannot drift, so
# "the filter admitted a packet the extraction found nothing in" is impossible by
# construction rather than by review. It was possible before: the extraction looked
# the fields up under hardcoded layer names (`layers["dns"]`), but tshark's DNS
# dissector also registers as `mdns`, `llmnr` and `nbns`, and its TLS dissector as
# `quic`. On a real capture of a benign probe, 6 of the 13 packets tshark selected
# produced ZERO events — silently, looking exactly like no traffic.
PCAP_FIELDS = ("dns.qry.name", "http.request", "tls.handshake.extensions_server_name")
PCAP_FILTER = " or ".join(PCAP_FIELDS)


def _layer_field(layers: Any, key: str) -> str | None:
    """The value of a dissected field, wherever tshark filed it.

    Searched across ALL layers rather than a guessed layer name: the layer key is
    the protocol tshark decided the packet was (`dns` / `mdns` / `llmnr` / `quic`),
    while the FIELD name is what `-Y` matches on. Only the field name is stable.
    """
    return _deep_field(layers, key)


def parse_tshark_json(raw: str) -> list[EvidenceEvent]:
    # A capture we cannot read is missing evidence, not absent traffic. tshark 4.0
    # prints "[\n\n]" for zero matching packets (verified against the sandbox
    # image), so blank stdout means the pipeline broke, and stop_pcap already
    # refuses to degrade a nonzero tshark exit into zero network events. Returning
    # [] here would have reintroduced exactly that: an empty timeline that lets an
    # exfil hypothesis be REFUTED for want of evidence nobody knows was lost.
    try:
        packets = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"tshark stdout is not JSON ({exc}): {raw[:200]!r}") from exc
    if not isinstance(packets, list):
        raise RuntimeError(f"tshark stdout is not a packet list: {raw[:200]!r}")
    events = []
    for packet in packets:
        layers = packet.get("_source", {}).get("layers", {}) if isinstance(packet, dict) else {}
        # INVARIANT: `frame` is tshark's pseudo-header — every packet in every -T
        # json document carries it, with frame.time_relative as a nanosecond
        # string. Falling back to timestamp 0 was a branch for a shape tshark does
        # not emit, and it silently moved network evidence to the start of the run,
        # where it no longer lines up with the syscalls that caused it.
        relative = _layer_field(layers.get("frame", {}), "frame.time_relative")
        assert relative is not None, f"tshark: packet with no frame.time_relative — {packet}"
        timestamp = max(0, round(float(relative) * 1e9))
        dns = _layer_field(layers, "dns.qry.name")
        request = _layer_field(layers, "http.request")
        sni = _layer_field(layers, "tls.handshake.extensions_server_name")
        if dns:
            events.append(
                EvidenceEvent(
                    stream="L2:pcap",
                    timestamp=timestamp,
                    pid=0,
                    kind="dns_query",
                    raw={"dns": dns},
                    normalized={"host": dns},
                )
            )
        elif request is not None:
            host = _layer_field(layers, "http.host")
            method = _layer_field(layers, "http.request.method")
            uri = _layer_field(layers, "http.request.uri")
            # INVARIANT: what makes a packet an http.request is its REQUEST LINE, so
            # the method and the URI are always dissected. Defaulting them to
            # "GET" / "/" invented a request that was never sent — the same
            # fabrication as inventing a :80 port, and the real captures include an
            # `M-SEARCH *` (SSDP), which "GET /" would have misreported outright.
            # `host` genuinely can be absent (HTTP/1.0 has no Host header).
            assert method and uri, f"tshark: http.request with no request line — {packet}"
            events.append(
                EvidenceEvent(
                    stream="L2:pcap",
                    timestamp=timestamp,
                    pid=0,
                    kind="http_request",
                    raw={"host": host, "method": method, "uri": uri},
                    normalized={"host": host or "", "method": method, "path": uri},
                )
            )
        elif sni:
            events.append(
                EvidenceEvent(
                    stream="L2:pcap",
                    timestamp=timestamp,
                    pid=0,
                    kind="tls_sni",
                    raw={"sni": sni},
                    normalized={"host": sni},
                )
            )
        else:
            raise AssertionError(
                "tshark: a packet its own -Y filter selected carries none of "
                f"{PCAP_FIELDS} — layers {sorted(layers)}. The filter and the "
                "extraction have diverged; refusing to drop network evidence silently."
            )
    return events


@dataclass(frozen=True)
class PcapResult:
    events: list[EvidenceEvent]
    raw_pcap: bytes


async def stop_pcap(container: str) -> PcapResult:
    # INVARIANT: tcpdump was capturing continuously from start_pcap until this
    # TERM. pkill matching no process means the capture died mid-run and network
    # evidence was silently lost — a SensorError (-> DEFER), never an empty pcap
    # that could refute.
    stopped = await docker_exec(
        ["exec", "--user", "0", container, "pkill", "-TERM", "tcpdump"], 5_000
    )
    if stopped.exit_code:
        raise RuntimeError(
            f"tcpdump was not running at stop — capture died mid-run: {stopped.stderr[:300]}"
        )
    # Barrier: tcpdump's TERM handler flushes and closes the dump file; its exit
    # is the flushed-and-complete marker (a fixed sleep can read a torn file).
    deadline = asyncio.get_running_loop().time() + PCAP_FLUSH_DEADLINE_SEC
    while True:
        alive = await docker_exec(
            ["exec", "--user", "0", container, "sh", "-c", "pgrep -x tcpdump || true"], 5_000
        )
        # Only a SUCCESSFUL probe with empty output confirms exit — a failed or
        # timed-out exec (docker contention) also has empty stdout and proves
        # nothing; treating it as exit would read a possibly-live, torn capture.
        if alive.exit_code == 0 and not alive.stdout.strip():
            break
        if asyncio.get_running_loop().time() >= deadline:
            raise RuntimeError(
                f"tcpdump did not flush and exit within {PCAP_FLUSH_DEADLINE_SEC:g}s of SIGTERM"
            )
        await asyncio.sleep(0.1)
    # INVARIANT: an over-cap transfer of a WHOLE capture is unrepresentable, not
    # merely loud. tcpdump writes the capture to the container's /tmp, a tmpfs of
    # SANDBOX_TMP_MB, and docker.py asserts at import that the tmpfs is no larger
    # than MAX_EXEC_OUTPUT_BYTES — so a raw transfer of the whole file cannot pass
    # the cap. Measured at the exact boundary: a file written until /tmp hit ENOSPC
    # is 67,108,864 bytes = the cap, and read_bytes_from_container returned all of
    # it sha256-identical; `base64 -w0` of the SAME file raised at 67,280,896 bytes
    # read. The 4/3 inflation was the last way a complete capture could arrive as a
    # prefix (13 MB -> a sealed 7.5 MiB pcapHash), and it bought no fidelity.
    raw_pcap = await read_bytes_from_container(container, PCAP_FILE, user="0")
    tshark = await docker_exec(
        [
            "exec",
            container,
            "tshark",
            "-r",
            PCAP_FILE,
            "-T",
            "json",
            "-Y",
            PCAP_FILTER,
            "-2",
        ],
        30_000,
    )
    if tshark.exit_code:
        # A failed parse is missing evidence, not absent traffic — fail loud.
        raise RuntimeError(f"tshark parse failed: {tshark.stderr[:300]}")
    return PcapResult(parse_tshark_json(tshark.stdout), raw_pcap)

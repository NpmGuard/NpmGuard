import asyncio
import base64
import json
import re
import shlex
from dataclasses import dataclass
from typing import Any

from .contract.models import EvidenceEvent
from .docker import docker_exec

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
STRACE_TAIL = r"(\w+)\((.*)\)\s+=\s+(-?\d+|0x[0-9a-f]+|\?)(?:\s|$)"
STRACE_FORMATS = (
    (re.compile(r"^(\d+)\s+(\d+\.\d+)\s+" + STRACE_TAIL), True),
    (re.compile(r"^\[pid\s+(\d+)\]\s+(\d+\.\d+)\s+" + STRACE_TAIL), True),
    (re.compile(r"^(\d+\.\d+)\s+" + STRACE_TAIL), False),
)


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


def parse_strace_line(line: str) -> tuple[int | None, float, str, str, str] | None:
    if not line or "<unfinished ...>" in line or "<... " in line:
        return None
    for expression, has_pid in STRACE_FORMATS:
        match = expression.match(line)
        if match:
            groups = match.groups()
            return (
                (int(groups[0]), float(groups[1]), groups[2], groups[3], groups[4])
                if has_pid
                else (None, float(groups[0]), groups[1], groups[2], groups[3])
            )
    return None


def _quoted(args: str) -> list[str]:
    return re.findall(r'"((?:[^"\\]|\\.)*)"', args)


def parse_strace_log(log: str, run_start_sec: float) -> list[EvidenceEvent]:
    events = []
    for line in log.splitlines():
        parsed = parse_strace_line(line)
        if parsed is None:
            continue
        pid, timestamp, syscall, args, result = parsed
        kind = SYSCALL_KIND.get(syscall)
        if kind is None:
            raise AssertionError(
                f"parse_strace_log: syscall '{syscall}' has no evidence kind — "
                "refusing to fabricate one"
            )
        normalized: dict[str, Any] = {"ret": result}
        quotes = _quoted(args)
        if syscall in {"open", "openat"}:
            normalized["path"] = quotes[0] if quotes else ""
        elif syscall == "execve":
            normalized.update(path=quotes[0] if quotes else "", argv=quotes[1:])
        elif syscall in {"read", "write", "recvfrom"}:
            match = re.match(r"^(\d+)", args)
            normalized["fd"] = int(match.group(1)) if match else None
        elif syscall in {"connect", "sendto", "accept", "accept4"}:
            address = re.search(r'sin_addr="([^"]+)"', args) or re.search(
                r'sin6_addr="([^"]+)"', args
            )
            port = re.search(r"htons\((\d+)\)", args)
            normalized.update(
                addr=address.group(1) if address else None,
                port=int(port.group(1)) if port else None,
            )
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
                raw=f"{syscall}({args}) = {result}",
                normalized=normalized,
            )
        )
    return events


def parse_snapshot(raw: str) -> dict[str, tuple[int, float]]:
    output = {}
    for line in raw.splitlines():
        parts = line.rstrip("\r").split("\t")
        if len(parts) != 3:
            continue
        try:
            output[parts[0]] = (int(parts[1]), float(parts[2]))
        except ValueError:
            continue
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
    safe_paths = " ".join(shlex.quote(path) for path in paths)
    return f"find {safe_paths} -type f -printf '%p\\t%s\\t%T@\\n' 2>/dev/null | sort > {shlex.quote(output)}"


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


def parse_tshark_json(raw: str) -> list[EvidenceEvent]:
    try:
        packets = json.loads(raw) if raw.strip() else []
    except json.JSONDecodeError:
        return []
    if not isinstance(packets, list):
        return []
    events = []
    for packet in packets:
        layers = packet.get("_source", {}).get("layers", {}) if isinstance(packet, dict) else {}
        try:
            timestamp = max(
                0,
                round(
                    float(_deep_field(layers.get("frame", {}), "frame.time_relative") or 0) * 1e9
                ),
            )
        except ValueError:
            timestamp = 0
        dns = _deep_field(layers.get("dns", {}), "dns.qry.name")
        host = _deep_field(layers.get("http", {}), "http.host")
        method = _deep_field(layers.get("http", {}), "http.request.method")
        uri = _deep_field(layers.get("http", {}), "http.request.uri")
        sni = _deep_field(layers.get("tls", {}), "tls.handshake.extensions_server_name")
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
        elif host or method or uri:
            events.append(
                EvidenceEvent(
                    stream="L2:pcap",
                    timestamp=timestamp,
                    pid=0,
                    kind="http_request",
                    raw={"host": host, "method": method, "uri": uri},
                    normalized={"host": host or "", "method": method or "GET", "path": uri or "/"},
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
    copied = await docker_exec(
        ["exec", "--user", "0", container, "base64", "-w0", PCAP_FILE], 30_000
    )
    if copied.exit_code:
        raise RuntimeError(f"pcap read failed: {copied.stderr[:300]}")
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
            "dns.qry.name or http.request or tls.handshake.extensions_server_name",
            "-2",
        ],
        30_000,
    )
    if tshark.exit_code:
        # A failed parse is missing evidence, not absent traffic — fail loud.
        raise RuntimeError(f"tshark parse failed: {tshark.stderr[:300]}")
    return PcapResult(parse_tshark_json(tshark.stdout), base64.b64decode(copied.stdout.strip()))

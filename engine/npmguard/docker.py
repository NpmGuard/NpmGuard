import asyncio
import base64
import contextlib
import shlex
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings

# The most output one `docker exec` may produce. A real resource bound because it
# is applied WHILE READING — a slice taken after `communicate()` has buffered the
# whole stream bounds nothing, it only shortens the value the caller then hashes.
#
# 64 MiB, measured against the sandbox rather than picked: every file a sensor reads
# back out of a run (the strace log, the pcap, the fs-diff snapshots) is written to
# the container's /tmp, a tmpfs of SANDBOX_TMP_MB — so a WHOLE sensor file
# transferred RAW cannot reach the cap, the tmpfs being the tighter bound. An
# ENCODED transfer still can, since `base64 -w0` inflates by 4/3, and that is why
# read_bytes_from_container exists.
MAX_EXEC_OUTPUT_BYTES = 64 * 1024 * 1024
_READ_CHUNK = 256 * 1024
# How long to wait for a killed docker client's pipes to reach EOF. Only bounds
# the wait: whatever was read is kept either way (see _CappedStream.data).
_KILL_DRAIN_SEC = 5.0


class DockerOutputTooLargeError(RuntimeError):
    """A `docker exec` produced more output than the transfer cap.

    Raised rather than returning what fits, because a stream that arrives as a
    prefix is indistinguishable from a short one. Measured on real docker: a run
    captured 13,002,771 pcap bytes, `base64 -w0` inflated them to 17.3 MB,
    docker_exec sliced that at exactly 10 MiB — a multiple of 4, so `b64decode`
    never complained — and the sha256 of the resulting 7,864,320-byte PREFIX was
    sealed as `pcapHash` with `error: null`, i.e. an artifact eligible to REFUTE.

    Callers turn this into a coverage gap (SensorError -> DEFER, never SAFE).
    Nothing may turn it back into data.
    """

    def __init__(self, stream: str, read_bytes: int, cap: int, args: list[str]) -> None:
        self.stream = stream
        self.read_bytes = read_bytes
        self.cap = cap
        super().__init__(
            f"docker exec output too large: {stream} passed the {cap}-byte transfer cap "
            f"({read_bytes} bytes read before the producer was killed) — refusing to return "
            f"a prefix that would read as the whole stream (docker {shlex.join(args)[:200]})"
        )


@dataclass(frozen=True)
class ExecResult:
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool


class _CappedStream:
    """One output stream, accumulated with a hard byte bound.

    `data` is what has been read so far, so the PARTIAL output of a process killed
    at its wall-clock timeout survives (the artifact records it with
    `timedOut: true`, the one short read that is not silent). Past the cap the
    bytes are COUNTED and DISCARDED rather than buffered, and `overflowed` makes
    the caller raise: an unbounded read is how a package that floods stdout OOMs
    the engine, and a bounded one that hands back the prefix anyway is how it
    forges evidence. Reading continues to EOF after the producer is killed, so the
    pipe closes and no descriptor is left behind.
    """

    def __init__(self, name: str, cap: int) -> None:
        self.name = name
        self.cap = cap
        self.total = 0
        self.overflowed = False
        self._chunks: list[bytes] = []

    @property
    def data(self) -> bytes:
        return b"".join(self._chunks)

    async def read_from(self, stream: asyncio.StreamReader, on_overflow) -> None:
        while True:
            chunk = await stream.read(_READ_CHUNK)
            if not chunk:
                return
            self.total += len(chunk)
            if self.total > self.cap:
                if not self.overflowed:
                    self.overflowed = True
                    on_overflow()
                continue
            self._chunks.append(chunk)


async def _feed(writer: asyncio.StreamWriter, payload: bytes) -> None:
    # A process that exits without reading its stdin breaks the pipe; its exit
    # code and stderr are the story then, not the write error (`communicate`
    # swallows the same two exceptions for the same reason).
    with contextlib.suppress(BrokenPipeError, ConnectionResetError):
        writer.write(payload)
        await writer.drain()
    with contextlib.suppress(BrokenPipeError, ConnectionResetError, OSError):
        writer.close()


async def _exec_raw(
    args: list[str], timeout_ms: int, stdin: bytes | None = None
) -> tuple[bytes, bytes, int, bool]:
    """(stdout, stderr, exit_code, timed_out) — bytes, undecoded.

    INVARIANT: neither returned stream is ever a SILENT prefix of what the
    process wrote. There are exactly two outcomes: the process reached EOF on
    both pipes, so both streams are complete; or `timed_out` is True, marking
    output cut short by the kill (which every caller treats as a failed run).
    Passing the cap is neither — it raises. This is what makes hashing a
    returned stream sound: the previous seam sliced at 10 MiB and callers hashed
    the slice as if it were the whole capture.
    """
    process = await asyncio.create_subprocess_exec(
        "docker",
        *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out = _CappedStream("stdout", MAX_EXEC_OUTPUT_BYTES)
    err = _CappedStream("stderr", MAX_EXEC_OUTPUT_BYTES)

    def stop() -> None:
        # A stream past the cap makes the whole exec void, so there is nothing to
        # gain by letting the producer keep writing — and letting it would hand a
        # package that floods stdout the engine's whole wall-clock budget.
        with contextlib.suppress(ProcessLookupError):
            process.kill()

    watched = [
        asyncio.ensure_future(out.read_from(process.stdout, stop)),
        asyncio.ensure_future(err.read_from(process.stderr, stop)),
        asyncio.ensure_future(process.wait()),
    ]
    if stdin is not None:
        watched.append(asyncio.ensure_future(_feed(process.stdin, stdin)))
    try:
        _, pending = await asyncio.wait(watched, timeout=timeout_ms / 1000)
        timed_out = bool(pending)
        if timed_out:
            # Wall-clock budget. Kill, then let the readers reach EOF so the output
            # written BEFORE the kill is preserved (and the pipes close).
            stop()
            await asyncio.wait(watched, timeout=_KILL_DRAIN_SEC)
        if out.overflowed or err.overflowed:
            stream = out if out.overflowed else err
            raise DockerOutputTooLargeError(stream.name, stream.total, stream.cap, list(args))
        if timed_out:
            return out.data, err.data, -1, True
        return out.data, err.data, process.returncode or 0, False
    finally:
        # No task may outlive this call: a reader abandoned on a live process is a
        # descriptor and a coroutine the engine never gets back, and a cancelled
        # caller (graceful shutdown, per-hypothesis timeout) must not leave the
        # docker client running. Drain first so the pipes close on their own;
        # cancel only what is still stuck afterwards.
        if any(not task.done() for task in watched):
            stop()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait(watched, timeout=_KILL_DRAIN_SEC)
            for task in watched:
                task.cancel()


async def docker_exec(args: list[str], timeout_ms: int, stdin: bytes | None = None) -> ExecResult:
    stdout, stderr, exit_code, timed_out = await _exec_raw(args, timeout_ms, stdin)
    return ExecResult(
        stdout.decode(errors="replace"), stderr.decode(errors="replace"), exit_code, timed_out
    )


@dataclass(frozen=True)
class VolumeMount:
    host_path: str
    container_path: str
    read_only: bool


@dataclass(frozen=True)
class TmpfsMount:
    path: str
    options: str


# The sandbox /tmp, defined once: every file a sensor writes for the engine to
# read back (the strace log, the pcap, the fs-diff snapshots) lives here, so this
# size is the ceiling on any whole-file transfer out of a run.
SANDBOX_TMP_MB = 64
TMPFS_TMP = TmpfsMount("/tmp", f"rw,noexec,nosuid,size={SANDBOX_TMP_MB}m")
# INVARIANT: a whole sensor file, transferred raw, always fits under the transfer
# cap — so DockerOutputTooLargeError can only ever mean an ENCODING hop inflated
# the transfer or a process is flooding a pipe, never that a complete capture was
# too big to fetch. The two numbers live apart and are edited for different
# reasons (a bigger tmpfs for a chattier trace; a smaller cap for engine memory),
# so this is checked at import rather than trusted: a tmpfs above the cap would
# put the cap back in the business of deciding which evidence arrives.
assert SANDBOX_TMP_MB * 1024 * 1024 <= MAX_EXEC_OUTPUT_BYTES, (
    f"sandbox /tmp is {SANDBOX_TMP_MB}MiB but docker_exec caps one transfer at "
    f"{MAX_EXEC_OUTPUT_BYTES // (1024 * 1024)}MiB — a complete sensor file would not fit"
)


@dataclass
class ContainerSpec:
    image: str
    memory: str
    cpus: float
    network_mode: str
    envs: dict[str, str] = field(default_factory=dict)
    volumes: list[VolumeMount] = field(default_factory=list)
    cap_add: list[str] = field(default_factory=list)
    cap_drop: list[str] = field(default_factory=lambda: ["ALL"])
    read_only: bool = True
    tmpfs: list[TmpfsMount] = field(default_factory=lambda: [TMPFS_TMP])
    pids_limit: int = 64
    user: str = "1000:1000"
    preload: str | None = None
    ld_preload: str | None = None
    hostname: str | None = None
    # "<name>:<ip>" pins written into the container's /etc/hosts at create time. The
    # file is a root-owned bind mount, so the package (uid 1000) cannot rewrite what
    # a name resolves to — which is why a stubbed endpoint is pinned here and not by
    # editing /etc/hosts from inside.
    extra_hosts: list[str] = field(default_factory=list)
    workdir: str = "/pkg"


def default_container_spec(settings: Settings, **changes) -> ContainerSpec:
    spec = ContainerSpec(
        image=settings.sandbox_image,
        memory=f"{settings.sandbox_memory_mb}m",
        cpus=settings.sandbox_cpus,
        network_mode=settings.sandbox_network,
    )
    for key, value in changes.items():
        setattr(spec, key, value)
    return spec


def spec_to_docker_args(spec: ContainerSpec, container_name: str) -> list[str]:
    args = ["run", "-d", "--name", container_name, f"--network={spec.network_mode}"]
    args.extend(f"--cap-drop={cap}" for cap in spec.cap_drop)
    args.extend(f"--cap-add={cap}" for cap in spec.cap_add)
    if spec.read_only:
        args.append("--read-only")
    args.extend(
        [
            f"--memory={spec.memory}",
            f"--cpus={spec.cpus}",
            "--user",
            spec.user,
            "--pids-limit",
            str(spec.pids_limit),
        ]
    )
    for tmpfs in spec.tmpfs:
        args.extend(["--tmpfs", f"{tmpfs.path}:{tmpfs.options}"])
    for key, value in spec.envs.items():
        args.extend(["-e", f"{key}={value}"])
    if spec.preload:
        existing = spec.envs.get("NODE_OPTIONS")
        args.extend(
            ["-e", f"NODE_OPTIONS={existing + ' ' if existing else ''}--require {spec.preload}"]
        )
    if spec.ld_preload:
        args.extend(["-e", f"LD_PRELOAD={spec.ld_preload}"])
    if spec.hostname:
        args.extend(["--hostname", spec.hostname])
    for host in spec.extra_hosts:
        args.extend(["--add-host", host])
    for volume in spec.volumes:
        args.extend(
            ["-v", f"{volume.host_path}:{volume.container_path}{':ro' if volume.read_only else ''}"]
        )
    return [*args, "-w", spec.workdir, spec.image, "sleep", "infinity"]


async def write_file_in_container(container: str, path: str, content: str | bytes) -> None:
    raw = content.encode() if isinstance(content, str) else content
    encoded = base64.b64encode(raw).decode()
    quoted = shlex.quote(path)
    command = f"mkdir -p \"$(dirname {quoted})\" && printf '%s' {shlex.quote(encoded)} | base64 -d > {quoted}"
    result = await docker_exec(["exec", container, "sh", "-c", command], 15_000)
    if result.exit_code:
        raise RuntimeError(f"writeFileInContainer({path}) failed: {result.stderr[:300]}")


async def read_bytes_from_container(container: str, path: str, *, user: str | None = None) -> bytes:
    """Copy a file out of the container as EXACT bytes, with no encoding hop.

    `docker exec cat` streams stdout raw — no TTY is allocated, so there is no
    newline translation and nothing to decode — proven byte-exact for 8 MiB of
    /dev/urandom against real docker in `tests/e2e/test_docker_transfer.py`.
    Prefer this to `base64 -w0` for any binary evidence: base64 costs a 4/3
    inflation on top of MAX_EXEC_OUTPUT_BYTES, and that inflation is the entire
    reason a >7.5 MB pcap used to arrive as a 7.5 MiB prefix while `base64` exited
    0. `sensors.stop_pcap` is the one remaining base64 caller.

    `user="0"` reads a root-owned file (tcpdump writes its capture with -Z root).
    """
    stdout, stderr, exit_code, timed_out = await _exec_raw(
        ["exec", *(["--user", user] if user else []), container, "cat", path], 15_000
    )
    if exit_code or timed_out:
        raise RuntimeError(
            f"readBytesFromContainer({path}) failed: exit={exit_code} "
            f"timed_out={timed_out} {stderr.decode(errors='replace')[:300]}"
        )
    return stdout


async def read_file_in_container(container: str, path: str) -> str:
    return (await read_bytes_from_container(container, path)).decode(errors="replace")


def instrumentation_source(inspector: bool) -> str:
    """Concatenate the L4 instrument fragments into one CJS module.

    INVARIANT: the `require` hook is installed after every fragment that requires
    anything of its own, so no `require` event in the trace can be the
    instrument's. Order is the mechanism — `instrumentation-require-hook.js` must
    stay after monkey/inspector and before flush (which requires nothing). The
    engine-side check is the assertion in `evidence.parse_l4_trace`.
    """
    assets = Path(__file__).with_name("assets")
    parts = [(assets / "instrumentation-monkey.js").read_text(encoding="utf-8")]
    if inspector:
        parts.append((assets / "instrumentation-inspector.js").read_text(encoding="utf-8"))
    parts.append((assets / "instrumentation-require-hook.js").read_text(encoding="utf-8"))
    parts.append((assets / "instrumentation-flush.js").read_text(encoding="utf-8"))
    return "\n".join(parts)

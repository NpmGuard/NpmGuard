import asyncio
import base64
import shlex
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings


@dataclass(frozen=True)
class ExecResult:
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool


async def docker_exec(args: list[str], timeout_ms: int, stdin: bytes | None = None) -> ExecResult:
    process = await asyncio.create_subprocess_exec(
        "docker",
        *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(input=stdin), timeout_ms / 1000
        )
    except TimeoutError:
        process.kill()
        stdout, stderr = await process.communicate()
        return ExecResult(
            stdout.decode(errors="replace"), stderr.decode(errors="replace"), -1, True
        )
    return ExecResult(
        stdout[: 10 * 1024 * 1024].decode(errors="replace"),
        stderr[: 10 * 1024 * 1024].decode(errors="replace"),
        process.returncode or 0,
        False,
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
    tmpfs: list[TmpfsMount] = field(
        default_factory=lambda: [TmpfsMount("/tmp", "rw,noexec,nosuid,size=64m")]
    )
    pids_limit: int = 64
    user: str = "1000:1000"
    preload: str | None = None
    ld_preload: str | None = None
    hostname: str | None = None
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


async def read_file_in_container(container: str, path: str) -> str:
    result = await docker_exec(["exec", container, "cat", path], 15_000)
    if result.exit_code:
        raise RuntimeError(f"readFileInContainer({path}) failed: {result.stderr[:300]}")
    return result.stdout


def instrumentation_source(inspector: bool) -> str:
    assets = Path(__file__).with_name("assets")
    parts = [(assets / "instrumentation-monkey.js").read_text(encoding="utf-8")]
    if inspector:
        parts.append((assets / "instrumentation-inspector.js").read_text(encoding="utf-8"))
    parts.append((assets / "instrumentation-flush.js").read_text(encoding="utf-8"))
    return "\n".join(parts)

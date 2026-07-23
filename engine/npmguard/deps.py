from __future__ import annotations

import asyncio
import contextlib
import io
import json
import tarfile
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from .config import Settings
from .docker import docker_exec, write_file_in_container
from .errors import DockerUnavailableError

INSTALL_WALL_MS = 180_000
# node_modules is streamed out of the container's tmpfs via `tar` over exec stdout
# (docker cp cannot read tmpfs mounts). Cap the archive so a pathological dependency
# tree can't exhaust host memory.
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True)
class DependencyProvision:
    installed: bool
    package_count: int
    skipped_reason: str | None = None
    error: str | None = None


def _runtime_dependencies(package_path: Path) -> dict[str, str]:
    manifest = package_path / "package.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}
    deps = data.get("dependencies")
    if not isinstance(deps, dict):
        return {}
    return {key: value for key, value in deps.items() if isinstance(key, str) and isinstance(value, str)}


async def provision_dependencies(package_path: Path, settings: Settings) -> DependencyProvision:
    """Install the target package's runtime dependencies into ``package_path`` so
    experiments observe a loadable module graph instead of crashing at ``require``.

    Runs ``npm install --ignore-scripts`` in a throwaway, network-enabled sandbox
    container: dependency *code* is never executed (no lifecycle scripts) — deps are
    only downloaded and unpacked, then copied back to the host package dir so the
    existing ``/pkg-src -> /pkg`` copy carries ``node_modules`` into every experiment.

    Best-effort by design. A failure leaves ``node_modules`` absent; the orchestrator
    then DEFERS (never REFUTES) any experiment that crashes on the missing module, so
    an install failure can never be laundered into a false SAFE verdict.
    """
    if (package_path / "node_modules").exists():
        # package_path is this run's private copy (ResolvedPackage invariant), so
        # node_modules here means the package SHIPS it (e.g. bundledDependencies)
        # — it can never be residue observed from a previous audit run.
        return DependencyProvision(False, 0, skipped_reason="node_modules already present")
    deps = _runtime_dependencies(package_path)
    if not deps:
        return DependencyProvision(False, 0, skipped_reason="no runtime dependencies")

    container = f"npmguard-install-{uuid4().hex[:12]}"
    run_args = [
        "run",
        "-d",
        "--name",
        container,
        "--network=bridge",
        "--cap-drop=ALL",
        "--read-only",
        f"--memory={max(1024, settings.sandbox_memory_mb)}m",
        f"--cpus={max(2.0, settings.sandbox_cpus)}",
        "--pids-limit",
        "512",
        "--user",
        "1000:1000",
        "--tmpfs",
        "/work:rw,size=512m,uid=1000,gid=1000,mode=0755",
        "--tmpfs",
        "/tmp:rw,size=256m,uid=1000,gid=1000,mode=0755",
        "--tmpfs",
        "/home/node:rw,size=128m,uid=1000,gid=1000,mode=0755",
        "-e",
        "npm_config_cache=/tmp/.npm",
        "-e",
        "npm_config_update_notifier=false",
        "-w",
        "/work",
        settings.sandbox_image,
        "sleep",
        "infinity",
    ]
    try:
        start = await docker_exec(run_args, 30_000)
    except FileNotFoundError as exc:
        raise DockerUnavailableError() from exc
    if start.exit_code:
        return DependencyProvision(
            False, 0, error=f"install container failed to start: {start.stderr[:300]}"
        )

    try:
        manifest = {
            "name": "npmguard-install-target",
            "version": "0.0.0",
            "private": True,
            "dependencies": deps,
        }
        await write_file_in_container(
            container, "/work/package.json", json.dumps(manifest, separators=(",", ":"))
        )
        install = await docker_exec(
            [
                "exec",
                container,
                "npm",
                "install",
                "--ignore-scripts",
                "--omit=dev",
                "--no-package-lock",
                "--no-audit",
                "--no-fund",
                "--loglevel=warn",
            ],
            INSTALL_WALL_MS,
        )
        if install.timed_out:
            return DependencyProvision(
                False, 0, error=f"npm install exceeded {INSTALL_WALL_MS}ms budget"
            )
        if install.exit_code:
            return DependencyProvision(
                False, 0, error=f"npm install exit={install.exit_code}: {install.stderr[:300]}"
            )
        archive = await _stream_tar(container, "/work", "node_modules")
        if archive is None:
            return DependencyProvision(
                False, 0, error=f"node_modules exceeded {MAX_ARCHIVE_BYTES} byte extraction cap"
            )
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(package_path, filter="data")
        installed = sum(1 for entry in (package_path / "node_modules").glob("*") if entry.is_dir())
        return DependencyProvision(True, installed)
    finally:
        with contextlib.suppress(Exception):
            await docker_exec(["rm", "-f", container], 10_000)


async def _stream_tar(container: str, parent: str, name: str) -> bytes | None:
    """Emit ``parent/name`` from the container as a tar byte stream, capped at
    ``MAX_ARCHIVE_BYTES``. Returns None if the cap is exceeded."""
    process = await asyncio.create_subprocess_exec(
        "docker",
        "exec",
        container,
        "tar",
        "c",
        "-C",
        parent,
        name,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    assert process.stdout is not None
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await process.stdout.read(1 << 20)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_ARCHIVE_BYTES:
            process.kill()
            await process.wait()
            return None
        chunks.append(chunk)
    await process.wait()
    return b"".join(chunks)

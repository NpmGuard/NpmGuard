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
# Enough of tar's stderr to diagnose a failure; bounded so a pathological warning
# storm cannot be read into host memory.
STDERR_CAP_BYTES = 64 * 1024


@dataclass(frozen=True)
class DependencyProvision:
    installed: bool
    package_count: int
    skipped_reason: str | None = None
    error: str | None = None


class DependencyStreamError(Exception):
    """node_modules could not be streamed out of the install container intact."""


def _runtime_dependencies(package_path: Path) -> dict[str, str] | None:
    """The package's declared runtime dependencies, or None if the manifest could
    not be read at all.

    None and ``{}`` are deliberately different answers: "we could not read what
    this package depends on" is not "this package depends on nothing". Collapsing
    them reported ``skipped_reason="no runtime dependencies"`` for a manifest we
    had simply failed to parse — a reason that was false, and the only trace of the
    failure. Every require in the experiment then crashed on the missing module and
    the run DEFERRED, so a package could buy itself immunity from dynamic analysis
    by shipping an unparseable manifest.
    """
    manifest = package_path / "package.json"
    try:
        # utf-8-sig, because npm strips a UTF-8 BOM before parsing (verified: `npm
        # pkg get dependencies` reads a BOM'd manifest fine, while json.loads on the
        # same bytes raises). A plain utf-8 read made a BOM'd package.json — legal
        # input npm installs happily — look dependency-free.
        data = json.loads(manifest.read_text(encoding="utf-8-sig"))
    except (ValueError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    deps = data.get("dependencies")
    if deps is None:
        return {}
    if not isinstance(deps, dict):
        return None
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
    if deps is None:
        return DependencyProvision(
            False,
            0,
            error="package.json is unreadable or not valid JSON — dependencies unknown, "
            "not absent",
        )
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
        try:
            archive = await _stream_tar(container, "/work", "node_modules")
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(package_path, filter="data")
        except (DependencyStreamError, tarfile.TarError, OSError) as exc:
            return DependencyProvision(False, 0, error=f"node_modules extraction failed: {exc}")
        # INVARIANT: installed=True ⇒ node_modules exists on disk with at least one
        # package in it. `tar c` of a missing directory exits 2 but still writes a
        # VALID EMPTY 10240-byte archive (verified in the sandbox image), which
        # extracted cleanly, globbed a nonexistent directory to zero entries, and
        # returned installed=True / package_count=0 — a claimed success for a total
        # failure, indistinguishable downstream from a real install.
        installed = sum(1 for entry in (package_path / "node_modules").glob("*") if entry.is_dir())
        if not installed:
            return DependencyProvision(
                False,
                0,
                error=f"npm reported success but node_modules holds no packages "
                f"(archive {len(archive)} bytes) — dependencies were NOT provisioned",
            )
        return DependencyProvision(True, installed)
    finally:
        with contextlib.suppress(Exception):
            await docker_exec(["rm", "-f", container], 10_000)


async def _stream_tar(container: str, parent: str, name: str) -> bytes:
    """Emit ``parent/name`` from the container as a tar byte stream, capped at
    ``MAX_ARCHIVE_BYTES``.

    Raises ``DependencyStreamError`` for the cap and for a nonzero ``tar`` exit.
    The exit code is load-bearing, not hygiene: `tar c` of a directory that does
    not exist exits 2 while still writing a well-formed EMPTY archive, so ignoring
    it turned "there was nothing to copy" into "an archive was copied".
    """
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
        stderr=asyncio.subprocess.PIPE,
    )
    assert process.stdout is not None and process.stderr is not None
    # stderr is drained CONCURRENTLY: a 64KiB pipe that nobody reads blocks tar
    # mid-write, and we would then wait forever on a stdout that never ends.
    diagnostic = asyncio.create_task(process.stderr.read(STDERR_CAP_BYTES))
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            chunk = await process.stdout.read(1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_ARCHIVE_BYTES:
                process.kill()
                await process.wait()
                raise DependencyStreamError(
                    f"exceeded the {MAX_ARCHIVE_BYTES} byte extraction cap"
                )
            chunks.append(chunk)
        await process.wait()
    finally:
        stderr = (await diagnostic).decode(errors="replace") if not diagnostic.cancelled() else ""
    if process.returncode:
        raise DependencyStreamError(f"tar exit={process.returncode}: {stderr[:300]}")
    return b"".join(chunks)

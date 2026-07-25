import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from .config import REPO_ROOT, Settings
from .errors import PackageNotFoundError

# Bound at import, as before — `panel/watch.py` imports this name and uses it as a
# dataclass field default, so the module attribute is the seam and stays one. What
# changed is where the value comes from: a validated setting, so
# `NPMGUARD_NPM_REGISTRY=registry.npmjs.org` (no scheme) is a named boot rejection
# rather than an httpx UnsupportedProtocol raised inside a paid audit's resolve
# phase, and the trailing slash is normalised off for the f-string below.
# `Settings()` and not `get_settings()`: this is an import-time constant, and the
# cached singleton would additionally fix the whole config surface at whatever
# moment this module first got imported.
NPM_REGISTRY = Settings().npm_registry


@dataclass(frozen=True)
class ResolvedPackage:
    """A package staged for auditing.

    ``version`` is the registry-resolved concrete version (None for local
    test fixtures, which carry their version in package.json).
    """

    path: Path
    workdir: Path
    version: str | None = None

    def __post_init__(self) -> None:
        # INVARIANT: path lives inside workdir, a fresh per-run tmpdir owned
        # exclusively by this audit — fixtures are COPIED in, tarballs extracted
        # in — so nothing an audit writes (e.g. deps.py unpacking node_modules
        # into path) can mutate the committed fixture tree or leak across runs.
        assert self.path.resolve().is_relative_to(self.workdir.resolve()), (
            f"resolved path {self.path} escapes its private workdir {self.workdir}"
        )


def _test_fixture(package_name: str) -> Path | None:
    if not package_name.startswith("test-pkg-"):
        return None
    path = REPO_ROOT / "sandbox" / "test-fixtures" / package_name
    return path if path.exists() else None


async def resolve_tarball_url(package_name: str, version: str = "latest") -> tuple[str, str]:
    url = f"{NPM_REGISTRY}/{package_name}/{version}"
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(url)
    if response.status_code == 404:
        raise PackageNotFoundError(package_name)
    response.raise_for_status()
    data = response.json()
    resolved = data.get("version")
    tarball = (data.get("dist") or {}).get("tarball")
    if not isinstance(resolved, str) or not isinstance(tarball, str):
        raise ValueError(f"npm registry returned malformed metadata for {package_name}@{version}")
    return resolved, tarball


def _safe_extract(archive: tarfile.TarFile, destination: Path) -> None:
    root = destination.resolve()
    for member in archive.getmembers():
        target = (destination / member.name).resolve()
        if not target.is_relative_to(root):
            raise ValueError(f"tar entry escapes extraction root: {member.name}")
        if member.issym() or member.islnk():
            link_target = (target.parent / member.linkname).resolve()
            if not link_target.is_relative_to(root):
                raise ValueError(f"tar link escapes extraction root: {member.name}")
    archive.extractall(destination, filter="data")


def _reject_escaping_symlinks(root: Path, boundary: Path) -> None:
    """Mirror of _safe_extract's link check for the fixture-copy path: bench
    fixtures under sandbox/test-fixtures are live malware and may ship
    symlinks; a link resolving outside the private workdir would hand the
    audit a read/write channel to host files, breaking the ResolvedPackage
    invariant."""
    resolved_boundary = boundary.resolve()
    for entry in root.rglob("*"):
        if entry.is_symlink() and not entry.resolve().is_relative_to(resolved_boundary):
            raise ValueError(f"fixture symlink escapes the private workdir: {entry}")


def _package_root(extracted: Path, package_name: str) -> Path:
    """The package root is the unique candidate directory (``extracted`` itself
    or an immediate subdirectory — npm convention is ``package/``) holding a
    top-level package.json. Absence or ambiguity is a checked error, never an
    arbitrary-first-dir guess."""
    candidates = [extracted, *sorted(entry for entry in extracted.iterdir() if entry.is_dir())]
    roots = [candidate for candidate in candidates if (candidate / "package.json").is_file()]
    if len(roots) != 1:
        raise ValueError(
            f"tarball for {package_name} has no unambiguous package root: "
            f"{len(roots)} candidate directories contain a package.json"
        )
    return roots[0]


async def resolve_package(package_name: str, version: str | None = None) -> ResolvedPackage:
    workdir = Path(tempfile.mkdtemp(prefix="npmguard-"))
    try:
        fixture = _test_fixture(package_name)
        if fixture is not None:
            # Offline short-circuit for test-pkg-* fixtures — no network — but the
            # audit gets a private COPY: the committed fixture tree stays
            # byte-identical no matter what the run writes into `path`.
            path = workdir / fixture.name
            shutil.copytree(fixture, path, symlinks=True)
            _reject_escaping_symlinks(path, workdir)
            return ResolvedPackage(path=path, workdir=workdir)

        resolved_version, tarball_url = await resolve_tarball_url(
            package_name, version or "latest"
        )
        archive_path = workdir / "package.tgz"
        async with (
            httpx.AsyncClient(timeout=60, follow_redirects=True) as client,
            client.stream("GET", tarball_url) as response,
        ):
            response.raise_for_status()
            with archive_path.open("wb") as output:
                async for chunk in response.aiter_bytes():
                    output.write(chunk)
        extracted = workdir / "extracted"
        extracted.mkdir()
        with tarfile.open(archive_path, "r:gz") as archive:
            _safe_extract(archive, extracted)
        return ResolvedPackage(
            path=_package_root(extracted, package_name),
            workdir=workdir,
            version=resolved_version,
        )
    except BaseException:
        # INVARIANT: resolve_package either RETURNS a ResolvedPackage that owns
        # `workdir`, or leaves no workdir behind — there is no third state where a
        # tmpdir exists with no owner to call cleanup_package on it.
        # BaseException, not Exception: asyncio.CancelledError is a BaseException in
        # 3.8+, and this function awaits a registry lookup and a streaming tarball
        # download. `except Exception` therefore missed the two cancellations that
        # actually happen — the phase's own timeout and engine shutdown — and each
        # one leaked the whole extracted package tree into /tmp. Verified by
        # probe: cancel during the download, one npmguard-* workdir left behind.
        shutil.rmtree(workdir, ignore_errors=True)
        raise


def cleanup_package(resolved: ResolvedPackage) -> None:
    # workdir is always this run's private tmpdir (see ResolvedPackage
    # invariant), so removal is unconditional — no needs_cleanup tri-state.
    shutil.rmtree(resolved.workdir, ignore_errors=True)

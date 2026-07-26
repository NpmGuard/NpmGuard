import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from .config import Settings
from .errors import PackageNotFoundError

# `panel/watch.py` captures this module attribute as a dataclass default. Resolve
# it from validated settings at import so every consumer sees the same normalized
# registry URL.
NPM_REGISTRY = Settings().npm_registry


@dataclass(frozen=True)
class ResolvedPackage:
    """A package staged for auditing.

    ``version`` is the registry-resolved concrete version, and None for a
    package staged from a local path — nothing resolved it, so there is no
    version to claim.
    """

    path: Path
    workdir: Path
    version: str | None = None

    def __post_init__(self) -> None:
        # INVARIANT: every staged package lives in the private workdir owned by
        # this audit, so writes cannot mutate its source or leak across runs.
        assert self.path.resolve().is_relative_to(self.workdir.resolve()), (
            f"resolved path {self.path} escapes its private workdir {self.workdir}"
        )


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
    """Reject links that would give a staged package access to host files."""
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


async def resolve_package(
    package_name: str, version: str | None = None, local_path: str | None = None
) -> ResolvedPackage:
    # INVARIANT: the source is DECLARED by the caller, never inferred from the
    # package name — `local_path is None` iff this resolves from the registry.
    workdir = Path(tempfile.mkdtemp(prefix="npmguard-"))
    try:
        if local_path is not None:
            # Corpus packages can be live malware. Copy the admitted package
            # directory so the run cannot write into the source tree. Absolute,
            # and a package directory: both checked at admission
            # (`validation.valid_local_path_shape`, `api._local_path_refused`).
            source = Path(local_path)
            path = workdir / source.name
            shutil.copytree(source, path, symlinks=True)
            _reject_escaping_symlinks(path, workdir)
            return ResolvedPackage(path=path, workdir=workdir)

        resolved_version, tarball_url = await resolve_tarball_url(package_name, version or "latest")
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
        # INVARIANT: failure or cancellation before ownership is returned leaves
        # no workdir behind. Cancellation is a BaseException.
        shutil.rmtree(workdir, ignore_errors=True)
        raise


def cleanup_package(resolved: ResolvedPackage) -> None:
    shutil.rmtree(resolved.workdir, ignore_errors=True)

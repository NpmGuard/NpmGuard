import os
import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from .config import REPO_ROOT
from .errors import PackageNotFoundError

NPM_REGISTRY = os.environ.get("NPMGUARD_NPM_REGISTRY") or "https://registry.npmjs.org"


@dataclass(frozen=True)
class ResolvedPackage:
    path: Path
    needs_cleanup: bool = False
    tmpdir: Path | None = None


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


async def resolve_package(package_name: str, version: str | None = None) -> ResolvedPackage:
    fixture = _test_fixture(package_name)
    if fixture is not None:
        return ResolvedPackage(path=fixture)

    _, tarball_url = await resolve_tarball_url(package_name, version or "latest")
    tmpdir = Path(tempfile.mkdtemp(prefix="npmguard-"))
    try:
        archive_path = tmpdir / "package.tgz"
        async with (
            httpx.AsyncClient(timeout=60, follow_redirects=True) as client,
            client.stream("GET", tarball_url) as response,
        ):
            response.raise_for_status()
            with archive_path.open("wb") as output:
                async for chunk in response.aiter_bytes():
                    output.write(chunk)
        extracted = tmpdir / "extracted"
        extracted.mkdir()
        with tarfile.open(archive_path, "r:gz") as archive:
            _safe_extract(archive, extracted)
        package_dir = extracted / "package"
        if not package_dir.exists():
            package_dir = next(
                (entry for entry in extracted.iterdir() if entry.is_dir()), extracted
            )
        return ResolvedPackage(path=package_dir, needs_cleanup=True, tmpdir=tmpdir)
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise


def cleanup_package(resolved: ResolvedPackage) -> None:
    if resolved.needs_cleanup and resolved.tmpdir is not None:
        shutil.rmtree(resolved.tmpdir, ignore_errors=True)

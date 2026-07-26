"""Package acquisition through the public resolver boundary.

Local-path cases use synthetic trees and never touch committed fixtures. Registry
cases run `resolve_package` over captured npm metadata and tarballs, with HTTP
replaced at the transport boundary. Axes: acquisition source, workdir ownership,
cleanup outcome, symlink containment, package-root shape, and metadata validity.
"""

import io
import json
import tarfile
import tempfile
from pathlib import Path
from typing import Any

import httpx
import pytest

from npmguard.resolve import (
    ResolvedPackage,
    cleanup_package,
    resolve_package,
    resolve_tarball_url,
)

REGISTRY_FIXTURES = Path(__file__).parent / "fixtures" / "registry"


def _leaked_workdirs() -> list[Path]:
    """npmguard workdirs still holding this test's fixture copy."""
    return [
        d
        for d in Path(tempfile.gettempdir()).glob("npmguard-*")
        if (d / "test-pkg-alpha" / "sneaky").exists()
    ]


def _tree_snapshot(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


@pytest.fixture
def fixture_tree(tmp_path) -> Path:
    """A synthetic committed-fixture stand-in so a broken implementation can
    never dirty the real repo tree."""
    source = tmp_path / "repo" / "sandbox" / "test-fixtures" / "test-pkg-alpha"
    (source / "lib").mkdir(parents=True)
    (source / "package.json").write_text('{"name":"test-pkg-alpha","version":"1.0.0"}')
    (source / "lib" / "index.js").write_text("module.exports = 1;\n")
    return source


async def test_fixture_resolve_returns_private_copy(fixture_tree) -> None:
    """A local package is copied inside a private per-run workdir."""
    resolved = await resolve_package("test-pkg-alpha", local_path=str(fixture_tree))
    try:
        assert resolved.path != fixture_tree
        assert resolved.path.resolve().is_relative_to(resolved.workdir.resolve())
        assert not resolved.path.resolve().is_relative_to(fixture_tree.resolve())
        assert _tree_snapshot(resolved.path) == _tree_snapshot(fixture_tree)
        assert resolved.version is None  # fixture version lives in package.json
    finally:
        cleanup_package(resolved)


async def test_audit_writes_never_mutate_fixture_source(fixture_tree) -> None:
    """Writes to the staged package leave its source byte-identical."""
    before = _tree_snapshot(fixture_tree)
    resolved = await resolve_package("test-pkg-alpha", local_path=str(fixture_tree))
    try:
        (resolved.path / "node_modules" / "left-pad").mkdir(parents=True)
        (resolved.path / "node_modules" / "left-pad" / "index.js").write_text("evil")
        (resolved.path / "package.json").write_text("{}")
        assert _tree_snapshot(fixture_tree) == before
    finally:
        cleanup_package(resolved)
    assert _tree_snapshot(fixture_tree) == before


async def test_runs_share_nothing(fixture_tree) -> None:
    """Consecutive resolves cannot observe each other's files."""
    first = await resolve_package("test-pkg-alpha", local_path=str(fixture_tree))
    (first.path / "node_modules").mkdir()
    (first.path / "node_modules" / "marker").write_text("run-1")
    cleanup_package(first)
    second = await resolve_package("test-pkg-alpha", local_path=str(fixture_tree))
    try:
        assert second.path != first.path
        assert not (second.path / "node_modules").exists()
    finally:
        cleanup_package(second)


async def test_cleanup_is_unconditional(fixture_tree) -> None:
    """Cleanup removes the owned workdir and is idempotent."""
    resolved = await resolve_package("test-pkg-alpha", local_path=str(fixture_tree))
    assert resolved.workdir.exists()
    cleanup_package(resolved)
    assert not resolved.workdir.exists()
    cleanup_package(resolved)  # idempotent, never raises


def test_path_escaping_workdir_is_rejected(tmp_path) -> None:
    """A staged package path cannot escape its owned workdir."""
    outside = tmp_path / "outside"
    outside.mkdir()
    workdir = tmp_path / "work"
    workdir.mkdir()
    with pytest.raises(AssertionError, match="escapes its private workdir"):
        ResolvedPackage(path=outside, workdir=workdir)
    ResolvedPackage(path=workdir / "pkg", workdir=workdir)  # inside: fine


async def test_escaping_fixture_symlink_is_rejected(fixture_tree, tmp_path) -> None:
    """An escaping symlink cannot give a staged package access to host files."""
    secret = tmp_path / "host-secret"
    secret.write_text("hunter2")
    (fixture_tree / "sneaky").symlink_to(secret)
    with pytest.raises(ValueError, match="escapes the private workdir"):
        await resolve_package("test-pkg-alpha", local_path=str(fixture_tree))
    assert _leaked_workdirs() == []

    # an internal relative symlink travels with the copy and is allowed
    (fixture_tree / "sneaky").unlink()
    (fixture_tree / "alias.js").symlink_to(Path("lib") / "index.js")
    resolved = await resolve_package("test-pkg-alpha", local_path=str(fixture_tree))
    try:
        assert (resolved.path / "alias.js").read_text() == "module.exports = 1;\n"
    finally:
        cleanup_package(resolved)


async def test_cancelled_resolve_leaves_no_workdir(monkeypatch, tmp_path) -> None:
    """Cancellation before ownership is returned leaves no workdir."""
    import asyncio

    inside = asyncio.Event()

    async def never(package_name, version="latest"):
        # Reached only after the workdir exists, so the cancel lands INSIDE the try.
        inside.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr("npmguard.resolve.resolve_tarball_url", never)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    before = set(tmp_path.glob("npmguard-*"))
    task = asyncio.create_task(resolve_package("chalk", "5.6.2"))
    await asyncio.wait_for(inside.wait(), timeout=5)
    assert set(tmp_path.glob("npmguard-*")) - before  # the workdir to be leaked
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert set(tmp_path.glob("npmguard-*")) == before


async def test_captured_registry_packages_resolve_end_to_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Captured npm metadata and tarballs pass through the complete resolver."""
    captures = sorted(REGISTRY_FIXTURES.glob("*/packument-subset.json"))
    assert captures, "the committed registry captures are the point of this test"
    served: dict[str, Any] = {"document": {}, "tarball": b""}
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if request.url.path.endswith(".tgz"):
            return httpx.Response(200, content=served["tarball"])
        return httpx.Response(200, json=served["document"])

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    class Patched(original):  # the seam: resolve_tarball_url builds its own client
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Patched)

    for metadata_path in captures:
        document = json.loads(metadata_path.read_text())
        served["document"] = document
        served["tarball"] = next(metadata_path.parent.glob("*.tgz")).read_bytes()
        before = len(requests)
        resolved = await resolve_package(document["name"], document["version"])
        try:
            assert resolved.version == document["version"]
            assert (
                json.loads((resolved.path / "package.json").read_text())["name"] == document["name"]
            )
            assert requests[before:] == [
                f"https://registry.npmjs.org/{document['name']}/{document['version']}",
                str(httpx.URL(document["dist"]["tarball"])),
            ]
        finally:
            cleanup_package(resolved)


async def test_malformed_registry_metadata_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Registry metadata must carry both a concrete version and tarball URL."""
    served: dict[str, Any] = {}

    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=served))
    original = httpx.AsyncClient

    class Patched(original):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Patched)

    for broken in ({"version": "1.0.0"}, {"dist": {"tarball": "http://x/y.tgz"}}, {}):
        served.clear()
        served.update(broken)
        with pytest.raises(ValueError, match="malformed metadata"):
            await resolve_tarball_url("chalk", "5.6.2")


@pytest.mark.parametrize("roots", [(), ("a", "b")], ids=["no-root", "ambiguous-root"])
async def test_registry_tarball_requires_one_package_root(
    roots: tuple[str, ...],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """A registry archive must contain exactly one top-level package manifest."""
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for root in roots:
            body = b"{}"
            member = tarfile.TarInfo(f"{root}/package.json")
            member.size = len(body)
            archive.addfile(member, io.BytesIO(body))

    document = {
        "version": "1.0.0",
        "dist": {"tarball": "http://registry.test/pkg/-/pkg-1.0.0.tgz"},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".tgz"):
            return httpx.Response(200, content=output.getvalue())
        return httpx.Response(200, json=document)

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    class Patched(original):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Patched)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    before = set(tmp_path.glob("npmguard-*"))
    with pytest.raises(ValueError, match="no unambiguous package root"):
        await resolve_package("pkg", "1.0.0")
    assert set(tmp_path.glob("npmguard-*")) == before

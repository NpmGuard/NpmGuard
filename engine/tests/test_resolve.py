# CLASS MAP — resolve (seam: REPO_ROOT monkeypatched to a synthetic fixture tree;
# no network — the registry path is exercised only through its pure helpers)
# Axes: fixture staging, workdir ownership, cleanup, package-root detection
#   C1 fixture resolve stages a private COPY — path is under workdir, not the
#      fixture tree, and content matches the source
#   C2 INVARIANT (was pipeline-phases[1], UNENFORCED before): mutating the
#      resolved path — including unpacking node_modules into it, the deps.py
#      write — leaves the committed fixture tree byte-identical
#   C3 two resolves of the same fixture share nothing: distinct dirs, writes in
#      one invisible to the other (kills the cross-run node_modules skip leak)
#   C4 cleanup_package removes workdir unconditionally — no needs_cleanup
#      tri-state survives
#   C5 ResolvedPackage rejects a path escaping its workdir (the invariant guard)
#   C6 _package_root: npm-standard package/ and flat roots are found
#      deterministically; zero or multiple package.json roots is a checked
#      ValueError — the arbitrary-first-dir guess is dead (a dir without
#      package.json is never picked just for being first)
#   C7 the real committed sandbox/test-fixtures tree: resolve returns a copy
#      OUTSIDE the repo, source dir untouched
#   C8 a fixture shipping a symlink that escapes the workdir (bench fixtures
#      are live malware) is a checked ValueError and leaks no tmpdir — the
#      fixture path enforces the same link boundary _safe_extract gives
#      tarballs; internal relative symlinks stay allowed
import tempfile
from pathlib import Path

import pytest

from npmguard.config import REPO_ROOT
from npmguard.resolve import (
    ResolvedPackage,
    _package_root,
    cleanup_package,
    resolve_package,
)


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
def fixture_tree(tmp_path, monkeypatch) -> Path:
    """A synthetic committed-fixture stand-in so a broken implementation can
    never dirty the real repo tree."""
    source = tmp_path / "repo" / "sandbox" / "test-fixtures" / "test-pkg-alpha"
    (source / "lib").mkdir(parents=True)
    (source / "package.json").write_text('{"name":"test-pkg-alpha","version":"1.0.0"}')
    (source / "lib" / "index.js").write_text("module.exports = 1;\n")
    monkeypatch.setattr("npmguard.resolve.REPO_ROOT", tmp_path / "repo")
    return source


async def test_fixture_resolve_returns_private_copy(fixture_tree) -> None:
    """C1: the resolved path is a copy inside a per-run workdir — never the
    fixture source dir — with identical content."""
    resolved = await resolve_package("test-pkg-alpha")
    try:
        assert resolved.path != fixture_tree
        assert resolved.path.resolve().is_relative_to(resolved.workdir.resolve())
        assert not resolved.path.resolve().is_relative_to(fixture_tree.resolve())
        assert _tree_snapshot(resolved.path) == _tree_snapshot(fixture_tree)
        assert resolved.version is None  # fixture version lives in package.json
    finally:
        cleanup_package(resolved)


async def test_audit_writes_never_mutate_fixture_source(fixture_tree) -> None:
    """C2 — INVARIANT: writes into the resolved path (node_modules unpacking,
    file edits) leave the fixture source byte-identical."""
    before = _tree_snapshot(fixture_tree)
    resolved = await resolve_package("test-pkg-alpha")
    try:
        (resolved.path / "node_modules" / "left-pad").mkdir(parents=True)
        (resolved.path / "node_modules" / "left-pad" / "index.js").write_text("evil")
        (resolved.path / "package.json").write_text("{}")
        assert _tree_snapshot(fixture_tree) == before
    finally:
        cleanup_package(resolved)
    assert _tree_snapshot(fixture_tree) == before


async def test_runs_share_nothing(fixture_tree) -> None:
    """C3: consecutive resolves are fully isolated — the second run can never
    observe the first run's node_modules (the old shared-dir skip leak)."""
    first = await resolve_package("test-pkg-alpha")
    (first.path / "node_modules").mkdir()
    (first.path / "node_modules" / "marker").write_text("run-1")
    cleanup_package(first)
    second = await resolve_package("test-pkg-alpha")
    try:
        assert second.path != first.path
        assert not (second.path / "node_modules").exists()
    finally:
        cleanup_package(second)


async def test_cleanup_is_unconditional(fixture_tree) -> None:
    """C4: cleanup_package always removes the workdir — there is no
    needs_cleanup tri-state left to consult."""
    resolved = await resolve_package("test-pkg-alpha")
    assert resolved.workdir.exists()
    cleanup_package(resolved)
    assert not resolved.workdir.exists()
    cleanup_package(resolved)  # idempotent, never raises


def test_path_escaping_workdir_is_rejected(tmp_path) -> None:
    """C5: the invariant guard — a ResolvedPackage whose path is outside its
    workdir cannot be constructed."""
    outside = tmp_path / "outside"
    outside.mkdir()
    workdir = tmp_path / "work"
    workdir.mkdir()
    with pytest.raises(AssertionError, match="escapes its private workdir"):
        ResolvedPackage(path=outside, workdir=workdir)
    ResolvedPackage(path=workdir / "pkg", workdir=workdir)  # inside: fine


def test_package_root_is_checked_never_guessed(tmp_path) -> None:
    """C6: root detection finds the unique package.json holder (package/ or a
    flat root) and raises on zero or ambiguous candidates instead of guessing
    an arbitrary first directory."""
    # npm-standard package/ layout
    standard = tmp_path / "standard"
    (standard / "package").mkdir(parents=True)
    (standard / "package" / "package.json").write_text("{}")
    assert _package_root(standard, "pkg") == standard / "package"

    # flat layout: package.json at the extraction root
    flat = tmp_path / "flat"
    (flat / "lib").mkdir(parents=True)
    (flat / "package.json").write_text("{}")
    assert _package_root(flat, "pkg") == flat

    # non-standard dir name: still found because it holds package.json —
    # a manifest-less sibling sorting first is NOT picked (guess is dead)
    odd = tmp_path / "odd"
    (odd / "aaa-decoy").mkdir(parents=True)
    (odd / "zzz-real").mkdir()
    (odd / "zzz-real" / "package.json").write_text("{}")
    assert _package_root(odd, "pkg") == odd / "zzz-real"

    # zero candidates → checked error
    empty = tmp_path / "empty"
    (empty / "docs").mkdir(parents=True)
    with pytest.raises(ValueError, match="no unambiguous package root"):
        _package_root(empty, "pkg")

    # ambiguous candidates → checked error
    ambiguous = tmp_path / "ambiguous"
    (ambiguous / "a").mkdir(parents=True)
    (ambiguous / "b").mkdir()
    (ambiguous / "a" / "package.json").write_text("{}")
    (ambiguous / "b" / "package.json").write_text("{}")
    with pytest.raises(ValueError, match="no unambiguous package root"):
        _package_root(ambiguous, "pkg")


async def test_escaping_fixture_symlink_is_rejected(fixture_tree, tmp_path) -> None:
    """C8: a fixture symlink resolving outside the private workdir (live-malware
    bench fixtures can ship these) fails loud instead of handing the audit a
    host read/write channel; the failed run leaks no workdir."""
    secret = tmp_path / "host-secret"
    secret.write_text("hunter2")
    (fixture_tree / "sneaky").symlink_to(secret)
    with pytest.raises(ValueError, match="escapes the private workdir"):
        await resolve_package("test-pkg-alpha")
    assert _leaked_workdirs() == []

    # an internal relative symlink travels with the copy and is allowed
    (fixture_tree / "sneaky").unlink()
    (fixture_tree / "alias.js").symlink_to(Path("lib") / "index.js")
    resolved = await resolve_package("test-pkg-alpha")
    try:
        assert (resolved.path / "alias.js").read_text() == "module.exports = 1;\n"
    finally:
        cleanup_package(resolved)


async def test_real_committed_fixture_resolves_outside_repo() -> None:
    """C7: against the actual repo tree — the resolved path is outside
    sandbox/test-fixtures and the source survives cleanup untouched."""
    fixture_dir = REPO_ROOT / "sandbox" / "test-fixtures" / "test-pkg-child-success"
    if not fixture_dir.exists():
        pytest.skip("committed fixture tree not present")
    before = _tree_snapshot(fixture_dir)
    resolved = await resolve_package("test-pkg-child-success")
    try:
        assert not resolved.path.resolve().is_relative_to(REPO_ROOT.resolve())
    finally:
        cleanup_package(resolved)
    assert _tree_snapshot(fixture_dir) == before

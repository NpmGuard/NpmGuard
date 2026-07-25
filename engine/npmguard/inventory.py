import json
import re
import shlex
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .config import SKIP_DIRS, SOURCE_FILE_TYPES
from .contract.models import (
    DealBreaker,
    EntryPoints,
    FileRecord,
    InventoryFlag,
    InventoryReport,
    PackageMetadata,
)
from .errors import AuditIncompleteError

# The ONE check name for every install-time coverage gap, shared with the consumer
# that has to refuse SAFE while one exists (pipeline.py). A named constant rather
# than a literal in three places because the two modules now agree on it: a typo on
# either side would not fail — it would silently produce a report that ships SAFE
# with the gap still open, which is the exact failure this fact exists to prevent.
INSTALL_COVERAGE_GAP = "install-coverage-gap"

# The three hooks npm runs when a PUBLISHED TARBALL is installed as a dependency —
# which is the only artifact an audit ever resolves (resolve.py fetches a registry
# tarball), so this is the only execution the engine can be asked about.
# `prepare`/`prepublish` are BUILD-time: npm runs them for the ROOT project on a
# bare `npm install`, on pack/publish, for a link install and for a git dependency
# — never for a registry tarball dependency (npm 12,
# `docs/content/using-npm/scripts.md`, "Life Cycle Operation Order"). Ordered
# tuples, not a set: `entryPoints.install` and the dealbreaker detail are both
# derived by iterating these, and frozenset iteration order over str varies per
# PROCESS (hash randomization) — which makes the report's entryPoints order, the
# flag order, and therefore the hypothesize prompt text differ between two audits
# of the same bytes.
INSTALL_TIME_HOOKS = ("preinstall", "install", "postinstall")
BUILD_TIME_HOOKS = ("prepare", "prepublish")
LIFECYCLE_SCRIPTS = frozenset(INSTALL_TIME_HOOKS + BUILD_TIME_HOOKS)
EXTENSION_TYPE_MAP = {
    ".js": "js",
    ".mjs": "js",
    ".cjs": "js",
    ".jsx": "js",
    ".json": "json",
    ".md": "doc",
    ".txt": "doc",
    ".html": "web",
    ".css": "web",
    ".ts": "ts",
    ".tsx": "ts",
    ".mts": "ts",
    ".cts": "ts",
    ".sh": "shell",
    ".map": "sourcemap",
    ".yml": "config",
    ".yaml": "config",
}
MAGIC_BYTES = (
    ("ELF", b"\x7fELF"),
    ("MachO", b"\xcf\xfa\xed\xfe"),
    ("MachO", b"\xce\xfa\xed\xfe"),
    ("PE", b"MZ"),
)
# Enough for the longest real shebang line and for every magic number above. Read
# once per file, so `#!` recognition costs no extra open and no extra syscall.
HEAD_BYTES = 256
# A shebang is the file's own declaration of the language it is written in, and it
# outranks the file NAME because it is what the kernel obeys. Only interpreters whose
# language some model in this engine actually reads are mapped. It matters because
# ~14% of real `bin` targets ship extensionless (`typescript`'s bin/tsc, rollup,
# esbuild, acorn, uuid): without this a DECLARED executable entry point classifies
# `unknown` and is read by nobody, and `executable-outside-bin` does not fire on it
# either because it sits under `bin/`. Anything else with a shebang (`#!/usr/bin/env python3`) stays `unknown` on
# purpose: `unknown` is what keeps it a coverage gap instead of silently clean.
SHEBANG_TYPE_MAP = {
    "node": "js",
    "nodejs": "js",
    "bun": "js",
    "deno": "js",
    "sh": "shell",
    "bash": "shell",
    "dash": "shell",
    "zsh": "shell",
    "ksh": "shell",
}
SHELL_PIPE_PATTERNS = (
    re.compile(r"curl\s.*\|\s*sh\b", re.I),
    re.compile(r"curl\s.*\|\s*bash\b", re.I),
    re.compile(r"wget\s.*\|\s*sh\b", re.I),
    re.compile(r"wget\s.*\|\s*bash\b", re.I),
    re.compile(r"curl\s.*\|", re.I),
    re.compile(r"wget\s.*-O.*&&\s*(?:sh|bash|chmod)", re.I),
)
STANDARD_DOTFILES = frozenset({".npmignore", ".gitignore", ".browserslistrc", ".editorconfig"})
STANDARD_DOTFILE_PREFIXES = (".eslintrc", ".prettierrc", ".babelrc")
# Programs whose first non-flag operand IS a script path, by their own documented
# CLI contract. NOT a soundness boundary — see classify_install_hooks: an
# interpreter missing from this set degrades its hook to a coverage GAP, never to
# "clean", so the set may be incomplete without ever producing a false SAFE. That
# is the difference between this and a pattern list like SHELL_PIPE_PATTERNS,
# which has to be complete to be sound.
NODE_INTERPRETERS = frozenset({"node", "nodejs", "bun", "deno"})
SCRIPT_INTERPRETERS = NODE_INTERPRETERS | frozenset(
    {
        "sh",
        "bash",
        "dash",
        "zsh",
        "ksh",
        "python",
        "python2",
        "python3",
        "ruby",
        "perl",
        "php",
        "pwsh",
        "powershell",
        "osascript",
    }
)
# Flags after which the next word is a PROGRAM, not a path: what executes lives in
# the manifest string, so no file in the tarball can account for it. `msw@2.15.0`
# ships `postinstall: node -e "import('./config/scripts/postinstall.js')…"`, whose
# inline code read as a FILENAME reports a missing install script — a DANGEROUS
# verdict on a benign package.
INLINE_CODE_FLAGS = frozenset({"-e", "--eval", "-p", "--print", "-c", "--command", "-m"})
# Node's own CommonJS resolution of a path target: `node scripts/postinstall`
# executes `scripts/postinstall.js`, and `node .` reads `main` out of the
# directory's package.json. Verified by execution (`node dir/postinstall` loads
# `postinstall.js`). protobufjs ships exactly this extensionless shape, and without
# the resolution it is a false `missing-install-script` dealbreaker.
NODE_EXTENSION_CANDIDATES = (".js", ".json", ".node", ".mjs", ".cjs")
NODE_DIRECTORY_CANDIDATES = (
    "package.json",
    "index.js",
    "index.json",
    "index.node",
    "index.mjs",
    "index.cjs",
)
# shlex(punctuation_chars=True) emits these as standalone tokens, so a compound
# command is split on them instead of being read as one word list. Without the
# split, `node build.js; tsc src/constants.ts` yields the reference `build.js;` —
# semicolon included — which no package can ever contain.
SHELL_OPERATORS = frozenset({"&&", "||", ";", ";;", "|", "|&", "&"})


@dataclass(frozen=True)
class InstallTarget:
    """A file an install-time hook will hand to an interpreter."""

    hook: str
    reference: str
    module_resolution: bool


@dataclass(frozen=True)
class InstallGap:
    """An install-time hook whose executed code this audit cannot locate."""

    hook: str
    command: str
    reason: str


def _string_record(value: Any) -> dict[str, str]:
    return (
        {key: item for key, item in value.items() if isinstance(item, str)}
        if isinstance(value, dict)
        else {}
    )


def _string_list(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _command_segments(command: str) -> list[list[str]] | None:
    """Split one script value into the word list of each command it runs, quoting
    respected. `None` means the value is not lexable as a shell command at all."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    segments: list[list[str]] = [[]]
    try:
        for token in lexer:
            if token in SHELL_OPERATORS:
                segments.append([])
            else:
                segments[-1].append(token)
    except ValueError:
        return None
    return [segment for segment in segments if segment]


def _segment_target(hook: str, words: list[str]) -> tuple[InstallTarget | None, str | None]:
    """Classify one command. Exactly one of (target, reason) is not None."""
    program = PurePosixPath(words[0]).name
    if program not in SCRIPT_INTERPRETERS:
        # A command carrying a path separator executes a FILE, through its shebang
        # — `"postinstall": "./scripts/postinstall.sh"` is the same fact as `sh
        # ./scripts/postinstall.sh`, so it has to resolve the same way or the hole
        # this function closes reopens in a different spelling. A bare name is not:
        # npm runs scripts with node_modules/.bin on PATH and the package root NOT
        # on it, so `install.sh` alone is a PATH lookup that cannot be a package
        # file. Paths into a SKIP_DIRS directory are excluded because classify_files
        # never inventoried them, so "absent from `files`" would not mean absent
        # from the tarball — `node_modules/.bin/patch-package` would be a false
        # dealbreaker. Those stay gaps, which is what not having the bytes means.
        if "/" in words[0] and not any(
            part in SKIP_DIRS for part in PurePosixPath(words[0]).parts
        ):
            return InstallTarget(hook, str(PurePosixPath(words[0])), False), None
        return None, f"'{program}' is not an interpreter whose script argument we can identify"
    # Options precede the script path, so only the flags BEFORE the first operand
    # decide whether one exists. Scanning the whole word list would read `node
    # build.js -e production` — a `-e` belonging to the SCRIPT — as inline code and
    # lose a target that resolves perfectly well.
    operand: str | None = None
    for word in words[1:]:
        if not word.startswith("-"):
            operand = word
            break
        if word.split("=", 1)[0] in INLINE_CODE_FLAGS:
            return None, f"'{program}' runs code given inline, not a file shipped in the package"
    if operand is None:
        return None, f"'{program}' was given no script path (a REPL, or a program on stdin)"
    if any(character in operand for character in "$`*?"):
        return None, f"'{program}' resolves its script path at run time: {operand}"
    return (
        InstallTarget(
            hook=hook,
            reference=str(PurePosixPath(operand)),
            module_resolution=program in NODE_INTERPRETERS,
        ),
        None,
    )


def classify_install_hooks(
    scripts: dict[str, str],
) -> tuple[tuple[InstallTarget, ...], tuple[InstallGap, ...]]:
    """Split every install-time hook into the files it runs and the gaps it leaves.

    INVARIANT: every command in every install-time hook lands in exactly one of the
    two returned tuples. There is no third outcome, and in particular no outcome
    that looks like "this package has no install-time hook" — which is what the
    previous extractor produced for any interpreter other than `node`.
    `entryPoints.install == []` therefore used to denote two opposite facts at
    once, "nothing runs at install time" and "something runs and we could not see
    what", and `run_inventory_checks` read them identically: `"install": "sh
    install.sh"` with install.sh absent from the tarball was as clean as a library
    with no scripts block. Making the second fact a value rather than an absence is
    what closes that, and it closes it for every interpreter and every command
    shape at once, including the ones SHELL_PIPE_PATTERNS misses (`curl -o f url
    && sh f`, `sh -c "$(curl …)"`, a base64-decoded pipeline): none of them yields
    a target, so all of them are gaps.

    Soundness therefore does not depend on SCRIPT_INTERPRETERS being complete. An
    unlisted interpreter, an unlexable value, a computed path — every failure to
    understand a command produces a gap, and a gap is a coverage gap that must
    never reach SAFE. Recognising MORE shapes only ever converts a gap into a
    precise answer; it cannot convert a gap into "clean".
    """
    targets: list[InstallTarget] = []
    gaps: list[InstallGap] = []
    for hook in INSTALL_TIME_HOOKS:
        command = (scripts.get(hook) or "").strip()
        if not command:
            continue
        segments = _command_segments(command)
        if segments is None:
            gaps.append(InstallGap(hook, command, "the value is not lexable as a shell command"))
            continue
        if not segments:
            gaps.append(InstallGap(hook, command, "the value contains no command to run"))
            continue
        reasons: list[str] = []
        for words in segments:
            target, reason = _segment_target(hook, words)
            if target is not None:
                targets.append(target)
            elif reason is not None:
                reasons.append(reason)
        # One gap per HOOK, not per command: `prebuild-install || node-gyp rebuild`
        # is a single unanalysable hook, and two flags quoting the same command
        # would make the flag count read as two separate gaps.
        if reasons:
            gaps.append(InstallGap(hook, command, "; ".join(dict.fromkeys(reasons))))
    return tuple(targets), tuple(gaps)


def _exports_entries(value: Any) -> list[str]:
    """Every string leaf of the `exports` tree.

    A leaf can sit under a LIST as well as a dict: node's exports syntax allows an
    array of fallbacks (`"exports": {".": ["./new.js", "./old.js"]}`), and the
    recursion used to stop at one, dropping the entry point entirely. Measured over
    1317 installed manifests, 140 use an array fallback — so this was not an exotic
    shape, and every one of those runtime entry points was invisible to
    `trigger_targets` (phases.py), which is the list an experiment picks the program
    it executes from.
    """
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict | list):
        children = value.values() if isinstance(value, dict) else value
        return [entry for child in children for entry in _exports_entries(child)]
    return []


def _bin_entries(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    return (
        [entry for entry in value.values() if isinstance(entry, str)]
        if isinstance(value, dict)
        else []
    )


def parse_package_json(
    package: dict[str, Any],
) -> tuple[PackageMetadata, dict[str, str], EntryPoints, dict[str, dict[str, str]]]:
    def text(key: str) -> str | None:
        value = package.get(key)
        return value if isinstance(value, str) else None

    metadata = PackageMetadata(
        name=text("name"),
        version=text("version"),
        description=text("description"),
        license=text("license"),
        homepage=text("homepage"),
        keywords=_string_list(package.get("keywords")),
        repository=package.get("repository"),
    )
    scripts = _string_record(package.get("scripts"))
    targets, _ = classify_install_hooks(scripts)
    install = list(dict.fromkeys(target.reference for target in targets))
    runtime = [text("main") or "index.js"]
    if text("module"):
        runtime.append(text("module"))
    runtime.extend(_exports_entries(package.get("exports")))
    entry_points = EntryPoints(
        install=install, runtime=list(dict.fromkeys(runtime)), bin=_bin_entries(package.get("bin"))
    )
    dependencies = {
        "prod": _string_record(package.get("dependencies")),
        "dev": _string_record(package.get("devDependencies")),
        "optional": _string_record(package.get("optionalDependencies")),
        "peer": _string_record(package.get("peerDependencies")),
    }
    return metadata, scripts, entry_points, dependencies


def _shebang_type(head: bytes) -> str | None:
    """The language a `#!` line declares, or None if there is no usable one.

    The interpreter is the first word that names one, so `#!/usr/bin/env node` and
    `#!/usr/bin/env -S node --enable-source-maps` both resolve to node without this
    having to model `env`'s option grammar. Undecodable bytes are not a shebang: this
    only ever runs on a file the magic-number check already declined to call binary.
    """
    if not head.startswith(b"#!"):
        return None
    line = head.split(b"\n", 1)[0].decode("utf-8", "replace")
    for word in re.split(r"[\s/]+", line[2:].strip()):
        mapped = SHEBANG_TYPE_MAP.get(word.split("=", 1)[0])
        if mapped is not None:
            return mapped
    return None


def _classify_head(path: Path) -> tuple[bool, str | None, str | None]:
    """(is_binary, binary_type, shebang_type) from one bounded read of the head.

    Bounded on purpose. This used to be `path.read_bytes()[:4]`, which pulls the
    WHOLE file into memory to look at four bytes of it — on a package whose tarball
    ships a 200 MB prebuilt `.node`, that is 200 MB of untrusted input resident to
    answer "does it start with \\x7fELF". The slice was applied to the finished copy,
    so the four-byte look never bounded anything.
    """
    try:
        with path.open("rb") as handle:
            head = handle.read(HEAD_BYTES)
    except OSError:
        return False, None, None
    for name, magic in MAGIC_BYTES:
        if head.startswith(magic):
            return True, name, None
    return False, None, _shebang_type(head)


def classify_files(package_path: Path) -> list[FileRecord]:
    records: list[FileRecord] = []
    for path in package_path.rglob("*"):
        if any(part in SKIP_DIRS for part in path.relative_to(package_path).parts):
            continue
        try:
            if not path.is_file():
                continue
            info = path.stat()
        except OSError:
            continue
        is_binary, binary_type, shebang = _classify_head(path)
        # Name first, shebang second, and only where the name says nothing: an
        # extension IS a declaration and the overwhelming majority of files carry a
        # true one, while a shebang is the fallback for the files that carry none.
        # The order also keeps the mapping one-way — a `#!` line can only ever turn
        # `unknown` into a type some model reads, never reclassify a `.json` or
        # demote a `.js`, so no file that is read today stops being read.
        file_type = "binary" if is_binary else EXTENSION_TYPE_MAP.get(path.suffix, "unknown")
        if file_type == "unknown" and shebang is not None:
            file_type = shebang
        records.append(
            FileRecord(
                path=path.relative_to(package_path).as_posix(),
                fileType=file_type,
                sizeBytes=info.st_size,
                permissions=format(stat.S_IMODE(info.st_mode), "o"),
                isBinary=is_binary,
                binaryType=binary_type,
            )
        )
    return records


def _resolve(target: InstallTarget, paths: set[str]) -> str | None:
    """The shipped file an interpreter would load for this target, or None if the
    tarball contains no such file — the concrete path, because whether the audit
    ever READS it is decided by that path's classified type, not by the reference."""
    if target.reference in paths:
        return target.reference
    if not target.module_resolution:
        return None
    candidates = [target.reference + extension for extension in NODE_EXTENSION_CANDIDATES]
    candidates += [
        str(PurePosixPath(target.reference) / name) for name in NODE_DIRECTORY_CANDIDATES
    ]
    return next((candidate for candidate in candidates if candidate in paths), None)


def run_inventory_checks(
    scripts: dict[str, str], files: list[FileRecord]
) -> tuple[list[InventoryFlag], DealBreaker | None]:
    """The structural checks: two dealbreakers, then advisory flags.

    INVARIANT: an install-time hook is never merely noted. Each one either names a
    file the tarball ships (analysable), names a file it does not ship (a
    dealbreaker — the manifest is internally inconsistent about the code it will
    execute, and what actually runs will be resolved at install time from wherever
    it then exists), or leaves an `install-coverage-gap` flag. The two are
    deliberately different verdicts on different facts: "you declared a file you
    did not ship" is an assertion about the package, which real published packages
    do not do, while "we could not tell what this runs" is an assertion about THIS
    ENGINE and carries no accusation. Measured over 227 published packages with
    install-time hooks, unresolvable hooks are dominated by ordinary native-build
    tooling (`node-gyp rebuild`, `prebuild-install`, `node-gyp-build`), so routing
    them to the dealbreaker would condemn every native addon on the registry.
    """
    for key, value in scripts.items():
        if any(pattern.search(value) for pattern in SHELL_PIPE_PATTERNS):
            return [], DealBreaker(
                check="shell-pipe", detail=f"Script '{key}' contains shell pipe: {value}"
            )
    file_types = {file.path: file.fileType for file in files}
    targets, gaps = classify_install_hooks(scripts)
    resolved: list[tuple[InstallTarget, str]] = []
    for target in targets:
        path = _resolve(target, set(file_types))
        if path is None:
            return [], DealBreaker(
                check="missing-install-script",
                detail=(
                    f"Install script '{target.hook}' references '{target.reference}' "
                    "but file not found in package"
                ),
            )
        resolved.append((target, path))

    flags: list[InventoryFlag] = []
    hooks = [key for key in scripts if key in LIFECYCLE_SCRIPTS]
    if hooks:
        flags.append(
            InventoryFlag(
                severity="info",
                check="lifecycle-scripts",
                detail=f"Package declares lifecycle hooks: {', '.join(hooks)}",
                file=None,
            )
        )
    for gap in gaps:
        flags.append(
            InventoryFlag(
                severity="critical",
                check=INSTALL_COVERAGE_GAP,
                detail=(
                    f"Install-time hook '{gap.hook}' runs code this audit cannot locate "
                    f"({gap.reason}): {gap.command}"
                ),
                file=None,
            )
        )
    for target, path in resolved:
        # A target that ships is only analysable if some phase actually READS it,
        # and FLAG reads SOURCE_FILE_TYPES only (config.py, via
        # phases.flag_source_files), which includes `shell` — so a shipped
        # `postinstall.sh` IS coverage. What remains here are the types no model
        # reads — a `.py`/`.rb`/`.pl` target (SCRIPT_INTERPRETERS accepts those
        # interpreters, and no extension mapping exists for their files, so they
        # classify `unknown`), and any extensionless target whose shebang names an
        # interpreter SHEBANG_TYPE_MAP does not map. Calling one of those "resolved"
        # would make this recogniser narrower than the claim it is read as. One check
        # name for both gap kinds,
        # so a consumer deciding "can this audit still reach SAFE" branches on one
        # closed fact instead of a list that grows every time a new gap is found.
        if file_types[path] not in SOURCE_FILE_TYPES:
            flags.append(
                InventoryFlag(
                    severity="critical",
                    check=INSTALL_COVERAGE_GAP,
                    detail=(
                        f"Install-time hook '{target.hook}' runs '{target.reference}', which "
                        f"ships as '{path}' ({file_types[path]}) — not a file type this audit "
                        "reads"
                    ),
                    file=path,
                )
            )
    for file in files:
        if file.isBinary:
            flags.append(
                InventoryFlag(
                    severity="warn",
                    check="binary-detected",
                    detail=f"Binary file detected ({file.binaryType})",
                    file=file.path,
                )
            )
        if not file.path.startswith(("bin/", "bin\\")) and int(file.permissions, 8) & 0o111:
            flags.append(
                InventoryFlag(
                    severity="warn",
                    check="executable-outside-bin",
                    detail=f"File has executable permissions ({file.permissions}) outside bin/",
                    file=file.path,
                )
            )
        name = Path(file.path).name
        if (
            name.startswith(".")
            and name not in STANDARD_DOTFILES
            and not name.startswith(STANDARD_DOTFILE_PREFIXES)
        ):
            flags.append(
                InventoryFlag(
                    severity="info",
                    check="hidden-dotfile",
                    detail=f"Non-standard dotfile: {name}",
                    file=file.path,
                )
            )
    return flags, None


def load_manifest(package_path: Path) -> dict[str, Any]:
    """Parse `package.json`, or fail loud and located.

    INVARIANT: past this boundary the manifest is a real JSON object, so
    metadata / scripts / entryPoints / dependencies describe the package that was
    actually shipped. The previous `package = {}` fallback made an audit with NO
    manifest knowledge look complete: no name, no version, no scripts, no
    dependencies, `entryPoints.runtime` silently defaulting to ["index.js"], and
    BOTH dealbreaker checks passing trivially (empty scripts, empty install list)
    — a hidden coverage gap that can only bias toward SAFE. Two strictly smaller
    gaps are already loud: an unreadable source file (`phases.py`, 0031) and an
    ambiguous tarball root (`resolve.py`, ValueError).

    Unreadable (OSError) and unparseable (bad JSON / bad encoding / not an
    object) raise the SAME class with the same retryability and differ only in
    the located detail. Justification: the resulting blindness is identical in
    size, 0031-retryable already denotes "could not read this input" for a source
    file, and nothing auto-retries — a retryable classification lets a caller
    re-run a paid claim (a `latest` request can even resolve to a fixed version),
    where a non-retryable one would burn the claim on a package the caller cannot
    repair. `json.loads` is given bytes on purpose: it does the encoding
    detection, so undecodable bytes are content-classified here instead of
    escaping as an unmapped UnicodeDecodeError (an NPMGUARD-9999), and a
    BOM-prefixed manifest parses as npm's own reader takes it rather than being
    discarded as unreadable.
    """
    try:
        raw = (package_path / "package.json").read_bytes()
    except OSError as exc:
        raise AuditIncompleteError(
            "inventory", f"package.json could not be read: {type(exc).__name__}"
        ) from exc
    try:
        package = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise AuditIncompleteError("inventory", f"package.json is not valid JSON: {exc}") from exc
    if not isinstance(package, dict):
        raise AuditIncompleteError(
            "inventory",
            f"package.json is not a JSON object but a {type(package).__name__}",
        )
    return package


async def analyze_inventory(package_path: Path) -> InventoryReport:
    metadata, scripts, entry_points, dependencies = parse_package_json(load_manifest(package_path))
    files = classify_files(package_path)
    flags, dealbreaker = run_inventory_checks(scripts, files)
    return InventoryReport(
        metadata=metadata,
        scripts=scripts,
        entryPoints=entry_points,
        dependencies=dependencies,
        files=files,
        flags=flags,
        dealbreaker=dealbreaker,
    )

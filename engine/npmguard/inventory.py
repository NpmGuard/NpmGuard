import json
import re
import stat
from pathlib import Path
from typing import Any

from .config import SKIP_DIRS
from .contract.models import (
    DealBreaker,
    EntryPoints,
    FileRecord,
    InventoryFlag,
    InventoryReport,
    PackageMetadata,
)

LIFECYCLE_SCRIPTS = frozenset({"preinstall", "install", "postinstall", "prepare", "prepublish"})
EXTENSION_TYPE_MAP = {
    ".js": "js",
    ".mjs": "js",
    ".cjs": "js",
    ".json": "json",
    ".md": "doc",
    ".txt": "doc",
    ".html": "web",
    ".css": "web",
    ".ts": "ts",
    ".tsx": "ts",
    ".mts": "ts",
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


def _string_record(value: Any) -> dict[str, str]:
    return (
        {key: item for key, item in value.items() if isinstance(item, str)}
        if isinstance(value, dict)
        else {}
    )


def _string_list(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def extract_script_file_ref(script_value: str) -> str | None:
    parts = script_value.strip().split()
    if not parts or parts[0] != "node":
        return None
    return next((part for part in parts[1:] if not part.startswith("-")), None)


def _exports_entries(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [entry for child in value.values() for entry in _exports_entries(child)]
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
    install = []
    for hook in LIFECYCLE_SCRIPTS:
        reference = extract_script_file_ref(scripts[hook]) if hook in scripts else None
        if reference:
            install.append(str(Path(reference)))
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


def _binary(path: Path) -> tuple[bool, str | None]:
    try:
        prefix = path.read_bytes()[:4]
    except OSError:
        return False, None
    return next(
        ((True, name) for name, magic in MAGIC_BYTES if prefix.startswith(magic)), (False, None)
    )


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
        is_binary, binary_type = _binary(path)
        records.append(
            FileRecord(
                path=path.relative_to(package_path).as_posix(),
                fileType="binary" if is_binary else EXTENSION_TYPE_MAP.get(path.suffix, "unknown"),
                sizeBytes=info.st_size,
                permissions=format(stat.S_IMODE(info.st_mode), "o"),
                isBinary=is_binary,
                binaryType=binary_type,
            )
        )
    return records


def run_inventory_checks(
    scripts: dict[str, str], entry_points: EntryPoints, files: list[FileRecord]
) -> tuple[list[InventoryFlag], DealBreaker | None]:
    for key, value in scripts.items():
        if any(pattern.search(value) for pattern in SHELL_PIPE_PATTERNS):
            return [], DealBreaker(
                check="shell-pipe", detail=f"Script '{key}' contains shell pipe: {value}"
            )
    paths = {file.path for file in files}
    for reference in entry_points.install:
        if reference not in paths:
            return [], DealBreaker(
                check="missing-install-script",
                detail=f"Install script references '{reference}' but file not found in package",
            )

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
    for key in LIFECYCLE_SCRIPTS:
        value = scripts.get(key)
        if value and (not value.strip().split() or value.strip().split()[0] != "node"):
            flags.append(
                InventoryFlag(
                    severity="warn",
                    check="non-node-script",
                    detail=f"Lifecycle script '{key}' is not a node command: {value}",
                    file=None,
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


async def analyze_inventory(package_path: Path) -> InventoryReport:
    try:
        package = json.loads((package_path / "package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        package = {}
    metadata, scripts, entry_points, dependencies = parse_package_json(package)
    files = classify_files(package_path)
    flags, dealbreaker = run_inventory_checks(scripts, entry_points, files)
    return InventoryReport(
        metadata=metadata,
        scripts=scripts,
        entryPoints=entry_points,
        dependencies=dependencies,
        files=files,
        flags=flags,
        dealbreaker=dealbreaker,
    )

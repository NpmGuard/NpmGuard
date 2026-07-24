"""Dependency lockfile parsers for the GitHub repo panel.

Thin, format-specific parsers producing one normalized shape. npm v2/v3 +
pnpm are first-class; yarn (classic + berry) is best-effort. Unsupported
formats fail with a clear, user-facing :class:`UnsupportedLockfileError`
naming what IS supported.

The parsers are **pure**: string in → ``list[LockfileDep]`` out. No IO, no
network, no clock. A port of the TS ``engine/src/lockfile/*`` modules.
"""

from __future__ import annotations

import json

from ._base import LOCKFILE_CANDIDATES, LockfileDep, UnsupportedLockfileError
from .npm import parse_npm_lockfile
from .pnpm import parse_pnpm_lockfile
from .yarn import parse_yarn_lockfile

__all__ = [
    "LOCKFILE_CANDIDATES",
    "LockfileDep",
    "UnsupportedLockfileError",
    "manifest_ranges",
    "parse_lockfile",
]


def manifest_ranges(package_json_content: str | dict | None) -> dict[str, str]:
    """Extract direct-dependency ranges from a package.json.

    Accepts the raw JSON string (as fetched from GitHub) or an already-parsed
    mapping. Collects across ``dependencies``, ``devDependencies`` and
    ``optionalDependencies``; the first section a name appears in wins. Garbage
    input yields an empty mapping (never raises) — classification degrades to
    "everything transitive", it never crashes a scan.
    """
    manifest: object
    if isinstance(package_json_content, str):
        try:
            manifest = json.loads(package_json_content)
        except (ValueError, TypeError):
            return {}
    else:
        manifest = package_json_content

    if not isinstance(manifest, dict):
        return {}

    ranges: dict[str, str] = {}
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        deps = manifest.get(section)
        if not isinstance(deps, dict):
            continue
        for name, rng in deps.items():
            if isinstance(rng, str) and name not in ranges:
                ranges[name] = rng
    return ranges


def parse_lockfile(
    filename: str,
    content: str,
    manifest: dict[str, str] | None = None,
) -> list[LockfileDep]:
    """Parse a lockfile by its (root-relative) filename → normalized deps.

    ``manifest`` (package.json ranges from :func:`manifest_ranges`) classifies
    direct deps for formats that don't carry that information themselves
    (yarn), and fills gaps for the others. An unknown filename raises
    :class:`UnsupportedLockfileError` naming the supported formats.
    """
    ranges = manifest or {}
    if filename == "package-lock.json":
        return parse_npm_lockfile(content, ranges)
    if filename == "pnpm-lock.yaml":
        return parse_pnpm_lockfile(content, ranges)
    if filename == "yarn.lock":
        return parse_yarn_lockfile(content, ranges)
    raise UnsupportedLockfileError(f'Unsupported lockfile "{filename}"')

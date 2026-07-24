"""package-lock.json v2/v3 parser.

Walks the ``packages`` map. v1 (npm < 7) has no ``packages`` key and is
rejected with a regenerate hint. A port of TS ``lockfile/npm.ts``.
"""

from __future__ import annotations

import json

from ._base import LockfileDep, UnsupportedLockfileError

_NODE_MODULES = "node_modules/"


def parse_npm_lockfile(content: str, manifest: dict[str, str]) -> list[LockfileDep]:
    try:
        lock = json.loads(content)
    except (ValueError, TypeError) as exc:
        raise UnsupportedLockfileError("package-lock.json is not valid JSON") from exc

    packages = lock.get("packages") if isinstance(lock, dict) else None
    if not isinstance(packages, dict):
        raise UnsupportedLockfileError(
            "package-lock.json v1 is not supported — regenerate it with npm >= 7"
        )

    # Direct ranges: the lockfile's root ("") entry is authoritative; the
    # manifest fills gaps (e.g. a lockfile written by an older npm).
    root = packages.get("") or {}
    direct_ranges: dict[str, str] = dict(manifest)
    if isinstance(root, dict):
        for section in (
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
        ):
            deps = root.get(section)
            if isinstance(deps, dict):
                for name, rng in deps.items():
                    if isinstance(rng, str):
                        direct_ranges[name] = rng

    seen: dict[str, LockfileDep] = {}
    for pkg_path, entry in packages.items():
        if pkg_path == "" or not isinstance(entry, dict) or entry.get("link"):
            continue
        # "node_modules/foo", "node_modules/a/node_modules/@scope/b", or a
        # workspace dir ("packages/a" — skipped, it's local code, not a dep).
        idx = pkg_path.rfind(_NODE_MODULES)
        if idx == -1:
            continue
        name = pkg_path[idx + len(_NODE_MODULES) :]
        version = entry.get("version")
        if not name or not version:
            continue

        key = f"{name}@{version}"
        if key in seen:
            continue
        direct = name in direct_ranges
        seen[key] = LockfileDep(
            name=name,
            version=version,
            direct=direct,
            range=direct_ranges.get(name) if direct else None,
        )
    return list(seen.values())

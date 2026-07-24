"""yarn.lock parser — classic (v1) and berry (v2+).

Classic is yarn's own custom format; berry is YAML with a ``__metadata`` block.
Neither records which deps are direct, so classification comes from the
package.json manifest (best-effort: with no manifest everything is marked
transitive). A port of TS ``lockfile/yarn.ts`` — the classic format is parsed
directly here (no ``@yarnpkg/lockfile`` analog is needed for the subset a
committed lockfile uses). Version/range/resolution values are always quoted or
bare tokens; comments and blank lines are ignored.
"""

from __future__ import annotations

import yaml

from ._base import LockfileDep, UnsupportedLockfileError

_NPM_MARKER = "@npm:"


def _push(
    seen: dict[str, LockfileDep],
    manifest: dict[str, str],
    name: str,
    version: str,
) -> None:
    key = f"{name}@{version}"
    if key in seen:
        return
    direct = name in manifest
    seen[key] = LockfileDep(
        name=name,
        version=version,
        direct=direct,
        range=manifest.get(name) if direct else None,
    )


def _name_from_spec(spec: str) -> str | None:
    """"name@range" / "@scope/name@range" → name (scoped '@' at index 0 kept)."""
    spec = spec.strip().strip('"')
    at = spec.rfind("@")
    if at <= 0:
        return None
    return spec[:at]


def _parse_berry(content: str, manifest: dict[str, str]) -> list[LockfileDep]:
    try:
        lock = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        raise UnsupportedLockfileError("yarn.lock (berry) could not be parsed") from exc
    if not isinstance(lock, dict):
        raise UnsupportedLockfileError("yarn.lock (berry) could not be parsed")

    seen: dict[str, LockfileDep] = {}
    for key, value in lock.items():
        if key == "__metadata" or not isinstance(value, dict):
            continue
        version = value.get("version")
        resolution = value.get("resolution")
        if version is None or not isinstance(resolution, str):
            continue
        # resolution: "lodash@npm:4.17.21" / "@types/node@npm:22.1.0"; skip
        # workspace:/patch:/portal: resolutions — local code, not registry deps.
        npm_idx = resolution.rfind(_NPM_MARKER)
        if npm_idx <= 0:
            continue
        name = resolution[:npm_idx]
        _push(seen, manifest, name, str(version))
    return list(seen.values())


def _parse_classic(content: str, manifest: dict[str, str]) -> list[LockfileDep]:
    seen: dict[str, LockfileDep] = {}
    pending_names: list[str] = []
    for raw in content.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw[0].isspace():
            # An entry body line; capture the version for the open header.
            stripped = raw.strip()
            if pending_names and stripped.startswith("version"):
                rest = stripped[len("version") :].strip()
                version = rest.strip('"').strip("'").strip()
                if version:
                    for name in pending_names:
                        _push(seen, manifest, name, version)
                pending_names = []
            continue
        # A header line at column 0: one or more comma-separated specifiers
        # ending with ':'  ->  lodash@^4.17.21, lodash@^4.0.0:
        header = raw.rstrip()
        if not header.endswith(":"):
            pending_names = []
            continue
        header = header[:-1]
        names: list[str] = []
        for spec in header.split(","):
            name = _name_from_spec(spec)
            if name:
                names.append(name)
        pending_names = names
    return list(seen.values())


def parse_yarn_lockfile(content: str, manifest: dict[str, str]) -> list[LockfileDep]:
    if "__metadata:" in content:
        return _parse_berry(content, manifest)
    return _parse_classic(content, manifest)

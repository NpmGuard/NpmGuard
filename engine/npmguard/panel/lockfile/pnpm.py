"""pnpm-lock.yaml parser.

Package keys vary across lockfile versions::

    v5:  "/name/1.2.3"          (peer suffix: "_react@18.0.0")
    v6:  "/name@1.2.3"          (peer suffix: "(react@18.0.0)")
    v9:  "name@1.2.3"           (peer suffix: "(react@18.0.0)")

Scoped names keep their internal slash ("/@scope/name@1.2.3"). The format is
decided by ``lockfileVersion``, not guessed — package names may legally
contain "_" (``string_decoder``) and v5 peer suffixes put "@" in the version,
so heuristics mis-split. A port of TS ``lockfile/pnpm.ts``.
"""

from __future__ import annotations

import yaml

from ._base import LockfileDep, UnsupportedLockfileError


def _key_to_name_version(raw_key: str, v5: bool) -> tuple[str, str] | None:
    key = raw_key.strip()
    paren = key.find("(")
    if paren != -1:
        key = key[:paren]
    if key.startswith("/"):
        key = key[1:]
    if not key:
        return None

    if v5:
        slash = key.rfind("/")
        if slash <= 0:
            return None
        version = key[slash + 1 :].split("_")[0]
        return (key[:slash], version) if version else None

    at = key.rfind("@")
    if at <= 0:
        return None
    version = key[at + 1 :]
    return (key[:at], version) if version else None


def _importer_range(value: object) -> str | None:
    """Importer values are "1.2.3" (v5) or {specifier, version} (v6/v9)."""
    if isinstance(value, dict):
        spec = value.get("specifier")
        return spec if isinstance(spec, str) else None
    return None


def parse_pnpm_lockfile(content: str, manifest: dict[str, str]) -> list[LockfileDep]:
    try:
        lock = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        raise UnsupportedLockfileError("pnpm-lock.yaml could not be parsed") from exc
    if not isinstance(lock, dict):
        raise UnsupportedLockfileError("pnpm-lock.yaml could not be parsed")

    # Direct deps: importers["."] (v6/v9) or root-level sections (v5).
    importers = lock.get("importers")
    importers = importers if isinstance(importers, dict) else None
    root_importer = (importers or {}).get(".") if importers else lock
    if not isinstance(root_importer, dict):
        root_importer = {}

    direct_ranges: dict[str, str | None] = {}
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        deps = root_importer.get(section)
        if not isinstance(deps, dict):
            continue
        for name, value in deps.items():
            direct_ranges[name] = _importer_range(value) or manifest.get(name)
    for name, rng in manifest.items():
        direct_ranges.setdefault(name, rng)

    try:
        v5 = float(str(lock.get("lockfileVersion", "0"))) < 6
    except ValueError:
        v5 = False

    packages = lock.get("packages")
    packages = packages if isinstance(packages, dict) else {}
    seen: dict[str, LockfileDep] = {}
    for key in packages:
        parsed = _key_to_name_version(str(key), v5)
        if not parsed:
            continue
        name, version = parsed
        dedup_key = f"{name}@{version}"
        if dedup_key in seen:
            continue
        direct = name in direct_ranges
        seen[dedup_key] = LockfileDep(
            name=name,
            version=version,
            direct=direct,
            range=direct_ranges.get(name) if direct else None,
        )

    if not seen and not packages and importers is None:
        raise UnsupportedLockfileError("pnpm-lock.yaml has no packages section")
    return list(seen.values())

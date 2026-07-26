"""Shared types for the lockfile parsers.

Lives in its own module so the format-specific parsers (``npm``/``pnpm``/
``yarn``) and the package ``__init__`` can all import these without a circular
import.
"""

from __future__ import annotations

from dataclasses import dataclass

# Root-relative filenames we look for, in priority order.
LOCKFILE_CANDIDATES: tuple[str, ...] = (
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
)


def strip_bom(content: str) -> str:
    """Drop a leading UTF-8 BOM.

    npm, pnpm and yarn all read a BOM-prefixed file fine, and Windows editors
    write them, so a BOM is a property of the repo rather than a defect in it.
    Python disagrees only once the bytes are already a `str`: `json.loads` on
    bytes strips the BOM itself, `json.loads` on a `str` raises. Every parser
    here takes a `str`, so the strip belongs at this boundary — the same fact
    `deps.py` states as `utf-8-sig` and `inventory.load_manifest` states by
    handing `json.loads` the raw bytes.
    """
    return content.lstrip("﻿")


@dataclass(frozen=True, slots=True)
class LockfileDep:
    """One normalized dependency extracted from a lockfile.

    ``range`` is the declared semver range for a direct dep (e.g. ``"^4.17.21"``)
    and ``None`` for a transitive dep.
    """

    name: str
    version: str
    direct: bool
    range: str | None


class UnsupportedLockfileError(Exception):
    """Raised when a lockfile is missing, malformed, or an unsupported format.

    The message always names the supported formats so the surface can tell a
    user what to commit at the repo root. ``supported`` mirrors
    :data:`LOCKFILE_CANDIDATES`.
    """

    supported: tuple[str, ...] = LOCKFILE_CANDIDATES

    def __init__(self, detail: str) -> None:
        super().__init__(
            f"{detail} — supported lockfiles: "
            f"{', '.join(LOCKFILE_CANDIDATES)} (committed at the repo root)"
        )

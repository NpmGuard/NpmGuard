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

"""Publisher continuity — the signal that makes attestations worth making.

The observation this whole feature exists for: *"this version is unattested"* is
worthless on its own, because 99.99% of npm is unattested. What is not worthless
is a **change in pattern**:

    lodash 4.17.19 ✓  4.17.20 ✓  4.17.21 ✓   all by publisher N
    lodash 4.17.22    published 40 minutes ago, attested by nobody

That shape is what an account takeover looks like from the outside. A worm
holding a stolen npm token can publish bytes that look exactly like a normal
release; what it cannot do is produce a fresh proof from the human whose
releases came before. So we do not ask "is this signed?" — we ask "did the
publisher change, or stop?"

INVARIANT — continuity is a SEPARATE AXIS and never mutates the audit verdict.
The verdict is SAFE | ERROR | DANGEROUS, derived only from reproduced evidence
about the code. Continuity is derived from who pressed publish. A package can be
`SAFE` and `BREAK` at once (dangerous-looking provenance, harmless code) or
`DANGEROUS` and `ATTESTED` (a maintainer who shipped a bug). Collapsing them
would destroy both.

INVARIANT — absence of attestation is NEVER evidence of malice. A package nobody
ever attested reports ``NO_HISTORY`` and says nothing at all. Emitting a warning
there would fire on essentially all of npm, train every user to ignore it, and
punish maintainers for not having adopted a thing that did not exist. The signal
must be rare to be worth reading.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import httpx

# How many consecutive attested releases must precede an unattested one before
# the gap is worth reporting. Below this the "streak" is too short to be a
# pattern — one attested release then a gap is far more likely to be a
# maintainer trying the feature once than an account takeover.
DEFAULT_STREAK_THRESHOLD = 3

Status = Literal["NO_HISTORY", "ATTESTED", "NEW_PUBLISHER", "BREAK", "UNATTESTED"]

# Ordered worst-last, so a caller can rank without hardcoding the vocabulary.
SEVERITY: dict[str, int] = {
    "NO_HISTORY": 0,
    "ATTESTED": 0,
    "UNATTESTED": 1,
    "NEW_PUBLISHER": 2,
    "BREAK": 3,
}


@dataclass(frozen=True)
class Release:
    """One release, as continuity sees it: a version and who attested it."""

    version: str
    nullifier: str | None = None
    tier: int = 0
    attested_at: str | None = None


@dataclass(frozen=True)
class Continuity:
    """What the attestation history says about one version.

    ``summary`` is deliberately part of the result rather than left to each
    consumer. The CLI, the web app, the GitHub check and the alert mail must not
    each invent their own wording for a security signal — a maintainer who reads
    "BREAK" in one place and something softer elsewhere learns to trust neither.
    """

    status: Status
    summary: str
    streak: int = 0
    publisher: str | None = None
    tier: int = 0
    attested_count: int = 0
    total_known: int = 0

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "summary": self.summary,
            "streak": self.streak,
            "publisher": self.publisher,
            "tier": self.tier,
            "attestedCount": self.attested_count,
            "totalKnown": self.total_known,
        }


# npm's packument `time` map carries these alongside the real versions.
_NON_VERSION_TIME_KEYS = frozenset({"created", "modified"})


def release_history(
    published: dict[str, str], attested: Iterable[Any]
) -> list[Release]:
    """Merge npm's publication timeline with our attestations.

    ``published`` is the packument's ``time`` map (version -> ISO timestamp);
    ordering comes from it rather than from semver because **publication order
    is what a takeover disturbs**. An attacker publishing 4.17.22 while 5.x
    exists is still publishing "next"; sorting by version would file that
    release in the middle of history and hide the break.
    """
    by_version = {a.version: a for a in attested}
    ordered = sorted(
        ((v, t) for v, t in published.items() if v not in _NON_VERSION_TIME_KEYS),
        key=lambda item: item[1],
    )
    history: list[Release] = []
    for version, _ in ordered:
        record = by_version.get(version)
        history.append(
            Release(
                version=version,
                nullifier=getattr(record, "nullifier", None),
                tier=getattr(record, "tier", 0) or 0,
                attested_at=getattr(record, "attested_at", None),
            )
        )
    return history


async def published_versions(
    package_name: str, *, registry: str = "https://registry.npmjs.org"
) -> dict[str, str]:
    """The packument's version -> publish-time map.

    Returns ``{}`` rather than raising when npm is unreachable: continuity is a
    supplementary signal, and a registry outage must degrade it to silence, not
    fail the report it rides along with.
    """
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(f"{registry}/{package_name}")
        if response.status_code != 200:
            return {}
        times = response.json().get("time")
    except (httpx.HTTPError, ValueError):
        return {}
    if not isinstance(times, dict):
        return {}
    return {k: v for k, v in times.items() if isinstance(v, str)}


def _preceding_streak(history: Sequence[Release], index: int) -> tuple[int, str | None]:
    """Length of the attested run ending immediately before ``index``.

    Contiguity matters and is the point: a package attested long ago that then
    went quiet for twenty releases has no live pattern to break. Only a run
    ending at the *immediately preceding* release says "this publisher was
    attesting right up until now".
    """
    streak = 0
    publisher: str | None = None
    for release in reversed(history[:index]):
        if release.nullifier is None:
            break
        if publisher is None:
            publisher = release.nullifier
        elif release.nullifier != publisher:
            # A different publisher ends this run: the streak measures ONE
            # publisher's consistency, not "somebody was attesting".
            break
        streak += 1
    return streak, publisher


def continuity_for(
    history: Sequence[Release],
    version: str,
    *,
    threshold: int = DEFAULT_STREAK_THRESHOLD,
) -> Continuity:
    """Classify one version against the package's attestation history.

    ``history`` must be every known release in publication order, oldest first,
    including unattested ones — a gap is only visible against what surrounds it.
    """
    attested = [r for r in history if r.nullifier is not None]
    total_known = len(history)

    # Nothing was ever attested for this package: stay silent. This is the
    # overwhelmingly common case and it is not a finding.
    if not attested:
        return Continuity(
            status="NO_HISTORY",
            summary="No releases of this package have been attested.",
            total_known=total_known,
        )

    index = next((i for i, r in enumerate(history) if r.version == version), None)
    if index is None:
        # Asked about a version we have no record of. Report what the package
        # looks like without pretending to have classified the version.
        return Continuity(
            status="NO_HISTORY",
            summary="This version is not in the known release history.",
            attested_count=len(attested),
            total_known=total_known,
        )

    this = history[index]
    streak, streak_publisher = _preceding_streak(history, index)
    known_publishers = {r.nullifier for r in attested[:index] if r.nullifier}

    if this.nullifier is not None:
        if known_publishers and this.nullifier not in known_publishers:
            return Continuity(
                status="NEW_PUBLISHER",
                summary=(
                    "Attested, but by a publisher who has never attested this package "
                    "before. Verify this is an intended maintainer change."
                ),
                streak=streak,
                publisher=this.nullifier,
                tier=this.tier,
                attested_count=len(attested),
                total_known=total_known,
            )
        return Continuity(
            status="ATTESTED",
            summary="A human proved they published this exact release.",
            streak=streak + 1,
            publisher=this.nullifier,
            tier=this.tier,
            attested_count=len(attested),
            total_known=total_known,
        )

    # Unattested. Whether that is worth saying depends entirely on what came
    # immediately before it.
    if streak >= threshold:
        return Continuity(
            status="BREAK",
            summary=(
                f"The previous {streak} releases were attested by the same publisher. "
                f"This one is attested by nobody — the pattern an account takeover or a "
                f"self-replicating worm produces."
            ),
            streak=streak,
            publisher=streak_publisher,
            attested_count=len(attested),
            total_known=total_known,
        )
    return Continuity(
        status="UNATTESTED",
        summary=(
            "This release is not attested. Other releases of this package are, "
            "but not enough consecutively to call this a break."
        ),
        streak=streak,
        attested_count=len(attested),
        total_known=total_known,
    )

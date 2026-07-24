"""Derived, rebuildable verdict index over ``package_verdicts``.

Port of the TS ``verdict-index.ts``. This table is the panel's fast
``(name, version) -> verdict`` lookup for rollups and cache-first scans. The
report files under ``data/reports/`` stay authoritative; this index is
rebuildable at any time (``rebuild`` at boot) and kept in sync by the panel
worker after each audit's future resolves.

dev is 2-state: only ``SAFE`` and ``DANGEROUS`` ever land here. The 4-state
severity map (``SUSPECT`` / ``UNKNOWN``) is retained for the rollup ordering the
wire contract assumes, but those verdicts are never produced by the dev engine.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso

from .tables import package_verdicts

# Severity order for rollups (spec §5). Unknown/None ranks as UNKNOWN.
SEVERITY: dict[str, int] = {"SAFE": 0, "UNKNOWN": 1, "SUSPECT": 2, "DANGEROUS": 3}

# The only verdicts the dev engine ever produces — everything else is dropped
# on the way into the index (a completed audit is SAFE, DANGEROUS, or an error).
LANDABLE_VERDICTS = frozenset({"SAFE", "DANGEROUS"})


def verdict_severity(verdict: str | None) -> int:
    """Rollup rank for a verdict; missing/unknown ranks as UNKNOWN."""
    if not verdict:
        return SEVERITY["UNKNOWN"]
    return SEVERITY.get(verdict, SEVERITY["UNKNOWN"])


def assess_report(report: Mapping[str, Any]) -> tuple[str | None, str, int]:
    """Extract ``(verdict, reason, evidence_count)`` from a saved AuditReport.

    Dev reports carry only ``SAFE``/``DANGEROUS``; the reason is the report's
    ``rationale`` and the evidence count is ``len(confirmedHypIds)``.
    """
    verdict = report.get("verdict")
    reason = report.get("rationale") or ""
    evidence = report.get("confirmedHypIds") or []
    return verdict, reason, len(evidence)


@dataclass(frozen=True)
class SavedReport:
    """One report record for a rebuild: identity + the raw report + its time.

    ``report`` is the full AuditReport dict (as persisted on disk); ``rebuild``
    assesses it. Keyed by the *requested* (lockfile) version so scan_items joins
    line up even when the tarball's real version differs.
    """

    name: str
    version: str
    report: Mapping[str, Any]
    audited_at: str


class VerdictIndex:
    """Async store over ``package_verdicts`` (portable read-then-write upserts)."""

    def __init__(self, sessions: async_sessionmaker) -> None:
        self._sessions = sessions

    async def upsert(
        self,
        name: str,
        version: str,
        verdict: str,
        reason: str = "",
        evidence_count: int = 0,
        audited_at: str | None = None,
    ) -> None:
        """Insert or replace the verdict row for ``(name, version)``."""
        audited_at = audited_at or now_iso()
        values = {
            "verdict": verdict,
            "reason": reason,
            "evidence_count": evidence_count,
            "audited_at": audited_at,
        }
        async with self._sessions() as session, session.begin():
            exists = (
                await session.execute(
                    sa.select(package_verdicts.c.name).where(
                        package_verdicts.c.name == name,
                        package_verdicts.c.version == version,
                    )
                )
            ).first()
            if exists is None:
                await session.execute(
                    package_verdicts.insert().values(name=name, version=version, **values)
                )
            else:
                await session.execute(
                    package_verdicts.update()
                    .where(
                        package_verdicts.c.name == name,
                        package_verdicts.c.version == version,
                    )
                    .values(**values)
                )

    async def get(self, name: str, version: str) -> dict[str, Any] | None:
        """The wire projection for one pair, or ``None`` if unaudited."""
        async with self._sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(
                            package_verdicts.c.verdict,
                            package_verdicts.c.reason,
                            package_verdicts.c.evidence_count,
                            package_verdicts.c.audited_at,
                        ).where(
                            package_verdicts.c.name == name,
                            package_verdicts.c.version == version,
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
        if row is None:
            return None
        return _project(row)

    async def get_many(
        self, pairs: Iterable[tuple[str, str]]
    ) -> dict[tuple[str, str], dict[str, Any]]:
        """Batch lookup keyed by ``(name, version)`` — only audited pairs appear.

        Fetches by name (portable; ``tuple_ IN`` is not supported on every
        backend) and filters to the exact requested pairs in-process.
        """
        wanted = set(pairs)
        if not wanted:
            return {}
        names = {name for name, _ in wanted}
        async with self._sessions() as session:
            rows = (
                (
                    await session.execute(
                        sa.select(
                            package_verdicts.c.name,
                            package_verdicts.c.version,
                            package_verdicts.c.verdict,
                            package_verdicts.c.reason,
                            package_verdicts.c.evidence_count,
                            package_verdicts.c.audited_at,
                        ).where(package_verdicts.c.name.in_(names))
                    )
                )
                .mappings()
                .all()
            )
        result: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            key = (row["name"], row["version"])
            if key in wanted:
                result[key] = _project(row)
        return result

    async def rebuild(self, list_reports_fn: Callable[[], Iterable[SavedReport]]) -> int:
        """Full rebuild from disk — run at boot. Assesses each report and upserts
        the ones that carry a landable (``SAFE``/``DANGEROUS``) verdict; returns
        how many rows were written."""
        count = 0
        for record in list_reports_fn():
            verdict, reason, evidence = assess_report(record.report)
            if verdict not in LANDABLE_VERDICTS:
                continue
            await self.upsert(
                record.name, record.version, verdict, reason, evidence, record.audited_at
            )
            count += 1
        return count


def _project(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "verdict": row["verdict"],
        "reason": row["reason"],
        "evidenceCount": row["evidence_count"],
        "auditedAt": row["audited_at"],
    }


__all__ = [
    "LANDABLE_VERDICTS",
    "SEVERITY",
    "SavedReport",
    "VerdictIndex",
    "assess_report",
    "verdict_severity",
]

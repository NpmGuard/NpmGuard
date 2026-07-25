"""Derived, rebuildable verdict index over ``package_verdicts``.

This table is the panel's fast ``(name, version) -> verdict`` lookup for rollups and cache-first scans. The
report files under ``data/reports/`` stay authoritative; this index is
rebuildable at any time (``rebuild`` at boot) and kept in sync by the panel
worker after each audit's future resolves.

This module also owns the **panel outcome domain** (design §4.4, contract
``OutcomeSchema``): the stored verdict is 2-state, and ``item_outcome`` lifts it
plus the item's progress into the 3-state ``SAFE | ERROR | DANGEROUS``. That
domain is the PANEL's, not the audit core's — the core concludes ``SAFE`` or
``DANGEROUS`` and reports a failure as an ``audit_error`` event, so ``ERROR`` is
the panel's name for "the attempt could not conclude" and is never an audit
verdict value. Do not alias the two.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso

from ..contract.kinds import PackageOutcome
from .tables import package_verdicts

# Rollup severity over the panel outcome domain (design §4.4). A set's outcome
# is the max over its CONCLUDED items; there is no rank for "not concluded"
# because progress is the other axis and never competes with an outcome.
#
# This mapping is BOTH the ranks and the domain: its keys are the panel outcomes,
# and `outcome_severity`'s lookup is the only domain check the rollup needs.
OUTCOME_SEVERITY: dict[str, int] = {"SAFE": 0, "ERROR": 1, "DANGEROUS": 2}

# INVARIANT: package_verdicts.verdict is exactly SAFE or DANGEROUS — enforced by a
# DB ``CHECK`` (alembic 0007), not only by the writers. Every write is gated on this
# set (``rebuild`` here, the worker in jobs.py) and ``upsert`` raises on it, so any
# other stored value is corruption rather than a state the readers have to model. An
# audit that could not conclude lands NO row at all — its outcome is derived from
# progress by ``item_outcome`` below.
#
# The guards here are `raise`, not `assert`, because both stand at a DB boundary and
# `python -O` strips `assert` — an assert here is a domain check that is
# conditionally compiled out of production.
LANDABLE_VERDICTS: frozenset[PackageOutcome] = frozenset({"SAFE", "DANGEROUS"})


def item_outcome(verdict: str | None, *, pending: bool) -> PackageOutcome | None:
    """The panel outcome for one ``(name, version)`` (design §4.4).

    ``verdict`` is the stored audit verdict (``None`` when nothing landed);
    ``pending`` is TRUE iff an audit attempt is still live (a queued/running
    job). The mapping is total by construction, so there is no ``UNKNOWN`` bucket
    to represent:

    - a landed verdict IS the outcome (``SAFE``/``DANGEROUS``);
    - nothing landed but an attempt is live → ``None``, i.e. not concluded yet;
    - nothing landed and nothing is running → ``ERROR``: we have no result and
      none is coming. Reachable in production three ways — the job failed after
      its retries, or it completed on a report carrying no landable verdict
      (jobs.py), or its worker died — and all three are "we tried and failed",
      never "not checked yet" and never SAFE.
    """
    if verdict is not None:
        # INVARIANT (read side): only a landable verdict is stored. Anything else
        # fails HERE, loudly and located, instead of silently rendering as a bucket
        # nobody branches on.
        #
        # `raise`, not `assert`: this is the DB -> panel-domain read boundary. The
        # 0007 CHECK forbids such a row from existing in a MIGRATED database; this
        # covers the database that has not been migrated yet, which is precisely the
        # case a constraint cannot.
        if verdict not in LANDABLE_VERDICTS:
            raise AssertionError(
                f"package_verdicts holds {verdict!r}; the panel outcome domain is "
                f"{sorted(LANDABLE_VERDICTS)} + ERROR derived from progress"
            )
        return verdict
    return None if pending else "ERROR"


def outcome_severity(outcome: str) -> int:
    """Rollup rank of a CONCLUDED outcome — ``DANGEROUS > ERROR > SAFE``.

    No domain guard: ``OUTCOME_SEVERITY[outcome]`` IS the check, and it raises a
    ``KeyError`` naming the offending value on the same input an assert would have
    caught. The domain is already guaranteed upstream — every production caller
    reaches here through ``item_outcome``.
    """
    return OUTCOME_SEVERITY[outcome]


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
    assesses it. Keyed by the *requested* (lockfile) version so audit_set_items
    joins line up even when the tarball's real version differs.
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
        # INVARIANT (write side): the index is the 2-state audit verdict. Callers
        # filter on LANDABLE_VERDICTS; this refuses it at the boundary that owns the
        # column, so a new producer cannot widen the vocabulary by accident.
        #
        # `raise`, not `assert`, and it is NOT redundant with the 0007 CHECK: this
        # names the offending pair before the round-trip instead of surfacing as an
        # `IntegrityError` from whichever engine is configured.
        if verdict not in LANDABLE_VERDICTS:
            raise AssertionError(
                f"cannot index verdict {verdict!r} for {name}@{version}; "
                f"expected one of {sorted(LANDABLE_VERDICTS)}"
            )
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
        how many rows were written.

        Skipping a foreign report is sufficient and no ``DELETE`` is owed: the 0007
        CHECK means an out-of-domain row cannot be in the table for this to
        reconcile, and 0007 itself removed the ones that predated it. Before the
        constraint, such a row was neither removed nor overwritten by any boot (the
        pair is skipped, so ``upsert`` never runs for it) and tripped the read guard
        on every dashboard request forever.
        """
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
    "OUTCOME_SEVERITY",
    "SavedReport",
    "VerdictIndex",
    "assess_report",
    "item_outcome",
    "outcome_severity",
]

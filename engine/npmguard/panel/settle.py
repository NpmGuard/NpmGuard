"""What the panel does once an audit on a cache-filling lane reaches its end.

This is the whole consumer side of the fold. Panel work runs on the one durable
queue in its own lane, so there is no second executor and no second hop: what used
to be a pool of workers awaiting futures for audits they had themselves admitted is
now one function, called once per settle, that answers "a verdict landed — file it".

Three things happen, in this order and for stated reasons:

1. INDEX THE VERDICT, from the report FILE where there is one. The file is
   authoritative because it is what the public listing and the CLI short-circuit
   read; the row's copy is the fallback for an audit that produced no file (no
   concrete version) or no report at all (a failure).
2. ALERT, only on a landed DANGEROUS verdict, and only with the origin the audit
   ROW carries. Deriving the origin from what the work points at cannot tell a
   public-repo scan from a registry-watch audit, which is how every public-repo
   finding once got filed as a watch alert.
3. NUDGE EVERY LIVE SET covering the pair — not "its own" set. A shared audit
   belongs to no single set by design (that is what dedupe buys), so progress is
   computed from ``audit_set_items ⋈ package_verdicts`` and every set covering the
   pair is advanced by one hook rather than one hook per kind of scan.

A settle with NO landable verdict still refreshes the sets. The pair is left with
no outcome and no live attempt, which ``item_outcome`` reads as ERROR — a visible
coverage gap rather than a set that waits forever on work that already finished.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import structlog

from ..lanes import PANEL_LANES
from ..persistence import AuditSession
from ..report_store import load_report as default_load_report
from .audit_set import ORIGIN_WATCHLIST, AuditSetStore
from .verdict_index import LANDABLE_VERDICTS, VerdictIndex, assess_report

log = structlog.get_logger("npmguard.panel.settle")

LoadReport = Callable[[str, str], tuple[dict, str] | None]
# (package, version, origin) for a landed DANGEROUS verdict. Injected so this
# module stays free of the alerts subsystem and its email transport.
OnDangerous = Callable[[str, str, str], Awaitable[None]]


def build_settle_hook(
    verdicts: VerdictIndex,
    sets: AuditSetStore,
    *,
    on_dangerous: OnDangerous | None = None,
    load_report: LoadReport = default_load_report,
) -> Callable[[AuditSession], Awaitable[None]]:
    """The ``AuditService.on_settled`` callback, bound to the panel's stores."""

    async def on_settled(settled: AuditSession) -> None:
        if settled.lane not in PANEL_LANES:
            return  # a paid or bench audit answers one caller and joins no set
        version = settled.requested_version
        if version is None:
            # Nothing to key the shared cache on: the index is (name, version), and
            # a resolved-at-runtime "latest" is not a version anybody can look up.
            return
        # Off the loop: a miss scans and parses the package's whole directory,
        # and this runs on a worker that has audits waiting behind it.
        loaded = await asyncio.to_thread(load_report, settled.package_name, version)
        report = loaded[0] if loaded else (settled.report or {})
        verdict, reason, evidence = assess_report(report)
        if verdict in LANDABLE_VERDICTS:
            await verdicts.upsert(settled.package_name, version, verdict, reason, evidence)
            if verdict == "DANGEROUS" and on_dangerous is not None:
                await on_dangerous(
                    settled.package_name, version, settled.origin or ORIGIN_WATCHLIST
                )
        else:
            log.warning(
                "panel audit produced no landable verdict",
                package=settled.package_name,
                version=version,
                lane=settled.lane,
                verdict=verdict,
            )
        await sets.refresh_touching(settled.package_name, version)

    return on_settled


__all__ = ["LoadReport", "OnDangerous", "build_settle_hook"]

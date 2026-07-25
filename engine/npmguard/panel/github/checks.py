"""GitHub check runs for the repo panel (port of TS ``github/checks.ts``).

A protected repo's push opens an audit set over the pushed commit's lockfile; the
set's outcome is surfaced to GitHub as a **check run** on the head commit. The
trust contract (spec §5.10): a check **fails only on DANGEROUS**. A SAFE rollup is
a success, an ERROR rollup is ``neutral`` (visible, never blocking, and never
claiming safe), and a set that covered nothing is ``neutral`` too — never left
open.

Every GitHub call here is best-effort: the App may have been registered without
the ``Checks:write`` permission, in which case create/conclude fail. We log and
carry on — the dashboard and email alert paths do not depend on the check.

The ``octo`` argument is a resolved installation :class:`~githubkit.GitHub`
client (the caller mints it via ``gh_client.installation_octokit``), matching
``github/content.py``'s "octo passed in" style.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import structlog

from ..verdict_index import OUTCOMES

if TYPE_CHECKING:  # pragma: no cover - import cycle: audit_set imports nothing here
    from ..audit_set import Rollup

log = structlog.get_logger("npmguard.panel.checks")

CHECK_NAME = "NpmGuard"


# The one outcome -> check-state mapping (design §4.4). Total over the outcome
# domain, so a value it does not cover is a domain violation rather than a
# silent "in progress" — which is what the old catch-all arm hid.
_CONCLUSION = {"DANGEROUS": "failure", "ERROR": "neutral", "SAFE": "success"}

# A set that covered nothing. Distinct from every outcome, and NOT a reason to
# leave the check open: the audit ran and had no work, which is a terminal fact.
_EMPTY_CONCLUSION = "neutral"


def check_conclusion(rollup: Rollup) -> str:
    """Map a FINALIZED set's rollup to a TERMINAL GitHub check state.

    - ``DANGEROUS`` → ``"failure"`` — the ONLY blocking outcome (trust contract).
    - ``SAFE`` → ``"success"``.
    - ``ERROR`` → ``"neutral"``: the audit could not conclude. It does not block
      the push, and it must not report success either — "we tried and failed" is
      a fact GitHub gets to see.
    - ``total == 0`` → ``"neutral"``: nothing to audit.

    Takes the ROLLUP, not the outcome, and that is the whole point. A finalized set
    has ``pending == 0``, so ``outcome is None`` can only mean ``total == 0`` —
    "the set covered nothing", not "nothing has concluded yet". With only an
    outcome to look at, those two were the same value, the mapper answered
    ``in_progress``, and a push that added no new dependencies left its check run
    spinning forever. Distinguishing them is a rollup fact, and became expressible
    the moment progress got its own entity.

    Pure — the single source of truth for the fail-only-on-DANGEROUS policy.
    """
    # INVARIANT: only a finalized set is concluded, and a finalized set has no
    # pending items — so there is no non-terminal answer to give.
    assert rollup.pending == 0, (
        f"check_conclusion got a set with {rollup.pending} pending items; only a "
        "finalized set is concluded, and finalizing requires pending == 0"
    )
    if rollup.total == 0:
        return _EMPTY_CONCLUSION
    # INVARIANT: total > 0 and pending == 0 ⇒ something concluded ⇒ outcome is a
    # panel outcome, so the mapping is total.
    assert rollup.outcome in OUTCOMES, (
        f"a finalized set of {rollup.total} items has outcome {rollup.outcome!r}, "
        f"which is outside {sorted(OUTCOMES)}"
    )
    return _CONCLUSION[rollup.outcome]


def check_summary(rollup: Rollup) -> str:
    """A short human summary for the check output panel."""
    if rollup.total == 0:
        return "NpmGuard found no dependencies to audit in this commit."
    if rollup.outcome == "DANGEROUS":
        detail = f" ({rollup.dangerous} dangerous)" if rollup.dangerous else ""
        return f"NpmGuard found a DANGEROUS dependency{detail}."
    if rollup.outcome == "ERROR":
        detail = f" ({rollup.error} could not be audited)" if rollup.error else ""
        return f"NpmGuard could not complete this audit{detail} — no clean bill of health."
    return f"NpmGuard found no dangerous dependencies in {rollup.total} packages."


async def create_check_run(
    octo: Any, owner: str, repo: str, head_sha: str
) -> int | None:
    """Open an ``in_progress`` check run on ``head_sha``; return its id (or
    ``None`` if the call failed — never fatal)."""
    try:
        resp = await octo.rest.checks.async_create(
            owner,
            repo,
            name=CHECK_NAME,
            head_sha=head_sha,
            status="in_progress",
        )
        data = resp.json()
        check_run_id = data.get("id") if isinstance(data, dict) else None
        return int(check_run_id) if check_run_id is not None else None
    except Exception as err:  # noqa: BLE001 - a missing Checks:write is not fatal
        log.warning(
            "check run create failed",
            repo=f"{owner}/{repo}",
            sha=head_sha[:7],
            error=str(err),
        )
        return None


async def conclude_check_run(
    octo: Any,
    owner: str,
    repo: str,
    check_run_id: int,
    conclusion: str,
    summary: str,
    *,
    title: str = CHECK_NAME,
) -> None:
    """Complete a check run with a terminal ``conclusion``
    (``"success"``/``"failure"``). Failures are logged, never raised."""
    try:
        await octo.rest.checks.async_update(
            owner,
            repo,
            check_run_id,
            status="completed",
            conclusion=conclusion,
            output={"title": title, "summary": summary},
        )
    except Exception as err:  # noqa: BLE001 - conclusion failure must not crash a scan
        log.warning(
            "check run conclude failed",
            repo=f"{owner}/{repo}",
            check_run_id=check_run_id,
            error=str(err),
        )


__all__ = [
    "CHECK_NAME",
    "check_conclusion",
    "check_summary",
    "conclude_check_run",
    "create_check_run",
]

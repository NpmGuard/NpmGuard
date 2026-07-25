"""GitHub check runs for the repo panel (port of TS ``github/checks.ts``).

A protected repo's push triggers a delta scan; the scan's outcome is surfaced to
GitHub as a **check run** on the head commit. The trust contract (spec §5.10): a
check **fails only on DANGEROUS**. A SAFE rollup is a success, an ERROR rollup is
``neutral`` (visible, never blocking, and never claiming safe), and a set with
nothing concluded yet leaves the check ``in_progress`` — it is never concluded
prematurely.

Every GitHub call here is best-effort: the App may have been registered without
the ``Checks:write`` permission, in which case create/conclude fail. We log and
carry on — the dashboard and email alert paths do not depend on the check.

The ``octo`` argument is a resolved installation :class:`~githubkit.GitHub`
client (the caller mints it via ``gh_client.installation_octokit``), matching
``github/content.py``'s "octo passed in" style.
"""

from __future__ import annotations

from typing import Any

import structlog

from ..verdict_index import OUTCOMES

log = structlog.get_logger("npmguard.panel.checks")

CHECK_NAME = "NpmGuard"


# The one outcome -> check-state mapping (design §4.4). Total over the outcome
# domain, so a value it does not cover is a domain violation rather than a
# silent "in progress" — which is what the old catch-all arm hid.
_CONCLUSION = {"DANGEROUS": "failure", "ERROR": "neutral", "SAFE": "success"}


def check_conclusion(outcome: str | None) -> str:
    """Map a set's rollup outcome to a GitHub check state.

    - ``DANGEROUS`` → ``"failure"`` — the ONLY blocking outcome (trust contract).
    - ``SAFE`` → ``"success"``.
    - ``ERROR`` → ``"neutral"``: the audit could not conclude. It does not block
      the push, and it must not report success either — "we tried and failed" is
      a fact GitHub gets to see.
    - ``None`` (nothing concluded yet) → ``"in_progress"``: the only non-terminal
      state, and it is PROGRESS, not an outcome.

    Pure — the single source of truth for the fail-only-on-DANGEROUS policy.
    """
    if outcome is None:
        return "in_progress"
    # INVARIANT: a non-null outcome is a panel outcome, so the mapping is total.
    assert outcome in OUTCOMES, f"{outcome!r} is not a panel outcome"
    return _CONCLUSION[outcome]


def check_summary(outcome: str | None, rollup: dict[str, Any] | None = None) -> str:
    """A short human summary for the check output panel."""
    if outcome == "DANGEROUS":
        count = (rollup or {}).get("dangerous")
        detail = f" ({count} dangerous)" if count else ""
        return f"NpmGuard found a DANGEROUS dependency{detail}."
    if outcome == "ERROR":
        count = (rollup or {}).get("error")
        detail = f" ({count} could not be audited)" if count else ""
        return f"NpmGuard could not complete this audit{detail} — no clean bill of health."
    if outcome == "SAFE":
        return "NpmGuard found no dangerous dependencies."
    return "NpmGuard audit in progress."


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

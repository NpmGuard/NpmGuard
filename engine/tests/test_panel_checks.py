# CLASS MAP — panel.github.checks (port of TS github/checks.ts)
# (seam: check_conclusion is PURE — a FINALIZED set's rollup in, a TERMINAL check
#  state out, no IO. It takes the rollup rather than the outcome because
#  "the set covered nothing" and "nothing concluded yet" are the same OUTCOME
#  (None) and different ROLLUPS (total 0 vs pending > 0) — and only a rollup can
#  tell them apart. The create/conclude API calls run against a FAKE githubkit
#  octo that records calls or raises — no network, no GitHub App, no real runs.)
# check_conclusion — total over the outcome domain (§4.4) x coverage:
#   C1  DANGEROUS -> 'failure' (the only blocking outcome, trust contract §5.10)
#   C2  SAFE -> 'success'
#   C3  ERROR -> 'neutral': visible, non-blocking, and NOT a success — an audit
#       that could not conclude must never read as a clean bill of health
#   C4  total == 0 -> 'neutral': nothing to audit is a TERMINAL fact. Before R-1
#       this set's outcome was None, the mapper answered 'in_progress', and an
#       empty push left its check run spinning forever
#   C5  a value outside the domain (a legacy UNKNOWN/SUSPECT) raises, instead of
#       silently parking the check in_progress forever
#   C5b a set with PENDING items raises: only a finalized set is concluded, so
#       there is no non-terminal answer for this function to give
# check_summary:
#   C10 the ERROR summary names the failed count and refuses to claim safety
#   C11 the empty-set summary says there was nothing to audit, not "no dangerous
#       dependencies" — the SAFE copy over zero packages is a false clean bill
# create_check_run:
#   C6  success -> returns the new check-run id, POSTs status='in_progress'
#   C7  a GitHub failure is swallowed -> returns None (never fatal)
# conclude_check_run:
#   C8  PATCHes status='completed' + the mapped conclusion + summary output
#   C9  a GitHub failure is swallowed (logged, never raised)
import pytest

from npmguard.panel.audit_set import Rollup
from npmguard.panel.github.checks import (
    CHECK_NAME,
    check_conclusion,
    check_summary,
    conclude_check_run,
    create_check_run,
)

# --------------------------------------------------------------------------
# check_conclusion — pure mapping
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rollup", "expected"),
    [
        (Rollup(outcome="DANGEROUS", total=1, dangerous=1), "failure"),  # C1
        (Rollup(outcome="SAFE", total=1, safe=1), "success"),  # C2
        (Rollup(outcome="ERROR", total=1, error=1), "neutral"),  # C3
        (Rollup(), "neutral"),  # C4 — covered nothing
    ],
)
def test_check_conclusion_mapping(rollup, expected) -> None:
    """C1-C4: only DANGEROUS blocks; SAFE passes; ERROR concludes as neutral so a
    failed audit is neither hidden nor reported green; and a set that covered
    NOTHING concludes too, rather than leaving the run open forever."""
    assert check_conclusion(rollup) == expected


@pytest.mark.parametrize("legacy", ["UNKNOWN", "SUSPECT"])
def test_check_conclusion_rejects_legacy_verdict(legacy) -> None:
    """C5: the retired 4-state vocabulary fails loud here. Before, both mapped to
    in_progress — so a check run was silently never concluded.

    A ``KeyError`` from ``_CONCLUSION``, which is the mapping's own totality rather
    than an assert in front of it. The assert that used to precede this lookup fired
    on exactly the same inputs and only improved the message, and its input is
    ``Rollup.outcome``, set one call chain up from ``item_outcome``.
    """
    with pytest.raises(KeyError, match=legacy):
        check_conclusion(Rollup(outcome=legacy, total=1, safe=1))


def test_check_conclusion_refuses_an_unfinished_set() -> None:
    """C5b: concluding is terminal, and a set with pending items has not finished.
    Asked to answer anyway, this raises rather than inventing a non-terminal
    check state — the branch that used to exist for exactly that case."""
    with pytest.raises(AssertionError, match="pending"):
        check_conclusion(Rollup(outcome="SAFE", total=2, safe=1, pending=1))


def test_check_summary_error_never_claims_safe() -> None:
    """C10: the ERROR summary reports the count and says no clean bill of
    health — the SAFE copy ("no dangerous dependencies") would be a lie."""
    summary = check_summary(Rollup(outcome="ERROR", total=12, error=12))
    assert "12" in summary
    assert "could not complete" in summary
    assert "no dangerous dependencies" not in summary


def test_check_summary_empty_set_says_nothing_to_audit() -> None:
    """C11: zero packages is not "no dangerous dependencies found" — that phrasing
    over an empty set is a clean bill of health nobody earned."""
    summary = check_summary(Rollup())
    assert "no dependencies to audit" in summary


# --------------------------------------------------------------------------
# create / conclude — against a fake githubkit octo
# --------------------------------------------------------------------------


class _Resp:
    def __init__(self, data) -> None:
        self._data = data

    def json(self):
        return self._data


class _FakeChecks:
    def __init__(self, *, create_id=None, raise_on=None) -> None:
        self._create_id = create_id
        self._raise_on = raise_on or set()
        self.create_calls: list[dict] = []
        self.update_calls: list[dict] = []

    async def async_create(self, owner, repo, **kwargs):
        if "create" in self._raise_on:
            raise RuntimeError("Resource not accessible by integration")
        self.create_calls.append({"owner": owner, "repo": repo, **kwargs})
        return _Resp({"id": self._create_id})

    async def async_update(self, owner, repo, check_run_id, **kwargs):
        if "update" in self._raise_on:
            raise RuntimeError("Resource not accessible by integration")
        self.update_calls.append(
            {"owner": owner, "repo": repo, "check_run_id": check_run_id, **kwargs}
        )
        return _Resp({"id": check_run_id})


class _FakeOcto:
    def __init__(self, checks) -> None:
        self.rest = type("Rest", (), {"checks": checks})()


async def test_create_check_run_returns_id() -> None:
    """C6: a successful create opens an in_progress run and returns its id."""
    checks = _FakeChecks(create_id=42)
    octo = _FakeOcto(checks)

    result = await create_check_run(octo, "acme", "app", "deadbeef" * 5)

    assert result == 42
    call = checks.create_calls[0]
    assert call["name"] == CHECK_NAME
    assert call["status"] == "in_progress"
    assert call["head_sha"] == "deadbeef" * 5


async def test_create_check_run_swallows_failure() -> None:
    """C7: a missing Checks:write permission (GitHub raises) returns None, never
    raises — the dashboard/email paths still work."""
    octo = _FakeOcto(_FakeChecks(raise_on={"create"}))
    assert await create_check_run(octo, "acme", "app", "abc123") is None


async def test_conclude_check_run_completes() -> None:
    """C8: conclude PATCHes status=completed with the conclusion + summary."""
    checks = _FakeChecks()
    octo = _FakeOcto(checks)

    await conclude_check_run(octo, "acme", "app", 42, "failure", "found malware")

    call = checks.update_calls[0]
    assert call["check_run_id"] == 42
    assert call["status"] == "completed"
    assert call["conclusion"] == "failure"
    assert call["output"]["summary"] == "found malware"


async def test_conclude_check_run_swallows_failure() -> None:
    """C9: a GitHub failure while concluding is logged, never raised."""
    octo = _FakeOcto(_FakeChecks(raise_on={"update"}))
    # Must not raise.
    await conclude_check_run(octo, "acme", "app", 42, "success", "clean")

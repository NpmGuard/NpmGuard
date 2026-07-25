"""Publisher continuity classification.

Class map — the states, and the ways each one can be wrong:

    C1  no attestations at all           -> silent (the 99.99% case)
    C2  this version attested by the run's publisher -> ATTESTED
    C3  attested by someone new          -> NEW_PUBLISHER
    C4  unattested after a long run      -> BREAK          (THE signal)
    C5  unattested after a short run     -> UNATTESTED, not BREAK
    C6  unattested after a STALE run     -> not BREAK       (contiguity)
    C7  a run split across publishers    -> counted per publisher
    C8  continuity never touches verdict

The false-positive cases (C1, C5, C6, C7) are load-bearing. A signal that fires
on ordinary npm is one every user learns to ignore, and then it protects nobody
on the day it is right.
"""

from __future__ import annotations

from npmguard.attest_index import (
    DEFAULT_STREAK_THRESHOLD,
    SEVERITY,
    Release,
    continuity_for,
)

ALICE = "0xalice"
BOB = "0xbob"


def _history(*specs: tuple[str, str | None]) -> list[Release]:
    return [Release(version=v, nullifier=n, tier=1 if n else 0) for v, n in specs]


# --- C1: silence is the default ---------------------------------------------


def test_a_package_nobody_ever_attested_says_nothing() -> None:
    """Almost all of npm is unattested. Warning here would fire on everything,
    train users to ignore the signal, and punish maintainers for not adopting
    something that did not exist when they published."""
    history = _history(("1.0.0", None), ("1.0.1", None), ("1.0.2", None))
    result = continuity_for(history, "1.0.2")
    assert result.status == "NO_HISTORY"
    assert SEVERITY[result.status] == 0


# --- C2/C3: attested ---------------------------------------------------------


def test_a_release_by_the_established_publisher_is_attested() -> None:
    history = _history(("1.0.0", ALICE), ("1.0.1", ALICE), ("1.0.2", ALICE))
    result = continuity_for(history, "1.0.2")
    assert result.status == "ATTESTED"
    assert result.publisher == ALICE
    assert result.streak == 3


def test_a_release_by_an_unseen_publisher_is_flagged_not_blessed() -> None:
    """An attested release is not automatically fine. A takeover where the
    attacker CAN produce a proof is still a publisher change, and the human
    reading this needs to know a different person pressed publish."""
    history = _history(("1.0.0", ALICE), ("1.0.1", ALICE), ("1.0.2", BOB))
    result = continuity_for(history, "1.0.2")
    assert result.status == "NEW_PUBLISHER"
    assert result.publisher == BOB
    assert SEVERITY["NEW_PUBLISHER"] > SEVERITY["ATTESTED"]


def test_the_very_first_attested_release_is_not_a_new_publisher() -> None:
    """There is nobody to be new relative to. Flagging the first adopter would
    make adopting the feature look suspicious."""
    history = _history(("1.0.0", None), ("1.0.1", None), ("1.0.2", ALICE))
    assert continuity_for(history, "1.0.2").status == "ATTESTED"


# --- C4: THE signal ----------------------------------------------------------


def test_an_unattested_release_after_a_run_is_a_break() -> None:
    """The whole product in one assertion.

    Three consecutive releases by one proven human, then a release proving
    nothing. That is what a stolen npm token or a self-replicating worm looks
    like from outside: the bytes may be unremarkable, but the publisher stopped
    being able to prove they are the publisher.
    """
    history = _history(
        ("1.0.0", ALICE), ("1.0.1", ALICE), ("1.0.2", ALICE), ("1.0.3", None)
    )
    result = continuity_for(history, "1.0.3")
    assert result.status == "BREAK"
    assert result.streak == 3
    assert result.publisher == ALICE
    assert SEVERITY["BREAK"] == max(SEVERITY.values())


def test_the_break_summary_names_the_run_it_broke() -> None:
    """A bare status is unactionable. The reader must be told what pattern
    existed, or they cannot judge whether breaking it matters."""
    history = _history(*[(f"1.0.{i}", ALICE) for i in range(5)], ("1.0.5", None))
    result = continuity_for(history, "1.0.5")
    assert result.status == "BREAK"
    assert "5" in result.summary


# --- C5/C6/C7: the false positives that would ruin the signal ---------------


def test_one_attested_release_then_a_gap_is_not_a_break() -> None:
    """Far more likely a maintainer tried the feature once than that an account
    was taken over. Below the threshold this is not a pattern."""
    history = _history(("1.0.0", ALICE), ("1.0.1", None))
    result = continuity_for(history, "1.0.1")
    assert result.status == "UNATTESTED"
    assert SEVERITY[result.status] < SEVERITY["BREAK"]


def test_a_run_that_already_lapsed_does_not_break_again() -> None:
    """Contiguity is the point.

    A package attested long ago that then went quiet has no live pattern left to
    break. Without this, every subsequent release of an abandoned-then-resumed
    package reports BREAK forever.
    """
    history = _history(
        ("1.0.0", ALICE),
        ("1.0.1", ALICE),
        ("1.0.2", ALICE),
        ("1.0.3", None),  # the real break
        ("1.0.4", None),
        ("1.0.5", None),
    )
    assert continuity_for(history, "1.0.3").status == "BREAK"
    assert continuity_for(history, "1.0.5").status == "UNATTESTED"


def test_a_run_is_measured_per_publisher_not_per_package() -> None:
    """Two publishers alternating do not add up to one long streak. The streak
    measures ONE human's consistency; 'somebody was attesting' is not a pattern
    a takeover breaks."""
    history = _history(
        ("1.0.0", ALICE), ("1.0.1", BOB), ("1.0.2", ALICE), ("1.0.3", None)
    )
    result = continuity_for(history, "1.0.3")
    assert result.streak == 1
    assert result.status == "UNATTESTED", "one release each is not a run"


def test_the_threshold_is_the_only_thing_separating_break_from_quiet() -> None:
    history = _history(*[(f"1.0.{i}", ALICE) for i in range(DEFAULT_STREAK_THRESHOLD)])
    history.append(Release(version="9.9.9"))
    assert continuity_for(history, "9.9.9").status == "BREAK"

    shorter = _history(*[(f"1.0.{i}", ALICE) for i in range(DEFAULT_STREAK_THRESHOLD - 1)])
    shorter.append(Release(version="9.9.9"))
    assert continuity_for(shorter, "9.9.9").status == "UNATTESTED"


def test_an_unknown_version_is_never_classified_as_a_break() -> None:
    """Asked about something not in the history: report the package, do not
    invent a verdict about a version we have no record of."""
    history = _history(("1.0.0", ALICE), ("1.0.1", ALICE), ("1.0.2", ALICE))
    result = continuity_for(history, "7.7.7")
    assert result.status == "NO_HISTORY"
    assert result.attested_count == 3


# --- C8: the axis invariant --------------------------------------------------


def test_continuity_exposes_no_verdict_field_at_all() -> None:
    """Structural guard for the invariant.

    Continuity is derived from who published; the verdict is derived from what
    the code does. If this object ever grows a verdict-shaped field, someone is
    about to collapse two independent axes into one and destroy both.
    """
    payload = continuity_for(_history(("1.0.0", ALICE)), "1.0.0").to_json()
    assert "verdict" not in payload
    assert not {"SAFE", "DANGEROUS", "ERROR"} & set(map(str, payload.values()))

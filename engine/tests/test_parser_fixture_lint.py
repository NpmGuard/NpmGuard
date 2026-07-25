# CLASS MAP — tools/parser_fixture_lint, the mechanism behind TESTING.md's
# parser-input rule. Runs in the DEFAULT suite rather than only in scripts/gate.sh,
# because a rule enforced by a script nobody runs locally is advisory again.
# Axes: literal provenance (in a fixture / absent) × position (docstring / input) ×
#       escape marker (present / absent) × marker collision with ordinary code
#   C1 the whole tests tree passes, except a pinned set of files owned elsewhere
#   C2 a hand-authored external-format literal is caught
#   C3 the same literal, once committed as a fixture, passes
#   C4 docstrings and comments are prose, never scanned — otherwise every class map
#      that DESCRIBES the bad shape would fail the rule that forbids asserting it
#   C5 the escape marker suppresses a file, and only inside the marked function
#   C6 markers do not fire on ordinary code that merely looks similar — the
#      instrumentation tests are full of JavaScript `http.request(`, which is not
#      tshark output
from pathlib import Path

from tools.parser_fixture_lint import ESCAPE, lint_file, lint_tests

TESTS_ROOT = Path(__file__).parent

# Empty, and the assertion below keeps it that way: an entry that stops offending
# must be DELETED, so an exemption cannot rot into a permanent licence. The one entry
# this set ever held (`test_evidence.py`, whose four strace `raw` values were written
# by hand) was cleared by driving those classes through the real `parse_strace_log`
# over committed captures — `tests/fixtures/sensors/strace-connect-results.log`, plus
# lines already committed in `strace-node.log` — rather than by widening anything.
PINNED_UNFIXED: set[str] = set()


def test_no_hand_authored_external_format_input_outside_the_pinned_files() -> None:
    """C1: the rule, enforced. Every string literal in tests/ that looks like
    strace or tshark output must appear in a committed fixture, or sit in a
    function whose docstring admits it is not a captured shape."""
    failures = lint_tests(TESTS_ROOT)
    offenders = {failure.split(":", 1)[0] for failure in failures}
    unexpected = offenders - PINNED_UNFIXED
    assert not unexpected, "hand-authored external-format test input:\n" + "\n".join(
        f for f in failures if f.split(":", 1)[0] in unexpected
    )
    stale = PINNED_UNFIXED - offenders
    assert not stale, (
        f"{sorted(stale)} no longer holds hand-authored external-format input — "
        "delete it from PINNED_UNFIXED so the exemption cannot rot"
    )


def test_hand_authored_shape_is_caught_and_a_committed_one_is_not(tmp_path) -> None:
    """C2/C3: the same literal fails when it is invented and passes once it is
    captured. This is the check that would have caught `sin_addr="1.2.3.4"`, the
    literal that kept a dead regex green for the whole life of sensors.py — and
    that a later fix widened the production regex to keep passing."""
    invented = '1700000002.0 connect(7, {sa_family=AF_INET, sin_addr="1.2.3.4"}, 16) = 0'
    module = tmp_path / "test_probe.py"
    module.write_text(f'def test_x():\n    parse({invented!r})\n')
    assert len(lint_file(module, corpus="")) == 1
    assert "in no committed fixture" in lint_file(module, corpus="")[0]
    # Same literal, now present in the fixture corpus.
    assert lint_file(module, corpus=f"some captured log\n{invented}\nmore\n") == []


def test_docstrings_and_comments_are_prose_not_input(tmp_path) -> None:
    """C4: a class map that DESCRIBES the imagined shape is how the finding gets
    recorded, so scanning docstrings would forbid documenting the very defect the
    rule exists to prevent. This file's own header would fail such a check."""
    module = tmp_path / "test_probe.py"
    module.write_text(
        '"""Module doc mentioning sa_family=AF_INET and sin_addr="1.2.3.4"."""\n\n\n'
        "def test_x():\n"
        '    """The regex looked for sin_addr="1.2.3.4" with htons(443)."""\n'
        "    # a comment with sa_family=AF_UNIX and AT_FDCWD\n"
        "    return 1\n"
    )
    assert lint_file(module, corpus="") == []


def test_escape_marker_is_scoped_to_the_function_that_admits_it(tmp_path) -> None:
    """C5: the escape is per-function, so admitting one constructed shape does not
    quietly license the rest of the file."""
    module = tmp_path / "test_probe.py"
    module.write_text(
        "def test_marked():\n"
        f'    """Deliberately impossible. {ESCAPE}: strace cannot emit this."""\n'
        '    parse("connect(7, {sa_family=AF_INET, sin_addr=<junk>}, 16) = 0")\n'
        "\n\n"
        "def test_unmarked():\n"
        '    parse("connect(8, {sa_family=AF_INET, sin_addr=<junk>}, 16) = 0")\n'
    )
    failures = lint_file(module, corpus="")
    assert len(failures) == 1
    assert "connect(8" in failures[0]


def test_markers_do_not_fire_on_ordinary_code_that_looks_similar(tmp_path) -> None:
    """C6: `http.request(` is a Node API call and appears throughout the
    instrumentation tests, which are JavaScript source rather than tshark output.
    A marker list that cannot tell them apart makes the rule unusable, and an
    unusable rule gets deleted."""
    module = tmp_path / "test_probe.py"
    module.write_text(
        "def test_x():\n"
        "    return run(\"const req = _http.request('http://x.test/exfil');\")\n"
    )
    assert lint_file(module, corpus="") == []
    # The tshark JSON *key* form still fires.
    module.write_text('def test_y():\n    parse(\'{"http.request": "1"}\')\n')
    assert len(lint_file(module, corpus="")) == 1

"""Enforce TESTING.md's parser-input rule mechanically.

    A test for a parser of an EXTERNAL format must use input captured from the
    real producer, committed as a fixture. A hand-authored example is acceptable
    only for shapes we emit ourselves.

The rule exists because a whitebox test written against a format you imagined is
not a test — it is the same assumption stated twice. `sensors.py` matched the peer
address of an strace connect with `sin_addr="([^"]+)"`; strace emits
`sin_addr=inet_addr("127.0.0.1")`. The regex matched nothing, ever. It stayed green
for the module's whole life because `test_sensors.py` asserted the same imagined
shape, and a later fix WIDENED the regex to keep that test passing rather than
deleting it.

So this checks the thing review kept missing: every string literal in a test that
looks like external-format text must appear in a committed fixture.

How it decides:

* MARKERS are tokens that occur only inside the external formats we parse. A
  literal containing one is external-format text.
* Docstrings and comments are prose, never input, and are not scanned.
* A literal passes if each of its non-blank lines is a substring of some file
  under tests/fixtures/.
* A function may opt out by putting ESCAPE in its docstring, which forces the
  author to write down, at the assertion, that the shape is deliberately not real.
  There are exactly two honest uses: asserting that a shape the producer CANNOT
  emit is rejected, and a shape we tried and failed to capture — in which case the
  docstring must say so.

Run: `uv run python -m tools.parser_fixture_lint`
"""

from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path

ESCAPE = "NOT-A-CAPTURED-SHAPE"

# Tokens that appear only inside an external producer's output. Grows whenever a
# new external format acquires a parser; a format with no marker here is not
# enforced, which is a gap to close rather than a licence.
MARKERS: dict[str, tuple[str, ...]] = {
    "strace": (
        "sa_family=",
        "sin_addr=",
        "sin6_addr",
        "sun_path=",
        "<unfinished ...>",
        " resumed>",
        "htons(",
        "AT_FDCWD",
        "O_CLOEXEC",
        "nlmsg_type=",
        "inet_pton(",
        "+++ exited",
        "+++ killed",
    ),
    # Quoted forms only. tshark field names are JSON KEYS, and the bare tokens
    # collide with ordinary JavaScript: `http.request(` appears throughout the
    # instrumentation tests, which are not tshark input at all.
    "tshark": (
        '"dns.qry.name"',
        '"http.request"',
        '"frame.time_relative"',
        '"tls.handshake.extensions_server_name"',
        '"_source"',
        '"_ws.expert"',
    ),
}


class LintFailure(Exception):
    pass


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """id() of every string Constant that is a docstring — prose, not input."""
    marked: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                marked.add(id(body[0].value))
    return marked


def _escaped_ranges(tree: ast.AST) -> list[tuple[int, int, str]]:
    """(start, end, name) of every function whose docstring carries ESCAPE."""
    ranges = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            doc = ast.get_docstring(node) or ""
            if ESCAPE in doc:
                ranges.append((node.lineno, node.end_lineno or node.lineno, node.name))
    return ranges


def _fixture_corpus(fixtures_root: Path) -> str:
    parts = []
    for path in sorted(fixtures_root.rglob("*")):
        if path.is_file():
            parts.append(path.read_text(errors="surrogateescape"))
    return "\n".join(parts)


def lint_file(path: Path, corpus: str) -> list[str]:
    """Return one failure message per hand-authored external-format literal."""
    source = path.read_text()
    tree = ast.parse(source, filename=str(path))
    docstrings = _docstring_nodes(tree)
    escaped = _escaped_ranges(tree)
    failures = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in docstrings:
            continue
        matched = [
            (fmt, marker)
            for fmt, markers in MARKERS.items()
            for marker in markers
            if marker in node.value
        ]
        if not matched:
            continue
        line = node.lineno
        if any(start <= line <= end for start, end, _ in escaped):
            continue
        unmatched = [
            part
            for part in node.value.splitlines()
            if part.strip() and part not in corpus
        ]
        if unmatched:
            fmt, marker = matched[0]
            failures.append(
                f"{path.name}:{line}: hand-authored {fmt} input (marker {marker!r}) is in no "
                f"committed fixture: {unmatched[0][:120]!r}. Capture it from the real producer "
                f"and commit it, or — if the shape is deliberately one the producer CANNOT "
                f"emit — say so in the test's docstring with {ESCAPE}."
            )
    return failures


# This lint's OWN tests must contain the shapes it detects — that is what proves it
# detects them — so the file is skipped structurally rather than by sprinkling
# escape markers through it. The exemption is one file, named, and it cannot rot:
# lint_file is called directly there with an explicit corpus.
SELF_TEST = "test_parser_fixture_lint.py"


def lint_tests(tests_root: str | Path = "tests") -> list[str]:
    root = Path(tests_root)
    corpus = _fixture_corpus(root / "fixtures")
    if not corpus:
        raise LintFailure(f"no fixtures under {root / 'fixtures'} — nothing to check against")
    failures = []
    for path in sorted(root.rglob("test_*.py")):
        if path.name == SELF_TEST:
            continue
        failures.extend(lint_file(path, corpus))
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tests_root", nargs="?", default="tests")
    args = parser.parse_args(argv)
    try:
        failures = lint_tests(args.tests_root)
    except LintFailure as exc:
        print(f"LINT FAIL: {exc}", file=sys.stderr)
        return 1
    for failure in failures:
        print(f"LINT FAIL: {failure}", file=sys.stderr)
    if failures:
        print(f"{len(failures)} hand-authored external-format inputs", file=sys.stderr)
        return 1
    print("parser fixtures OK: no hand-authored external-format test input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

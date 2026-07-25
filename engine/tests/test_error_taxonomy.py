# CLASS MAP — the wire error taxonomy as a CLOSED vocabulary (npmguard.errors,
# read through its public classes plus an `ast` scan of the production package;
# no private imports)
# Axes: does a declared code have a producer × is the wire contract coherent
#   C1 concrete NpmGuardError subclass  — constructed at least once under npmguard/,
#                                         so no consumer's code table carries a dead arm
#   C2 the base NpmGuardError           — never constructed; NPMGUARD-9999 reaches the
#                                         wire as a string literal from the fallback
#   C3 the code set                     — one class per code, each `NPMGUARD-dddd`
#   C4 retired 0002/0010/0050           — absent from the taxonomy AND from every
#                                         executable form in the package
#   C5 retryable members                — 5xx only: a client that retries on
#                                         `retryable` must never retry a client error
#
# Adversarial pass: 2026-07-25 — the first map asked only "is every class
# raised?", which a grep already answers, and it would have FAILED on the base
# class. The missing dimension was the exemption itself: NPMGUARD-9999's producer
# is a string literal, not a raise, so a rule phrased over raise sites alone
# either red-flags the base class or waves it through unexamined. C2 turns the
# exemption into an assertion. Second missing dimension: a *retired* code is
# reserved forever (kit_spine: "code is stable forever and is what clients branch
# on"), so C4 asserts absence rather than trusting that nobody recycles 0050 for
# a new meaning.
#
# The scan counts CONSTRUCTION, not `raise`, on purpose: `exc = X(...); raise exc`
# and `raise X(...) from err` are the same producer, and an exception class
# instantiated in production code but never raised would itself be a defect.
import ast
import re
from pathlib import Path

from npmguard import errors as taxonomy

PACKAGE = Path(taxonomy.__file__).parent
RETIRED_CODES = ("NPMGUARD-0002", "NPMGUARD-0010", "NPMGUARD-0050")
CODE_PATTERN = r"NPMGUARD-\d{4}"


def _members() -> dict[str, type[taxonomy.NpmGuardError]]:
    """Every NpmGuardError in the process, base included — subclasses are walked
    transitively so a taxonomy member declared outside errors.py still counts."""
    found: dict[str, type[taxonomy.NpmGuardError]] = {}
    stack = [taxonomy.NpmGuardError]
    while stack:
        cls = stack.pop()
        found[cls.__name__] = cls
        stack.extend(cls.__subclasses__())
    return found


def _production_sources(*, skip: set[str]) -> list[ast.Module]:
    return [
        ast.parse(path.read_text(encoding="utf-8"))
        for path in sorted(PACKAGE.rglob("*.py"))
        if path.name not in skip and "__pycache__" not in path.parts
    ]


def _called_names(*, skip: set[str]) -> set[str]:
    called: set[str] = set()
    for tree in _production_sources(skip=skip):
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name):
                    called.add(node.func.id)
                elif isinstance(node.func, ast.Attribute):
                    called.add(node.func.attr)
    return called


def _string_literals(*, skip: set[str]) -> set[str]:
    """String CONSTANTS only — comments and docstrings are prose, and the
    retirement ledger in errors.py is a comment, so `ast` cannot see it."""
    literals: set[str] = set()
    for tree in _production_sources(skip=skip):
        docstrings = {
            ast.get_docstring(node)
            for node in ast.walk(tree)
            if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef)
        }
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and node.value not in docstrings
            ):
                literals.add(node.value)
    return literals


def test_every_declared_error_has_a_producer() -> None:
    """C1: every concrete NpmGuardError is constructed somewhere in npmguard/.

    A declared code no engine path can produce forces every consumer building an
    exhaustive code table to carry an arm that can never be reached, and an
    unreachable arm is untestable by construction."""
    called = _called_names(skip={"errors.py"})
    dead = sorted(
        name
        for name, cls in _members().items()
        if cls is not taxonomy.NpmGuardError and name not in called
    )
    assert dead == [], (
        f"declared with no producer anywhere in {PACKAGE}: {dead}. "
        "Either give it a raise site or delete it — the taxonomy is closed."
    )


def test_base_error_is_the_fallback_and_not_a_member() -> None:
    """C2: NpmGuardError is never constructed, and its code still has a producer.

    This is the one exemption from C1, and it is checked rather than assumed:
    NPMGUARD-9999 is emitted as a literal on the non-NpmGuardError path, so the
    fallback code is reachable while the class is not."""
    assert "NpmGuardError" not in _called_names(skip={"errors.py"}), (
        "the base class is the 500 fallback, not a raisable member — raise a "
        "specific subclass, or declare a new one"
    )
    assert taxonomy.NpmGuardError.code in _string_literals(skip={"errors.py"}), (
        f"{taxonomy.NpmGuardError.code} has neither a raise site nor a literal "
        "producer, so nothing can emit it — C1's exemption no longer holds"
    )


def test_each_code_is_claimed_by_exactly_one_class() -> None:
    """C3: codes are unique and well-formed — two classes sharing a code would
    make the wire value ambiguous for the client that branches on it."""
    by_code: dict[str, list[str]] = {}
    for name, cls in _members().items():
        by_code.setdefault(cls.code, []).append(name)
    collisions = {code: sorted(names) for code, names in by_code.items() if len(names) > 1}
    assert collisions == {}, f"one code, two meanings: {collisions}"
    malformed = sorted(code for code in by_code if not re.fullmatch(CODE_PATTERN, code))
    assert malformed == [], f"codes must match {CODE_PATTERN}: {malformed}"


def test_retired_codes_are_never_recycled() -> None:
    """C4: 0002 / 0010 / 0050 appear nowhere executable.

    All three were declared without a producer; 0050's running-count session cap
    was deliberately replaced by the bounded wait queue plus a fixed worker pool.
    A code is stable forever, so re-using one of these numbers for a new meaning
    silently changes what an already-deployed client believes. This test fails
    against the pre-deletion tree, which is the point."""
    declared = {cls.code for cls in _members().values()}
    literals = _string_literals(skip=set())
    resurrected = sorted(
        code for code in RETIRED_CODES if code in declared or code in literals
    )
    assert resurrected == [], (
        f"retired codes back in executable form: {resurrected}. They are reserved "
        "— a new failure mode takes a new number (see the ledger in errors.py)."
    )


def test_retryable_errors_are_server_errors() -> None:
    """C5: `retryable` implies a 5xx. The flag exists so a caller can retry
    without parsing the message; a retryable 4xx would tell it to retry a request
    that is wrong on its face, forever."""
    incoherent = sorted(
        (cls.code, cls.http_status)
        for cls in _members().values()
        if cls.retryable and cls.http_status < 500
    )
    assert incoherent == [], f"retryable client errors: {incoherent}"

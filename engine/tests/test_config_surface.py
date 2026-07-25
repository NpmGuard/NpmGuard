# CLASS MAP — the settings surface as a set of knobs, checked in BOTH directions
# (npmguard.config.Settings through its declared fields plus an `ast` scan of the
# production package; no private imports)
# Axes: is a declared knob wired × is a read knob declared × was a retired knob
#       quietly re-declared
#   C1 every own Settings field   — read as `settings.<field>` somewhere under npmguard/
#   C2 the eight retired knobs    — still absent, so re-adding one is a decision
#                                   rather than an accident
#   C3 every NPMGUARD_* variable READ under npmguard/ — declared on Settings, so a
#                                   bad value is a named boot rejection and not a
#                                   crash on whichever code path first touches it
#   C4 the scan C3 depends on is COMPLETE — no dynamic environment key can hide a
#                                   read from it
#
# Why C1 is worth a test rather than a comment: an unread knob is not merely
# untidy. `triage_max_files` (default 80) read as a bound on the FLAG pass's model
# calls while `run_flag` in fact analysed every non-noise source file, and
# `max_docker_exec_timeout_sec` (default 30) read as a ceiling on docker execs
# while deps.py runs a 180s npm install through the same helper. A cap nobody
# reads is a protection that does not exist, and it is invisible to review because
# the declaration looks exactly like a working one.
#
# Why C3 is the other half, and why it was not added earlier: it needed a large
# exemption list until the reads were moved. `NPMGUARD_DEMO_SPEED=fast` stopped the
# engine BOOTING (`float()` on the raw string at demo.py module scope, and
# npmguard.api imports demo) with a ValueError naming neither the knob nor the
# module; `NPMGUARD_TRIAGE_CONCURRENCY` — the knob that sets model-call concurrency,
# i.e. the audit's cost behaviour — was `int(os.environ.get(...))` inside the FLAG
# fan-out, where a typo fails MID-AUDIT as a bare ValueError → NPMGUARD-9999,
# non-retryable, discarding an audit already paid for. So the cleanup and the test
# land together. The exemption table it needed at first is now EMPTY — the last two
# reads (`NPMGUARD_TRIAGE_CONCURRENCY`, `NPMGUARD_DATA_DIR`) landed with their
# declarations — and an empty table is the property C3 is really protecting: with a
# list beside it the rule degrades from "two items of named debt" into "it does not
# apply here". test_no_exemption_outlives_its_reader is what keeps it emptied.
#
import ast
import re
from pathlib import Path

from kit_spine import KitSettings
from npmguard import config as config_module
from npmguard.config import Settings

PRODUCTION = Path(config_module.__file__).parent
ENV_PREFIX = Settings.model_config["env_prefix"]
ENV_VARIABLE = re.compile(rf"{re.escape(ENV_PREFIX)}[A-Z0-9_]+")
# Environment reads C3 does not require a Settings field for. Each entry would be debt
# with a named owner, not a design choice — delete the entry together with the swap.
#
# EMPTY, and that is the property this table protects. An entry here is a licence to
# crash mid-audit on a typo; the honest move when one is tempting is to land the
# reader, not to grow the list.
UNDECLARED_READS: dict[str, str] = {}
RETIRED_KNOBS = (
    "triage_max_files",
    "max_agent_turns",
    "investigation_enabled",
    "test_gen_model",
    "test_gen_mode",
    "max_findings_to_prove",
    "verify_timeout_sec",
    "max_docker_exec_timeout_sec",
)


def _own_fields() -> list[str]:
    inherited = set(KitSettings.model_fields)
    return [name for name in Settings.model_fields if name not in inherited]


def _attributes_read() -> set[str]:
    """Every attribute name read anywhere in production code. Deliberately
    name-based rather than type-based: `settings`, `runtime.settings`,
    `self.settings` and a `getattr` chain all have to count, and no static pass
    over an untyped attribute can tell which object a name belongs to. The
    consequence is that this test can only produce FALSE PASSES (some other
    object has a same-named attribute), never false failures — so a failure here
    is always a real unread knob."""
    names: set[str] = set()
    for path in sorted(PRODUCTION.rglob("*.py")):
        if path.name == "config.py" or "__pycache__" in path.parts:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Attribute):
                names.add(node.attr)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                names.add(node.value)  # getattr(settings, "field") / field-name lookups
    return names


def test_every_declared_setting_is_read_by_production_code() -> None:
    """C1: no field on Settings is dead vocabulary.

    Holds today with an empty exemption list, which is the property worth
    protecting: the moment a knob needs an exemption, the honest move is to
    delete the knob or land its reader, not to grow a list."""
    unread = sorted(set(_own_fields()) - _attributes_read())
    assert unread == [], (
        f"declared but read by nothing under {PRODUCTION}: {unread}. A knob lands "
        "together with its reader — an unread cap reads as a protection that is "
        "not there."
    )


def _production_trees() -> list[tuple[Path, ast.Module]]:
    return [
        (path, ast.parse(path.read_text(encoding="utf-8")))
        for path in sorted(PRODUCTION.rglob("*.py"))
        if "__pycache__" not in path.parts
    ]


def _environment_access() -> tuple[dict[str, set[str]], list[str]]:
    """Every site where production code reads THIS process's environment, split into
    (literal `NPMGUARD_*` keys → the files reading them, sites with a computed key).

    Access SITES rather than string literals, because the two are not the same
    question. `experiments.py` builds `{"NPMGUARD_STUBS": …}` to hand to a Node
    process inside the sandbox container — the engine never reads it, an operator
    setting it in `.env` must have no effect, and declaring it on Settings would
    assert the opposite. A literal-only scan cannot tell that apart from a read.

    Covered spellings, all four of them: `os.environ[…]`, any method on `os.environ`
    (`get`/`setdefault`/`pop`), `os.getenv(…)`, and `"…" in os.environ`. `environ`
    and `getenv` are matched by NAME, so `from os import environ` and an aliased
    import are both caught."""
    found: dict[str, set[str]] = {}
    computed: list[str] = []
    for path, tree in _production_trees():
        for node in ast.walk(tree):
            for key in _environment_keys(node):
                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                    if ENV_VARIABLE.fullmatch(key.value):
                        found.setdefault(key.value, set()).add(path.name)
                else:
                    computed.append(f"{path.name}:{node.lineno}")
    return found, sorted(computed)


def _environment_keys(node: ast.AST) -> list[ast.expr]:
    if isinstance(node, ast.Subscript) and _names_environ(node.value):
        return [node.slice]
    if isinstance(node, ast.Compare) and any(
        isinstance(operator, ast.In | ast.NotIn) for operator in node.ops
    ):
        return [node.left for comparator in node.comparators if _names_environ(comparator)]
    if isinstance(node, ast.Call):
        function = node.func
        named = getattr(function, "id", None) == "getenv" or (
            isinstance(function, ast.Attribute)
            and (function.attr == "getenv" or _names_environ(function.value))
        )
        if named and node.args:
            return [node.args[0]]
    return []


def _names_environ(node: ast.expr) -> bool:
    if isinstance(node, ast.Attribute):
        return node.attr == "environ" or _names_environ(node.value)
    return isinstance(node, ast.Name) and node.id == "environ"


def test_every_environment_variable_read_is_declared() -> None:
    """C3: the inverse of C1. A variable production code reads is declared on
    Settings, so a malformed value is refused at boot with the variable named —
    instead of a bare ValueError from whichever `int()` or `float()` first sees it,
    which for a knob inside the FLAG fan-out means mid-audit on an audit already
    paid for.

    Measured against the pre-cleanup tree (this file dropped onto 0d73449): fails
    naming NPMGUARD_DEMO_SPEED (demo.py), NPMGUARD_NPM_REGISTRY (resolve.py),
    NPMGUARD_AUDIT_LOG_DIR (audit_log.py) and NPMGUARD_API_URL (ops.py) — four of the
    six then-undeclared reads, the other two being the pair in UNDECLARED_READS. That
    is the falsification: the four this change fixed all show up, and each surviving
    exemption is a named reader in a file a concurrent change owned, with its
    one-line swap written out — not a judgement that the knob is fine where it is."""
    declared = set(Settings.model_fields)  # inherited included: same prefix, same file
    read, _ = _environment_access()
    undeclared = {
        variable: sorted(files)
        for variable, files in read.items()
        if variable.removeprefix(ENV_PREFIX).lower() not in declared
        and variable not in UNDECLARED_READS
    }
    assert undeclared == {}, (
        f"read from the environment but not declared on Settings: {undeclared}. "
        "Declare it with real Field validation and read it from settings, or add it "
        "to UNDECLARED_READS with the reason and the swap it is waiting on."
    )


def test_no_exemption_outlives_its_reader() -> None:
    """C3, the other direction: an exemption is deleted when its read is. Left
    standing it becomes a permanent licence — the exact way an exemption list rots
    from 'two items of named debt' into 'the rule does not apply here'."""
    read, _ = _environment_access()
    stale = sorted(variable for variable in UNDECLARED_READS if variable not in read)
    assert stale == [], (
        f"exempted but no longer read anywhere under {PRODUCTION}: {stale}. "
        "The swap landed — delete the entry."
    )


def test_no_environment_key_is_computed() -> None:
    """C4: C3 reads string literals, so a computed key would be invisible to it. This
    is what keeps that from being a silent gap: `os.environ[PREFIX + name]` fails
    here, loudly, naming the file and line."""
    _, computed = _environment_access()
    assert computed == [], (
        f"environment accessed with a non-literal key: {computed}. The declared "
        "surface cannot be checked against a name that only exists at runtime — "
        "read it from Settings instead."
    )


def test_retired_knobs_stay_retired() -> None:
    """C2: the eight deleted knobs are not back on the surface.

    Each was declared without a reader anywhere. C1 alone would accept `triage_max_files` again the moment any reader appeared;
    this pin makes reintroducing one an explicit act — delete the entry here, with
    the reasoning in config.py's ledger read first. Fails against the
    pre-deletion tree, which is the point."""
    back = sorted(name for name in RETIRED_KNOBS if name in Settings.model_fields)
    assert back == [], (
        f"retired knobs re-declared: {back}. If a bound like this is genuinely "
        "wanted, it needs a reader whose truncation is VISIBLE in the report — a "
        "silently capped analysis is a coverage gap wearing a green badge."
    )

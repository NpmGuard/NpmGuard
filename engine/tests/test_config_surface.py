# CLASS MAP — the settings surface as a set of knobs that must all be READ
# (npmguard.config.Settings through its declared fields plus an `ast` scan of the
# production package; no private imports)
# Axes: is a declared knob wired × was a retired knob quietly re-declared
#   C1 every own Settings field   — read as `settings.<field>` somewhere under npmguard/
#   C2 the eight retired knobs    — still absent, so re-adding one is a decision
#                                   rather than an accident
#
# Why this is worth a test rather than a comment: an unread knob is not merely
# untidy. `triage_max_files` (default 80) read as a bound on the FLAG pass's model
# calls while `run_flag` in fact analysed every non-noise source file, and
# `max_docker_exec_timeout_sec` (default 30) read as a ceiling on docker execs
# while deps.py runs a 180s npm install through the same helper. A cap nobody
# reads is a protection that does not exist, and it is invisible to review because
# the declaration looks exactly like a working one.
#
# Adversarial pass: 2026-07-25 — the first version of C1 scanned the whole engine
# tree, which counted a TEST as a reader; a knob only tests read is still dead
# vocabulary in production, so the scan is restricted to `npmguard/`. Second
# missing dimension: inherited `KitSettings` fields (llm_*, env, log_level) are
# Kit's surface and are read inside Kit, so policing them here would fail on code
# this test cannot see — the scan is over OWN fields only.
import ast
from pathlib import Path

from kit_spine import KitSettings
from npmguard import config as config_module
from npmguard.config import Settings

PRODUCTION = Path(config_module.__file__).parent
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


def test_retired_knobs_stay_retired() -> None:
    """C2: the eight deleted knobs are not back on the surface.

    Each was declared without a reader here AND in the TypeScript engine this one
    was ported from, so the port carried the shape and never any behaviour. C1
    alone would accept `triage_max_files` again the moment any reader appeared;
    this pin makes reintroducing one an explicit act — delete the entry here, with
    the reasoning in config.py's ledger read first. Fails against the
    pre-deletion tree, which is the point."""
    back = sorted(name for name in RETIRED_KNOBS if name in Settings.model_fields)
    assert back == [], (
        f"retired knobs re-declared: {back}. If a bound like this is genuinely "
        "wanted, it needs a reader whose truncation is VISIBLE in the report — a "
        "silently capped analysis is a coverage gap wearing a green badge."
    )

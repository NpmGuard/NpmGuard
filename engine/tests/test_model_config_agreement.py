"""Every place that names the LLM model pair must name the SAME pair, and the pair
we ship must be one we have evidence about.

WHY THIS FILE EXISTS. Three sources disagreed about which models this engine runs
on, each looked authoritative, and reading any one of them gave a confidently wrong
answer:

    config.py            claude-haiku-4-5 / claude-sonnet-4-6   never ran
    .env.template        deepseek-v3.2 / z-ai/glm-5             never validated —
                                                                and it is what a
                                                                deploy copies
    recorded corpus      deepseek/deepseek-v4-flash (both)      what actually served

Only the third is evidence: a recording stores the model that ANSWERED, not the one
someone intended. A comment saying "keep these in step" is not a mechanism; this is.

C3 is the one that generalises — it does not enumerate today's files, it finds every
declaration in the repo. A fourth source appearing (a compose file, a systemd drop-in,
a second template) fails here rather than silently becoming the next wrong answer.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from npmguard.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE_ROOT = REPO_ROOT / "engine"
FIXTURES = ENGINE_ROOT / "tests" / "fixtures" / "llm"

ROLE_VARIABLES = {
    "triage_model": "NPMGUARD_TRIAGE_MODEL",
    "investigation_model": "NPMGUARD_INVESTIGATION_MODEL",
    "hypothesis_model": "NPMGUARD_HYPOTHESIS_MODEL",
}

# Where an env-style declaration may legitimately live. A real `.env` is a
# developer's machine-local file and is never read here (conftest disables the
# dotenv source entirely; see tests/conftest.py).
_ENV_DECLARATION = re.compile(
    r"^\s*(?:#\s*)?(NPMGUARD_(?:TRIAGE|INVESTIGATION|HYPOTHESIS)_MODEL)\s*=\s*(\S+)\s*$",
    re.MULTILINE,
)

_SEARCH_SUFFIXES = {".template", ".env", ".yml", ".yaml", ".toml", ".service", ".sh", ".md"}
_SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".claude"}


def _settings_defaults() -> dict[str, str]:
    """The defaults a Settings() built with no environment carries."""
    settings = Settings()
    return {field: getattr(settings, field) for field in ROLE_VARIABLES}


def _declarations() -> dict[Path, dict[str, str]]:
    """Every env-style model declaration committed to the repo, by file.

    Commented-out lines count: a commented alternative that disagrees is exactly
    how `.env.template` drifted — someone reads it as documentation of the real
    configuration. If it is stale enough to be commented out, delete it.
    """
    found: dict[Path, dict[str, str]] = {}
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in _SEARCH_SUFFIXES:
            continue
        if any(part in _SKIP_DIRS for part in path.parts):
            continue
        if path.name == ".env":  # machine-local, never committed, never asserted on
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:  # pragma: no cover - unreadable file is not this test's business
            continue
        matches = dict(_ENV_DECLARATION.findall(text))
        if matches:
            found[path] = matches
    return found


def _recorded_models() -> dict[str, set[str]]:
    """Per role, every model a committed recording says actually served it."""
    served: dict[str, set[str]] = {"triage": set(), "investigation": set()}
    for manifest in FIXTURES.glob("*/manifest.json"):
        models = json.loads(manifest.read_text()).get("models") or {}
        for role in served:
            if models.get(role):
                served[role].add(models[role])
    return served


@pytest.mark.parametrize("role", ["triage", "investigation"])
def test_c2_the_shipped_model_has_a_recording_behind_it(role: str) -> None:
    """C2: the model we ship must appear in the recorded corpus as one that actually
    served that role. This is what makes the default *evidence* rather than an
    intention, and it forces a model change and a re-record to land together — which
    they must anyway, since fixtures replay real captured traffic.

    Deliberately NOT asserted in reverse: older recordings legitimately carry retired
    models (`is-number@7.0.0` is a `google/gemini-2.5-flash` capture from an earlier
    era). A recording is a historical fact and does not go stale; a config default
    does."""
    field = "triage_model" if role == "triage" else "investigation_model"
    shipped = _settings_defaults()[field]
    served = _recorded_models()[role]
    assert served, f"no committed recording declares a {role} model — corpus missing?"
    assert shipped in served, (
        f"the shipped {role} model {shipped!r} has no recording behind it.\n"
        f"  recorded {role} models: {sorted(served)}\n"
        "Either this is the wrong model, or the corpus needs a re-record. A re-record "
        "costs real money and is the owner's call, never an agent's."
    )


def test_c3_config_py_is_the_only_declaration() -> None:
    """C3: INVARIANT — the model pair is declared in exactly ONE place, `config.py`.
    No committed file declares it a second time, with any value.

    This is the enforcement, not a comparison. An earlier version of this file
    asserted that every declaration *agreed*, which left the copies in place and
    policed them forever — the state stayed reachable and the check was the smoke
    alarm. Deleting `.env.template`'s two lines removes the state instead: there is
    nothing left to disagree.

    Commented-out declarations count. A value in a comment is still a copy, and
    reading one as documentation of the real configuration is precisely how
    `deepseek-v3.2`/`z-ai/glm-5` survived in `.env.template` from the Python rewrite
    onward. A real `.env` is machine-local, never committed, and never asserted on —
    overriding per host is legitimate.
    """
    extra = [
        f"  {path.relative_to(REPO_ROOT)}: {variable}={value}"
        for path, declared in sorted(_declarations().items())
        for variable, value in sorted(declared.items())
    ]
    assert not extra, (
        "the model pair is declared outside config.py:\n"
        + "\n".join(extra)
        + "\n\nDelete it. config.py's defaults are the single declaration, and they are "
        "answerable to the recorded corpus (C2). A second copy is a state that can "
        "disagree — which is the bug this file exists to make unreachable, not to detect."
    )

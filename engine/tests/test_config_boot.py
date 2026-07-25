# CLASS MAP — configuration REJECTION: what happens to a bad NPMGUARD_* value, and
# when. (unit: npmguard.config.Settings constructed over a controlled environment,
# plus one OUT-OF-PROCESS import of npmguard.api — the only place "at boot" can
# actually be observed, since in-process the module is already imported.)
#
# The defect this file closes: `NPMGUARD_DEMO_SPEED=fast` stopped the engine from
# booting, because `float()` ran on the raw environment string at demo.py module
# scope and npmguard.api imports demo. Verified out of process before the fix:
# `ValueError: could not convert string to float: 'fast'` — a message naming neither
# the knob nor what to do. Four knobs were read straight from os.environ the same
# way; NPMGUARD_TRIAGE_CONCURRENCY was the worst of them, because
# `int(os.environ.get(...))` sat inside the FLAG fan-out and a typo would surface
# MID-AUDIT as a bare ValueError → NPMGUARD-9999, non-retryable, discarding an audit
# already paid for.
#
# Axes: knob (newly declared / pre-existing / secret-bearing / model-level) ×
#       failure kind (unparseable / out of range / malformed shape) ×
#       when (Settings construction / process import)
#   C1 every kind of bad value is refused at construction, and the message names the
#      ENVIRONMENT VARIABLE. Measured: pydantic-settings names the FIELD
#      (`demo_speed`), never the variable an operator writes in `.env`, in any of the
#      error kinds this surface produces — so config.py maps loc → NPMGUARD_<LOC>
#   C2 the naming covers the WHOLE surface, not just the fields added with it: a
#      pre-existing knob and the model-level cross-field validator both come out
#      named
#   C3 a rejected SECRET-bearing knob names the variable and NEVER echoes the value
#      (N-8) — the reason the renderer uses pydantic's `msg` and not `input_value`
#   C4 a good value round-trips, normalised: no trailing slash on an origin, an
#      absolute Path for a directory. Without this the C1 rows would also pass
#      against a Settings that rejected everything
#   C5 OUT-OF-PROCESS: `NPMGUARD_DEMO_SPEED=fast python -c "import npmguard.api"`
#      still fails — that is correct, a bad knob must kill the process — but now
#      names the variable. Paired with a control run at a VALID value that imports
#      cleanly, so the class cannot pass by the import being broken for some other
#      reason
# Adversarial pass: 2026-07-25 — the first map was "bad values raise", which pydantic
# already did before this change and which says nothing about the actual complaint
# (the message). The missing dimensions are WHOSE NAME appears (C1/C2), what must NOT
# appear (C3), and the difference between "raises in this process" and "the engine
# will not boot" (C5).
from __future__ import annotations

import os
import subprocess
import sys

import pytest

from npmguard.config import ConfigError, Settings

SECRET_VALUE = "deadbeefnotarealkey"
BOOT_PROBE = (
    "import npmguard.config as config; config.Settings.model_config['env_file'] = None; "
    "import npmguard.api"
)
BOOT_TIMEOUT_SECONDS = 90.0


def _settings(**env: str) -> Settings:
    """Settings over exactly `env` — every ambient NPMGUARD_* stripped, so a
    developer's shell cannot make a row pass or fail (N-6)."""
    clean = {key: value for key, value in os.environ.items() if not key.startswith("NPMGUARD_")}
    saved = dict(os.environ)
    os.environ.clear()
    os.environ.update(clean | env)
    try:
        return Settings(_env_file=None)
    finally:
        os.environ.clear()
        os.environ.update(saved)


# (variable, bad value, a fragment of the complaint that must appear)
REJECTED = {
    "unparseable-float": ("NPMGUARD_DEMO_SPEED", "fast", "valid number"),
    "unparseable-int": ("NPMGUARD_MAX_SOURCE_FILES", "lots", "valid integer"),
    "negative-bound": ("NPMGUARD_MAX_SOURCE_FILES", "-1", "greater than or equal to 0"),
    "registry-without-scheme": ("NPMGUARD_NPM_REGISTRY", "registry.npmjs.org", "http(s) URL"),
    "registry-scheme-typo": ("NPMGUARD_NPM_REGISTRY", "hxxp://registry.npmjs.org", "http(s) URL"),
    "api-url-without-scheme": ("NPMGUARD_API_URL", "127.0.0.1:8000", "http(s) URL"),
    "relative-log-dir": ("NPMGUARD_AUDIT_LOG_DIR", "audit-logs", "absolute path"),
    "empty-log-dir": ("NPMGUARD_AUDIT_LOG_DIR", "", "absolute path"),
    # Pre-existing knobs: the renaming is a property of the surface, not of the
    # fields that arrived with it.
    "port-out-of-range": ("NPMGUARD_API_PORT", "70000", "less than or equal to 65535"),
    "unknown-log-level": ("NPMGUARD_LOG_LEVEL", "debgu", "'debug'"),
}


@pytest.mark.parametrize(("case", "row"), sorted(REJECTED.items()))
def test_a_bad_value_is_refused_and_names_its_variable(case: str, row: tuple[str, str, str]) -> None:
    """C1 + C2: no Settings exists over a bad value, and the complaint is addressed to
    the variable an operator can grep for. NPMGUARD_LOG_LEVEL is inherited from
    KitSettings and NPMGUARD_API_PORT predates this change — both come out named, so
    the mapping is a property of the whole surface."""
    variable, value, fragment = row
    with pytest.raises(ConfigError) as excinfo:
        _settings(**{variable: value})
    message = str(excinfo.value)
    assert variable in message, f"{case}: complaint does not name the knob: {message!r}"
    assert fragment in message, f"{case}: complaint does not say what is wrong: {message!r}"


def test_the_cross_field_rule_is_reported_too() -> None:
    """C2: a model-level validator has an empty `loc`, so the renderer has no field to
    rename — it must pass the message through rather than mislabel it. That message
    already names both variables itself."""
    with pytest.raises(ConfigError) as excinfo:
        _settings(NPMGUARD_LLM_BACKEND="openai_compatible")
    message = str(excinfo.value)
    assert "NPMGUARD_LLM_BASE_URL" in message
    assert "NPMGUARD_LLM_BACKEND" in message


def test_a_rejected_secret_is_named_but_never_echoed() -> None:
    """C3: N-8. The renderer reports pydantic's `msg` and never its `input_value`, so
    a malformed key, token or DSN is diagnosable without the value reaching a log,
    a crash report, or an agent's context."""
    with pytest.raises(ConfigError) as excinfo:
        _settings(NPMGUARD_ENCRYPTION_KEY=SECRET_VALUE)
    message = str(excinfo.value)
    assert "NPMGUARD_ENCRYPTION_KEY" in message
    assert SECRET_VALUE not in message
    assert "pattern" in message  # still says WHAT is wrong with it


def test_good_values_round_trip_and_are_normalised(tmp_path) -> None:
    """C4: the positive control for every row above, plus the two normalisations the
    readers depend on. The trailing slash matters: resolve.py builds
    f"{npm_registry}/{name}/{version}", so an un-normalised value produces a double
    separator against a registry that may or may not forgive it."""
    settings = _settings(
        NPMGUARD_DEMO_SPEED="0",
        NPMGUARD_MAX_SOURCE_FILES="1000",
        NPMGUARD_NPM_REGISTRY="http://127.0.0.1:1/",
        NPMGUARD_API_URL="https://api.npmguard.test/",
        NPMGUARD_AUDIT_LOG_DIR=str(tmp_path / "audit-logs"),
    )
    assert settings.demo_speed == 0
    assert settings.max_source_files == 1000
    assert settings.npm_registry == "http://127.0.0.1:1"
    assert settings.api_url == "https://api.npmguard.test"
    assert settings.audit_log_dir == tmp_path / "audit-logs"
    assert settings.audit_log_dir.is_absolute()


def test_config_error_is_a_value_error() -> None:
    """C4: ConfigError narrows the message without widening the contract — pydantic's
    own ValidationError is a ValueError, so any caller already prepared for one still
    catches this."""
    assert issubclass(ConfigError, ValueError)


def _boot(**env: str) -> subprocess.CompletedProcess[str]:
    """Import npmguard.api in a fresh interpreter — the closest a test can get to
    `uvicorn npmguard.api:app` starting up, and the only way to observe an
    import-time read at all (in-process the module is already imported).

    The dotenv source is disabled first, exactly as tests/conftest.py does it, so the
    probe cannot inherit a developer's `engine/.env` (N-6). Real environment
    variables are what this test supplies, and they outrank a dotenv anyway — the
    neutering is for everything the test does NOT set."""
    clean = {key: value for key, value in os.environ.items() if not key.startswith("NPMGUARD_")}
    return subprocess.run(
        [sys.executable, "-c", BOOT_PROBE],
        env=clean | env,
        capture_output=True,
        text=True,
        timeout=BOOT_TIMEOUT_SECONDS,
    )


def test_a_bad_demo_speed_still_stops_the_boot_but_now_says_which_knob() -> None:
    """C5: the original defect, observed where it actually bites. npmguard.api imports
    npmguard.demo, which reads this knob at module scope, so a typo has always killed
    the process — correctly. What changed is the message: it was `ValueError: could
    not convert string to float: 'fast'`, naming neither the knob nor the fix."""
    failed = _boot(NPMGUARD_DEMO_SPEED="fast")
    assert failed.returncode != 0
    assert "NPMGUARD_DEMO_SPEED" in failed.stderr, failed.stderr[-2000:]
    assert "could not convert string to float" not in failed.stderr, failed.stderr[-2000:]


def test_the_same_boot_succeeds_at_a_valid_value() -> None:
    """C5, the control. Without it the class above would also pass against an
    npmguard.api that cannot be imported for any unrelated reason — which is exactly
    the state a multi-agent tree spends part of its time in."""
    booted = _boot(NPMGUARD_DEMO_SPEED="0")
    assert booted.returncode == 0, booted.stderr[-2000:]

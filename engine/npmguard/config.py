from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import Field, ValidationError, field_validator, model_validator
from pydantic_settings import SettingsConfigDict

from kit_spine import KitSettings

REPO_ROOT = Path(__file__).resolve().parents[2]


class ConfigError(ValueError):
    """A rejected configuration value, reported by ENVIRONMENT VARIABLE name.

    A `ValueError` subclass because that is what a caller of `Settings()` already
    has to be prepared for (pydantic's own `ValidationError` is one), so this
    narrows the message without widening the contract.
    """


def _named_by_variable(exc: ValidationError) -> str:
    """Re-render a pydantic ValidationError against the env vars an operator writes.

    Measured (pydantic 2.13 / pydantic-settings 2.x): a bad `NPMGUARD_DEMO_SPEED`
    reports `demo_speed\\n  Input should be a valid number …` — the message
    contains neither the prefix nor the variable name, in any of the three error
    kinds this surface can produce (float_parsing, int_parsing,
    greater_than_equal). An operator greps `.env` for `demo_speed` and finds
    nothing. Mapping `loc → NPMGUARD_<LOC>` here fixes every knob at once, where
    per-field `validation_alias`es would have to be added one at a time and would
    be silently forgotten on the next one.
    """
    prefix = Settings.model_config.get("env_prefix") or ""
    lines = []
    for error in exc.errors():
        location = "_".join(str(part) for part in error["loc"])
        # A model-level validator has an empty loc and names its own variable.
        label = f"{prefix}{location.upper()}: " if location else ""
        lines.append(f"  {label}{error['msg']}")
    plural = "" if len(lines) == 1 else "s"
    return "npmguard configuration rejected {} value{}:\n{}".format(
        len(lines), plural, "\n".join(lines)
    )


# INVARIANT: every setting declared here is read by production code under
# `npmguard/`. A knob nothing reads is worse than an absent one, because an
# unread *cap* reads as a protection that does not exist — someone sizing a
# deployment from this file must be able to trust it. Enforced by
# tests/test_config_surface.py (an `ast` scan for `settings.<field>`), which is
# why the surface carries no exemption list. Inherited `KitSettings` fields are
# Kit's surface, not this one's.
#
# Eight knobs were deleted rather than wired, none of which ever had a reader in
# this engine or in the TypeScript engine it was ported from (so the port
# carried the shape, not any behaviour): `triage_max_files`, `max_agent_turns`,
# `investigation_enabled`, `test_gen_model`, `test_gen_mode`,
# `max_findings_to_prove`, `verify_timeout_sec`, `max_docker_exec_timeout_sec`.
# Two of them named bounds the code contradicts — `max_docker_exec_timeout_sec`
# defaulted to 30s beside a 180s `docker_exec` npm install (deps.py), and
# `max_agent_turns` defaulted to 30 above the agent's own [10, 24] budget
# (hypothesis_agent.py). A bound lands here together with its reader, never
# ahead of it. `extra="ignore"` means a stale `NPMGUARD_*` left in a deployed
# `.env` is inert rather than a boot failure.
#
# The inverse rule holds too, and is enforced by the same test file: every
# `NPMGUARD_*` variable read anywhere under `npmguard/` is declared HERE, so a
# malformed value is a named boot rejection instead of a `ValueError` on whichever
# code path first happens to touch it. `NPMGUARD_DEMO_SPEED=fast` used to stop the
# engine booting with `could not convert string to float: 'fast'` — a message that
# names neither the knob nor what to do about it. Two variables are still read
# straight from `os.environ` and are named, with the one-line swap each needs, in
# `test_config_surface.py`'s exemption table; they are ownership debt, not design.
class Settings(KitSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", Path.cwd() / ".env"),
        env_prefix="NPMGUARD_",
        extra="ignore",
    )

    database_url: str = f"sqlite+aiosqlite:///{REPO_ROOT / 'data' / 'npmguard.sqlite3'}"
    api_host: str = "0.0.0.0"
    api_port: int = Field(default=8000, ge=1, le=65535)
    cors_origin: str = "http://localhost:5173"
    # Where `npmguard-ops` points by default (ops.py). Declared rather than read
    # from os.environ at argparse-default time so `NPMGUARD_API_URL=127.0.0.1:8000`
    # (no scheme) is a named boot rejection, not an httpx UnsupportedProtocol on
    # the first request of a 400-package batch.
    api_url: str = "http://127.0.0.1:8000"
    npm_registry: str = "https://registry.npmjs.org"
    # Absolute on purpose — see _absolute_directory. Read per AuditLog (audit_log.py).
    audit_log_dir: Path = REPO_ROOT / "audit-logs"

    llm_backend: Literal["anthropic", "google", "openai_compatible"] = "anthropic"
    llm_base_url: str | None = None
    llm_api_key: str = ""
    llm_timeout_seconds: float = Field(default=60, gt=0)
    llm_budget_usd_24h: float = Field(default=0, ge=0)
    llm_budget_margin: float = Field(default=0.1, ge=0, le=1)
    mock_llm: bool = False
    # The only bound on ONE audit's model spend, and it is a REFUSAL, not a cap on
    # what gets read: FLAG issues exactly one triage call per file in
    # phases.flag_source_files, so this number IS the worst-case FLAG call count
    # (pipeline.py raises PackageTooLargeError above it, before the first model
    # call). Truncating instead — read the first N of 3953 files and report SAFE —
    # would be a coverage gap wearing a green badge, and the unread files are
    # exactly where a payload hides.
    #
    # Measured over 650 installed packages on a dev machine, counted through
    # flag_source_files itself: median 2 files, p90 33, p95 81, p99 647, max 3953
    # (viem; then lucide-react 2016, es-toolkit 1893, jsdom 647, zod 275). 183 of
    # the 650 have zero source files. Refusal rate by bound: 500 → 1.08%,
    # 1000 → 0.77%, 2000 → 0.31%, 4000 → 0%. The corpus is dev dependencies, so it
    # is tilted toward frontend tooling and understates nothing at the tail.
    #
    # 0 = OFF, deliberately, exactly as llm_budget_usd_24h defaults off. The
    # refusal lands AFTER the payment claim: an errored row is re-submittable
    # (reset_to_queued) but a re-submit hits the same refusal, so switching this on
    # needs either a refund path or a pre-payment probe — and a pre-payment probe
    # cannot exist before `resolve` has downloaded the tarball. That is an owner
    # decision, so the mechanism ships dark and enabling it is one env var.
    # Recommended production value once that decision is made: 1000.
    max_source_files: int = Field(default=0, ge=0)

    payment_required: bool = True
    cre_api_key: str | None = None
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None
    stripe_api_base: str | None = None
    audit_price_cents: int = Field(default=500, ge=50)

    queue_size: int = Field(default=50, ge=1)
    # Sizes the audit worker pool = the HARD cap on concurrent audits, i.e.
    # concurrent Docker sandboxes (each ~sandbox_memory_mb + node/strace/tcpdump
    # overhead). Over-cap audits queue (bounded by queue_size), never drop, so a
    # low value throttles rather than refuses. Kept conservative by default — a
    # host with more RAM should raise it; a small host must not exceed what it can
    # hold or a burst of audits OOMs the box.
    max_running_sessions: int = Field(default=4, ge=1)
    shutdown_deadline_seconds: float = Field(default=10, gt=0)

    triage_model: str = "claude-haiku-4-5-20251001"
    investigation_model: str = "claude-sonnet-4-6"

    sandbox_image: str = "npmguard-sandbox:v1"
    sandbox_memory_mb: int = Field(default=512, ge=64, le=4096)
    sandbox_cpus: float = Field(default=1, gt=0, le=4)
    sandbox_network: str = "none"

    base_sepolia_rpc_url: str | None = None
    base_sepolia_contract: str | None = None
    base_rpc_url: str | None = None
    base_contract: str | None = None

    # GitHub App + repo panel. The whole panel is gated behind the computed
    # `github_app_enabled` property below: when any required credential is
    # missing the engine runs exactly as it does today and every panel route
    # returns 503. Secret values are never logged — only presence is checked.
    github_app_id: str | None = None
    github_app_private_key_path: str | None = None  # path to the App's .pem
    github_client_id: str | None = None
    github_client_secret: str | None = None
    github_webhook_secret: str | None = None
    # 32-byte key, hex-encoded (64 hex chars), for AES-256-GCM token encryption.
    encryption_key: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")
    smtp_url: str | None = None
    alert_from: str = "NpmGuard <alerts@npmguard.com>"
    panel_base_url: str = "http://localhost:3000"
    scan_concurrency: int = Field(default=4, ge=1, le=16)
    watch_interval_min: int = Field(default=15, ge=1)
    free_max_protected_repos: int = Field(default=3, ge=0)
    free_max_public_repo_audits: int = Field(default=2, ge=0)
    free_max_audits_month: int = Field(default=250, ge=0)
    pro_max_protected_repos: int = Field(default=25, ge=0)
    pro_max_public_repo_audits: int = Field(default=0, ge=0)  # 0 = unlimited
    pro_max_audits_month: int = Field(default=5000, ge=0)
    stripe_pro_price_id: str | None = None
    # TEST-ONLY: point githubkit at a mock host (default = api.github.com).
    github_api_base: str | None = None
    # TEST-ONLY: the raw-host origin public-repo file downloads are allowed to
    # hit (default = https://raw.githubusercontent.com). The SSRF allow-list in
    # panel/github/content.py checks scheme+host+port against this; a test points
    # it at the GitHub stub so no real raw host is ever reached.
    github_raw_base: str | None = None

    # Divisor on the demo replay's human throttle (demo.py); e2e/Playwright uses 0
    # to emit instantly. NOT bounded below here: demo.py clamps negatives to 0 and
    # that clamp is the pinned contract (test_demo.py C11). A `ge=0` would be the
    # better invariant — see the note in demo.py.
    demo_speed: float = 1

    @field_validator("api_url", "npm_registry")
    @classmethod
    def _http_origin(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(f"must be an absolute http(s) URL with a host (got {value!r})")
        # INVARIANT: no trailing slash, so every f-string that appends "/{path}"
        # to one of these produces one separator rather than two. Normalising here
        # is what makes that true for EVERY reader, instead of each one stripping.
        return value.rstrip("/")

    @field_validator("audit_log_dir")
    @classmethod
    def _absolute_directory(cls, value: Path) -> Path:
        # A relative audit-log root silently follows the process cwd, which for the
        # engine is whatever systemd/uvicorn/pytest happened to start it in — so the
        # logs for one audit and the next can land in different trees. Empty string
        # parses to Path(".") and is caught by the same check; it used to fall back
        # to the default through an `or`, which hid the typo.
        if not value.is_absolute():
            raise ValueError(f"must be an absolute path (got {str(value)!r})")
        return value

    def __init__(self, **values: Any) -> None:
        # INVARIANT: a Settings instance exists only if every knob it declares
        # parsed and validated — so no reader downstream needs a guard, and no
        # malformed knob can surface mid-audit on the one code path that happens to
        # touch it. The wrapper exists only to rename: pydantic reports the FIELD
        # (`demo_speed`), an operator writes the VARIABLE (`NPMGUARD_DEMO_SPEED`).
        try:
            super().__init__(**values)
        except ValidationError as exc:
            raise ConfigError(_named_by_variable(exc)) from exc

    @property
    def github_app_enabled(self) -> bool:
        return all(
            [
                self.github_app_id,
                self.github_app_private_key_path,
                self.github_client_id,
                self.github_client_secret,
                self.encryption_key,
            ]
        )

    @model_validator(mode="after")
    def validate_llm_endpoint(self) -> "Settings":
        if self.llm_backend == "openai_compatible" and not self.llm_base_url:
            raise ValueError(
                "NPMGUARD_LLM_BASE_URL is required when NPMGUARD_LLM_BACKEND=openai_compatible"
            )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


SOURCE_FILE_TYPES = frozenset({"js", "ts"})
SKIP_DIRS = frozenset({"node_modules", ".git", ".svn"})

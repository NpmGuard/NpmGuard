from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, ValidationError, field_validator, model_validator
from pydantic_settings import SettingsConfigDict

from kit_spine import KitSettings

from .validation import valid_http_origin

REPO_ROOT = Path(__file__).resolve().parents[2]


class ConfigError(ValueError):
    """A rejected configuration value, reported by ENVIRONMENT VARIABLE name.

    A `ValueError` subclass because that is what a caller of `Settings()` already
    has to be prepared for (pydantic's own `ValidationError` is one), so this
    narrows the message without widening the contract.
    """


def _named_by_variable(exc: ValidationError) -> str:
    """Re-render a pydantic ValidationError against the env vars an operator writes.

    pydantic names the FIELD (`demo_speed`); an operator greps `.env` for the
    VARIABLE (`NPMGUARD_DEMO_SPEED`). Mapping `loc → NPMGUARD_<LOC>` here covers
    every knob at once, where per-field `validation_alias`es would have to be
    added one at a time and forgotten on the next one.
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


# INVARIANT, both directions, enforced by tests/test_config_surface.py with no
# exemption list:
#   every setting declared here is read by production code under `npmguard/`, and
#   every `NPMGUARD_*` variable production code reads is declared here.
# An unread *cap* reads as a protection that does not exist, and someone sizing a
# deployment from this file must be able to trust it. Going the other way, an
# undeclared read means a malformed value surfaces as a bare `ValueError` on
# whichever code path first touches it, mid-audit, instead of as a named boot
# rejection. So a knob lands together with its reader, in one change, in either
# direction. Inherited `KitSettings` fields are Kit's surface, not this one's.
# `extra="ignore"` keeps a stale `NPMGUARD_*` in a deployed `.env` inert rather
# than a boot failure.
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
    # Root of the durable report store; `report_store.DATA_DIR` is
    # `<data_dir>/reports`. Absolute for the same reason as audit_log_dir: a
    # relative root follows the process cwd, so the reports of one audit and the
    # next can land in different trees.
    data_dir: Path = REPO_ROOT / "data"

    llm_backend: Literal["anthropic", "bedrock", "google", "openai_compatible"] = "bedrock"
    llm_base_url: str | None = None
    llm_api_key: str = ""
    bedrock_region: str = Field(default="us-east-1", pattern=r"^[a-z]{2}(?:-gov)?-[a-z]+-\d+$")
    # Bedrock offers its Responses-API models in fewer regions than its chat ones,
    # so a deployment pinned to a chat-only region needs a second region to reach
    # them. Setting this sends those roles' prompts outside `bedrock_region` —
    # explicit because it is a data-residency choice, not a routing detail.
    bedrock_responses_region: str | None = Field(
        default=None, pattern=r"^[a-z]{2}(?:-gov)?-[a-z]+-\d+$"
    )
    llm_timeout_seconds: float = Field(default=60, gt=0)
    llm_budget_usd_24h: float = Field(default=0, ge=0)
    llm_budget_margin: float = Field(default=0.1, ge=0, le=1)
    mock_llm: bool = False
    # The only bound on ONE audit's model spend, and it is a REFUSAL, not a cap on
    # what gets read: FLAG issues exactly one triage call per file, so this number
    # IS the worst-case FLAG call count (pipeline.py raises PackageTooLargeError
    # above it, before the first model call). Truncating instead — read the first N
    # of 3953 files and report SAFE — would be a coverage gap wearing a green badge,
    # and the unread files are exactly where a payload hides.
    #
    # Measured over 650 installed dev-dependency packages, counted through
    # flag_source_files itself: median 2 files, p90 33, p95 81, p99 647, max 3953
    # (viem). Refusal rate by bound: 500 → 1.08%, 1000 → 0.77%, 2000 → 0.31%,
    # 4000 → 0%. Recommended production value: 1000.
    #
    # 0 = OFF, because the refusal lands AFTER the payment claim: an errored row is
    # re-submittable but a re-submit hits the same refusal, so switching this on
    # needs a refund path or a pre-payment probe — and no probe can exist before
    # `resolve` has downloaded the tarball. Owner decision; the mechanism ships dark.
    max_source_files: int = Field(default=0, ge=0)
    # Whether an install-time coverage gap (`inventory.INSTALL_COVERAGE_GAP` — a hook
    # whose code is nowhere in the tarball, or a target that ships as a type no model
    # reads) may still end in a report. OFF = the gap ships as a `critical` inventory
    # flag beside whatever verdict the graph derives, which today means `SAFE`. ON =
    # `pipeline._report` refuses instead (NPMGUARD-0031, retryable, no report), unless
    # a hypothesis CONFIRMED — in which case the evidence wins and the verdict is
    # DANGEROUS, so the switch can never suppress a true positive.
    #
    # Defaults OFF because turning it on CHANGES THE CONCLUSION for real, benign
    # packages. Measured over 834 installed packages: 2 stop reaching SAFE —
    # better-sqlite3 and msw — i.e. 0.24% of manifests and 40% of install-hooked
    # ones. Like `max_source_files` the refusal lands after the payment claim (and
    # after the full model spend — it cannot be raised earlier without discarding a
    # possible DANGEROUS), so switching it on means paying for audits that end in
    # 0031. Recommended production value: true.
    refuse_install_coverage_gap: bool = False

    # Whether `/audit` may accept a `localPath` — a package staged on this host
    # rather than fetched from the registry. It is how the benchmark audits a
    # corpus entry and how tests audit a fixture. Default off: it is a local-read
    # capability, so production serves the registry and nothing else.
    #
    # INVARIANT: this gates ADMISSION only. Every read surface — bench runs,
    # rows, metrics, and the `/audit/{id}` replay behind them — serves stored
    # local audits whether or not it is on, so prod publishes benchmark results
    # it cannot itself produce.
    local_package_audits: bool = False

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

    # INVARIANT: this is the only declaration of the primary model pair. The
    # committed corpus records what actually answered, and
    # tests/test_model_config_agreement.py requires each shipped primary to appear
    # there. llm_runtime appends the measured fallback chain.
    # `min_length=1`: an explicitly-empty value must fail at boot naming its VARIABLE,
    # not later as `ModelSpec`'s "model slug must be a non-empty string" — roles are
    # built before the mock short-circuit, so even a mock engine constructs these.
    triage_model: str = Field(default="zai.glm-5", min_length=1)
    investigation_model: str = Field(default="zai.glm-5", min_length=1)
    # Hypothesis is the one role whose output must survive `compile_plan` into a
    # runnable experiment, and measured pass rates separate the models on it far
    # more than on the other structured roles — so it declares its own primary
    # rather than riding `investigation_model`.
    hypothesis_model: str = Field(default="xai.grok-4.3", min_length=1)
    # Model-call concurrency of BOTH triage fan-outs (phases.run_flag over the FLAG
    # file set, phases.run_hypothesize over the flags it produced) — i.e. how many
    # provider calls one audit has in flight, not how many it makes. `ge=1` makes the
    # semaphore's argument valid by construction; 0 would deadlock the phase. Bounded
    # at 64 because every slot is a concurrent provider request against one API key:
    # past a provider's own concurrency limit the extra slots buy 429s, which kit
    # retries and bills for.
    triage_concurrency: int = Field(default=8, ge=1, le=64)

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
    free_max_audits_month: int = Field(default=250, ge=0)
    pro_max_protected_repos: int = Field(default=25, ge=0)
    pro_max_audits_month: int = Field(default=5000, ge=0)
    # Public-repo scan cost control (D-1 / F-F6). A public scan requires a GitHub
    # sign-in and nothing more — no installation, nothing charged — so the sign-in
    # is the abuse ceiling and these three knobs are the COST ceiling. They are
    # per USER, not per installation: a public scan has a requester and no payer.
    #
    # A scan's cost is exactly its cache MISSES; a verdict already in
    # `package_verdicts` is free to serve. So both of F-F6's first two bullets are
    # this one quantity: a 900-dep monorepo cannot buy 900 audits, and past the
    # ceiling a scan still runs on cached verdicts alone. Coverage is then smaller
    # than the lockfile, which the wire reports rather than hides.
    #
    # 0 = UNLIMITED on both budgets, matching the plan-limit convention in caps.py.
    public_scan_max_new_audits: int = Field(default=150, ge=0)
    public_scan_monthly_new_audits: int = Field(default=400, ge=0)
    public_scan_max_concurrent: int = Field(default=2, ge=1)
    stripe_pro_price_id: str | None = None
    # TEST-ONLY: point githubkit at a mock host (default = api.github.com).
    github_api_base: str | None = None
    # TEST-ONLY: the raw-host origin public-repo file downloads are allowed to
    # hit (default = https://raw.githubusercontent.com). The SSRF allow-list in
    # panel/github/content.py checks scheme+host+port against this; a test points
    # it at the GitHub stub so no real raw host is ever reached.
    github_raw_base: str | None = None

    # Divisor on the demo replay's human throttle (demo.py); e2e/Playwright uses 0
    # to emit instantly. Not bounded below here: demo.py clamps negatives to 0 and
    # that clamp is the pinned contract.
    demo_speed: float = 1

    @field_validator("api_url", "npm_registry")
    @classmethod
    def _http_origin(cls, value: str) -> str:
        return valid_http_origin(value)

    @field_validator("audit_log_dir", "data_dir")
    @classmethod
    def _absolute_directory(cls, value: Path) -> Path:
        # A relative audit-log or report root silently follows the process cwd, which
        # for the engine is whatever systemd/uvicorn/pytest happened to start it in —
        # so the logs for one audit and the next can land in different trees. An empty
        # string parses to Path(".") and is caught by the same check.
        if not value.is_absolute():
            raise ValueError(f"must be an absolute path (got {str(value)!r})")
        return value

    def __init__(self, **values: Any) -> None:
        # INVARIANT: a Settings instance exists only if every knob it declares parsed
        # and validated — so no reader downstream needs a guard, and no malformed knob
        # can surface mid-audit. The wrapper exists only to rename the error.
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


# The file types some model actually READS (phases.flag_source_files fans FLAG out
# over exactly these). It is therefore the definition of "analysed", and every type
# outside it that a package DECLARES as an entry point is a coverage gap by
# construction (inventory.run_inventory_checks emits `install-coverage-gap` for one).
#
# `shell` is in the set because a `postinstall.sh` an install hook names and the
# tarball ships is the same fact as a `postinstall.js`: code npm will execute.
# Measured over 834 installed package copies it adds 22 files against the 36,239
# FLAG already reads, i.e. +0.06%.
#
# `python`/`ruby`/`perl` targets are deliberately out: SCRIPT_INTERPRETERS accepts
# them so they resolve, but they have no extension mapping, stay `unknown`, and keep
# producing a gap flag. That is the honest answer while no FLAG prompt has been
# validated on them; widening this set is what would turn it into coverage.
SOURCE_FILE_TYPES = frozenset({"js", "ts", "shell"})
SKIP_DIRS = frozenset({"node_modules", ".git", ".svn"})

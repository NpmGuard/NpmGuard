from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import SettingsConfigDict

from kit_spine import KitSettings

REPO_ROOT = Path(__file__).resolve().parents[2]


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

    llm_backend: Literal["anthropic", "google", "openai_compatible"] = "anthropic"
    llm_base_url: str | None = None
    llm_api_key: str = ""
    llm_timeout_seconds: float = Field(default=60, gt=0)
    llm_budget_usd_24h: float = Field(default=0, ge=0)
    llm_budget_margin: float = Field(default=0.1, ge=0, le=1)
    mock_llm: bool = False

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
    triage_max_files: int = Field(default=80, ge=1, le=1000)
    investigation_model: str = "claude-sonnet-4-6"
    max_agent_turns: int = Field(default=30, ge=1, le=200)
    investigation_enabled: bool = True
    test_gen_model: str = "claude-sonnet-4-6"
    test_gen_mode: Literal["openclaw", "direct"] = "direct"
    max_findings_to_prove: int = Field(default=0, ge=0)
    verify_timeout_sec: int = Field(default=60, ge=10, le=300)

    sandbox_image: str = "npmguard-sandbox:v1"
    sandbox_memory_mb: int = Field(default=512, ge=64, le=4096)
    sandbox_cpus: float = Field(default=1, gt=0, le=4)
    sandbox_network: str = "none"
    max_docker_exec_timeout_sec: int = Field(default=30, ge=5, le=300)

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

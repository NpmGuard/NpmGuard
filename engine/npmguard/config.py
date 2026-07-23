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
    max_running_sessions: int = Field(default=100, ge=1)

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

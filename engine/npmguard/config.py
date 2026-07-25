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

    # The inference switch. `openrouter` and `zerog` are one-variable presets —
    # each resolves its own endpoint, model catalogue and adapter — so a demo can
    # move between them by editing this line alone. `openai_compatible` stays the
    # escape hatch for any other endpoint and still requires an explicit base URL.
    llm_backend: Literal[
        "anthropic", "google", "openai_compatible", "openrouter", "zerog"
    ] = "anthropic"
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

    # 0G Compute Router — OpenAI-compatible, TEE-attested inference. Only the
    # MAINNET router carries models usable for code audit (the testnet router
    # serves two multimodal models); the Router is a metered service with its own
    # balance, independent of which 0G chain the contracts live on, so pointing
    # inference at mainnet while settling on Galileo testnet is coherent.
    zerog_router_base_url: str = "https://router-api.0g.ai/v1"
    # Role models are per-catalogue: `triage_model` / `investigation_model` name
    # OpenRouter slugs that the 0G Router does not serve, so the zerog backend
    # reads its own pair rather than silently reinterpreting those.
    zerog_triage_model: str = "deepseek-v4-flash"
    zerog_investigation_model: str = "deepseek-v4-flash"

    base_sepolia_rpc_url: str | None = None
    base_sepolia_contract: str | None = None
    base_rpc_url: str | None = None
    base_contract: str | None = None

    # 0G Chain settlement. Same NpmGuardAuditRequest contract, another EVM chain
    # — a chain is only offered once its contract address is set, so an unset
    # address means the chain is simply absent rather than half-configured.
    zerog_testnet_rpc_url: str | None = None
    zerog_testnet_contract: str | None = None
    zerog_rpc_url: str | None = None
    zerog_contract: str | None = None

    # 0G Storage + the relayer that pays for storage submissions and writes
    # attestation rows. `zerog_relayer_key` is a SECRET (hex private key): it is
    # never logged and never leaves the engine — the CLI has no private-key path.
    zerog_network: Literal["testnet", "mainnet"] = "testnet"
    zerog_storage_indexer_url: str | None = None
    zerog_relayer_key: str | None = None
    zerog_attestations_contract: str | None = None
    # Best-effort mirror of each audit report to 0G Storage. Off by default: the
    # filesystem report store stays the source of truth and an audit must never
    # depend on a storage network being reachable.
    zerog_mirror_reports: bool = False

    # World ID publisher attestation. `world_signing_key` is a SECRET (the RP
    # signing key) and is never logged. The whole feature is gated behind the
    # computed `world_enabled` below: unset means every attestation route 503s
    # and the engine behaves exactly as it does without it.
    world_app_id: str | None = None
    world_rp_id: str | None = None
    world_signing_key: str | None = None
    # The action scopes the nullifier. It MUST stay fixed forever: change it and
    # every publisher gets a new pseudonym, which silently resets every
    # continuity streak — the one thing this feature exists to measure.
    world_action: str = "attest-npm-release"
    # Which credential a publisher proves with. All three bind a `signal`, so the
    # artifact binding — the security-critical part — is identical across them;
    # they differ only in what the credential says about the human behind it.
    # `proof_of_human` is the Orb credential and the right default for npm. The
    # document credentials exist because a World ID that holds one may hold no
    # Orb credential at all, which is a `credential_unavailable` and not a
    # recoverable one: the publisher cannot acquire an Orb on the spot.
    world_credential: Literal["proof_of_human", "passport", "mnc"] = "proof_of_human"
    # Legacy (v3) proofs predate the v4 credential model. Off by default for two
    # reasons, and the second is the serious one:
    #
    #   1. an attestation must not quietly mean something weaker than yesterday;
    #   2. a v3 and a v4 proof from the SAME human yield DIFFERENT nullifiers
    #      (measured — see finding D-15). The nullifier is the durable publisher
    #      identity that continuity is keyed on, so allowing both protocols
    #      fragments one human into two publishers. Every streak then resets at
    #      the protocol boundary and BREAK fires against a maintainer who did
    #      nothing wrong — and it is undetectable, because "never enrolled" and
    #      "enrolled under the other protocol" are the same empty lookup.
    #
    # Enabling this is a testing affordance. It trades publisher identity for
    # client compatibility, and there is no way to have both today.
    world_allow_legacy_proofs: bool = False
    # Fresh liveness per release — the single primitive the anti-worm claim rests
    # on. A stolen token can replay bytes; it cannot make a human be present now.
    # Configurable ONLY because the World simulator cannot perform a presence
    # check (it answers `user_presence_failed`), so leaving it hardcoded makes
    # the flow untestable without real credentials. Refused outright in
    # production by the validator below, and every attestation records
    # `user_present` as it actually happened — an attestation made without a
    # presence check must never read as though one occurred.
    world_require_user_presence: bool = True
    world_environment: Literal["production", "staging", "sandbox"] = "staging"
    world_api_base: str | None = None  # TEST-ONLY: point the verifier at a stub
    # Minimum age asserted at enrolment. Requested as an Identity Check
    # attribute; never stored as a value, only as a boolean assertion.
    world_minimum_age: int = Field(default=18, ge=0, le=120)
    # DEV ONLY — skip the GitHub push-access check so the World ID half of the
    # flow can be exercised without a configured GitHub App. Mirrors the existing
    # `payment_required=false` escape hatch. Refused outright when
    # world_environment is "production" (see the validator below), and every
    # attestation made this way records `ownership_proven: false`, so a bypassed
    # record can never masquerade as a proven one.
    attest_dev_trust_ownership: bool = False

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

    # Indexer URLs per network (turbo tier). Source: the 0G storage SDK's own
    # INDEXER_URLS table, which mirrors the TS starter kit.
    _ZEROG_INDEXERS = {
        "testnet": "https://indexer-storage-testnet-turbo.0g.ai",
        "mainnet": "https://indexer-storage-turbo.0g.ai",
    }

    @property
    def zerog_indexer_url(self) -> str:
        return self.zerog_storage_indexer_url or self._ZEROG_INDEXERS[self.zerog_network]

    @property
    def zerog_storage_rpc_url(self) -> str:
        """The chain RPC storage submissions are sent to — the same endpoint the
        matching settlement chain uses, so one network choice moves both."""
        if self.zerog_network == "mainnet":
            return self.zerog_rpc_url or "https://evmrpc.0g.ai"
        return self.zerog_testnet_rpc_url or "https://evmrpc-testnet.0g.ai"

    @property
    def zerog_storage_enabled(self) -> bool:
        """Storage writes cost gas, so without a relayer key there is nothing to
        pay with and every 0G write is skipped rather than half-attempted."""
        return bool(self.zerog_relayer_key)

    @property
    def world_enabled(self) -> bool:
        """Attestation needs an app, a relying-party id and the RP signing key.
        Presence only — secret values are never inspected or logged."""
        return all([self.world_app_id, self.world_rp_id, self.world_signing_key])

    @property
    def world_verify_url(self) -> str:
        base = (self.world_api_base or "https://developer.world.org/api").rstrip("/")
        return f"{base}/v4/verify/{self.world_rp_id}"

    @property
    def world_is_production(self) -> bool:
        """False for staging/sandbox. Every surface that shows an attestation
        must say so — a staging proof carries no real-world assurance and must
        never be presentable as though it did."""
        return self.world_environment == "production"

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
    def refuse_production_ownership_bypass(self) -> "Settings":
        """The ownership bypass is a development affordance and must be
        impossible to leave on against real World ID credentials. Fails at
        construction — a misconfigured engine should not boot at all rather than
        serve attestations nobody proved they were entitled to make."""
        if self.attest_dev_trust_ownership and self.world_environment == "production":
            raise ValueError(
                "NPMGUARD_ATTEST_DEV_TRUST_OWNERSHIP cannot be enabled when "
                "NPMGUARD_WORLD_ENVIRONMENT=production"
            )
        # Same rule, same reason: a testing affordance that weakens what an
        # attestation means must be impossible to leave on against real
        # credentials. Without presence, a proof no longer says a human was
        # there *now*, which is the whole claim.
        if not self.world_require_user_presence and self.world_environment == "production":
            raise ValueError(
                "NPMGUARD_WORLD_REQUIRE_USER_PRESENCE cannot be disabled when "
                "NPMGUARD_WORLD_ENVIRONMENT=production"
            )
        return self

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

"""LLM settings + the app-facing units: ModelSpec (one model in a chain)
and Role (a named LLM job: chain + prompt family + output contract).
Apps define roles at wiring time; nothing here names a provider."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
import math
from types import MappingProxyType
from typing import Any

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from kit_llm.schema import audit_strict_schema

# A Parser turns raw model text into the caller's value, raising on
# failure (any exception). `output=` accepts a pydantic model class
# (sugar: fences → json → validate), a Parser, or None (raw text).
Parser = Callable[[str], Any]


class LlmSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", validate_assignment=True)

    llm_api_key: str = ""
    llm_base_url: str = "https://openrouter.ai/api/v1"
    llm_prompts_dir: str = "./prompts"

    # spend window: 0 disables the gate (dev default — set a budget in prod).
    # ge=0: a negative budget must fail fast, not silently switch the gate off.
    llm_budget_usd_24h: float = Field(default=0.0, ge=0, allow_inf_nan=False)
    # refuse below this fraction of budget; outside [0,1] headroom is nonsensical
    llm_budget_margin: float = Field(default=0.10, ge=0, le=1, allow_inf_nan=False)

    # conservative pricing for attempts whose true cost is unresolved and
    # whose ModelSpec carries no static prices — deliberately expensive:
    # a budget that undercounts is not a budget
    llm_fallback_price_in_per_mtok: float = Field(default=10.0, ge=0, allow_inf_nan=False)
    llm_fallback_price_out_per_mtok: float = Field(default=40.0, ge=0, allow_inf_nan=False)

    @field_validator(
        "llm_budget_usd_24h",
        "llm_budget_margin",
        "llm_fallback_price_in_per_mtok",
        "llm_fallback_price_out_per_mtok",
        mode="before",
    )
    @classmethod
    def _spend_numbers_are_not_booleans(cls, value: Any) -> Any:
        # Pydantic normally coerces bool to 0.0/1.0. For budgets and prices
        # that turns a configuration typo into a materially different policy.
        if isinstance(value, bool):
            raise ValueError("spend settings must be numbers, not booleans")
        return value


@dataclass(frozen=True)
class ReasoningControl:
    """Portable reasoning knob for one model. A request intent, not a promise:
    routes honor it inconsistently — some ignore a token cap and reason until
    the output budget is gone, some refuse to disable reasoning at all. Kit
    passes it through and surfaces the outcome; the client chooses per model.

    - ``enabled=False`` asks the route to skip reasoning entirely.
    - ``effort`` requests a reasoning level ("low" | "medium" | "high").
    - ``max_tokens`` requests a reasoning-token budget.

    Set at least one. ``effort`` and ``max_tokens`` are alternative ways to
    bound reasoning; a route may honor only one of them.
    """

    enabled: bool | None = None
    effort: str | None = None
    max_tokens: int | None = None

    def __post_init__(self) -> None:
        if self.enabled is not None and not isinstance(self.enabled, bool):
            raise ValueError("reasoning enabled must be a bool or None")
        if self.effort is not None and self.effort not in ("low", "medium", "high"):
            raise ValueError("reasoning effort must be 'low', 'medium', 'high', or None")
        if self.max_tokens is not None and (
            isinstance(self.max_tokens, bool)
            or not isinstance(self.max_tokens, int)
            or self.max_tokens < 0
        ):
            raise ValueError("reasoning max_tokens must be a non-negative integer or None")
        if self.enabled is None and self.effort is None and self.max_tokens is None:
            raise ValueError("reasoning control must set at least one of enabled, effort, max_tokens")

    def to_wire(self) -> dict[str, Any]:
        """The provider `reasoning` request field. Only the set options appear."""
        wire: dict[str, Any] = {}
        if self.enabled is not None:
            wire["enabled"] = self.enabled
        if self.effort is not None:
            wire["effort"] = self.effort
        if self.max_tokens is not None:
            wire["max_tokens"] = self.max_tokens
        return wire


@dataclass(frozen=True)
class PlainText:
    """No provider-side response format: the prompt and the local parser own
    the output shape entirely. The default for Parser and raw-text contracts,
    and the explicit choice for routes that reject response formats."""


@dataclass(frozen=True)
class JsonObject:
    """Provider JSON-object response mode — one of the two measured transport
    finalists (finalists-v1, hyp-confirm-v1). The default for a Pydantic
    output contract. Provider-side structure stays advisory: JSON-object mode
    can return fenced or otherwise non-native JSON, and the local parser
    remains authoritative."""


@dataclass(frozen=True)
class StrictSchema:
    """Provider-side strict JSON Schema — the other measured finalist. The
    finalists fail on DISJOINT cases (hyp-confirm-v1: 52/64 semantic each,
    union 62/64), so a chain that lists the same model under both transports
    recovers misses either transport alone would keep.

    ``schema=None`` projects the role's effective Pydantic output contract
    through ``portable_strict_schema()`` when the role is wired or run; the
    projection fails closed when the contract cannot satisfy the strict
    dialect audit. An unprojected Pydantic schema never reaches the wire.

    An explicit ``schema`` mapping is the client's own portable contract for
    that route: it passes the same fail-closed audit at construction and is
    then sent as given — Kit does not rewrite a contract the client measured.
    """

    schema: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.schema is None:
            return
        if not isinstance(self.schema, Mapping):
            raise ValueError("strict schema must be a JSON Schema mapping or None")
        errors = audit_strict_schema(self.schema)
        if errors:
            raise ValueError(
                "explicit strict schema failed the portable strict audit: "
                + "; ".join(errors)
            )


# The typed per-route output transport. There is no provider-independent
# preferred transport (a measured result, not a hedge) — the client chooses
# per route from measured endpoint capability, never from the model name.
Transport = PlainText | JsonObject | StrictSchema


@dataclass(frozen=True)
class ModelSpec:
    """One model in a fallback chain. `prices` (usd per million tokens,
    (input, output)) is optional — set it for providers that never report
    cost; leave None where the adapter reports or backfills it.

    ``max_output_tokens`` is a portable request intent, not a promise that
    every endpoint interprets the ceiling or finish reason identically.
    ``reasoning`` is likewise a request intent (see ReasoningControl).

    ``transport`` selects this route's output transport (PlainText |
    JsonObject | StrictSchema); None means the output contract's default —
    JSON-object mode for a Pydantic contract, plain text otherwise. Chain
    entries may repeat a slug under different transports: the chain IS the
    transport-fallback config.
    """

    slug: str
    timeout_ms: int = 30_000
    temperature: float | None = None
    prices: tuple[float, float] | None = None
    max_output_tokens: int | None = None
    reasoning: ReasoningControl | None = None
    transport: Transport | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.slug, str) or not self.slug.strip():
            raise ValueError("model slug must be a non-empty string")
        if self.reasoning is not None and not isinstance(self.reasoning, ReasoningControl):
            raise ValueError("reasoning must be a ReasoningControl or None")
        if self.transport is not None and not isinstance(
            self.transport, (PlainText, JsonObject, StrictSchema)
        ):
            raise ValueError("transport must be PlainText, JsonObject, StrictSchema, or None")
        if (
            isinstance(self.timeout_ms, bool)
            or not isinstance(self.timeout_ms, int)
            or self.timeout_ms <= 0
        ):
            raise ValueError("timeout_ms must be a positive integer")
        if self.max_output_tokens is not None and (
            isinstance(self.max_output_tokens, bool)
            or not isinstance(self.max_output_tokens, int)
            or self.max_output_tokens <= 0
        ):
            raise ValueError("max_output_tokens must be a positive integer or None")
        if self.temperature is not None and (
            isinstance(self.temperature, bool)
            or not isinstance(self.temperature, (int, float))
            or not math.isfinite(self.temperature)
        ):
            raise ValueError("temperature must be a finite number or None")
        if self.prices is not None and (
            not isinstance(self.prices, tuple)
            or len(self.prices) != 2
            or any(
                isinstance(price, bool)
                or not isinstance(price, (int, float))
                or not math.isfinite(price)
                or price < 0
                for price in self.prices
            )
        ):
            raise ValueError("prices must be two finite non-negative numbers")


@dataclass(frozen=True)
class Role:
    """A named LLM job. The chain IS the fallback config; `prompt` names
    the app's prompts/<prompt>/vN.md family; `output` is the parser
    contract (model class | Parser | None); repair_retries re-asks the
    SAME model with the validation error before advancing the chain."""

    name: str
    chain: tuple[ModelSpec, ...]
    prompt: str | None = None
    output: type[BaseModel] | Parser | None = None
    repair_retries: int = 1

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip() or len(self.name) > 64:
            raise ValueError("role name must be a non-empty string of at most 64 characters")
        if not self.chain:
            raise ValueError(f"role {self.name!r} needs a non-empty chain")
        if (
            isinstance(self.repair_retries, bool)
            or not isinstance(self.repair_retries, int)
            or self.repair_retries < 0
        ):
            raise ValueError("repair_retries must be a non-negative integer")


@dataclass(frozen=True)
class Roles:
    """Role registry handed to build_llm."""

    by_name: Mapping[str, Role] = field(default_factory=dict)

    def __post_init__(self) -> None:
        normalized: dict[str, Role] = {}
        for name, role in self.by_name.items():
            if not isinstance(name, str) or not isinstance(role, Role):
                raise TypeError("role registry must map strings to Role values")
            if name != role.name:
                raise ValueError(
                    f"role registry key {name!r} does not match Role.name {role.name!r}"
                )
            normalized[name] = role
        object.__setattr__(self, "by_name", MappingProxyType(normalized))

    @classmethod
    def of(cls, *roles: Role) -> "Roles":
        by_name: dict[str, Role] = {}
        for role in roles:
            if role.name in by_name:
                raise ValueError(f"duplicate llm role name {role.name!r}")
            by_name[role.name] = role
        return cls(by_name=by_name)

    def get(self, name: str) -> Role:
        role = self.by_name.get(name)
        if role is None:
            raise ValueError(f"unknown llm role {name!r} — defined: {sorted(self.by_name)}")
        return role

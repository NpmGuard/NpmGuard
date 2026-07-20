"""LLM settings + the app-facing units: ModelSpec (one model in a chain)
and Role (a named LLM job: chain + prompt family + output contract).
Apps define roles at wiring time; nothing here names a provider."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# A Parser turns raw model text into the caller's value, raising on
# failure (any exception). `output=` accepts a pydantic model class
# (sugar: fences → json → validate), a Parser, or None (raw text).
Parser = Callable[[str], Any]

# How a final answer crosses the provider boundary. ``content`` reads the
# assistant message's text; ``tool`` forces a synthetic function call and
# reads its arguments. Both routes feed the same parser contract afterward.
OutputTransport = Literal["content", "tool"]


class LlmSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    llm_api_key: str = ""
    llm_base_url: str = "https://openrouter.ai/api/v1"
    llm_prompts_dir: str = "./prompts"

    # spend window: 0 disables the gate (dev default — set a budget in prod).
    # ge=0: a negative budget must fail fast, not silently switch the gate off.
    llm_budget_usd_24h: float = Field(default=0.0, ge=0)
    # refuse below this fraction of budget; outside [0,1] headroom is nonsensical
    llm_budget_margin: float = Field(default=0.10, ge=0, le=1)

    # conservative pricing for attempts whose true cost is unresolved and
    # whose ModelSpec carries no static prices — deliberately expensive:
    # a budget that undercounts is not a budget
    llm_fallback_price_in_per_mtok: float = Field(default=10.0, ge=0)
    llm_fallback_price_out_per_mtok: float = Field(default=40.0, ge=0)


@dataclass(frozen=True)
class ModelSpec:
    """One model in a fallback chain. `prices` (usd per million tokens,
    (input, output)) is optional — set it for providers that never report
    cost; leave None where the adapter reports or backfills it."""

    slug: str
    timeout_ms: int = 30_000
    temperature: float | None = None
    prices: tuple[float, float] | None = None


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
        if not self.chain:
            raise ValueError(f"role {self.name!r} needs a non-empty chain")


@dataclass(frozen=True)
class Roles:
    """Role registry handed to build_llm."""

    by_name: dict[str, Role] = field(default_factory=dict)

    @classmethod
    def of(cls, *roles: Role) -> "Roles":
        return cls(by_name={role.name: role for role in roles})

    def get(self, name: str) -> Role:
        role = self.by_name.get(name)
        if role is None:
            raise ValueError(f"unknown llm role {name!r} — defined: {sorted(self.by_name)}")
        return role

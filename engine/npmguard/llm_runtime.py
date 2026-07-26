import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm import (
    JsonObject,
    LlmSettings,
    ModelSpec,
    OpenAICompatAdapter,
    OpenRouterAdapter,
    ReasoningControl,
    Role,
    Roles,
    ScriptedLlm,
    StrictSchema,
    ZeroGAdapter,
    build_llm,
)
from kit_llm.provider import ProviderPort

from .config import Settings
from .hypothesis_agent import HypothesisProposal
from .phases import FileFlagResponse, JudgeVerdict, PackageIntent, hypothesis_submission


@dataclass(frozen=True)
class _Profile:
    """One provider's measured routing facts: the reasoning knobs, the fallback
    tails, and static prices. All of it is keyed on THAT provider's model slugs,
    so a slug table is only ever read against the route it was measured on.
    Selecting a backend selects a profile — configuration, not a new seam. The
    primary model itself stays a Settings knob; only these measured facts live
    here."""

    # Per-route reasoning policy — a KNOB the client sets, not policy baked into
    # Kit (reliability study output-controls-v1). For these small structured
    # tasks reasoning is a net liability: reasoning models spend the whole output
    # budget thinking and emit nothing. Controls are honored inconsistently, so
    # it is per-route: disable where the route honors disabling, cap effort where
    # it does not. Absent entries (e.g. google/gemini-*) get no reasoning field.
    reasoning: Mapping[str, ReasoningControl] = field(default_factory=dict)
    # Cross-provider model fallback appended after the primary on every role.
    # When the primary route fails — timeout, provider abort, or exhausted repair
    # — the client advances the chain (client.py:515/528/620) to a DIFFERENT
    # model instead of hard-ERRORing the audit; without one, a provider outage
    # kills every entry (the whole chain is one model), which turned a deepseek
    # latency window into a 14/15-ERROR benchmark run.
    strict_fallbacks: tuple[str, ...] = ()
    agent_fallbacks: tuple[str, ...] = ()
    # usd per million tokens, (input, output). Only for routes whose adapter
    # never reports cost — an unpriced route bills at the deliberately expensive
    # llm_fallback_price_* rate, which is correct but blunt.
    prices: Mapping[str, tuple[float, float]] = field(default_factory=dict)

    def _spec(
        self,
        slug: str,
        timeout_ms: int,
        max_output_tokens: int,
        *,
        transport: JsonObject | StrictSchema | None,
    ) -> ModelSpec:
        return ModelSpec(
            slug,
            timeout_ms=timeout_ms,
            max_output_tokens=max_output_tokens,
            transport=transport,
            reasoning=self.reasoning.get(slug),
            prices=self.prices.get(slug),
        )

    def union_chain(
        self, slug: str, timeout_ms: int, max_output_tokens: int
    ) -> tuple[ModelSpec, ...]:
        """The primary under StrictSchema, then the cross-provider StrictSchema
        fallback tail. The primary's own strict→JsonObject transport hop was
        dropped: measured JsonObject fallbacks do NOT conform to the strict
        contracts (they omit e.g. FileFlagResponse.flags[].lines), and the
        cross-model tail now covers the total-outage / provider-abort cases the
        same-model json hop used to. Trade-off: we lose the primary's own
        strict∪json transport-union recovery (hyp-confirm-v1: 52/64 each, 62/64
        union) in favour of a different-model retry — worth measuring."""
        slugs = (slug, *self.strict_fallbacks)
        return tuple(
            self._spec(entry, timeout_ms, max_output_tokens, transport=StrictSchema())
            for entry in slugs
        )

    def agent_chain(
        self, slug: str, timeout_ms: int, max_output_tokens: int
    ) -> tuple[ModelSpec, ...]:
        """Transport-free: offered tools suppress response_format
        (client.py:467), so these entries matter only if they tool-call."""
        slugs = (slug, *self.agent_fallbacks)
        return tuple(
            self._spec(entry, timeout_ms, max_output_tokens, transport=None) for entry in slugs
        )


# Role-split by what each fallback was PROBED to do (``:free`` slugs, pinned to
# zero price so spend stays off the expensive-fallback rate):
#   nemotron-3-super  — conforms to StrictSchema 3/3 (FileFlagResponse) AND
#                       tool-calls 2/3 → usable in every role.
#   minimax-m3        — conforms to StrictSchema 2/3, fast (1-6.5s), cheap-paid
#                       ($0.30/$1.20 per Mtok, backfilled — not priced here);
#                       different provider than nemotron → structured 3rd tier.
#   cohere/north-mini — tool-calls 3/3 but fails StrictSchema 0/3 (truncates /
#                       wrong top-level type) → agent role ONLY, where offered
#                       tools suppress the response format anyway (client.py:467).
#   xiaomi/mimo-v2.5  — rejected: ~110s/call (over the 60s per-call timeout) and
#                       truncates; disabling reasoning did not rescue it.
_OPENROUTER = _Profile(
    reasoning={
        "deepseek/deepseek-v4-flash": ReasoningControl(enabled=False),
        "qwen/qwen3-30b-a3b": ReasoningControl(enabled=False),
        "openai/gpt-5-nano": ReasoningControl(effort="low"),
    },
    strict_fallbacks=("nvidia/nemotron-3-super-120b-a12b:free", "minimax/minimax-m3"),
    agent_fallbacks=("nvidia/nemotron-3-super-120b-a12b:free", "cohere/north-mini-code:free"),
    prices={
        "nvidia/nemotron-3-super-120b-a12b:free": (0.0, 0.0),
        "cohere/north-mini-code:free": (0.0, 0.0),
    },
)

# 0G Compute Router. Slugs, capabilities and prices are as published by
# GET {router}/v1/models on 2026-07-25 — the Router reports token usage but never
# cost, so every route here carries static prices or the budget gate bills it at
# the expensive fallback rate.
#
# deepseek-v4-flash is the SAME model family the OpenRouter profile already runs,
# which is why the move needs no prompt or transport re-measurement. Fallbacks
# are split on the capability the Router itself advertises:
#   qwen3.7-plus / glm-5.2 — advertise `response_format` → structured roles.
#   minimax-m3             — advertises `tools` but NOT `response_format` →
#                            agent role only, the same shape as cohere above.
# Reasoning is disabled only for deepseek, where the OpenRouter profile measured
# it; the others are deliberately absent rather than guessed.
_ZEROG = _Profile(
    reasoning={"deepseek-v4-flash": ReasoningControl(enabled=False)},
    strict_fallbacks=("qwen3.7-plus", "glm-5.2"),
    agent_fallbacks=("qwen3.7-plus", "minimax-m3"),
    prices={
        "deepseek-v4-flash": (0.121, 0.242),
        "qwen3.7-plus": (0.221, 0.881),
        "glm-5.2": (0.9, 3.0),
        "minimax-m3": (0.27, 1.08),
    },
)


ZEROG_ROUTER_HOST = ".0g.ai"
OPENROUTER_HOST = "openrouter.ai"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _is_zerog(settings: Settings) -> bool:
    # The master mode routes every audit role through 0G Compute. Keep the
    # legacy backend value as a compute-only compatibility switch.
    return settings.zerog_enabled or settings.llm_backend == "zerog"


def _is_openrouter(settings: Settings) -> bool:
    """True for the `openrouter` preset AND for an `openai_compatible` endpoint
    that happens to BE OpenRouter — the vendor quirks below follow the route,
    not the spelling of the backend name."""
    if settings.llm_backend == "openrouter":
        return True
    return bool(settings.llm_base_url) and OPENROUTER_HOST in settings.llm_base_url


def _profile(settings: Settings) -> _Profile:
    return _ZEROG if _is_zerog(settings) else _OPENROUTER


def _model(settings: Settings, model: str) -> str:
    if _is_openrouter(settings) and "/" not in model:
        if model.startswith("claude-"):
            return f"anthropic/{model}"
        if model.startswith("gemini-"):
            return f"google/{model}"
    return model


def _role_models(settings: Settings) -> tuple[str, str]:
    """(triage, investigation) slugs for the configured backend. Read straight
    off Settings — a model name is a knob, and the knob a route reads must name
    a model that route's catalogue actually serves."""
    if _is_zerog(settings):
        return settings.zerog_triage_model, settings.zerog_investigation_model
    return (
        _model(settings, settings.triage_model),
        _model(settings, settings.investigation_model),
    )


def _adapter(settings: Settings, llm_settings: LlmSettings) -> ProviderPort:
    """The adapter is chosen from the RESOLVED endpoint, not the backend name: an
    endpoint label does not prove conformance (provider.py), so the only honest
    signal is the URL the request will actually go to."""
    if _is_zerog(settings) or ZEROG_ROUTER_HOST in llm_settings.llm_base_url:
        return ZeroGAdapter(
            llm_settings,
            verify_tee=settings.zerog_verify_tee,
            trust_mode=settings.zerog_trust_mode,
            provider_sort=settings.zerog_provider_sort,
        )
    if OPENROUTER_HOST in llm_settings.llm_base_url:
        return OpenRouterAdapter(llm_settings)
    return OpenAICompatAdapter(llm_settings)


def _provider_settings(settings: Settings) -> LlmSettings:
    base_url = settings.llm_base_url
    api_key = settings.llm_api_key
    if settings.zerog_enabled:
        # The product-level flag is authoritative. An old generic endpoint/key
        # may still be present for the non-0G backend, so do not let either keep
        # unified mode on that provider. Dedicated 0G values win.
        base_url = settings.zerog_router_url
        api_key = os.environ.get("ZEROG_API_KEY") or api_key
    elif settings.llm_backend == "zerog":
        base_url = base_url or settings.zerog_router_url
        api_key = api_key or os.environ.get("ZEROG_API_KEY", "")
    elif settings.llm_backend == "anthropic":
        base_url = base_url or "https://api.anthropic.com/v1/"
        api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    elif settings.llm_backend == "google":
        base_url = base_url or "https://generativelanguage.googleapis.com/v1beta/openai/"
        api_key = api_key or os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    elif settings.llm_backend == "openrouter":
        base_url = base_url or OPENROUTER_BASE_URL
        api_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")
    return LlmSettings(
        llm_api_key=api_key,
        llm_base_url=base_url or OPENROUTER_BASE_URL,
        llm_prompts_dir=str(Path(__file__).resolve().parents[1] / "prompts"),
        llm_budget_usd_24h=settings.llm_budget_usd_24h,
        llm_budget_margin=settings.llm_budget_margin,
    )


def build_npmguard_llm(
    sessions: async_sessionmaker,
    settings: Settings,
    *,
    provider: ProviderPort | None = None,
):
    timeout = int(settings.llm_timeout_seconds * 1000)
    profile = _profile(settings)
    triage, investigation = _role_models(settings)
    roles = Roles.of(
        Role(
            "intent",
            profile.union_chain(triage, timeout, 1_500),
            output=PackageIntent,
        ),
        Role(
            "flag",
            profile.union_chain(triage, timeout, 2_500),
            output=FileFlagResponse,
        ),
        Role(
            "hypothesis",
            # Generous output budget: reasoning-capable routes need room to think
            # AND answer; unused headroom is free (billing is per real token).
            profile.union_chain(investigation, timeout, 8_000),
            # The per-call output is target-specific (hypothesis_submission);
            # this static representative only lets build_llm project the strict
            # transport at wiring. Its shape is identical to every per-call one.
            output=hypothesis_submission([]),
            repair_retries=1,
        ),
        # Two-phase fallback (hypothesis_agent): a small proposal call...
        Role(
            "propose",
            profile.union_chain(investigation, timeout, 2_000),
            output=HypothesisProposal,
            repair_retries=1,
        ),
        # ...then an agentic tool-building loop. Offered tools suppress the
        # response format, so this route needs no transport — just the reasoning
        # knob and room to iterate. Its fallbacks matter only if they tool-call —
        # verified for both agent slugs, so a primary-route outage here advances
        # to a working tool-caller (incl. slugs excluded from the strict roles)
        # instead of failing to arm.
        Role(
            "agent",
            profile.agent_chain(investigation, timeout, 3_000),
            output=None,
        ),
        Role(
            "judge",
            profile.union_chain(investigation, timeout, 1_500),
            output=JudgeVerdict,
        ),
    )
    llm_settings = _provider_settings(settings)
    if provider is None:
        if settings.mock_llm:
            provider = ScriptedLlm(
                {
                    "intent": [
                        PackageIntent(
                            statedPurpose="Deterministic test package",
                            expectedCapabilities=[],
                            rationale="NPMGUARD_MOCK_LLM is enabled.",
                        )
                    ],
                    "flag": [
                        FileFlagResponse(
                            summary="No suspicious behavior in deterministic test mode",
                            capabilities=[],
                            flags=[],
                        )
                    ],
                }
            )
        else:
            provider = _adapter(settings, llm_settings)
    return build_llm(sessions, llm_settings, roles, provider=provider)

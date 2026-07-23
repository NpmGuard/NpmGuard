import os
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
    build_llm,
)
from kit_llm.provider import ProviderPort

from .config import Settings
from .hypothesis_agent import HypothesisProposal
from .phases import FileFlagResponse, JudgeVerdict, PackageIntent, hypothesis_submission

# Per-route reasoning policy — a KNOB the client sets, not policy baked into Kit
# (reliability study output-controls-v1). For these small structured tasks
# reasoning is a net liability: reasoning models spend the whole output budget
# thinking and emit nothing. Controls are honored inconsistently, so it is
# per-route: disable where the route honors disabling, cap effort where it does
# not. Absent entries (e.g. google/gemini-*) get no reasoning field. Keyed on the
# resolved OpenRouter slug.
_REASONING: dict[str, ReasoningControl] = {
    "deepseek/deepseek-v4-flash": ReasoningControl(enabled=False),
    "qwen/qwen3-30b-a3b": ReasoningControl(enabled=False),
    "openai/gpt-5-nano": ReasoningControl(effort="low"),
}


def _reasoning_for(slug: str) -> ReasoningControl | None:
    return _REASONING.get(slug)


# Cross-provider model fallback appended after the primary (deepseek) on every
# role. When the primary route fails — timeout, provider abort, or exhausted
# repair — the client advances the chain (client.py:515/528/620) to a DIFFERENT
# model instead of hard-ERRORing the audit; without one, a provider outage kills
# every entry (the whole chain is one model), which turned a deepseek latency
# window into a 14/15-ERROR benchmark run.
#
# Role-split by what each fallback was PROBED to do (``:free`` slugs, pinned to
# zero price so spend stays off the expensive-fallback rate):
#   nemotron-3-super  — conforms to StrictSchema 3/3 (FileFlagResponse) AND
#                       tool-calls 2/3 → usable in every role.
#   cohere/north-mini — tool-calls 3/3 but fails StrictSchema 0/3 (truncates /
#                       wrong top-level type) → agent role ONLY, where offered
#                       tools suppress the response format anyway (client.py:467).
#   xiaomi/mimo-v2.5  — rejected: ~110s/call (over the 60s per-call timeout) and
#                       truncates; disabling reasoning did not rescue it.
_STRICT_FALLBACKS: tuple[str, ...] = ("nvidia/nemotron-3-super-120b-a12b:free",)
_AGENT_FALLBACKS: tuple[str, ...] = (
    "nvidia/nemotron-3-super-120b-a12b:free",
    "cohere/north-mini-code:free",
)
_FREE_PRICES: dict[str, tuple[float, float]] = {
    "nvidia/nemotron-3-super-120b-a12b:free": (0.0, 0.0),
    "cohere/north-mini-code:free": (0.0, 0.0),
}


def _fallback_specs(
    slugs: tuple[str, ...],
    timeout_ms: int,
    max_output_tokens: int,
    *,
    transport: JsonObject | StrictSchema | None,
) -> tuple[ModelSpec, ...]:
    return tuple(
        ModelSpec(
            slug,
            timeout_ms=timeout_ms,
            max_output_tokens=max_output_tokens,
            transport=transport,
            reasoning=_reasoning_for(slug),
            prices=_FREE_PRICES.get(slug),
        )
        for slug in slugs
    )


def _union_chain(slug: str, timeout_ms: int, max_output_tokens: int) -> tuple[ModelSpec, ...]:
    """deepseek under StrictSchema, then the cross-provider StrictSchema fallback
    tail. The primary's own strict→JsonObject transport hop was dropped: measured
    JsonObject fallbacks do NOT conform to the strict contracts (they omit e.g.
    FileFlagResponse.flags[].lines), and the cross-model tail now covers the
    total-outage / provider-abort cases the same-model json hop used to. Trade-off:
    we lose deepseek's own strict∪json transport-union recovery (hyp-confirm-v1:
    52/64 each, 62/64 union) in favour of a different-model retry — worth measuring."""
    return (
        ModelSpec(
            slug,
            timeout_ms=timeout_ms,
            max_output_tokens=max_output_tokens,
            transport=StrictSchema(),
            reasoning=_reasoning_for(slug),
        ),
    ) + _fallback_specs(_STRICT_FALLBACKS, timeout_ms, max_output_tokens, transport=StrictSchema())


def _model(settings: Settings, model: str) -> str:
    if (
        settings.llm_backend == "openai_compatible"
        and settings.llm_base_url
        and "openrouter.ai" in settings.llm_base_url
    ):
        if "/" not in model and model.startswith("claude-"):
            return f"anthropic/{model}"
        if "/" not in model and model.startswith("gemini-"):
            return f"google/{model}"
    return model


def _provider_settings(settings: Settings) -> LlmSettings:
    base_url = settings.llm_base_url
    api_key = settings.llm_api_key
    if settings.llm_backend == "anthropic":
        base_url = base_url or "https://api.anthropic.com/v1/"
        api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    elif settings.llm_backend == "google":
        base_url = base_url or "https://generativelanguage.googleapis.com/v1beta/openai/"
        api_key = api_key or os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    return LlmSettings(
        llm_api_key=api_key,
        llm_base_url=base_url or "https://openrouter.ai/api/v1",
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
    triage = _model(settings, settings.triage_model)
    investigation = _model(settings, settings.investigation_model)
    roles = Roles.of(
        Role(
            "intent",
            _union_chain(triage, timeout, 1_500),
            output=PackageIntent,
        ),
        Role(
            "flag",
            _union_chain(triage, timeout, 2_500),
            output=FileFlagResponse,
        ),
        Role(
            "hypothesis",
            # Generous output budget: reasoning-capable routes need room to think
            # AND answer; unused headroom is free (billing is per real token).
            _union_chain(investigation, timeout, 8_000),
            # The per-call output is target-specific (hypothesis_submission);
            # this static representative only lets build_llm project the strict
            # transport at wiring. Its shape is identical to every per-call one.
            output=hypothesis_submission([]),
            repair_retries=1,
        ),
        # Two-phase fallback (hypothesis_agent): a small proposal call...
        Role(
            "propose",
            _union_chain(investigation, timeout, 2_000),
            output=HypothesisProposal,
            repair_retries=1,
        ),
        # ...then an agentic tool-building loop. Offered tools suppress the
        # response format, so this route needs no transport — one spec, just the
        # reasoning knob and room to iterate.
        Role(
            "agent",
            (
                ModelSpec(
                    investigation,
                    timeout_ms=timeout,
                    max_output_tokens=3_000,
                    reasoning=_reasoning_for(investigation),
                ),
            )
            # transport-free fallbacks: offered tools suppress response_format
            # (client.py:467), so these matter only if they tool-call — verified
            # for both agent slugs, so a deepseek outage here now advances to a
            # working tool-caller (incl. cohere, which is excluded from the strict
            # roles) instead of failing to arm.
            + _fallback_specs(_AGENT_FALLBACKS, timeout, 3_000, transport=None),
            output=None,
        ),
        Role(
            "judge",
            _union_chain(investigation, timeout, 1_500),
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
            provider = (
                OpenRouterAdapter(llm_settings)
                if "openrouter.ai" in llm_settings.llm_base_url
                else OpenAICompatAdapter(llm_settings)
            )
    return build_llm(sessions, llm_settings, roles, provider=provider)

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


# Cross-provider free fallbacks appended after the primary model's transport
# chain on EVERY role. When the primary (deepseek) route fails — timeout, provider
# abort, or exhausted repair — the client advances the chain (client.py:515/528/620)
# to these instead of hard-ERRORing the audit; without a DIFFERENT model here a
# provider outage kills every entry (the whole chain is one model), which is what
# turned a deepseek latency window into a 14/15-ERROR benchmark run. Two distinct
# providers so an NVIDIA free-tier outage still falls through to Cohere. Both probed
# for valid json_object output + correct malicious-code detection AND for tool-calling
# (Cohere 3/3, Nemotron 2/3 — one free-tier rate-limit, successes clean). StrictSchema
# is NOT verified, so structured roles pin them to JsonObject; the tool-calling agent
# role gets them transport-free (offered tools suppress the response format anyway —
# client.py:467). ``:free`` = no budget cost; prices are pinned to zero so spend
# accounting does not apply the expensive-fallback rate.
_FALLBACK_SLUGS: tuple[str, ...] = (
    "nvidia/nemotron-3-super-120b-a12b:free",
    "cohere/north-mini-code:free",
)


def _fallback_specs(
    timeout_ms: int, max_output_tokens: int, *, transport: JsonObject | None
) -> tuple[ModelSpec, ...]:
    return tuple(
        ModelSpec(
            slug,
            timeout_ms=timeout_ms,
            max_output_tokens=max_output_tokens,
            transport=transport,
            reasoning=_reasoning_for(slug),
            prices=(0.0, 0.0),
        )
        for slug in _FALLBACK_SLUGS
    )


def _union_chain(slug: str, timeout_ms: int, max_output_tokens: int) -> tuple[ModelSpec, ...]:
    """strict→json transport-fallback for one route, then the cross-provider
    free model_fallback tail. The two measured transport finalists fail on
    DISJOINT cases (hyp-confirm-v1: 52/64 semantic each, union 62/64), so listing
    the same model under StrictSchema then JsonObject recovers misses either
    transport alone would keep. There is no provider-independent best transport —
    the chain IS the choice. The trailing _fallback_specs make the chain survive a
    total outage of the primary model, not just a transport miss."""
    reasoning = _reasoning_for(slug)
    return (
        ModelSpec(
            slug,
            timeout_ms=timeout_ms,
            max_output_tokens=max_output_tokens,
            transport=StrictSchema(),
            reasoning=reasoning,
        ),
        ModelSpec(
            slug,
            timeout_ms=timeout_ms,
            max_output_tokens=max_output_tokens,
            transport=JsonObject(),
            reasoning=reasoning,
        ),
    ) + _fallback_specs(timeout_ms, max_output_tokens, transport=JsonObject())


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
            # for both slugs (see _FALLBACK_SLUGS), so a deepseek outage here now
            # advances to a working tool-caller instead of failing to arm.
            + _fallback_specs(timeout, 3_000, transport=None),
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

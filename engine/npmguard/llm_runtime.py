import os
from pathlib import Path

from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm import (
    BedrockAdapter,
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
    "openai.gpt-5.6-sol": ReasoningControl(effort="low"),
    "xai.grok-4.3": ReasoningControl(effort="low"),
    "deepseek/deepseek-v4-flash": ReasoningControl(enabled=False),
    "qwen/qwen3-30b-a3b": ReasoningControl(enabled=False),
    "openai/gpt-5-nano": ReasoningControl(effort="low"),
}


def _reasoning_for(slug: str) -> ReasoningControl | None:
    return _REASONING.get(slug)


# Every role crosses model families after a provider/model failure.
_STRICT_FALLBACKS: tuple[str, ...] = (
    "deepseek.v3.2",
    "moonshotai.kimi-k2.5",
)
_AGENT_DEFAULT_CHAIN: tuple[str, ...] = (
    "deepseek.v3.2",
    "zai.glm-5",
    "moonshotai.kimi-k2.5",
)
_MODEL_PRICES: dict[str, tuple[float, float]] = {
    "openai.gpt-5.6-sol": (5.50, 33.00),
    "zai.glm-5": (1.00, 3.20),
    "deepseek.v3.2": (0.62, 1.85),
    "moonshotai.kimi-k2.5": (0.60, 3.00),
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
            prices=_MODEL_PRICES.get(slug),
        )
        for slug in slugs
    )


def _union_chain(slug: str, timeout_ms: int, max_output_tokens: int) -> tuple[ModelSpec, ...]:
    """Strict-schema primary followed by the measured cross-model fallbacks."""
    return (
        ModelSpec(
            slug,
            timeout_ms=timeout_ms,
            max_output_tokens=max_output_tokens,
            transport=StrictSchema(),
            reasoning=_reasoning_for(slug),
            prices=_MODEL_PRICES.get(slug),
        ),
    ) + _fallback_specs(
        tuple(model for model in _STRICT_FALLBACKS if model != slug),
        timeout_ms,
        max_output_tokens,
        transport=StrictSchema(),
    )


def _agent_chain(slug: str, timeout_ms: int) -> tuple[ModelSpec, ...]:
    models = (
        _AGENT_DEFAULT_CHAIN
        if slug == "zai.glm-5"
        else (slug,) + tuple(model for model in _AGENT_DEFAULT_CHAIN if model != slug)
    )
    return tuple(
        ModelSpec(
            model,
            timeout_ms=timeout_ms,
            max_output_tokens=3_000,
            reasoning=_reasoning_for(model),
            prices=_MODEL_PRICES.get(model),
        )
        for model in models
    )


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
    elif settings.llm_backend == "bedrock":
        origin = (base_url or f"https://bedrock-mantle.{settings.bedrock_region}.api.aws").rstrip(
            "/"
        )
        origin = origin.removesuffix("/openai/v1").removesuffix("/v1")
        base_url = f"{origin}/v1"
        api_key = (
            api_key
            or os.environ.get("AWS_BEARER_TOKEN_BEDROCK", "")
            or os.environ.get("AWS_BEDROCK_API_KEY", "")
            or os.environ.get("BEDROCK_KEY", "")
        )
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
        # response format, so this route needs no transport.
        Role(
            "agent",
            # Tool-call reliability is a distinct measured capability, so its
            # ordering differs from the structured-output roles.
            _agent_chain(investigation, timeout),
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
            if settings.llm_backend == "bedrock":
                origin = llm_settings.llm_base_url.removesuffix("/v1")
                provider = BedrockAdapter(
                    llm_settings,
                    responses_base_url=f"{origin}/openai/v1",
                )
            elif "openrouter.ai" in llm_settings.llm_base_url:
                provider = OpenRouterAdapter(llm_settings)
            else:
                provider = OpenAICompatAdapter(llm_settings)
    return build_llm(sessions, llm_settings, roles, provider=provider)

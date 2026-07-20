import os
from pathlib import Path

from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm import (
    LlmSettings,
    ModelSpec,
    OpenAICompatAdapter,
    OpenRouterAdapter,
    Role,
    Roles,
    ScriptedLlm,
    build_llm,
)
from kit_llm.provider import ProviderPort

from .config import Settings
from .phases import FileFlagResponse, JudgeVerdict, PackageIntent


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
    roles = Roles.of(
        Role(
            "intent",
            (ModelSpec(_model(settings, settings.triage_model), timeout_ms=timeout),),
            output=PackageIntent,
        ),
        Role(
            "flag",
            (ModelSpec(_model(settings, settings.triage_model), timeout_ms=timeout),),
            output=FileFlagResponse,
        ),
        Role(
            "hypothesis",
            (ModelSpec(_model(settings, settings.investigation_model), timeout_ms=timeout),),
            output=None,
            repair_retries=2,
        ),
        Role(
            "judge",
            (ModelSpec(_model(settings, settings.investigation_model), timeout_ms=timeout),),
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

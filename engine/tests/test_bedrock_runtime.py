from typing import cast

from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm import ScriptedLlm
from npmguard.config import Settings
from npmguard.llm_runtime import _provider_settings, build_npmguard_llm

EXPECTED_CHAIN = [
    ("zai.glm-5", (1.00, 3.20)),
    ("deepseek.v3.2", (0.62, 1.85)),
    ("moonshotai.kimi-k2.5", (0.60, 3.00)),
]
EXPECTED_AGENT_CHAIN = [
    ("deepseek.v3.2", (0.62, 1.85)),
    ("zai.glm-5", (1.00, 3.20)),
    ("moonshotai.kimi-k2.5", (0.60, 3.00)),
]
# Hypothesis leads with grok, which alone compiled every plan it produced. It has
# no price entry, so it bills at the conservative fallback rather than silently
# free — an over-estimate trips the budget early, which is the safe direction.
EXPECTED_HYPOTHESIS_CHAIN = [
    ("xai.grok-4.3", None),
    ("deepseek.v3.2", (0.62, 1.85)),
    ("zai.glm-5", (1.00, 3.20)),
    ("moonshotai.kimi-k2.5", (0.60, 3.00)),
]


def test_every_npmguard_role_uses_the_bedrock_fallback_chain() -> None:
    llm = build_npmguard_llm(
        cast(async_sessionmaker, None),
        Settings(_env_file=None),
        provider=ScriptedLlm({}),
    )

    assert set(llm.roles.by_name) == {
        "intent",
        "flag",
        "hypothesis",
        "propose",
        "agent",
        "judge",
    }
    by_role = {"agent": EXPECTED_AGENT_CHAIN, "hypothesis": EXPECTED_HYPOTHESIS_CHAIN}
    for name, role in llm.roles.by_name.items():
        expected = by_role.get(name, EXPECTED_CHAIN)
        assert [(spec.slug, spec.prices) for spec in role.chain] == expected


def test_bedrock_endpoint_uses_the_configured_region_and_bearer_key(monkeypatch) -> None:
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "test-bedrock-key")
    settings = Settings(_env_file=None, bedrock_region="us-west-2")

    provider_settings = _provider_settings(settings)

    assert provider_settings.llm_base_url == "https://bedrock-mantle.us-west-2.api.aws/v1"
    assert provider_settings.llm_api_key == "test-bedrock-key"


def test_responses_region_can_differ_from_the_chat_region() -> None:
    """Bedrock offers its Responses-API models in fewer regions than its chat ones,
    so a deployment pinned to a chat-only region reaches them cross-region or not at
    all. The two clients carry independent origins for exactly this."""
    settings = Settings(
        _env_file=None,
        llm_api_key="test-bedrock-key",
        bedrock_region="eu-north-1",
        bedrock_responses_region="us-east-1",
    )
    llm = build_npmguard_llm(cast(async_sessionmaker, None), settings)

    provider = llm.provider
    assert str(provider._client.base_url).startswith("https://bedrock-mantle.eu-north-1.api.aws/v1")
    assert str(provider._responses_client.base_url).startswith(
        "https://bedrock-mantle.us-east-1.api.aws/openai/v1"
    )


def test_bedrock_custom_origin_accepts_a_trailing_api_path() -> None:
    settings = Settings(
        _env_file=None,
        llm_base_url="https://bedrock.test/openai/v1",
        llm_api_key="test-bedrock-key",
    )

    provider_settings = _provider_settings(settings)

    assert provider_settings.llm_base_url == "https://bedrock.test/v1"

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
    for name, role in llm.roles.by_name.items():
        expected = EXPECTED_AGENT_CHAIN if name == "agent" else EXPECTED_CHAIN
        assert [(spec.slug, spec.prices) for spec in role.chain] == expected


def test_bedrock_endpoint_uses_the_configured_region_and_bearer_key(monkeypatch) -> None:
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "test-bedrock-key")
    settings = Settings(_env_file=None, bedrock_region="us-west-2")

    provider_settings = _provider_settings(settings)

    assert provider_settings.llm_base_url == "https://bedrock-mantle.us-west-2.api.aws/v1"
    assert provider_settings.llm_api_key == "test-bedrock-key"


def test_bedrock_custom_origin_accepts_a_trailing_api_path() -> None:
    settings = Settings(
        _env_file=None,
        llm_base_url="https://bedrock.test/openai/v1",
        llm_api_key="test-bedrock-key",
    )

    provider_settings = _provider_settings(settings)

    assert provider_settings.llm_base_url == "https://bedrock.test/v1"

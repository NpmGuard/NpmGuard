# CLASS MAP — backend selection in llm_runtime + the 0G provider adapter.
# Axes: configured backend × what it must produce
#   B1 openrouter (default) — REGRESSION PIN: the exact chain that shipped, so a
#      profile refactor cannot silently retune the production route
#   B2 zerog — 0G Router slugs, static prices (the Router never reports cost),
#      reasoning disabled only where it was measured
#   B3 adapter selection is made from the RESOLVED endpoint, not the label
#   B4 ZeroGAdapter carries the enclave chat id into provider_call_id
#
# Blackbox for B1/B2/B3 (public build_npmguard_llm + _adapter seam); B4 drives the
# adapter over an injected httpx transport — the same seam TESTING.md documents.

import httpx
import pytest

from kit_llm import LlmSettings, OpenAICompatAdapter, OpenRouterAdapter, ZeroGAdapter
from npmguard.config import Settings
from npmguard.llm_runtime import _adapter, _profile, _provider_settings, _role_models


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


def _chain(settings: Settings, role: str):
    """The ModelSpec chain llm_runtime would wire for one role."""
    profile = _profile(settings)
    triage, investigation = _role_models(settings)
    slug = triage if role in ("intent", "flag") else investigation
    return (
        profile.agent_chain(slug, 60_000, 3_000)
        if role == "agent"
        else profile.union_chain(slug, 60_000, 1_500)
    )


# --- B1: the shipped OpenRouter route, pinned ------------------------------


def test_openrouter_chain_is_unchanged_by_the_profile_split() -> None:
    """The default backend must wire exactly the slugs, order and transports it
    wired before profiles existed. This is the regression that a provider
    refactor is most likely to cause and least likely to be noticed."""
    settings = _settings()
    flag = _chain(settings, "flag")
    assert [spec.slug for spec in flag] == [
        "claude-haiku-4-5-20251001",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "minimax/minimax-m3",
    ]
    assert all(type(spec.transport).__name__ == "StrictSchema" for spec in flag)

    agent = _chain(settings, "agent")
    assert [spec.slug for spec in agent] == [
        "claude-sonnet-4-6",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "cohere/north-mini-code:free",
    ]
    # offered tools suppress response_format, so the agent chain stays transport-free
    assert all(spec.transport is None for spec in agent)
    # the ``:free`` slugs stay pinned at zero so spend never bills them at the
    # deliberately expensive unpriced-fallback rate
    assert {spec.slug: spec.prices for spec in agent}["cohere/north-mini-code:free"] == (0.0, 0.0)


def test_an_explicit_openrouter_model_still_wins() -> None:
    settings = _settings(triage_model="qwen/qwen3-30b-a3b")
    assert _chain(settings, "flag")[0].slug == "qwen/qwen3-30b-a3b"


# --- B1b: the one-variable demo switch -------------------------------------


def test_the_backend_switch_needs_no_second_variable() -> None:
    """A demo has to move between providers by editing one line. Each preset must
    therefore resolve its OWN endpoint with no base URL configured."""
    assert _provider_settings(_settings(llm_backend="openrouter")).llm_base_url == (
        "https://openrouter.ai/api/v1"
    )
    assert _provider_settings(_settings(llm_backend="zerog")).llm_base_url == (
        "https://router-api.0g.ai/v1"
    )


def test_switching_backends_swaps_the_whole_route() -> None:
    """Not just the endpoint: the model catalogue, fallback tail and adapter all
    have to move together, or a 0G run silently asks for OpenRouter slugs."""
    openrouter, zerog = _settings(llm_backend="openrouter"), _settings(llm_backend="zerog")

    # namespaced by the OpenRouter rewrite below; 0G serves bare ids
    assert _chain(openrouter, "flag")[0].slug == "anthropic/claude-haiku-4-5-20251001"
    assert _chain(zerog, "flag")[0].slug == "deepseek-v4-flash"
    assert [spec.slug for spec in _chain(openrouter, "flag")[1:]] == [
        "nvidia/nemotron-3-super-120b-a12b:free",
        "minimax/minimax-m3",
    ]
    assert [spec.slug for spec in _chain(zerog, "flag")[1:]] == ["qwen3.7-plus", "glm-5.2"]

    assert type(_adapter(openrouter, _provider_settings(openrouter))) is OpenRouterAdapter
    assert type(_adapter(zerog, _provider_settings(zerog))) is ZeroGAdapter


def test_the_openrouter_preset_still_namespaces_vendor_slugs() -> None:
    """The `claude-*` → `anthropic/claude-*` rewrite was keyed on the backend
    being spelled `openai_compatible`. It has to follow the ROUTE instead, or the
    `openrouter` preset sends bare slugs that OpenRouter rejects."""
    assert _role_models(_settings(llm_backend="openrouter")) == (
        "anthropic/claude-haiku-4-5-20251001",
        "anthropic/claude-sonnet-4-6",
    )
    assert _role_models(_settings(llm_backend="openrouter", triage_model="gemini-3-pro"))[0] == (
        "google/gemini-3-pro"
    )
    # already-namespaced slugs are left alone
    assert _role_models(_settings(llm_backend="openrouter", triage_model="qwen/qwen3-30b-a3b"))[
        0
    ] == "qwen/qwen3-30b-a3b"


def test_a_non_openrouter_endpoint_does_not_get_the_rewrite() -> None:
    """The rewrite is an OpenRouter naming quirk, not a general one — applying it
    to another OpenAI-compatible endpoint would ask for a model it never serves."""
    settings = _settings(llm_backend="openai_compatible", llm_base_url="https://example.test/v1")
    assert _role_models(settings)[0] == "claude-haiku-4-5-20251001"


# --- B2: the 0G route ------------------------------------------------------


def test_zerog_wires_router_slugs_with_static_prices() -> None:
    """The Router reports token usage but never cost, so every 0G route must
    carry static prices — an unpriced route bills at the expensive fallback rate
    and would make the budget gate meaningless."""
    settings = _settings(llm_backend="zerog")
    flag = _chain(settings, "flag")
    assert [spec.slug for spec in flag] == ["deepseek-v4-flash", "qwen3.7-plus", "glm-5.2"]
    assert all(spec.prices is not None for spec in flag), "a 0G route without static prices"

    agent = _chain(settings, "agent")
    # minimax-m3 advertises `tools` but not `response_format` → agent role only
    assert [spec.slug for spec in agent] == ["deepseek-v4-flash", "qwen3.7-plus", "minimax-m3"]
    assert "minimax-m3" not in [spec.slug for spec in flag]


def test_zerog_disables_reasoning_only_where_it_was_measured() -> None:
    settings = _settings(llm_backend="zerog")
    by_slug = {spec.slug: spec.reasoning for spec in _chain(settings, "flag")}
    assert by_slug["deepseek-v4-flash"].enabled is False
    # deliberately absent rather than guessed — no measurement exists for these
    assert by_slug["qwen3.7-plus"] is None
    assert by_slug["glm-5.2"] is None


def test_zerog_reads_its_own_model_knobs() -> None:
    """`triage_model` names an OpenRouter slug the 0G Router does not serve, so
    the zerog backend must not read it."""
    settings = _settings(llm_backend="zerog", triage_model="claude-haiku-4-5-20251001")
    assert _role_models(settings) == ("deepseek-v4-flash", "deepseek-v4-flash")

    settings = _settings(llm_backend="zerog", zerog_triage_model="glm-5.2")
    assert _role_models(settings)[0] == "glm-5.2"


def test_zerog_defaults_to_the_router_endpoint() -> None:
    resolved = _provider_settings(_settings(llm_backend="zerog"))
    assert resolved.llm_base_url == "https://router-api.0g.ai/v1"


# --- B3: adapter selection -------------------------------------------------


@pytest.mark.parametrize(
    ("backend", "base_url", "expected"),
    [
        ("zerog", None, ZeroGAdapter),
        # an endpoint label does not prove conformance: a 0G URL gets the 0G
        # adapter even when the backend is spelled generically
        ("openai_compatible", "https://router-api.0g.ai/v1", ZeroGAdapter),
        ("openai_compatible", "https://openrouter.ai/api/v1", OpenRouterAdapter),
        ("openai_compatible", "https://example.test/v1", OpenAICompatAdapter),
    ],
)
def test_adapter_is_chosen_from_the_resolved_endpoint(backend, base_url, expected) -> None:
    settings = _settings(llm_backend=backend, llm_base_url=base_url)
    adapter = _adapter(settings, _provider_settings(settings))
    assert type(adapter) is expected


# --- B4: the enclave chat id ----------------------------------------------


def _completion_transport(headers: dict[str, str]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers=headers,
            json={
                "id": "chatcmpl-body-id",
                "model": "deepseek-v4-flash",
                "choices": [
                    {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}
                ],
                "usage": {"prompt_tokens": 7, "completion_tokens": 3},
            },
        )

    return httpx.MockTransport(handler)


async def _complete(headers: dict[str, str]):
    from kit_llm.provider import ProviderRequest

    adapter = ZeroGAdapter(
        LlmSettings(llm_api_key="k", llm_base_url="https://router-api.0g.ai/v1"),
        transport=_completion_transport(headers),
    )
    try:
        return await adapter.complete(
            ProviderRequest(role="flag", model="deepseek-v4-flash", messages=[{"role": "user", "content": "hi"}])
        )
    finally:
        await adapter.aclose()


async def test_the_enclave_chat_id_header_wins() -> None:
    """Verifying Sealed Inference needs the enclave chat id; it arrives in
    ZG-Res-Key, which must beat the router-side body id."""
    result = await _complete({"ZG-Res-Key": "enclave-chat-id"})
    assert result.provider_call_id == "enclave-chat-id"
    assert result.provider == "0g"


async def test_a_missing_header_falls_back_to_the_body_id() -> None:
    """Router conformance is not assumed. Without the header the call is an
    ordinary OpenAI-compatible one — it still works, it just carries no
    verifiability claim."""
    result = await _complete({})
    assert result.provider_call_id == "chatcmpl-body-id"
    assert result.in_tokens == 7 and result.out_tokens == 3

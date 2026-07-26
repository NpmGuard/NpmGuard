import json

import httpx
import pytest

from kit_llm import BedrockAdapter, LlmSettings, ProviderRequest


def _responses_body(*, output: list[dict], model: str = "openai.gpt-5.6-sol") -> dict:
    return {
        "id": "resp_bedrock_1",
        "object": "response",
        "created_at": 1,
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "max_output_tokens": 100,
        "model": model,
        "output": output,
        "parallel_tool_calls": True,
        "previous_response_id": None,
        "reasoning": {"effort": "low", "summary": None},
        "store": False,
        "temperature": 1,
        "text": {"format": {"type": "text"}},
        "tool_choice": "auto",
        "tools": [],
        "top_p": 1,
        "truncation": "disabled",
        "usage": {
            "input_tokens": 11,
            "input_tokens_details": {"cached_tokens": 3},
            "output_tokens": 7,
            "output_tokens_details": {"reasoning_tokens": 2},
            "total_tokens": 18,
        },
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["openai.gpt-5.6-sol", "xai.grok-4.3"])
async def test_responses_models_use_bedrock_path_and_map_strict_output(model: str) -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json=_responses_body(
                model=model,
                output=[
                    {
                        "id": "msg_1",
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": '{"ok":true}',
                                "annotations": [],
                                "logprobs": [],
                            }
                        ],
                    }
                ],
            ),
        )

    settings = LlmSettings(
        llm_api_key="bedrock-test-key",
        llm_base_url="https://bedrock-mantle.us-east-1.api.aws/v1",
    )
    adapter = BedrockAdapter(
        settings,
        responses_base_url="https://bedrock-mantle.us-east-1.api.aws/openai/v1",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await adapter.complete(
            ProviderRequest(
                role="intent",
                model=model,
                messages=[{"role": "user", "content": "return JSON"}],
                response_schema={
                    "type": "object",
                    "properties": {"ok": {"type": "boolean"}},
                    "required": ["ok"],
                    "additionalProperties": False,
                },
                max_output_tokens=100,
                reasoning={"effort": "low"},
            )
        )
    finally:
        await adapter.aclose()

    assert len(seen) == 1
    assert seen[0].url.path == "/openai/v1/responses"
    assert seen[0].headers["authorization"] == "Bearer bedrock-test-key"
    body = json.loads(seen[0].content)
    assert body["text"]["format"]["type"] == "json_schema"
    assert body["text"]["format"]["schema"]["required"] == ["ok"]
    assert body["reasoning"] == {"effort": "low"}
    assert result.content == '{"ok":true}'
    assert (result.in_tokens, result.out_tokens, result.cached_tokens) == (11, 7, 3)
    assert result.provider == "amazon-bedrock"


@pytest.mark.asyncio
async def test_sol_maps_agent_transcript_and_function_call() -> None:
    seen_body: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen_body.update(json.loads(request.content))
        return httpx.Response(
            200,
            json=_responses_body(
                output=[
                    {
                        "id": "fc_2",
                        "type": "function_call",
                        "status": "completed",
                        "call_id": "call_2",
                        "name": "finalize",
                        "arguments": '{"target":"index.js"}',
                    }
                ]
            ),
        )

    settings = LlmSettings(
        llm_api_key="bedrock-test-key",
        llm_base_url="https://bedrock-mantle.us-east-1.api.aws/v1",
    )
    adapter = BedrockAdapter(
        settings,
        responses_base_url="https://bedrock-mantle.us-east-1.api.aws/openai/v1",
        transport=httpx.MockTransport(handler),
    )
    tools = [
        {
            "type": "function",
            "function": {
                "name": "finalize",
                "description": "finish",
                "parameters": {
                    "type": "object",
                    "properties": {"target": {"type": "string"}},
                    "required": ["target"],
                    "additionalProperties": False,
                },
            },
        }
    ]
    try:
        result = await adapter.complete(
            ProviderRequest(
                role="agent",
                model="openai.gpt-5.6-sol",
                messages=[
                    {"role": "user", "content": "build"},
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "finalize",
                                    "arguments": '{"target":"setup.js"}',
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_1",
                        "content": "try again",
                    },
                ],
                tools=tools,
            )
        )
    finally:
        await adapter.aclose()

    assert seen_body["tools"][0] == {
        "type": "function",
        "name": "finalize",
        "description": "finish",
        "parameters": tools[0]["function"]["parameters"],
    }
    assert seen_body["input"][1]["type"] == "function_call"
    assert seen_body["input"][2] == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": "try again",
    }
    assert result.tool_calls == [
        {
            "id": "call_2",
            "type": "function",
            "function": {
                "name": "finalize",
                "arguments": '{"target":"index.js"}',
            },
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["zai.glm-5"])
async def test_fallback_models_use_bedrock_chat_completions_path(model: str) -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl_bedrock_1",
                "object": "chat.completion",
                "created": 1,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": '{"ok":true}',
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 5,
                    "completion_tokens": 3,
                    "total_tokens": 8,
                },
            },
        )

    settings = LlmSettings(
        llm_api_key="bedrock-test-key",
        llm_base_url="https://bedrock-mantle.eu-north-1.api.aws/v1",
    )
    adapter = BedrockAdapter(
        settings,
        responses_base_url="https://bedrock-mantle.eu-north-1.api.aws/openai/v1",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await adapter.complete(
            ProviderRequest(
                role="flag",
                model=model,
                messages=[{"role": "user", "content": "return JSON"}],
                json_response=True,
            )
        )
    finally:
        await adapter.aclose()

    assert len(seen) == 1
    assert seen[0].url.path == "/v1/chat/completions"
    assert result.content == '{"ok":true}'

"""ProviderPort — the seam between the chain walk and any model vendor.
Adapters translate the NEUTRAL request (plain messages, a `cache` flag,
response mode, tools, and forced tool choice) into provider syntax; nothing provider-shaped
leaks upward. Cost comes back response-native when the provider offers
it, else None — the client's cost pipeline (static prices → deferred
backfill) takes over from there.

The SDK is constructed with max_retries=0: the chain walk owns retry
semantics, and hidden SDK retries would both mask failures and multiply
per-model timeouts."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from openai import AsyncOpenAI

from kit_llm.config import LlmSettings


@dataclass(frozen=True)
class ProviderRequest:
    role: str  # metadata: mock keying, provider attribution headers
    model: str
    messages: list[dict[str, Any]]  # neutral; per-message `cache: True` flag
    temperature: float | None = None
    json_response: bool = False
    tools: list[dict[str, Any]] | None = None  # OpenAI tool defs (agentic P2)
    tool_choice: dict[str, Any] | str | None = None

    def __post_init__(self) -> None:
        if self.tool_choice is not None and not self.tools:
            raise ValueError("tool_choice requires at least one tool definition")


@dataclass(frozen=True)
class ProviderResult:
    content: str | None
    tool_calls: list[dict[str, Any]] | None
    in_tokens: int | None
    out_tokens: int | None
    cached_tokens: int | None
    cost_usd: float | None  # response-native only; None = later stages
    provider_call_id: str | None


class ProviderPort(Protocol):
    async def complete(self, request: ProviderRequest) -> ProviderResult: ...

    async def stream(
        self, request: ProviderRequest, on_token: Callable[[str], None]
    ) -> ProviderResult: ...

    async def lookup_cost(self, provider_call_id: str) -> float | None: ...

    async def aclose(self) -> None:
        """Release any long-lived resources (HTTP client pool). Apps call
        llm.aclose() on shutdown; must be safe to call more than once."""
        ...


def _wire_messages(
    messages: list[dict[str, Any]], *, cache_control: bool
) -> list[dict[str, Any]]:
    """Neutral → OpenAI wire form. The `cache` flag either becomes an
    ephemeral cache_control content block (providers that price cached
    prefixes) or is dropped (providers without the concept)."""
    wire = []
    for message in messages:
        clean = {k: v for k, v in message.items() if k != "cache"}
        if message.get("cache") and cache_control:
            clean["content"] = [
                {
                    "type": "text",
                    "text": message["content"],
                    "cache_control": {"type": "ephemeral"},
                }
            ]
        wire.append(clean)
    return wire


def _usage_fields(usage: Any) -> tuple[int | None, int | None, int | None]:
    if usage is None:
        return None, None, None
    details = getattr(usage, "prompt_tokens_details", None)
    cached = getattr(details, "cached_tokens", None) if details is not None else None
    return (
        getattr(usage, "prompt_tokens", None),
        getattr(usage, "completion_tokens", None),
        cached,
    )


class OpenAICompatAdapter:
    """Any OpenAI-compatible endpoint (vllm, ollama, minimax, a fake test
    provider). Reports tokens; never cost — static ModelSpec prices or
    nothing. No cache_control (dropped)."""

    supports_cache_control = False

    def __init__(self, settings: LlmSettings) -> None:
        self._client = AsyncOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key or "unused",
            max_retries=0,
        )

    def _request_kwargs(self, request: ProviderRequest) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": request.model,
            "messages": _wire_messages(
                request.messages, cache_control=self.supports_cache_control
            ),
        }
        if request.temperature is not None:
            kwargs["temperature"] = request.temperature
        if request.json_response:
            kwargs["response_format"] = {"type": "json_object"}
        if request.tools:
            kwargs["tools"] = request.tools
        if request.tool_choice is not None:
            kwargs["tool_choice"] = request.tool_choice
        return kwargs

    def _native_cost(self, response: Any) -> float | None:
        return None

    def _result(self, response: Any, content: str | None, tool_calls) -> ProviderResult:
        in_tokens, out_tokens, cached = _usage_fields(getattr(response, "usage", None))
        return ProviderResult(
            content=content,
            tool_calls=tool_calls,
            in_tokens=in_tokens,
            out_tokens=out_tokens,
            cached_tokens=cached,
            cost_usd=self._native_cost(response),
            provider_call_id=getattr(response, "id", None),
        )

    async def complete(self, request: ProviderRequest) -> ProviderResult:
        response = await self._client.chat.completions.create(**self._request_kwargs(request))
        if not response.choices:  # a 200 with no choices (content filter, provider hiccup)
            raise ValueError(f"provider returned no choices (model {request.model!r})")
        message = response.choices[0].message
        tool_calls = (
            [call.model_dump() for call in message.tool_calls] if message.tool_calls else None
        )
        return self._result(response, message.content, tool_calls)

    async def stream(
        self, request: ProviderRequest, on_token: Callable[[str], None]
    ) -> ProviderResult:
        stream = await self._client.chat.completions.create(
            **self._request_kwargs(request),
            stream=True,
            stream_options={"include_usage": True},
        )
        pieces: list[str] = []
        call_id: str | None = None
        final = None
        async for chunk in stream:
            call_id = call_id or getattr(chunk, "id", None)
            if chunk.choices and chunk.choices[0].delta.content:
                pieces.append(chunk.choices[0].delta.content)
                on_token(chunk.choices[0].delta.content)
            if getattr(chunk, "usage", None) is not None:
                final = chunk
        result = self._result(final, "".join(pieces), None)
        return ProviderResult(**{**result.__dict__, "provider_call_id": call_id})

    async def lookup_cost(self, provider_call_id: str) -> float | None:
        return None

    async def aclose(self) -> None:
        """Release the pooled HTTP connections behind the OpenAI SDK client.
        Idempotent — the SDK's close() no-ops once already closed."""
        await self._client.close()


class OpenRouterAdapter(OpenAICompatAdapter):
    """OpenRouter: cost arrives response-native when asked (usage.include),
    or is looked up later via GET /generation (the deferred-cost path).
    Understands cache_control."""

    supports_cache_control = True

    def __init__(
        self,
        settings: LlmSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,  # injectable (TESTING.md)
    ) -> None:
        super().__init__(settings)
        self._base_url = settings.llm_base_url.rstrip("/")
        self._api_key = settings.llm_api_key
        self._transport = transport

    def _request_kwargs(self, request: ProviderRequest) -> dict[str, Any]:
        kwargs = super()._request_kwargs(request)
        kwargs["extra_body"] = {"usage": {"include": True}}
        return kwargs

    def _native_cost(self, response: Any) -> float | None:
        usage = getattr(response, "usage", None)
        cost = getattr(usage, "cost", None) if usage is not None else None
        # openai SDK parses unknown fields into model_extra
        if cost is None and usage is not None:
            cost = (getattr(usage, "model_extra", None) or {}).get("cost")
        return float(cost) if cost is not None else None

    async def lookup_cost(self, provider_call_id: str) -> float | None:
        try:
            async with httpx.AsyncClient(timeout=10.0, transport=self._transport) as client:
                response = await client.get(
                    f"{self._base_url}/generation",
                    params={"id": provider_call_id},
                    headers={"authorization": f"Bearer {self._api_key}"},
                )
        except httpx.HTTPError:
            return None  # backfill is best-effort — an outage retries next sweep
        if response.is_error:
            return None
        cost = response.json().get("data", {}).get("total_cost")
        return float(cost) if cost is not None else None

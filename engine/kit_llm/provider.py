"""ProviderPort — the seam between the chain walk and any model vendor.
Adapters translate the neutral core request (plain messages, a `cache` flag,
response mode, tools, and forced tool choice) into provider syntax.
``response_schema`` carries the StrictSchema transport's wire schema (always a
projected/audited portable schema — the client never sends an unprojected
Pydantic schema) and stays open for adapter conformance and research.
Cost comes back response-native when the provider offers it, else None — the
client's cost pipeline (static prices → deferred backfill) takes over from
there.

The SDK is constructed with max_retries=0: the chain walk owns retry
semantics, and hidden SDK retries would both mask failures and multiply
per-model timeouts."""

from collections.abc import Callable
from dataclasses import dataclass
import math
from typing import Any, Protocol

import httpx
from openai import AsyncOpenAI

from kit_llm._contract import TOKEN_COUNT_MAX
from kit_llm.config import LlmSettings


class ProviderInvariantError(Exception):
    """A local provider-port invariant failed before a usable model result.

    Unlike transport/provider failures, these errors are fatal to the logical
    call: retrying another model would hide a broken adapter, replay, or test
    apparatus contract. Implementations may raise this marker to bypass normal
    provider fallback while preserving their concrete exception type.
    """


class ProviderResultError(ProviderInvariantError, ValueError):
    """A provider adapter produced an unusable result value.

    This is a local port-contract failure, not evidence that another model
    should be tried. The client records the physical call, closes the logical
    run as a client error, and does not silently fall back.
    """


@dataclass(frozen=True)
class ProviderRequest:
    role: str  # metadata: mock keying, provider attribution headers
    model: str
    messages: list[dict[str, Any]]  # neutral; per-message `cache: True` flag
    temperature: float | None = None
    json_response: bool = False
    response_schema: dict[str, Any] | None = None
    max_output_tokens: int | None = None
    tools: list[dict[str, Any]] | None = None  # OpenAI tool defs (agentic P2)
    tool_choice: dict[str, Any] | str | None = None
    reasoning: dict[str, Any] | None = None  # provider reasoning field (wire form)

    def __post_init__(self) -> None:
        if self.tool_choice is not None and not self.tools:
            raise ValueError("tool_choice requires at least one tool definition")
        if self.max_output_tokens is not None and (
            isinstance(self.max_output_tokens, bool)
            or not isinstance(self.max_output_tokens, int)
            or self.max_output_tokens <= 0
        ):
            raise ValueError("max_output_tokens must be a positive integer or None")
        if self.reasoning is not None and not isinstance(self.reasoning, dict):
            raise ValueError("reasoning must be a dict (provider wire form) or None")


@dataclass(frozen=True)
class ProviderResult:
    content: str | None
    tool_calls: list[dict[str, Any]] | None
    in_tokens: int | None
    out_tokens: int | None
    cached_tokens: int | None
    cost_usd: float | None  # response-native only; None = later stages
    provider_call_id: str | None
    actual_model: str | None = None
    provider: str | None = None
    finish_reason: str | None = None
    refusal: str | None = None
    reasoning: Any = None

    def __post_init__(self) -> None:
        if self.content is not None and not isinstance(self.content, str):
            raise ProviderResultError("content must be a string or None")
        if self.tool_calls is not None and (
            not isinstance(self.tool_calls, list)
            or any(not isinstance(call, dict) for call in self.tool_calls)
        ):
            raise ProviderResultError("tool_calls must be a list of dictionaries or None")
        if self.tool_calls is not None:
            for index, call in enumerate(self.tool_calls):
                call_id = call.get("id")
                function = call.get("function")
                if not isinstance(call_id, str) or not call_id:
                    raise ProviderResultError(f"tool_calls[{index}].id must be a non-empty string")
                if call.get("type") != "function":
                    raise ProviderResultError(f"tool_calls[{index}].type must be 'function'")
                if not isinstance(function, dict):
                    raise ProviderResultError(f"tool_calls[{index}].function must be a dictionary")
                if not isinstance(function.get("name"), str) or not function["name"]:
                    raise ProviderResultError(
                        f"tool_calls[{index}].function.name must be a non-empty string"
                    )
                if not isinstance(function.get("arguments"), str):
                    raise ProviderResultError(
                        f"tool_calls[{index}].function.arguments must be a string"
                    )
        for field in ("in_tokens", "out_tokens", "cached_tokens"):
            value = getattr(self, field)
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, int)
                or value < 0
                or value > TOKEN_COUNT_MAX
            ):
                raise ProviderResultError(f"{field} must be a non-negative JS-safe integer or None")
        if self.cost_usd is not None:
            object.__setattr__(
                self,
                "cost_usd",
                _validated_cost(self.cost_usd, field="cost_usd"),
            )
        for field in (
            "provider_call_id",
            "actual_model",
            "provider",
            "finish_reason",
            "refusal",
        ):
            value = getattr(self, field)
            if value is not None and not isinstance(value, str):
                raise ProviderResultError(f"{field} must be a string or None")


class ProviderResponseError(ValueError):
    """A valid provider response envelope had no usable completion choice.

    ``result`` preserves response-level billing and attribution so the client
    can capture the paid failure before advancing its fallback chain.
    """

    def __init__(self, message: str, result: ProviderResult) -> None:
        super().__init__(message)
        self.result = result


def _validated_cost(value: Any, *, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProviderResultError(f"{field} must be a finite non-negative number or None")
    try:
        normalized = float(value)
    except OverflowError as error:
        raise ProviderResultError(
            f"{field} must be a finite non-negative number or None"
        ) from error
    if not math.isfinite(normalized) or normalized < 0:
        raise ProviderResultError(f"{field} must be a finite non-negative number or None")
    return normalized


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


def _wire_messages(messages: list[dict[str, Any]], *, cache_control: bool) -> list[dict[str, Any]]:
    """Neutral → OpenAI wire form. The `cache` flag either becomes an
    ephemeral cache_control content block (providers that price cached
    prefixes) or is dropped (providers without the concept)."""
    wire = []
    for message in messages:
        clean = {k: v for k, v in message.items() if k != "cache"}
        # only plain-string content can be wrapped; structured content
        # (a list of blocks) wrapped here would produce an invalid wire
        # body ({"text": [...]}) and a provider 400
        if message.get("cache") and cache_control and isinstance(message.get("content"), str):
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
    """Adapter for the exercised OpenAI chat-completions subset.

    Endpoint labels do not prove conformance; run the adapter suite for each
    route. Reports tokens but never native cost, so static ModelSpec prices or
    later policy apply. No cache_control (the neutral flag is dropped).
    """

    supports_cache_control = False

    def __init__(
        self,
        settings: LlmSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http_client: httpx.AsyncClient | None = None
        self._extra_http_clients: list[httpx.AsyncClient] = []
        self._closed = False
        client_options: dict[str, Any] = {}
        if transport is not None:
            self._http_client = httpx.AsyncClient(transport=transport)
            client_options["http_client"] = self._http_client
        self._client = AsyncOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key or "unused",
            max_retries=0,
            **client_options,
        )

    def _request_kwargs(self, request: ProviderRequest) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": request.model,
            "messages": _wire_messages(request.messages, cache_control=self.supports_cache_control),
        }
        if request.temperature is not None:
            kwargs["temperature"] = request.temperature
        if request.max_output_tokens is not None:
            kwargs["max_tokens"] = request.max_output_tokens
        if request.response_schema is not None:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": request.role,
                    "strict": True,
                    "schema": request.response_schema,
                },
            }
        elif request.json_response:
            kwargs["response_format"] = {"type": "json_object"}
        if request.tools:
            kwargs["tools"] = request.tools
        if request.tool_choice is not None:
            kwargs["tool_choice"] = request.tool_choice
        extra_body = self._extra_body(request)
        if extra_body:
            kwargs["extra_body"] = extra_body
        return kwargs

    def _extra_body(self, request: ProviderRequest) -> dict[str, Any]:
        """Provider-specific body fields the OpenAI chat schema does not name.
        The reasoning knob rides here (non-standard on plain OpenAI-compat, so
        routes that do not understand it ignore or reject it — a request intent)."""
        extra: dict[str, Any] = {}
        if request.reasoning is not None:
            extra["reasoning"] = request.reasoning
        return extra

    def _native_cost(self, response: Any) -> float | None:
        return None

    def _result(
        self,
        response: Any,
        content: str | None,
        tool_calls,
        *,
        finish_reason: str | None = None,
        refusal: str | None = None,
        reasoning: Any = None,
    ) -> ProviderResult:
        in_tokens, out_tokens, cached = _usage_fields(getattr(response, "usage", None))
        extra = getattr(response, "model_extra", None) or {}
        return ProviderResult(
            content=content,
            tool_calls=tool_calls,
            in_tokens=in_tokens,
            out_tokens=out_tokens,
            cached_tokens=cached,
            cost_usd=self._native_cost(response),
            provider_call_id=getattr(response, "id", None),
            actual_model=getattr(response, "model", None),
            provider=extra.get("provider"),
            finish_reason=finish_reason,
            refusal=refusal,
            reasoning=reasoning,
        )

    async def complete(self, request: ProviderRequest) -> ProviderResult:
        response = await self._client.chat.completions.create(**self._request_kwargs(request))
        if not response.choices:  # a 200 with no choices (content filter, provider hiccup)
            error = (getattr(response, "model_extra", None) or {}).get("error")
            detail = error.get("message") if isinstance(error, dict) else error
            raise ProviderResponseError(
                (
                    f"provider returned no choices (model {request.model!r})"
                    + (f": {detail}" if detail else "")
                ),
                self._result(response, None, None),
            )
        choice = response.choices[0]
        message = choice.message
        tool_calls = (
            [call.model_dump() for call in message.tool_calls] if message.tool_calls else None
        )
        message_extra = getattr(message, "model_extra", None) or {}
        return self._result(
            response,
            message.content,
            tool_calls,
            finish_reason=getattr(choice, "finish_reason", None),
            refusal=getattr(message, "refusal", None),
            reasoning=message_extra.get("reasoning_details", message_extra.get("reasoning")),
        )

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
        finish_reason: str | None = None
        refusal: str | None = None
        saw_choice = False
        try:
            async for chunk in stream:
                call_id = call_id or getattr(chunk, "id", None)
                if chunk.choices:
                    saw_choice = True
                    choice = chunk.choices[0]
                    delta = choice.delta
                    if delta is not None and delta.content:
                        pieces.append(delta.content)
                        on_token(delta.content)
                    finish_reason = getattr(choice, "finish_reason", None) or finish_reason
                    delta_refusal = getattr(delta, "refusal", None) if delta is not None else None
                    refusal = delta_refusal or refusal
                if getattr(chunk, "usage", None) is not None:
                    final = chunk
        finally:
            # a per-attempt timeout or an on_token failure cancels this
            # coroutine mid-iteration — without close() the abandoned SSE
            # response holds its pooled connection until GC
            await stream.close()
        if not saw_choice:
            # mirror complete(): a stream carrying no choices at all is a
            # provider failure, not empty (billed-repair-bait) output
            error = (getattr(final, "model_extra", None) or {}).get("error") if final else None
            detail = error.get("message") if isinstance(error, dict) else error
            raise ProviderResponseError(
                (
                    f"provider streamed no choices (model {request.model!r})"
                    + (f": {detail}" if detail else "")
                ),
                self._result(final, None, None),
            )
        result = self._result(
            final, "".join(pieces), None, finish_reason=finish_reason, refusal=refusal
        )
        return ProviderResult(**{**result.__dict__, "provider_call_id": call_id})

    async def lookup_cost(self, provider_call_id: str) -> float | None:
        return None

    async def aclose(self) -> None:
        """Release the pooled HTTP connections behind the OpenAI SDK client.
        Idempotent — every adapter-owned transport is closed exactly once."""
        if self._closed:
            return
        self._closed = True
        try:
            await self._client.close()
        finally:
            for client in self._extra_http_clients:
                await client.aclose()


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
        super().__init__(settings, transport=transport)
        self._base_url = settings.llm_base_url.rstrip("/")
        self._api_key = settings.llm_api_key
        if self._http_client is None:
            self._lookup_client = httpx.AsyncClient(timeout=10.0)
            self._extra_http_clients.append(self._lookup_client)
        else:
            # One injected client owns the one injected transport. A lookup
            # must not create-and-close a second client around that transport:
            # doing so makes the next completion fail with "client closed".
            self._lookup_client = self._http_client

    def _extra_body(self, request: ProviderRequest) -> dict[str, Any]:
        extra = super()._extra_body(request)  # carries reasoning when set
        extra["usage"] = {"include": True}
        if request.response_schema is not None:
            extra["provider"] = {"require_parameters": True}
        return extra

    def _native_cost(self, response: Any) -> float | None:
        usage = getattr(response, "usage", None)
        cost = getattr(usage, "cost", None) if usage is not None else None
        # openai SDK parses unknown fields into model_extra
        if cost is None and usage is not None:
            cost = (getattr(usage, "model_extra", None) or {}).get("cost")
        return cost

    async def lookup_cost(self, provider_call_id: str) -> float | None:
        try:
            response = await self._lookup_client.get(
                f"{self._base_url}/generation",
                params={"id": provider_call_id},
                headers={"authorization": f"Bearer {self._api_key}"},
                timeout=10.0,
            )
        except httpx.HTTPError:
            return None  # backfill is best-effort — an outage retries next sweep
        if response.is_error:
            return None
        cost = response.json().get("data", {}).get("total_cost")
        return _validated_cost(cost, field="deferred cost") if cost is not None else None

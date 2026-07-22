"""Deterministic provider replay through two substitutable boundaries.

``ReplayProvider`` drives chain logic directly. ``ReplayTransport`` sends the
same golden exchange through the real OpenAI SDK and Kit adapter. Comparing
their normalized observations proves the cheap direct seam still represents
the shipped adapter seam; neither class makes recovery decisions. Replays are
completion-only, stateful, queryless, and ordered FIFO for one logical
consumer. They are not a concurrent or broadcast event source.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal, cast

import httpx
from openai import APIStatusError

from kit_llm.bench.golden import FrozenJson, GoldenEntry
from kit_llm.provider import (
    ProviderInvariantError,
    ProviderPort,
    ProviderRequest,
    ProviderResponseError,
    ProviderResult,
)


class ReplayError(ProviderInvariantError, ValueError):
    """Base class for malformed or incorrectly consumed replays."""


class ReplayMismatch(ReplayError):
    """The observed request does not match the next frozen exchange."""


class ReplayUnconsumed(ReplayError):
    """A replay ended with expected exchanges still queued."""


class ReplayStreamingUnsupported(ReplayError):
    """A completion JSON exchange cannot stand in for an SSE stream."""


class ReplayProviderFailure(Exception):
    def __init__(self, kind: str, status: int | None) -> None:
        super().__init__(kind)
        self.kind = kind
        self.status = status


@dataclass(frozen=True)
class ProviderFailureObservation:
    kind: str
    http_status: int | None


@dataclass(frozen=True)
class ProviderObservation:
    outcome: Literal["result", "failure"]
    result: ProviderResult | None = None
    failure: ProviderFailureObservation | None = None


@dataclass(frozen=True)
class ProviderExchange:
    id: str
    request_method: str
    request_path: str
    request_body: Mapping[str, Any]
    response_status: int
    response_body: Mapping[str, Any]
    expected: Mapping[str, Any]

    def __post_init__(self) -> None:
        if (
            not isinstance(self.request_method, str)
            or not self.request_method
            or self.request_method != self.request_method.upper()
        ):
            raise ReplayError("request_method must be a non-empty uppercase method")
        if (
            not isinstance(self.request_path, str)
            or not self.request_path.startswith("/")
            or "?" in self.request_path
            or "#" in self.request_path
        ):
            raise ReplayError("request_path must be an absolute queryless path")
        if type(self.response_status) is not int or not _supported_response_status(
            self.response_status
        ):
            raise ReplayError(
                "response_status must be 2xx, 4xx, or 5xx; "
                "informational and redirect fixtures are not replayable"
            )
        for name in ("request_body", "response_body", "expected"):
            frozen = _freeze_json(getattr(self, name), path=name, active_containers=set())
            if not isinstance(frozen, Mapping):
                raise ReplayError(f"{name} must be a JSON object")
            object.__setattr__(self, name, frozen)

    @classmethod
    def from_golden(cls, entry: GoldenEntry) -> "ProviderExchange":
        if entry.layer != "exchange":
            raise ReplayError(f"golden {entry.id!r} is not an exchange")
        payload = cast(dict[str, Any], _thaw(entry.payload))
        request = payload["request"]
        response = payload["response"]
        expected = payload["expected"]
        if not isinstance(request, Mapping) or set(request) != {"method", "path", "body"}:
            raise ReplayError(f"golden {entry.id!r} has an invalid request envelope")
        if not isinstance(response, Mapping) or set(response) != {"status", "body"}:
            raise ReplayError(f"golden {entry.id!r} has an invalid response envelope")
        if not isinstance(expected, Mapping):
            raise ReplayError(f"golden {entry.id!r} has invalid expected observations")
        method, path = request["method"], request["path"]
        status, request_body, response_body = response["status"], request["body"], response["body"]
        if (
            not isinstance(method, str)
            or not isinstance(path, str)
            or not path.startswith("/")
            or not isinstance(status, int)
            or isinstance(status, bool)
            or not _supported_response_status(status)
            or not isinstance(request_body, Mapping)
            or not isinstance(response_body, Mapping)
        ):
            raise ReplayError(f"golden {entry.id!r} has invalid exchange field types")
        return cls(
            id=entry.id,
            request_method=method.upper(),
            request_path=path,
            request_body=request_body,
            response_status=status,
            response_body=response_body,
            expected=expected,
        )

    def request_body_copy(self) -> dict[str, Any]:
        """Return mutable JSON without exposing the frozen replay fixture."""
        return cast(dict[str, Any], _thaw(self.request_body))

    def response_body_copy(self) -> dict[str, Any]:
        return cast(dict[str, Any], _thaw(self.response_body))

    def expected_copy(self) -> dict[str, Any]:
        return cast(dict[str, Any], _thaw(self.expected))


class _ExchangeQueue:
    """One-consumer, ordered FIFO; mismatches never advance the cursor."""

    def __init__(self, exchanges: Iterable[ProviderExchange]) -> None:
        self._remaining = list(exchanges)

    def peek(self) -> ProviderExchange:
        if not self._remaining:
            raise ReplayMismatch("unexpected request: no replay exchange remains")
        return self._remaining[0]

    def consume(self, exchange: ProviderExchange) -> None:
        if not self._remaining or self._remaining[0] is not exchange:
            raise ReplayError("replay exchange queue changed during request matching")
        self._remaining.pop(0)

    def assert_consumed(self) -> None:
        if self._remaining:
            ids = [exchange.id for exchange in self._remaining]
            raise ReplayUnconsumed(f"unconsumed replay exchanges: {ids}")


class ReplayProvider(ProviderPort):
    """Direct completion-only ProviderPort over a single-consumer FIFO."""

    def __init__(self, exchanges: Iterable[ProviderExchange]) -> None:
        self._queue = _ExchangeQueue(exchanges)
        self.closed = False

    async def complete(self, request: ProviderRequest) -> ProviderResult:
        exchange = self._queue.peek()
        _match_request(_neutral_wire_body(request), exchange.request_body, exchange.id)
        self._queue.consume(exchange)
        return _provider_result(exchange)

    async def stream(
        self, request: ProviderRequest, on_token: Callable[[str], None]
    ) -> ProviderResult:
        raise ReplayStreamingUnsupported(
            "completion JSON cannot replay streaming; provide a versioned SSE exchange"
        )

    async def lookup_cost(self, provider_call_id: str) -> float | None:
        return None

    async def aclose(self) -> None:
        self.closed = True

    def assert_consumed(self) -> None:
        self._queue.assert_consumed()


class ReplayTransport(httpx.AsyncBaseTransport):
    """Queryless completion HTTP replay over a single-consumer FIFO."""

    def __init__(self, exchanges: Iterable[ProviderExchange]) -> None:
        self._queue = _ExchangeQueue(exchanges)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        exchange = self._queue.peek()
        if request.method != exchange.request_method or request.url.path != exchange.request_path:
            raise ReplayMismatch(
                f"exchange {exchange.id!r} expected {exchange.request_method} "
                f"{exchange.request_path}, got {request.method} {request.url.path}"
            )
        if request.url.query:
            raise ReplayMismatch(
                f"exchange {exchange.id!r} does not permit request query parameters"
            )
        try:
            actual_body = _strict_object(request.content)
        except (UnicodeError, ValueError) as error:
            raise ReplayMismatch(
                f"exchange {exchange.id!r} request is not JSON: {error}"
            ) from error
        _match_request(actual_body, exchange.request_body, exchange.id)
        self._queue.consume(exchange)
        return httpx.Response(
            exchange.response_status,
            json=_thaw(exchange.response_body),
            request=request,
        )

    def assert_consumed(self) -> None:
        self._queue.assert_consumed()


async def observe_provider(provider: ProviderPort, request: ProviderRequest) -> ProviderObservation:
    """Normalize adapter-specific failures while preserving every result field."""
    try:
        result = await provider.complete(request)
    except ReplayError:
        raise
    except ReplayProviderFailure as error:
        return ProviderObservation(
            outcome="failure",
            failure=ProviderFailureObservation(error.kind, error.status),
        )
    except APIStatusError as error:
        return ProviderObservation(
            outcome="failure",
            failure=ProviderFailureObservation(
                _classify_provider_error(error.body), error.status_code
            ),
        )
    except ProviderResponseError:
        # the typed no-choices class — never classified by message text
        # (CONVENTIONS.md: never branch on error message text)
        return ProviderObservation(
            outcome="failure", failure=ProviderFailureObservation("provider_error", None)
        )
    except ValueError:
        return ProviderObservation(
            outcome="failure", failure=ProviderFailureObservation("provider_protocol_error", None)
        )
    return ProviderObservation(outcome="result", result=result)


def _neutral_wire_body(request: ProviderRequest) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": request.model,
        "messages": [
            {key: value for key, value in message.items() if key != "cache"}
            for message in request.messages
        ],
    }
    if request.temperature is not None:
        body["temperature"] = request.temperature
    if request.max_output_tokens is not None:
        body["max_tokens"] = request.max_output_tokens
    if request.response_schema is not None:
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": request.role,
                "strict": True,
                "schema": request.response_schema,
            },
        }
    elif request.json_response:
        body["response_format"] = {"type": "json_object"}
    if request.tools:
        body["tools"] = request.tools
    if request.tool_choice is not None:
        body["tool_choice"] = request.tool_choice
    if request.reasoning is not None:
        # mirror the real adapter's extra_body — the two replay seams must
        # stay equivalent for reasoning-bearing requests
        body["reasoning"] = request.reasoning
    return body


def _provider_result(exchange: ProviderExchange) -> ProviderResult:
    body = exchange.response_body
    choices = body.get("choices")
    if _is_success_status(exchange.response_status) and (
        not isinstance(choices, (list, tuple)) or not choices
    ):
        raise ProviderResponseError(
            f"provider returned no choices in replay exchange {exchange.id!r}",
            _partial_provider_result(exchange),
        )
    if not _is_success_status(exchange.response_status):
        failure = exchange.expected.get("failure")
        kind = (
            failure if failure in {"unsupported_contract", "provider_error"} else "provider_error"
        )
        raise ReplayProviderFailure(str(kind), exchange.response_status)
    choice = cast(list[Any] | tuple[Any, ...], choices)[0]
    if not isinstance(choice, Mapping):
        raise ReplayError(f"exchange {exchange.id!r} choice must be an object")
    message = choice.get("message")
    if not isinstance(message, Mapping):
        raise ReplayError(f"exchange {exchange.id!r} message must be an object")
    raw_usage = body.get("usage")
    usage: Mapping[str, Any] = raw_usage if isinstance(raw_usage, Mapping) else {}
    raw_details = usage.get("prompt_tokens_details")
    details: Mapping[str, Any] = raw_details if isinstance(raw_details, Mapping) else {}
    raw_tool_calls = message.get("tool_calls")
    tool_calls = (
        [_adapter_tool_call(call, exchange.id) for call in raw_tool_calls]
        if isinstance(raw_tool_calls, (list, tuple))
        else None
    )
    return ProviderResult(
        content=message.get("content") if isinstance(message.get("content"), str) else None,
        tool_calls=tool_calls,
        in_tokens=usage.get("prompt_tokens")
        if isinstance(usage.get("prompt_tokens"), int)
        else None,
        out_tokens=(
            usage.get("completion_tokens")
            if isinstance(usage.get("completion_tokens"), int)
            else None
        ),
        cached_tokens=(
            details.get("cached_tokens") if isinstance(details.get("cached_tokens"), int) else None
        ),
        cost_usd=(
            float(usage["cost"])
            if exchange.expected.get("adapter") == "openrouter"
            and isinstance(usage.get("cost"), (int, float))
            else None
        ),
        provider_call_id=body.get("id") if isinstance(body.get("id"), str) else None,
        actual_model=body.get("model") if isinstance(body.get("model"), str) else None,
        provider=body.get("provider") if isinstance(body.get("provider"), str) else None,
        finish_reason=(
            choice.get("finish_reason") if isinstance(choice.get("finish_reason"), str) else None
        ),
        refusal=message.get("refusal") if isinstance(message.get("refusal"), str) else None,
        reasoning=_thaw(message.get("reasoning_details", message.get("reasoning"))),
    )


def _partial_provider_result(exchange: ProviderExchange) -> ProviderResult:
    """Preserve envelope-level usage and attribution when no choice exists."""
    body = exchange.response_body
    raw_usage = body.get("usage")
    usage: Mapping[str, Any] = raw_usage if isinstance(raw_usage, Mapping) else {}
    raw_details = usage.get("prompt_tokens_details")
    details: Mapping[str, Any] = raw_details if isinstance(raw_details, Mapping) else {}
    return ProviderResult(
        content=None,
        tool_calls=None,
        in_tokens=(
            usage.get("prompt_tokens") if isinstance(usage.get("prompt_tokens"), int) else None
        ),
        out_tokens=(
            usage.get("completion_tokens")
            if isinstance(usage.get("completion_tokens"), int)
            else None
        ),
        cached_tokens=(
            details.get("cached_tokens") if isinstance(details.get("cached_tokens"), int) else None
        ),
        cost_usd=(
            float(usage["cost"])
            if exchange.expected.get("adapter") == "openrouter"
            and isinstance(usage.get("cost"), (int, float))
            else None
        ),
        provider_call_id=body.get("id") if isinstance(body.get("id"), str) else None,
        actual_model=body.get("model") if isinstance(body.get("model"), str) else None,
        provider=body.get("provider") if isinstance(body.get("provider"), str) else None,
    )


def _adapter_tool_call(value: Any, exchange_id: str) -> dict[str, Any]:
    """Mirror the OpenAI SDK model_dump shape used by the real adapter."""
    if not isinstance(value, Mapping):
        raise ReplayError(f"exchange {exchange_id!r} tool call must be an object")
    normalized = cast(dict[str, Any], _thaw(value))
    normalized.setdefault("id", None)
    return normalized


_ALLOWED_REQUEST_EXTRAS = frozenset(
    {
        "$.model",
        "$.messages",
        "$.usage",
        "$.response_format.json_schema.name",
    }
)


def _match_request(actual: Any, expected: Any, exchange_id: str) -> None:
    _match_subset(
        actual,
        expected,
        exchange_id,
        allowed_extras=_ALLOWED_REQUEST_EXTRAS,
    )


def _match_subset(
    actual: Any,
    expected: Any,
    exchange_id: str,
    path: str = "$",
    *,
    allowed_extras: frozenset[str] = frozenset(),
) -> None:
    if isinstance(expected, Mapping):
        if not isinstance(actual, Mapping):
            raise ReplayMismatch(f"exchange {exchange_id!r} expected object at {path}")
        missing = set(expected) - set(actual)
        if missing:
            raise ReplayMismatch(
                f"exchange {exchange_id!r} missing request keys at {path}: {sorted(missing)}"
            )
        unexpected = {
            key for key in set(actual) - set(expected) if f"{path}.{key}" not in allowed_extras
        }
        if unexpected:
            raise ReplayMismatch(
                f"exchange {exchange_id!r} unexpected request keys at {path}: {sorted(unexpected)}"
            )
        for key, value in expected.items():
            _match_subset(
                actual[key],
                value,
                exchange_id,
                f"{path}.{key}",
                allowed_extras=allowed_extras,
            )
        return
    if isinstance(expected, (list, tuple)):
        if not isinstance(actual, (list, tuple)) or len(actual) != len(expected):
            raise ReplayMismatch(f"exchange {exchange_id!r} list mismatch at {path}")
        for index, value in enumerate(expected):
            _match_subset(
                actual[index],
                value,
                exchange_id,
                f"{path}[{index}]",
                allowed_extras=allowed_extras,
            )
        return
    if type(actual) is not type(expected):
        raise ReplayMismatch(
            f"exchange {exchange_id!r} type mismatch at {path}: "
            f"expected {type(expected).__name__}, got {type(actual).__name__}"
        )
    if actual != expected:
        raise ReplayMismatch(
            f"exchange {exchange_id!r} value mismatch at {path}: "
            f"expected {expected!r}, got {actual!r}"
        )


def _strict_object(raw: bytes) -> dict[str, Any]:
    def reject_duplicate(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key {key!r}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number {value!r}")

    value = json.loads(
        raw.decode("utf-8"),
        object_pairs_hook=reject_duplicate,
        parse_constant=reject_constant,
    )
    if not isinstance(value, dict):
        raise ValueError("request body must be a JSON object")
    return value


def _classify_provider_error(body: object) -> str:
    text = _flatten_text(body).lower()
    if any(
        marker in text
        for marker in (
            "schema",
            "structured output",
            "structured_output",
            "response_format",
            "every property must appear in required",
            "additionalproperties",
            "oneof",
            "maxitems",
        )
    ):
        return "unsupported_contract"
    return "provider_error"


def _flatten_text(value: object) -> str:
    if isinstance(value, Mapping):
        return " ".join(_flatten_text(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return " ".join(_flatten_text(item) for item in value)
    return str(value)


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(child) for key, child in value.items()}
    if isinstance(value, tuple):
        return [_thaw(child) for child in value]
    return value


def _freeze_json(
    value: Any,
    *,
    path: str,
    active_containers: set[int],
) -> FrozenJson:
    if value is None or type(value) in {bool, int, str}:
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise ReplayError(f"{path} contains a non-finite number")
        return value
    if isinstance(value, Mapping):
        marker = id(value)
        if marker in active_containers:
            raise ReplayError(f"{path} contains a cyclic JSON container")
        active_containers.add(marker)
        frozen: dict[str, FrozenJson] = {}
        try:
            for key, child in value.items():
                if not isinstance(key, str):
                    raise ReplayError(f"{path} contains a non-string object key")
                frozen[key] = _freeze_json(
                    child,
                    path=f"{path}.{key}",
                    active_containers=active_containers,
                )
            return MappingProxyType(frozen)
        finally:
            active_containers.remove(marker)
    if isinstance(value, (list, tuple)):
        marker = id(value)
        if marker in active_containers:
            raise ReplayError(f"{path} contains a cyclic JSON container")
        active_containers.add(marker)
        try:
            return tuple(
                _freeze_json(
                    child,
                    path=f"{path}[{index}]",
                    active_containers=active_containers,
                )
                for index, child in enumerate(value)
            )
        finally:
            active_containers.remove(marker)
    raise ReplayError(f"{path} contains unsupported JSON value {type(value).__name__}")


def _is_success_status(status: int) -> bool:
    return 200 <= status <= 299


def _supported_response_status(status: int) -> bool:
    return _is_success_status(status) or 400 <= status <= 599

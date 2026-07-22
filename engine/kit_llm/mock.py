"""ScriptedLlm — THE test seam, implemented AS a ProviderPort adapter so
tests exercise the real chain walk, real capture, real spend against
deterministic outputs (TESTING.md: the mock stands behind the real
boundary). Exported as an app testing utility.

Scripts are keyed by ROLE; each role holds a sequence of steps handed
out in order, the last repeating forever — a one-item sequence IS a
canned answer, a multi-item sequence scripts an agentic loop. A step
may be: a str (raw content), a pydantic instance (serialized to JSON so it
round-trips through the caller's parser), a ToolCallStep (agentic, P2), or an
Exception instance (raised — scripts transport failures)."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel

from kit_llm.provider import ProviderRequest, ProviderResult


@dataclass(frozen=True)
class ToolCallStep:
    """The model 'asks' for tool executions instead of answering."""

    calls: list[tuple[str, dict[str, Any]]]  # (tool name, arguments)


Step = str | BaseModel | ToolCallStep | Exception


@dataclass
class ScriptedLlm:
    scripts: dict[str, list[Step]]
    in_tokens: int = 10
    out_tokens: int = 5
    cost_usd: float | None = 0.0
    _cursors: dict[str, int] = field(default_factory=dict)
    _calls: int = 0

    def _next(self, role: str) -> Step:
        sequence = self.scripts.get(role)
        if not sequence:
            raise AssertionError(f"ScriptedLlm has no script for role {role!r}")
        index = self._cursors.get(role, 0)
        self._cursors[role] = index + 1
        return sequence[min(index, len(sequence) - 1)]

    def _result(self, step: Step, request: ProviderRequest) -> ProviderResult:
        self._calls += 1
        if isinstance(step, Exception):
            raise step
        content: str | None = None
        tool_calls: list[dict[str, Any]] | None = None
        if isinstance(step, ToolCallStep):
            tool_calls = [
                {
                    "id": f"scripted-tc-{self._calls}-{i}",
                    "type": "function",
                    "function": {"name": name, "arguments": _json(arguments)},
                }
                for i, (name, arguments) in enumerate(step.calls)
            ]
        elif isinstance(step, BaseModel):
            content = step.model_dump_json()
        else:
            content = step
        return ProviderResult(
            content=content,
            tool_calls=tool_calls,
            in_tokens=self.in_tokens,
            out_tokens=self.out_tokens,
            cached_tokens=0,
            cost_usd=self.cost_usd,
            provider_call_id=f"scripted-{self._calls}",
        )

    async def complete(self, request: ProviderRequest) -> ProviderResult:
        return self._result(self._next(request.role), request)

    async def stream(
        self, request: ProviderRequest, on_token: Callable[[str], None]
    ) -> ProviderResult:
        result = self._result(self._next(request.role), request)
        if result.content:
            for piece in result.content.split(" "):
                on_token(piece + " ")
        return result

    async def lookup_cost(self, provider_call_id: str) -> float | None:
        return self.cost_usd

    async def aclose(self) -> None:
        return None  # nothing to release — the scripts are in memory


def _json(value: dict[str, Any]) -> str:
    import json

    return json.dumps(value, separators=(",", ":"))

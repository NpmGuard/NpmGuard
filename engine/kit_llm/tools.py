"""Tools and the agentic loop's dispatch half. A Tool is a name + a
pydantic params schema + an async handler. Arguments are validated
against the schema BEFORE the handler runs — a hallucinated-shape call
never reaches app code. The loop itself lives in client.run_agent; this
module owns tool definition, the OpenAI tool-def shape, and dispatch."""

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError

ToolHandler = Callable[[Any], Awaitable[Any]]


@dataclass(frozen=True)
class Tool:
    name: str
    params: type[BaseModel]
    handler: ToolHandler
    description: str = ""

    def definition(self) -> dict[str, Any]:
        """The OpenAI function-tool definition sent to the provider."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.params.model_json_schema(),
            },
        }


class ToolRegistry:
    def __init__(self, tools: tuple[Tool, ...]) -> None:
        self._by_name = {tool.name: tool for tool in tools}
        if len(self._by_name) != len(tools):
            raise ValueError("duplicate tool names")

    @property
    def definitions(self) -> list[dict[str, Any]]:
        return [tool.definition() for tool in self._by_name.values()]

    async def dispatch(self, name: str, raw_arguments: str) -> Any:
        """Validate the model's arguments against the tool's schema, then
        run the handler. An unknown tool or invalid arguments raises
        ToolCallError — surfaced back to the MODEL as a tool result so it
        can correct itself, never crashing the run."""
        tool = self._by_name.get(name)
        if tool is None:
            raise ToolCallError(f"no such tool {name!r}")
        try:
            parsed = tool.params.model_validate_json(raw_arguments or "{}")
        except ValidationError as error:
            raise ToolCallError(f"invalid arguments for {name!r}: {error}") from error
        return await tool.handler(parsed)


class ToolCallError(Exception):
    """A tool call the model got wrong (unknown tool / bad args). Fed back
    into the transcript as the tool's result — the model's problem to fix,
    not the run's to die on."""


def tool_result_message(tool_call_id: str, result: Any) -> dict[str, Any]:
    """One tool result as an OpenAI 'tool' message. Non-string results are
    JSON-encoded so the model sees structured data."""
    content = result if isinstance(result, str) else json.dumps(result, default=str)
    return {"role": "tool", "tool_call_id": tool_call_id, "content": content}

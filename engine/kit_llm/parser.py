"""The output contract, factored transparently: the default pydantic
path is a composition of the EXPORTED pieces below, so a custom parser
composes from the same public parts instead of patching the module
(transforms open, ledgers closed)."""

import json
import re
from typing import Any

from pydantic import BaseModel

from kit_llm.config import Parser

_FENCE = re.compile(r"^```[\w-]*\n(.*?)\n?```\s*$", re.DOTALL)


def strip_code_fences(raw: str) -> str:
    """Models wrap JSON in markdown fences regardless of instructions —
    a model behavior, not a domain one, so the module owns undoing it."""
    match = _FENCE.match(raw.strip())
    return match.group(1) if match else raw


def json_object_parser_raw(raw: str) -> dict[str, Any]:
    """Fence-stripped JSON to a dict; raises ValueError on non-objects."""
    data = json.loads(strip_code_fences(raw))
    if not isinstance(data, dict):
        raise ValueError(f"expected a JSON object, got {type(data).__name__}")
    return data


def json_object_parser(model: type[BaseModel]) -> Parser:
    """The default parser sugar: fences → json → model_validate."""

    def parse(raw: str) -> BaseModel:
        return model.model_validate(json_object_parser_raw(raw))

    return parse


def as_parser(output: type[BaseModel] | Parser | None) -> tuple[Parser | None, bool]:
    """Normalize the output contract. Returns (parser, wants_json):
    a pydantic class gets the sugar AND json response mode; a custom
    parser owns its own format (no response-mode assumption); None means
    raw text passthrough."""
    if output is None:
        return None, False
    if isinstance(output, type) and issubclass(output, BaseModel):
        return json_object_parser(output), True
    return output, False

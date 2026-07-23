"""Portable strict-schema projection — the measured transform behind the
StrictSchema transport (research: schema-solutions-v1, finalists-v1,
hyp-confirm-v1).

A raw Pydantic JSON Schema is not a portable strict contract: constraint and
annotation keywords are honored inconsistently across strict provider
dialects, and open or partially-required objects are rejected outright by
some of them. The projection strips the non-portable keywords — only in
schema-object position, so a client property literally named ``pattern`` or
``format`` survives — and the audit then fails closed unless every object is
closed (``additionalProperties: false``) with every property required.
Optionality must be expressed as union-with-null, never as an omitted key."""

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel

# Constraint/annotation keywords measured as non-portable across strict
# provider dialects. Stripped only where a value is a schema object; keys
# under the named schema maps below are client property names, never keywords.
SCHEMA_KEYWORDS_STRIPPED = frozenset(
    {
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "pattern",
        "format",
        "patternProperties",
        "unevaluatedProperties",
        "examples",
        "default",
        "title",
    }
)

_NAMED_SCHEMA_MAPS = frozenset({"properties", "$defs", "definitions"})

_AUDIT_HINT = (
    "strict provider dialects require closed objects with every property "
    "required: give every field no default (express optionality as `| None`) "
    "and set model_config = ConfigDict(extra='forbid')"
)


def portable_strict_schema(output: type[BaseModel] | Mapping[str, Any]) -> dict[str, Any]:
    """Project a Pydantic model class (or a raw JSON Schema mapping) into the
    measured portable strict form. Raises ValueError with every audit
    violation when the contract cannot satisfy the strict dialect."""
    if isinstance(output, type) and issubclass(output, BaseModel):
        raw: Mapping[str, Any] = output.model_json_schema()
        origin = output.__name__
    elif isinstance(output, Mapping):
        raw = output
        origin = "schema"
    else:
        raise TypeError(
            "portable_strict_schema takes a pydantic model class or a JSON Schema mapping"
        )
    projected = _project(raw)
    errors = audit_strict_schema(projected)
    if errors:
        raise ValueError(
            f"{origin} does not project to a portable strict schema "
            f"({_AUDIT_HINT}): " + "; ".join(errors)
        )
    return projected


def audit_strict_schema(schema: Any, path: str = "$") -> list[str]:
    """Every strict-dialect structural violation, one entry per schema path."""
    errors: list[str] = []
    if isinstance(schema, list):
        for index, item in enumerate(schema):
            errors.extend(audit_strict_schema(item, f"{path}[{index}]"))
        return errors
    if not isinstance(schema, Mapping):
        return errors
    properties = schema.get("properties")
    if isinstance(properties, Mapping):
        property_names = set(properties)
        required = schema.get("required")
        if not isinstance(required, list):
            errors.append(f"{path}: object properties require a required array")
        else:
            required_names = set(required)
            if required_names != property_names:
                errors.append(
                    f"{path}: required/properties mismatch "
                    f"missing={sorted(property_names - required_names)} "
                    f"extra={sorted(required_names - property_names)}"
                )
        if schema.get("additionalProperties") is not False:
            errors.append(f"{path}: object properties require additionalProperties=false")
    for key, item in schema.items():
        if key in _NAMED_SCHEMA_MAPS and isinstance(item, Mapping):
            for client_name, client_schema in item.items():
                errors.extend(audit_strict_schema(client_schema, f"{path}.{key}.{client_name}"))
        else:
            errors.extend(audit_strict_schema(item, f"{path}.{key}"))
    return errors


def _project(value: Any) -> Any:
    if isinstance(value, list):
        return [_project(item) for item in value]
    if not isinstance(value, Mapping):
        return value
    projected: dict[str, Any] = {}
    for key, item in value.items():
        if key in SCHEMA_KEYWORDS_STRIPPED:
            continue
        if key in _NAMED_SCHEMA_MAPS and isinstance(item, Mapping):
            projected[key] = {
                client_name: _project(client_schema)
                for client_name, client_schema in item.items()
            }
        else:
            projected[key] = _project(item)
    return projected

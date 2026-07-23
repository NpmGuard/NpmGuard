"""Levers → cells. A lever whose value is a list is an AXIS; the cells are
the cross-product of every axis. Scalar levers are held constant. The cell
id names only the varying axes — so a single-axis sweep reads
`model=haiku`, not a wall of constants. `repeats` is orthogonal (the same
cell run N times) and is NOT part of the id."""

import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import Any

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class Cell:
    id: str
    levers: dict[str, Any]


def _slug(value: Any) -> str:
    rendered = (
        json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        if isinstance(value, (dict, list))
        else str(value)
    )
    return _UNSAFE.sub("-", rendered)[:48]


def _bounded_cell_id(value: str) -> str:
    if len(value) <= 180:
        return value
    digest = hashlib.sha256(value.encode()).hexdigest()[:16]
    return f"{value[:160]}--{digest}"


def _canonical(value: Any) -> str:
    _validate_json(value, path="lever value", ancestors=set())
    try:
        return json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (RecursionError, TypeError, ValueError) as error:
        raise ValueError("lever values must be finite JSON") from error


def _validate_json(value: Any, *, path: str, ancestors: set[int]) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{path} must contain only finite JSON numbers")
        return
    if isinstance(value, (dict, list)):
        marker = id(value)
        if marker in ancestors:
            raise ValueError(f"{path} contains cyclic JSON")
        ancestors.add(marker)
        try:
            if isinstance(value, dict):
                for key, child in value.items():
                    if not isinstance(key, str):
                        raise ValueError(f"{path} JSON object keys must be strings")
                    _validate_json(child, path=f"{path}.{key}", ancestors=ancestors)
            else:
                for index, child in enumerate(value):
                    _validate_json(child, path=f"{path}[{index}]", ancestors=ancestors)
        finally:
            ancestors.remove(marker)
        return
    raise ValueError(f"{path} contains unsupported JSON value {type(value).__name__}")


def _clone_json(value: Any) -> Any:
    return json.loads(_canonical(value))


def expand(levers: dict[str, Any]) -> list[Cell]:
    """Cross-product of the list-valued levers. Deterministic order:
    input key order, then each axis in its listed order."""
    if not isinstance(levers, dict):
        raise ValueError("levers must be a JSON object")
    if any(not isinstance(key, str) for key in levers):
        raise ValueError("lever names must be strings")
    frozen_levers = {key: _clone_json(value) for key, value in levers.items()}
    axes = [
        (key, value if isinstance(value, list) else [value]) for key, value in frozen_levers.items()
    ]
    for key, values in axes:
        if not values:
            raise ValueError(f"lever axis {key!r} must not be empty")
        canonical = [_canonical(value) for value in values]
        if len(canonical) != len(set(canonical)):
            raise ValueError(f"lever axis {key!r} contains duplicate values")
    varying = {key for key, values in axes if len(values) > 1}

    combos: list[dict[str, Any]] = [{}]
    for key, values in axes:
        combos = [{**combo, key: value} for combo in combos for value in values]

    planned: list[tuple[str, dict[str, Any]]] = []
    for combo in combos:
        parts = [f"{_slug(key)}={_slug(combo[key])}" for key in combos[0] if key in varying]
        base = _bounded_cell_id("__".join(parts) or "cell")
        planned.append((base, combo))

    counts: dict[str, int] = {}
    for base, _ in planned:
        counts[base] = counts.get(base, 0) + 1

    cells: list[Cell] = []
    seen_ids: set[str] = set()
    for base, combo in planned:
        if counts[base] == 1:
            cell_id = base
        else:
            digest = hashlib.sha256(_canonical(combo).encode()).hexdigest()[:12]
            cell_id = _bounded_cell_id(f"{base}~{digest}")
        if cell_id in seen_ids:
            raise ValueError("lever combinations do not produce unique stable cell ids")
        seen_ids.add(cell_id)
        cells.append(Cell(id=cell_id, levers=_clone_json(combo)))
    return cells

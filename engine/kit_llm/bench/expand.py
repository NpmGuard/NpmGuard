"""Levers → cells. A lever whose value is a list is an AXIS; the cells are
the cross-product of every axis. Scalar levers are held constant. The cell
id names only the varying axes — so a single-axis sweep reads
`model=haiku`, not a wall of constants. `repeats` is orthogonal (the same
cell run N times) and is NOT part of the id."""

import re
from dataclasses import dataclass
from typing import Any

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class Cell:
    id: str
    levers: dict[str, Any]


def _slug(value: Any) -> str:
    return _UNSAFE.sub("-", str(value))[:48]


def expand(levers: dict[str, Any]) -> list[Cell]:
    """Cross-product of the list-valued levers. Deterministic order:
    input key order, then each axis in its listed order."""
    axes = [(key, value if isinstance(value, list) else [value]) for key, value in levers.items()]
    varying = {key for key, values in axes if len(values) > 1}

    combos: list[dict[str, Any]] = [{}]
    for key, values in axes:
        combos = [{**combo, key: value} for combo in combos for value in values]

    cells: list[Cell] = []
    seen: dict[str, int] = {}
    for combo in combos:
        parts = [f"{key}={_slug(combo[key])}" for key in combos[0] if key in varying]
        base = "__".join(parts) or "cell"
        # defend against slug collisions (two values slugging identically)
        count = seen.get(base, 0)
        seen[base] = count + 1
        cell_id = base if count == 0 else f"{base}~{count}"
        cells.append(Cell(id=cell_id, levers=combo))
    return cells

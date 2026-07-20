"""Generated contract artifacts. Regenerate with `pnpm contract` — never
hand-edit models.py, contract.schema.json, or constants.json."""

import json
from importlib import resources

from kit_llm._contract.models import AttemptRecord, RunRecord, Usage

_constants = json.loads(
    (resources.files(__package__) / "constants.json").read_text(encoding="utf-8")
)
ATTEMPT_STATUSES: tuple[str, ...] = tuple(_constants["ATTEMPT_STATUSES"])
RUN_STATUSES: tuple[str, ...] = tuple(_constants["RUN_STATUSES"])

__all__ = [
    "ATTEMPT_STATUSES",
    "RUN_STATUSES",
    "AttemptRecord",
    "RunRecord",
    "Usage",
]

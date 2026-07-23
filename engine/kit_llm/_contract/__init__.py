"""Generated contract artifacts. Regenerate with `pnpm contract` — never
hand-edit models.py, contract.schema.json, or constants.json."""

import json
from importlib import resources

from kit_llm._contract.models import AttemptRecord, RunRecord, Usage

_constants = json.loads(
    (resources.files(__package__) / "constants.json").read_text(encoding="utf-8")
)
ATTEMPT_STATUSES: tuple[str, ...] = tuple(_constants["ATTEMPT_STATUSES"])
ATTEMPT_TRANSPORTS: tuple[str, ...] = tuple(_constants["ATTEMPT_TRANSPORTS"])
RUN_STATUSES: tuple[str, ...] = tuple(_constants["RUN_STATUSES"])
TOKEN_COUNT_MAX: int = _constants["TOKEN_COUNT_MAX"]

__all__ = [
    "ATTEMPT_STATUSES",
    "ATTEMPT_TRANSPORTS",
    "RUN_STATUSES",
    "TOKEN_COUNT_MAX",
    "AttemptRecord",
    "RunRecord",
    "Usage",
]

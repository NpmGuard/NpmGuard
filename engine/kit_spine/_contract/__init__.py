"""Generated contract artifacts. Regenerate with `pnpm contract` — never
hand-edit models.py, contract.schema.json, or constants.json."""

import json
from importlib import resources

from kit_spine._contract.models import ErrorResponse, EventEnvelope, KitError

_constants = json.loads(
    (resources.files(__package__) / "constants.json").read_text(encoding="utf-8")
)
ERROR_CODE_PATTERN: str = _constants["ERROR_CODE_PATTERN"]
TIMESTAMP_PATTERN: str = _constants["TIMESTAMP_PATTERN"]

__all__ = [
    "ERROR_CODE_PATTERN",
    "ErrorResponse",
    "EventEnvelope",
    "KitError",
    "TIMESTAMP_PATTERN",
]

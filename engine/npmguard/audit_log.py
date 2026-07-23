import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from .config import REPO_ROOT


def _json_value(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_none=False)
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


class AuditLog:
    def __init__(self, package_name: str) -> None:
        stamp = datetime.now(UTC).isoformat().replace(":", "-").replace(".", "-")
        safe = re.sub(r"[^a-zA-Z0-9_-]", "_", package_name)
        root = Path(os.environ.get("NPMGUARD_AUDIT_LOG_DIR") or REPO_ROOT / "audit-logs")
        self.run_dir = root / f"{stamp}_{safe}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self._counter = 0

    def write(self, name: str, data: Any) -> Path:
        self._counter += 1
        path = self.run_dir / f"{self._counter:02d}_{name}"
        data = _json_value(data)
        content = data if isinstance(data, str) else json.dumps(data, indent=2, ensure_ascii=False)
        path.write_text(content, encoding="utf-8")
        return path

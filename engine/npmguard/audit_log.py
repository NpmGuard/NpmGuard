import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from .config import REPO_ROOT


class AuditLog:
    def __init__(self, package_name: str) -> None:
        stamp = datetime.now(UTC).isoformat().replace(":", "-").replace(".", "-")
        safe = re.sub(r"[^a-zA-Z0-9_-]", "_", package_name)
        self.run_dir = REPO_ROOT / "audit-logs" / f"{stamp}_{safe}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self._counter = 0

    def write(self, name: str, data: Any) -> Path:
        self._counter += 1
        path = self.run_dir / f"{self._counter:02d}_{name}"
        if isinstance(data, BaseModel):
            data = data.model_dump(mode="json", exclude_none=False)
        content = data if isinstance(data, str) else json.dumps(data, indent=2, ensure_ascii=False)
        path.write_text(content, encoding="utf-8")
        return path

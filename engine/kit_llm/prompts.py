"""Versioned prompt artifacts. A prompt is code that no compiler checks —
so it gets what code gets: immutable versions (prompts/<name>/v<N>.md,
new behavior = new file) and a stable content hash that rides into every
capture row, naming exactly which behavior produced a given call."""

import hashlib
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

_VERSION_FILE = re.compile(r"^v(\d+)\.md$")
_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


@dataclass(frozen=True)
class Prompt:
    name: str
    version: int
    text: str
    hash: str  # sha256(text)[:12] — stable across processes and languages


def prompt_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:12]


@lru_cache(maxsize=256)
def load_prompt(prompts_dir: str, name: str, version: int | None = None) -> Prompt:
    """Load prompts/<name>/v<version>.md (default: highest version).
    Exactly one trailing newline is stripped for hash stability."""
    role_dir = Path(prompts_dir) / name
    if version is None:
        versions = sorted(
            int(m.group(1))
            for f in role_dir.glob("v*.md")
            if (m := _VERSION_FILE.match(f.name))
        )
        if not versions:
            raise FileNotFoundError(f"no prompt versions under {role_dir}")
        version = versions[-1]
    text = (role_dir / f"v{version}.md").read_text(encoding="utf-8").removesuffix("\n")
    return Prompt(name=name, version=version, text=text, hash=prompt_hash(text))


def render(text: str, variables: dict[str, str]) -> str:
    """Strict {{key}} substitution: a missing variable raises (a silently
    empty hole is a behavior change nothing would catch); extra variables
    are ignored."""

    def substitute(match: re.Match) -> str:
        key = match.group(1)
        if key not in variables:
            raise KeyError(f"prompt variable {{{{{key}}}}} not provided")
        return str(variables[key])

    return _PLACEHOLDER.sub(substitute, text)

"""Strict, provider-neutral golden corpus loading and regression dispatch.

The corpus stores domain-shaped cases and sanitized adapter-exchange
reproducers. Their inner request/input bodies are deliberately opaque JSON; the
manifest and payload envelopes are versioned and exact. Loading verifies local
integrity and common credential patterns. ``source_sha256`` is an external
provenance fingerprint, not proof that the source artifact is checked in.

Loading never means a behavioral check passed. ``run_regression_checks`` binds
regression entries to app-owned executable checks; research entries remain
non-gating even when a caller can inspect them.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Literal, TypeAlias, cast

JsonScalar: TypeAlias = None | bool | int | float | str
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
FrozenJson: TypeAlias = JsonScalar | tuple["FrozenJson", ...] | Mapping[str, "FrozenJson"]

Layer = Literal["case", "exchange"]
Disposition = Literal["regression", "research"]

_MANIFEST_KEYS = frozenset({"suite", "version", "entries"})
_ENTRY_KEYS = frozenset(
    {
        "id",
        "layer",
        "family",
        "disposition",
        "path",
        "sha256",
        "source_sha256",
        "check",
        "blocker",
    }
)
_CASE_KEYS = frozenset({"id", "version", "layer", "family", "input", "expected"})
_EXCHANGE_KEYS = frozenset({"id", "version", "layer", "family", "request", "response", "expected"})
_SAFE_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_SAFE_FAMILY = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_SAFE_CHECK = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_BEARER = re.compile(r"\bbearer\s+\S+", re.IGNORECASE)
_ROOT_DOTENV = re.compile(r"/root(?:/[^\s/]*)*/\.env\b")
_KEY_ASSIGNMENT = re.compile(r"\b[a-z0-9_-]*api[_-]?key\s*=\s*\S+", re.IGNORECASE)
_KNOWN_TOKEN = re.compile(
    r"(?:sk-or-v1-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|"
    r"sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,})"
)


class GoldenCorpusError(ValueError):
    """A golden corpus is malformed, unsafe, or fails integrity checks."""


class GoldenCheckFailed(GoldenCorpusError):
    """An executable regression check rejected its frozen entry."""


@dataclass(frozen=True)
class GoldenEntry:
    """One verified corpus entry and its immutable payload."""

    id: str
    layer: Layer
    family: str
    disposition: Disposition
    path: Path
    sha256: str
    source_sha256: str
    check: str
    blocker: str | None
    payload: Mapping[str, FrozenJson]


@dataclass(frozen=True)
class GoldenSuite:
    """A completely verified manifest, ordered by entry id."""

    suite: str
    version: int
    entries: tuple[GoldenEntry, ...]
    digest: str
    manifest_path: Path


GoldenCheck = Callable[[GoldenEntry], None]


def canonical_sha256(value: JsonValue) -> str:
    """Hash Kit's stable UTF-8 JSON representation of *value*.

    Object-key and insignificant whitespace differences do not affect the hash.
    Arrays retain order because order is JSON meaning.  Non-finite numbers are
    never canonical JSON and are rejected.
    """

    _validate_canonical_json(value, "$")
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise GoldenCorpusError(f"value is not canonical JSON: {exc}") from exc
    return hashlib.sha256(encoded).hexdigest()


def load_golden_suite(manifest_path: str | Path) -> GoldenSuite:
    """Load and fully verify a version-1 golden manifest.

    Entry files must be ordinary JSON files beneath the manifest directory; no
    symlink is followed.  All verification completes before a suite is returned.
    """

    manifest = Path(manifest_path)
    if manifest.is_symlink():
        raise GoldenCorpusError("manifest must not be a symlink")
    _reject_symlinked_manifest_parent(manifest)
    if manifest.suffix != ".json":
        raise GoldenCorpusError("manifest must be a .json file")
    raw_manifest = _require_object(_read_strict_json(manifest), "manifest")
    _require_exact_keys(raw_manifest, _MANIFEST_KEYS, "manifest")
    _scan_secrets(raw_manifest, "manifest")

    suite_name = _require_string(raw_manifest["suite"], "manifest.suite")
    if not _SAFE_ID.fullmatch(suite_name):
        raise GoldenCorpusError("manifest.suite is not a safe id")
    version = _require_int(raw_manifest["version"], "manifest.version")
    if version != 1:
        raise GoldenCorpusError(f"unsupported manifest version: {version}")
    raw_entries = _require_list(raw_manifest["entries"], "manifest.entries")
    if not raw_entries:
        raise GoldenCorpusError("manifest.entries must not be empty")

    try:
        root = manifest.parent.resolve(strict=True)
    except OSError as exc:
        raise GoldenCorpusError(f"cannot resolve manifest directory: {exc}") from exc

    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    entries: list[GoldenEntry] = []
    payloads_for_digest: list[dict[str, JsonValue]] = []
    normalized_entries: list[dict[str, JsonValue]] = []

    for index, raw_entry_value in enumerate(raw_entries):
        where = f"manifest.entries[{index}]"
        raw_entry = _require_object(raw_entry_value, where)
        _require_exact_keys(raw_entry, _ENTRY_KEYS, where)
        entry_id = _validate_entry_id(raw_entry["id"], f"{where}.id")
        if entry_id in seen_ids:
            raise GoldenCorpusError(f"duplicate entry id: {entry_id}")
        seen_ids.add(entry_id)

        layer = cast(
            Layer,
            _validate_choice(raw_entry["layer"], {"case", "exchange"}, f"{where}.layer"),
        )
        family = _require_string(raw_entry["family"], f"{where}.family")
        if not _SAFE_FAMILY.fullmatch(family):
            raise GoldenCorpusError(f"{where}.family is not a safe family id")
        disposition = cast(
            Disposition,
            _validate_choice(
                raw_entry["disposition"],
                {"regression", "research"},
                f"{where}.disposition",
            ),
        )
        relative_text = _require_string(raw_entry["path"], f"{where}.path")
        if relative_text in seen_paths:
            raise GoldenCorpusError(f"duplicate entry path: {relative_text}")
        seen_paths.add(relative_text)
        payload_path = _resolve_payload_path(root, relative_text, where)

        payload_sha = _validate_sha(raw_entry["sha256"], f"{where}.sha256")
        source_sha = _validate_sha(raw_entry["source_sha256"], f"{where}.source_sha256")
        check = _require_string(raw_entry["check"], f"{where}.check")
        if not _SAFE_CHECK.fullmatch(check):
            raise GoldenCorpusError(f"{where}.check is not a safe check id")
        blocker = _validate_blocker(raw_entry["blocker"], disposition, where)

        raw_payload = _require_object(_read_strict_json(payload_path), f"payload {entry_id}")
        _scan_secrets(raw_payload, f"payload {entry_id}")
        _validate_payload(raw_payload, entry_id, version, layer, family)
        actual_sha = canonical_sha256(raw_payload)
        if actual_sha != payload_sha:
            raise GoldenCorpusError(
                f"payload {entry_id} sha256 mismatch: expected {payload_sha}, got {actual_sha}"
            )

        entry_copy: dict[str, JsonValue] = dict(raw_entry)
        normalized_entries.append(entry_copy)
        payloads_for_digest.append({"id": entry_id, "payload": raw_payload})
        entries.append(
            GoldenEntry(
                id=entry_id,
                layer=layer,
                family=family,
                disposition=disposition,
                path=payload_path,
                sha256=payload_sha,
                source_sha256=source_sha,
                check=check,
                blocker=blocker,
                payload=_freeze_object(raw_payload),
            )
        )

    normalized_entries.sort(key=lambda item: str(item["id"]))
    payloads_for_digest.sort(key=lambda item: str(item["id"]))
    entries.sort(key=lambda item: item.id)
    suite_digest = canonical_sha256(
        {
            "manifest": {
                "suite": suite_name,
                "version": version,
                "entries": normalized_entries,
            },
            "payloads": payloads_for_digest,
        }
    )
    return GoldenSuite(
        suite=suite_name,
        version=version,
        entries=tuple(entries),
        digest=suite_digest,
        manifest_path=manifest.resolve(),
    )


def run_regression_checks(
    suite: GoldenSuite,
    checks: Mapping[str, GoldenCheck],
) -> tuple[str, ...]:
    """Execute every regression entry exactly once through a named check.

    Research entries are deliberately excluded: a known reproducer is not a
    passing assertion. Missing implementations and callback failures are typed
    gate failures, never skips or truthy return-value conventions.
    """
    regressions = [entry for entry in suite.entries if entry.disposition == "regression"]
    missing = sorted({entry.check for entry in regressions if entry.check not in checks})
    if missing:
        raise GoldenCorpusError(f"regression checks have no implementation: {missing}")
    completed: list[str] = []
    for entry in regressions:
        try:
            result = checks[entry.check](entry)
            if inspect.isawaitable(result):
                # This API is deliberately synchronous.  Closing a native
                # coroutine avoids both a false pass and an un-awaited
                # coroutine warning; arbitrary awaitables are still rejected.
                close = getattr(result, "close", None)
                if callable(close):
                    close()
                raise GoldenCheckFailed(
                    f"golden regression {entry.id!r} check {entry.check!r} "
                    "returned an awaitable to the synchronous check runner"
                )
        except GoldenCheckFailed:
            raise
        except Exception as error:
            raise GoldenCheckFailed(
                f"golden regression {entry.id!r} failed check {entry.check!r}: "
                f"{type(error).__name__}: {error}"
            ) from error
        completed.append(entry.id)
    return tuple(completed)


def _read_strict_json(path: Path) -> JsonValue:
    def reject_duplicate(pairs: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
        result: dict[str, JsonValue] = {}
        for key, value in pairs:
            if key in result:
                raise GoldenCorpusError(f"duplicate JSON key {key!r} in {path}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise GoldenCorpusError(f"non-finite JSON number {value!r} in {path}")

    try:
        text = path.read_text(encoding="utf-8")
        return json.loads(
            text,
            object_pairs_hook=reject_duplicate,
            parse_constant=reject_constant,
        )
    except GoldenCorpusError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GoldenCorpusError(f"cannot read strict JSON from {path}: {exc}") from exc


def _validate_canonical_json(
    value: object,
    where: str,
    active_containers: set[int] | None = None,
) -> None:
    if active_containers is None:
        active_containers = set()
    if value is None or type(value) in {bool, int, str}:
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise GoldenCorpusError(f"non-finite number is not canonical JSON at {where}")
        return
    if type(value) is list:
        marker = id(value)
        if marker in active_containers:
            raise GoldenCorpusError(f"cyclic JSON container at {where}")
        active_containers.add(marker)
        try:
            for index, child in enumerate(value):
                _validate_canonical_json(
                    child,
                    f"{where}[{index}]",
                    active_containers,
                )
        finally:
            active_containers.remove(marker)
        return
    if type(value) is dict:
        marker = id(value)
        if marker in active_containers:
            raise GoldenCorpusError(f"cyclic JSON container at {where}")
        active_containers.add(marker)
        try:
            for key, child in value.items():
                if type(key) is not str:
                    raise GoldenCorpusError(f"JSON object key must be a string at {where}")
                _validate_canonical_json(child, f"{where}.{key}", active_containers)
        finally:
            active_containers.remove(marker)
        return
    raise GoldenCorpusError(f"value at {where} has non-JSON type {type(value).__name__}")


def _reject_symlinked_manifest_parent(manifest: Path) -> None:
    absolute = manifest if manifest.is_absolute() else Path.cwd() / manifest
    current = Path(absolute.anchor)
    for part in absolute.parts[1:-1]:
        if part == ".":
            continue
        if part == "..":
            current = current.parent
            continue
        current = current / part
        if current.is_symlink():
            raise GoldenCorpusError("manifest path must not traverse a symlinked directory")


def _require_exact_keys(value: dict[str, JsonValue], expected: frozenset[str], where: str) -> None:
    actual = set(value)
    if actual != expected:
        unknown = sorted(actual - expected)
        missing = sorted(expected - actual)
        details = []
        if unknown:
            details.append(f"unknown={unknown}")
        if missing:
            details.append(f"missing={missing}")
        raise GoldenCorpusError(f"{where} has invalid keys ({', '.join(details)})")


def _require_object(value: JsonValue, where: str) -> dict[str, JsonValue]:
    if type(value) is not dict:
        raise GoldenCorpusError(f"{where} must be an object")
    return value


def _require_list(value: JsonValue, where: str) -> list[JsonValue]:
    if type(value) is not list:
        raise GoldenCorpusError(f"{where} must be an array")
    return value


def _require_string(value: JsonValue, where: str) -> str:
    if type(value) is not str or not value.strip():
        raise GoldenCorpusError(f"{where} must be a non-empty string")
    return value


def _require_int(value: JsonValue, where: str) -> int:
    if type(value) is not int:
        raise GoldenCorpusError(f"{where} must be an integer")
    return value


def _validate_entry_id(value: JsonValue, where: str) -> str:
    entry_id = _require_string(value, where)
    if not _SAFE_ID.fullmatch(entry_id):
        raise GoldenCorpusError(f"{where} is not a safe id")
    return entry_id


def _validate_choice(value: JsonValue, choices: set[str], where: str) -> str:
    choice = _require_string(value, where)
    if choice not in choices:
        raise GoldenCorpusError(f"{where} must be one of {sorted(choices)}")
    return choice


def _validate_sha(value: JsonValue, where: str) -> str:
    digest = _require_string(value, where)
    if not _SHA256.fullmatch(digest):
        raise GoldenCorpusError(f"{where} must be a lowercase sha256")
    return digest


def _validate_blocker(value: JsonValue, disposition: str, where: str) -> str | None:
    if disposition == "research":
        return _require_string(value, f"{where}.blocker")
    if value is not None:
        raise GoldenCorpusError(f"{where}.blocker is forbidden for regression entries")
    return None


def _resolve_payload_path(root: Path, relative_text: str, where: str) -> Path:
    if "\\" in relative_text:
        raise GoldenCorpusError(f"{where}.path must use portable forward slashes")
    if any(part in {"", ".", ".."} for part in relative_text.split("/")):
        raise GoldenCorpusError(f"{where}.path must be a contained relative path")
    relative = PurePosixPath(relative_text)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise GoldenCorpusError(f"{where}.path must be a contained relative path")
    if relative.suffix != ".json":
        raise GoldenCorpusError(f"{where}.path must name a .json payload")

    candidate = root
    for part in relative.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise GoldenCorpusError(f"{where}.path must not traverse a symlink")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise GoldenCorpusError(f"{where}.path cannot be resolved: {exc}") from exc
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise GoldenCorpusError(f"{where}.path must resolve to a contained regular file")
    return resolved


def _validate_payload(
    payload: dict[str, JsonValue], entry_id: str, version: int, layer: str, family: str
) -> None:
    expected_keys = _CASE_KEYS if layer == "case" else _EXCHANGE_KEYS
    _require_exact_keys(payload, expected_keys, f"payload {entry_id}")
    if _require_string(payload["id"], f"payload {entry_id}.id") != entry_id:
        raise GoldenCorpusError(f"payload {entry_id} id does not match its manifest entry")
    if _require_int(payload["version"], f"payload {entry_id}.version") != version:
        raise GoldenCorpusError(f"payload {entry_id} version does not match its manifest")
    if _require_string(payload["layer"], f"payload {entry_id}.layer") != layer:
        raise GoldenCorpusError(f"payload {entry_id} layer does not match its manifest entry")
    if _require_string(payload["family"], f"payload {entry_id}.family") != family:
        raise GoldenCorpusError(f"payload {entry_id} family does not match its manifest entry")
    _require_object(payload["expected"], f"payload {entry_id}.expected")
    if layer == "case":
        _require_object(payload["input"], f"payload {entry_id}.input")
    else:
        _require_object(payload["request"], f"payload {entry_id}.request")
        _require_object(payload["response"], f"payload {entry_id}.response")


def _scan_secrets(value: JsonValue, where: str) -> None:
    if type(value) is dict:
        for key, child in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", key.lower())
            if normalized == "authorization" or "apikey" in normalized:
                raise GoldenCorpusError(f"credential-bearing key is forbidden at {where}.{key}")
            _scan_secrets(child, f"{where}.{key}")
        return
    if type(value) is list:
        for index, child in enumerate(value):
            _scan_secrets(child, f"{where}[{index}]")
        return
    if type(value) is str and (
        _BEARER.search(value)
        or _ROOT_DOTENV.search(value)
        or _KEY_ASSIGNMENT.search(value)
        or _KNOWN_TOKEN.search(value)
    ):
        raise GoldenCorpusError(f"credential material is forbidden at {where}")
    if type(value) is float and not math.isfinite(value):
        raise GoldenCorpusError(f"non-finite JSON number at {where}")


def _freeze(value: JsonValue) -> FrozenJson:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze(child) for key, child in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(child) for child in value)
    return value


def _freeze_object(value: dict[str, JsonValue]) -> Mapping[str, FrozenJson]:
    return MappingProxyType({key: _freeze(child) for key, child in value.items()})


__all__ = [
    "GoldenCheck",
    "GoldenCheckFailed",
    "GoldenCorpusError",
    "GoldenEntry",
    "GoldenSuite",
    "canonical_sha256",
    "load_golden_suite",
    "run_regression_checks",
]

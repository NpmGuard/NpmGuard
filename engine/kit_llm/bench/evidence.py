"""Durable, provider-neutral evidence bundles for real-call experiments.

The recorder sits beside :mod:`kit_llm.bench`; it does not intercept providers
or decide whether an application's answer is correct.  It freezes a campaign
before calls start, journals every apparatus-boundary attempt, and seals only
after the planned population has explicit terminal observations.

Sanitization is an apparatus responsibility.  The protocol records the named
policy that ran, while the writer persists only the values supplied to it.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import itertools
import json
import math
import os
import re
import threading
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Self, cast

from kit_llm._contract import TOKEN_COUNT_MAX
from kit_llm.bench._evidence_io import (
    CampaignLock,
    append_jsonl as _append_jsonl,
    atomic_write_bytes as _atomic_write_bytes,
    campaign_lock_is_held as _campaign_lock_is_held,
    canonical_json_bytes as _canonical_json_bytes,
    contained_regular_file as _contained_regular_file,
    ensure_safe_bundle_root as _ensure_safe_bundle_root,
    read_regular_bytes as _read_regular_bytes,
    sha256_bytes as _sha256_bytes,
    strict_load_json as _strict_load_json,
    strict_load_jsonl as _strict_load_jsonl,
)
from kit_llm.bench.harness import BenchArtifactError, LockUnavailable, RunLocked


EVIDENCE_BUNDLE_FORMAT = "kit.llm.evidence.bundle"
EVIDENCE_RECORD_FORMAT = "kit.llm.evidence.record"
EVIDENCE_BYTES_FORMAT = "kit.llm.evidence.bytes"
EVIDENCE_FORMAT_VERSION = 1
FORMAT = EVIDENCE_BUNDLE_FORMAT
RECORD_FORMAT = EVIDENCE_RECORD_FORMAT
FORMAT_VERSION = EVIDENCE_FORMAT_VERSION
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_ATOMIC_TEMP_NAME = re.compile(r"^\..+\.[0-9a-f]{32}\.tmp$")
_REQUIRED_PAYLOAD_PATHS = frozenset(
    {
        "protocol.json",
        "registration.json",
        "journal.jsonl",
        "attempts.jsonl",
        "roots.jsonl",
    }
)
_STAGES = ("parse", "schema", "semantic", "decode")
_PURPOSES = {
    "initial",
    "http_retry",
    "apparatus_retry",
    "same_model_repair",
    "model_fallback",
    "transport_fallback",
}
_RECOVERIES = _PURPOSES - {"initial"}
_POLICY_BY_PURPOSE = {
    "http_retry": "http",
    "apparatus_retry": "apparatus",
    "same_model_repair": "same_model_repair",
    "model_fallback": "model_fallback",
    "transport_fallback": "transport_fallback",
}
_OBSERVATION_STATES = {"observed", "absent", "not_applicable", "unknown"}
_CONTROL_KEYS = {
    "output_limits",
    "sampling",
    "reasoning",
    "tool_policy",
    "routing_policy",
    "provider_pins",
    "gateway_fallback_policy",
}
_RETRY_KEYS = {
    "http",
    "apparatus",
    "same_model_repair",
    "model_fallback",
    "transport_fallback",
}
_EXECUTION_KEYS = {
    "runner_entrypoint_artifact",
    "dependency_artifact_ids",
    "argv",
    "working_directory",
    "source_revision",
    "dirty_patch_artifact",
    "dependency_lock_artifact",
    "environment",
    "os",
    "runtime",
    "concurrency",
    "timeouts",
    "account_tier",
}
_PRICING_KEYS = {
    "source_artifact",
    "currency",
    "tariff_artifact",
    "fee_policy",
    "rounding_policy",
    "missing_usage_policy",
    "missing_cost_policy",
}
_EXECUTION_ARTIFACT_REFERENCE_KEYS = {
    "runner_entrypoint_artifact",
    "dirty_patch_artifact",
    "dependency_lock_artifact",
}
_PRICING_ARTIFACT_REFERENCE_KEYS = {"source_artifact", "tariff_artifact"}
_ROUTE_KEYS = {"gateway", "model", "provider", "routing_options"}
_PROTOCOL_KEYS = {
    "campaign_id",
    "question",
    "methods",
    "design",
    "dimensions",
    "planned_roots",
    "sampling_unit",
    "repeats",
    "blocks",
    "pairing",
    "randomization",
    "artifact_roles",
    "controls",
    "retry_policies",
    "execution",
    "pricing",
    "decision_rule",
    "sanitization",
    "extensions",
}


class EvidenceArtifactError(BenchArtifactError):
    """An evidence bundle is corrupt, ambiguous, or not strict JSON."""


class EvidenceStateError(EvidenceArtifactError):
    """The requested write is illegal in the campaign lifecycle."""


class EvidenceResumeMismatch(EvidenceArtifactError):
    """A resume request does not match the frozen campaign protocol."""


class EvidenceBundleLocked(RunLocked, EvidenceArtifactError):
    """Another writer owns the campaign directory."""


class EvidenceLockUnavailable(LockUnavailable, EvidenceArtifactError):
    """The platform cannot provide the local bundle's required lock."""


class AmbiguousEvidenceAttempt(EvidenceStateError):
    """An attempt start exists without a durable terminal observation."""


class EvidenceIncomplete(EvidenceStateError):
    """A complete seal was requested without complete evaluable evidence."""


def _evidence_error(error: BenchArtifactError) -> EvidenceArtifactError:
    if isinstance(error, EvidenceArtifactError):
        return error
    return EvidenceArtifactError(str(error))


def _assert_lock_owned(lock: CampaignLock) -> None:
    try:
        lock.assert_owned()
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


def canonical_json_bytes(value: Any, *, where: str) -> bytes:
    try:
        return _canonical_json_bytes(value, where=where)
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


def strict_load_json(path: str | Path, *, where: str) -> Any:
    try:
        return _strict_load_json(path, where=where)
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


def strict_load_jsonl(path: str | Path, *, where: str) -> tuple[dict[str, Any], ...]:
    try:
        return _strict_load_jsonl(path, where=where)
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


def atomic_write_bytes(path: str | Path, data: bytes) -> None:
    try:
        _atomic_write_bytes(path, data)
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


def append_jsonl(path: str | Path, value: Any, *, where: str) -> None:
    try:
        _append_jsonl(path, value, where=where)
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


def sha256_bytes(data: bytes) -> str:
    try:
        return _sha256_bytes(data)
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


def ensure_safe_bundle_root(path: str | Path) -> Path:
    try:
        return _ensure_safe_bundle_root(path)
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


def contained_regular_file(root: str | Path, relative: str | Path, *, where: str) -> Path:
    try:
        return _contained_regular_file(root, relative, where=where)
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


def read_regular_bytes(path: str | Path, *, where: str) -> bytes:
    try:
        return _read_regular_bytes(path, where=where)
    except BenchArtifactError as error:
        raise _evidence_error(error) from error


type JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
type ObservationState = Literal["observed", "absent", "not_applicable", "unknown"]
type StageState = Literal["pass", "fail", "not_run", "unknown"]
type BundleStatus = Literal["open", "ambiguous", "complete", "not_evaluable", "invalid"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | str, *, where: str) -> str:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise EvidenceArtifactError(f"{where} must be an ISO-8601 timestamp") from error
    else:
        raise EvidenceArtifactError(f"{where} must be a datetime or ISO-8601 string")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise EvidenceArtifactError(f"{where} must include a UTC offset")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: Any, *, where: str) -> datetime:
    if not isinstance(value, str):
        raise EvidenceArtifactError(f"{where} must be an ISO-8601 string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise EvidenceArtifactError(f"{where} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise EvidenceArtifactError(f"{where} must include a UTC offset")
    return parsed.astimezone(timezone.utc)


def _safe_id(value: Any, *, where: str) -> str:
    if not isinstance(value, str) or _SAFE_ID.fullmatch(value) is None:
        raise EvidenceArtifactError(
            f"{where} must be 1-96 portable characters: letters, digits, dot, underscore, dash"
        )
    return value


def _nonempty(value: Any, *, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EvidenceArtifactError(f"{where} must be a non-empty string")
    return value


def _integer(value: Any, *, where: str, minimum: int = 0, maximum: int | None = None) -> int:
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        suffix = f" and <= {maximum}" if maximum is not None else ""
        raise EvidenceArtifactError(f"{where} must be an integer >= {minimum}{suffix}")
    return value


def _exact_keys(value: Any, expected: set[str], *, where: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise EvidenceArtifactError(f"{where} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        raise EvidenceArtifactError(
            f"{where} has invalid keys (missing={missing}, unknown={unknown})"
        )
    return cast(dict[str, Any], value)


def _clone_json(value: Any, *, where: str) -> JsonValue:
    raw = canonical_json_bytes(value, where=where)
    try:
        return cast(JsonValue, json.loads(raw))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:  # defensive; writer made it
        raise EvidenceArtifactError(f"cannot clone {where}: {error}") from error


def _object(value: Any, *, where: str) -> dict[str, JsonValue]:
    cloned = _clone_json(value, where=where)
    if type(cloned) is not dict:
        raise EvidenceArtifactError(f"{where} must be an object")
    return cloned


def _tuple_json(values: Iterable[Any], *, where: str) -> tuple[JsonValue, ...]:
    return tuple(
        _clone_json(value, where=f"{where}[{index}]") for index, value in enumerate(values)
    )


def _object_with_observations(
    value: Any,
    observation_keys: set[str],
    *,
    where: str,
) -> dict[str, JsonValue]:
    """Clone a strict object while accepting public ``ObservedValue`` inputs."""

    if type(value) is not dict:
        raise EvidenceArtifactError(f"{where} must be an object")
    prepared = dict(value)
    for key in observation_keys & set(prepared):
        candidate = prepared[key]
        if isinstance(candidate, ObservedValue):
            prepared[key] = candidate.as_dict()
    return _object(prepared, where=where)


def _artifact_reference(
    value: Any,
    *,
    where: str,
    require_observed: bool = False,
) -> ObservedValue:
    reference = _observation(value, where=where)
    if reference.state == "observed":
        _safe_id(reference.value, where=f"{where}.value")
    elif require_observed:
        raise EvidenceArtifactError(f"{where} must be an observed artifact id")
    return reference


def _requested_route(value: Any, *, where: str) -> dict[str, JsonValue]:
    route = _exact_keys(_object(value, where=where), _ROUTE_KEYS, where=where)
    _nonempty(route["gateway"], where=f"{where}.gateway")
    _nonempty(route["model"], where=f"{where}.model")
    if route["provider"] is not None:
        _nonempty(route["provider"], where=f"{where}.provider")
    route["routing_options"] = _object(route["routing_options"], where=f"{where}.routing_options")
    return cast(dict[str, JsonValue], route)


def _same_json(left: Any, right: Any, *, where: str) -> bool:
    return canonical_json_bytes(left, where=f"{where} left") == canonical_json_bytes(
        right, where=f"{where} right"
    )


def _planned_route_error(route: Mapping[str, Any], planned_root: PlannedRoot) -> str | None:
    planned_route = planned_root.factors.get("route")
    if planned_route is not None and not _same_json(
        planned_route, route, where="planned requested route"
    ):
        return "requested route differs from the root's frozen route factor"
    for key in _ROUTE_KEYS:
        if key in planned_root.factors and not _same_json(
            planned_root.factors[key], route[key], where=f"planned requested route {key}"
        ):
            return f"requested route {key!r} differs from the root's frozen factor"
    return None


def _recovery_route_error(
    *,
    purpose: str,
    route: Mapping[str, Any],
    predecessor_route: Mapping[str, Any],
    policy: Any,
) -> str | None:
    if purpose not in {"model_fallback", "transport_fallback"}:
        if not _same_json(route, predecessor_route, where=f"{purpose} route"):
            return f"{purpose} must retain its predecessor's requested route"
        return None

    allowed = policy.get("requested_routes") if type(policy) is dict else None
    if purpose == "model_fallback" and not allowed:
        return "model_fallback policy must freeze non-empty requested_routes"
    if allowed and not any(
        _same_json(route, candidate, where=f"{purpose} allowed route") for candidate in allowed
    ):
        return f"{purpose} requested route is not declared by its frozen policy"
    if not allowed and not _same_json(route, predecessor_route, where="transport_fallback route"):
        return "transport_fallback route change is not declared by its frozen policy"
    if purpose == "model_fallback" and all(
        route[key] == predecessor_route[key] for key in ("model", "provider")
    ):
        return "model_fallback must change the requested model or provider"
    return None


def _validate_captured_bytes(value: JsonValue, *, where: str) -> None:
    if type(value) is not dict or value.get("format") != EVIDENCE_BYTES_FORMAT:
        return
    item = _exact_keys(
        value,
        {"format", "media_type", "bytes", "sha256", "base64"},
        where=where,
    )
    _nonempty(item["media_type"], where=f"{where}.media_type")
    size = _integer(item["bytes"], where=f"{where}.bytes")
    digest = item["sha256"]
    if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
        raise EvidenceArtifactError(f"{where}.sha256 must be a lowercase sha256")
    encoded = item["base64"]
    if not isinstance(encoded, str):
        raise EvidenceArtifactError(f"{where}.base64 must be a string")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise EvidenceArtifactError(f"{where}.base64 is not canonical base64") from error
    if base64.b64encode(raw).decode("ascii") != encoded:
        raise EvidenceArtifactError(f"{where}.base64 is not canonical base64")
    if len(raw) != size or sha256_bytes(raw) != digest:
        raise EvidenceArtifactError(f"{where} byte count/hash does not match its inline bytes")


@dataclass(frozen=True)
class FrozenArtifact:
    """Exact, already-sanitized bytes frozen before any paid call."""

    id: str
    media_type: str
    data: bytes

    def __post_init__(self) -> None:
        _safe_id(self.id, where="artifact id")
        _nonempty(self.media_type, where=f"artifact {self.id!r} media_type")
        if type(self.data) is not bytes:
            raise EvidenceArtifactError(f"artifact {self.id!r} data must be bytes")


@dataclass(frozen=True)
class PlannedRoot:
    """One preregistered sampling unit in the authoritative population."""

    root_id: str
    cell_id: str
    case_id: str
    repeat: int
    block: int
    planned_order: int
    factors: Mapping[str, Any]

    def __post_init__(self) -> None:
        _safe_id(self.root_id, where="planned root id")
        _safe_id(self.cell_id, where=f"root {self.root_id!r} cell_id")
        _safe_id(self.case_id, where=f"root {self.root_id!r} case_id")
        _integer(self.repeat, where=f"root {self.root_id!r} repeat")
        _integer(self.block, where=f"root {self.root_id!r} block")
        _integer(self.planned_order, where=f"root {self.root_id!r} planned_order")
        object.__setattr__(
            self, "factors", _object(self.factors, where=f"root {self.root_id!r} factors")
        )

    def as_dict(self) -> dict[str, JsonValue]:
        return _object(
            {
                "root_id": self.root_id,
                "cell_id": self.cell_id,
                "case_id": self.case_id,
                "repeat": self.repeat,
                "block": self.block,
                "planned_order": self.planned_order,
                "factors": dict(self.factors),
            },
            where=f"root {self.root_id!r} snapshot",
        )

    @classmethod
    def from_dict(cls, value: Any, *, where: str = "planned root") -> Self:
        item = _exact_keys(
            value,
            {"root_id", "cell_id", "case_id", "repeat", "block", "planned_order", "factors"},
            where=where,
        )
        return cls(**item)


@dataclass(frozen=True)
class CampaignProtocol:
    """Pre-registered scientific design and execution closure.

    Application-owned details stay strict JSON.  Exact code, prompts, schemas,
    parsers, validators, judges, locks, and tariffs are referenced through
    ``artifact_roles`` and verified against ``FrozenArtifact`` bytes.
    """

    campaign_id: str
    question: str
    methods: Mapping[str, Any]
    design: Literal["factorial", "enumerated"]
    dimensions: Mapping[str, Iterable[Any]]
    planned_roots: tuple[PlannedRoot, ...]
    sampling_unit: str
    repeats: int
    blocks: int
    pairing: Any
    randomization: Any
    artifact_roles: Mapping[str, Any]
    controls: Mapping[str, Any]
    retry_policies: Mapping[str, Any]
    execution: Mapping[str, Any]
    pricing: Mapping[str, Any]
    decision_rule: Mapping[str, Any]
    sanitization: Mapping[str, Any]
    extensions: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _safe_id(self.campaign_id, where="campaign_id")
        _nonempty(self.question, where="question")
        if not isinstance(self.design, str) or self.design not in {"factorial", "enumerated"}:
            raise EvidenceArtifactError("design must be 'factorial' or 'enumerated'")
        _nonempty(self.sampling_unit, where="sampling_unit")
        _integer(self.repeats, where="repeats", minimum=1)
        _integer(self.blocks, where="blocks", minimum=1)

        methods = _object(self.methods, where="methods")
        if not methods:
            raise EvidenceArtifactError("methods must name at least one declared condition")
        for method_id in methods:
            _safe_id(method_id, where="method id")
            method = _object(methods[method_id], where=f"method {method_id!r}")
            _nonempty(method.get("description"), where=f"method {method_id!r} description")
            methods[method_id] = method
        dimensions: dict[str, tuple[JsonValue, ...]] = {}
        if not isinstance(self.dimensions, Mapping):
            raise EvidenceArtifactError("dimensions must be an object")
        for name, raw_levels in self.dimensions.items():
            _safe_id(name, where="dimension name")
            if isinstance(raw_levels, (str, bytes)):
                raise EvidenceArtifactError(f"dimension {name!r} levels must be an array")
            try:
                levels = _tuple_json(raw_levels, where=f"dimension {name!r}")
            except TypeError as error:
                raise EvidenceArtifactError(
                    f"dimension {name!r} levels must be iterable"
                ) from error
            if not levels:
                raise EvidenceArtifactError(f"dimension {name!r} must have at least one level")
            fingerprints = [
                sha256_bytes(canonical_json_bytes(level, where=f"dimension {name!r}"))
                for level in levels
            ]
            if len(fingerprints) != len(set(fingerprints)):
                raise EvidenceArtifactError(f"dimension {name!r} has duplicate JSON levels")
            dimensions[name] = levels
        if "method" not in dimensions:
            raise EvidenceArtifactError("dimensions must declare the registered method ids")
        method_levels = dimensions["method"]
        if not all(isinstance(level, str) for level in method_levels):
            raise EvidenceArtifactError("dimension 'method' levels must be method-id strings")
        if set(cast(tuple[str, ...], method_levels)) != set(methods):
            raise EvidenceArtifactError(
                "dimension 'method' levels must equal the registered method ids"
            )

        try:
            roots = tuple(self.planned_roots)
        except TypeError as error:
            raise EvidenceArtifactError(
                "planned_roots must be an iterable of PlannedRoot values"
            ) from error
        if not roots:
            raise EvidenceArtifactError("planned_roots must not be empty")
        if not all(isinstance(root, PlannedRoot) for root in roots):
            raise EvidenceArtifactError("planned_roots must contain PlannedRoot values")
        root_ids = [root.root_id for root in roots]
        if len(root_ids) != len(set(root_ids)):
            raise EvidenceArtifactError("planned root ids must be unique")
        orders = [root.planned_order for root in roots]
        if sorted(orders) != list(range(len(roots))):
            raise EvidenceArtifactError("planned_order must be contiguous from zero")
        for root in roots:
            if root.repeat >= self.repeats:
                raise EvidenceArtifactError(
                    f"root {root.root_id!r} repeat exceeds protocol repeats"
                )
            if root.block >= self.blocks:
                raise EvidenceArtifactError(f"root {root.root_id!r} block exceeds protocol blocks")
            if set(root.factors) != set(dimensions):
                raise EvidenceArtifactError(
                    f"root {root.root_id!r} factors must name every declared dimension exactly once"
                )
            for name, value in root.factors.items():
                encoded = canonical_json_bytes(
                    value, where=f"root {root.root_id!r} factor {name!r}"
                )
                if all(
                    encoded != canonical_json_bytes(level, where=f"dimension {name!r}")
                    for level in dimensions[name]
                ):
                    raise EvidenceArtifactError(
                        f"root {root.root_id!r} factor {name!r} is not a declared level"
                    )
        populated_methods = {cast(str, root.factors["method"]) for root in roots}
        if populated_methods != set(methods):
            raise EvidenceArtifactError(
                "planned_roots must include every registered method at least once"
            )

        if self.design == "factorial":
            expected: Counter[bytes] = Counter()
            names = tuple(dimensions)
            for levels in itertools.product(*(dimensions[name] for name in names)):
                factors = dict(zip(names, levels, strict=True))
                for block in range(self.blocks):
                    for repeat in range(self.repeats):
                        expected[
                            canonical_json_bytes(
                                {"factors": factors, "block": block, "repeat": repeat},
                                where="factorial coordinate",
                            )
                        ] += 1
            actual = Counter(
                canonical_json_bytes(
                    {"factors": dict(root.factors), "block": root.block, "repeat": root.repeat},
                    where=f"root {root.root_id!r} coordinate",
                )
                for root in roots
            )
            if actual != expected:
                raise EvidenceArtifactError(
                    "factorial planned_roots do not equal dimensions × blocks × repeats"
                )

        controls = _object(self.controls, where="controls")
        if set(controls) != _CONTROL_KEYS:
            raise EvidenceArtifactError(f"controls must contain exactly {sorted(_CONTROL_KEYS)}")
        retries = _object(self.retry_policies, where="retry_policies")
        if set(retries) != _RETRY_KEYS:
            raise EvidenceArtifactError(
                f"retry_policies must contain exactly {sorted(_RETRY_KEYS)}"
            )
        for policy_name, raw_policy in retries.items():
            if type(raw_policy) is dict and "id" in raw_policy:
                _safe_id(raw_policy["id"], where=f"retry_policies.{policy_name}.id")
            if type(raw_policy) is not dict or "requested_routes" not in raw_policy:
                continue
            routes = raw_policy["requested_routes"]
            if type(routes) is not list or not routes:
                raise EvidenceArtifactError(
                    f"retry_policies.{policy_name}.requested_routes must be a non-empty array"
                )
            raw_policy["requested_routes"] = [
                _requested_route(
                    route,
                    where=f"retry_policies.{policy_name}.requested_routes[{index}]",
                )
                for index, route in enumerate(routes)
            ]
        execution = _object_with_observations(
            self.execution,
            _EXECUTION_ARTIFACT_REFERENCE_KEYS,
            where="execution",
        )
        if set(execution) != _EXECUTION_KEYS:
            raise EvidenceArtifactError(f"execution must contain exactly {sorted(_EXECUTION_KEYS)}")
        _integer(execution["concurrency"], where="execution.concurrency", minimum=1)
        if type(execution["argv"]) is not list or not all(
            isinstance(item, str) for item in execution["argv"]
        ):
            raise EvidenceArtifactError("execution.argv must be an array of strings")
        if type(execution["dependency_artifact_ids"]) is not list or not all(
            isinstance(item, str) for item in execution["dependency_artifact_ids"]
        ):
            raise EvidenceArtifactError("execution.dependency_artifact_ids must be an array of ids")
        dependency_ids = cast(list[str], execution["dependency_artifact_ids"])
        for index, artifact_id in enumerate(dependency_ids):
            _safe_id(artifact_id, where=f"execution.dependency_artifact_ids[{index}]")
        if len(dependency_ids) != len(set(dependency_ids)):
            raise EvidenceArtifactError("execution.dependency_artifact_ids must be unique")
        for key in sorted(_EXECUTION_ARTIFACT_REFERENCE_KEYS):
            reference = _artifact_reference(
                execution[key],
                where=f"execution.{key}",
                require_observed=key == "runner_entrypoint_artifact",
            )
            execution[key] = reference.as_dict()
        for key in ("working_directory", "source_revision"):
            _nonempty(execution[key], where=f"execution.{key}")
        _object(execution["environment"], where="execution.environment")
        _object(execution["os"], where="execution.os")
        _object(execution["runtime"], where="execution.runtime")
        _object(execution["timeouts"], where="execution.timeouts")
        if execution["account_tier"] is not None:
            _nonempty(execution["account_tier"], where="execution.account_tier")
        pricing = _object_with_observations(
            self.pricing,
            _PRICING_ARTIFACT_REFERENCE_KEYS,
            where="pricing",
        )
        if set(pricing) != _PRICING_KEYS:
            raise EvidenceArtifactError(f"pricing must contain exactly {sorted(_PRICING_KEYS)}")
        _nonempty(pricing["currency"], where="pricing.currency")
        for key in (
            "fee_policy",
            "rounding_policy",
            "missing_usage_policy",
            "missing_cost_policy",
        ):
            _nonempty(pricing[key], where=f"pricing.{key}")
        for key in sorted(_PRICING_ARTIFACT_REFERENCE_KEYS):
            pricing[key] = _artifact_reference(pricing[key], where=f"pricing.{key}").as_dict()

        object.__setattr__(self, "methods", methods)
        object.__setattr__(self, "dimensions", dimensions)
        object.__setattr__(self, "planned_roots", roots)
        pairing = _object(self.pairing, where="pairing")
        _nonempty(pairing.get("kind"), where="pairing.kind")
        object.__setattr__(self, "pairing", pairing)
        randomization = _object(self.randomization, where="randomization")
        _nonempty(randomization.get("kind"), where="randomization.kind")
        if "seed" not in randomization:
            raise EvidenceArtifactError("randomization is missing 'seed'")
        object.__setattr__(self, "randomization", randomization)
        artifact_roles = _object(self.artifact_roles, where="artifact_roles")
        if not artifact_roles:
            raise EvidenceArtifactError("artifact_roles must not be empty")
        object.__setattr__(self, "artifact_roles", artifact_roles)
        object.__setattr__(self, "controls", controls)
        object.__setattr__(self, "retry_policies", retries)
        object.__setattr__(self, "execution", execution)
        object.__setattr__(self, "pricing", pricing)
        decision_rule = _object(self.decision_rule, where="decision_rule")
        _nonempty(decision_rule.get("kind"), where="decision_rule.kind")
        object.__setattr__(self, "decision_rule", decision_rule)
        sanitization = _object_with_observations(
            self.sanitization,
            {"implementation_artifact", "scan_result"},
            where="sanitization",
        )
        sanitization = _exact_keys(
            sanitization,
            {"policy_id", "implementation_artifact", "scope", "scan_result"},
            where="sanitization",
        )
        _safe_id(sanitization["policy_id"], where="sanitization.policy_id")
        _nonempty(sanitization["scope"], where="sanitization.scope")
        implementation = _artifact_reference(
            sanitization["implementation_artifact"],
            where="sanitization.implementation_artifact",
            require_observed=True,
        )
        sanitization["implementation_artifact"] = implementation.as_dict()
        scan_result = _observation(sanitization["scan_result"], where="sanitization.scan_result")
        if scan_result.state == "observed":
            scan_value = _object(scan_result.value, where="sanitization.scan_result.value")
            if not scan_value:
                raise EvidenceArtifactError(
                    "observed sanitization.scan_result.value must be a non-empty object"
                )
        sanitization["scan_result"] = scan_result.as_dict()
        object.__setattr__(self, "sanitization", sanitization)
        object.__setattr__(self, "extensions", _object(self.extensions, where="extensions"))

    def as_dict(self) -> dict[str, JsonValue]:
        return _object(
            {
                "campaign_id": self.campaign_id,
                "question": self.question,
                "methods": dict(self.methods),
                "design": self.design,
                "dimensions": {name: list(levels) for name, levels in self.dimensions.items()},
                "planned_roots": [root.as_dict() for root in self.planned_roots],
                "sampling_unit": self.sampling_unit,
                "repeats": self.repeats,
                "blocks": self.blocks,
                "pairing": cast(JsonValue, self.pairing),
                "randomization": cast(JsonValue, self.randomization),
                "artifact_roles": dict(self.artifact_roles),
                "controls": dict(self.controls),
                "retry_policies": dict(self.retry_policies),
                "execution": dict(self.execution),
                "pricing": dict(self.pricing),
                "decision_rule": dict(self.decision_rule),
                "sanitization": dict(self.sanitization),
                "extensions": dict(self.extensions),
            },
            where=f"campaign {self.campaign_id!r} snapshot",
        )

    @classmethod
    def from_dict(cls, value: Any, *, where: str = "campaign protocol") -> Self:
        item = _exact_keys(value, _PROTOCOL_KEYS, where=where)
        roots = item.copy()
        raw_roots = roots["planned_roots"]
        if type(raw_roots) is not list:
            raise EvidenceArtifactError(f"{where}.planned_roots must be an array")
        roots["planned_roots"] = tuple(
            PlannedRoot.from_dict(root, where=f"{where}.planned_roots[{index}]")
            for index, root in enumerate(raw_roots)
        )
        return cls(**roots)


@dataclass(frozen=True)
class ObservedValue:
    """A value with absence and uncertainty represented independently."""

    state: ObservationState
    value: Any = None
    source: str | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.state, str) or self.state not in _OBSERVATION_STATES:
            raise EvidenceArtifactError(f"invalid observation state {self.state!r}")
        if self.state == "observed":
            if self.reason is not None:
                raise EvidenceArtifactError("observed values cannot have a reason")
            _nonempty(self.source, where="observed value source")
            object.__setattr__(self, "value", _clone_json(self.value, where="observed value"))
            _validate_captured_bytes(cast(JsonValue, self.value), where="observed byte capture")
        else:
            if self.value is not None or self.source is not None:
                raise EvidenceArtifactError(
                    f"{self.state} observations require null value and source"
                )
            _nonempty(self.reason, where=f"{self.state} observation reason")

    def as_dict(self) -> dict[str, JsonValue]:
        return _object(
            {
                "state": self.state,
                "value": cast(JsonValue, self.value),
                "source": self.source,
                "reason": self.reason,
            },
            where="observation snapshot",
        )

    @classmethod
    def from_dict(cls, value: Any, *, where: str = "observation") -> Self:
        item = _exact_keys(value, {"state", "value", "source", "reason"}, where=where)
        return cls(**item)


@dataclass(frozen=True)
class ValidationStage:
    """One client-supplied validation or decoding stage."""

    state: StageState
    issues: tuple[Mapping[str, Any], ...] = ()
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.state, str) or self.state not in {
            "pass",
            "fail",
            "not_run",
            "unknown",
        }:
            raise EvidenceArtifactError(f"invalid validation stage state {self.state!r}")
        try:
            issues = tuple(
                _object(issue, where=f"validation issue {index}")
                for index, issue in enumerate(self.issues)
            )
        except TypeError as error:
            raise EvidenceArtifactError("validation stage issues must be iterable") from error
        for index, issue in enumerate(issues):
            for key in ("code", "message"):
                if key not in issue:
                    raise EvidenceArtifactError(f"validation issue {index} is missing {key!r}")
                _nonempty(issue[key], where=f"validation issue {index}.{key}")
        if self.state == "pass" and (issues or self.reason is not None):
            raise EvidenceArtifactError("passing validation stages cannot have issues or a reason")
        if self.state == "fail" and (not issues or self.reason is not None):
            raise EvidenceArtifactError("failed validation stages require issues and no reason")
        if self.state in {"not_run", "unknown"} and (issues or not self.reason):
            raise EvidenceArtifactError(
                f"{self.state} validation stages require a reason and no issues"
            )
        object.__setattr__(self, "issues", issues)

    def as_dict(self) -> dict[str, JsonValue]:
        return _object(
            {
                "state": self.state,
                "issues": [dict(issue) for issue in self.issues],
                "reason": self.reason,
            },
            where="validation stage snapshot",
        )

    @classmethod
    def from_dict(cls, value: Any, *, where: str = "validation stage") -> Self:
        item = _exact_keys(value, {"state", "issues", "reason"}, where=where)
        if type(item["issues"]) is not list:
            raise EvidenceArtifactError(f"{where}.issues must be an array")
        return cls(state=item["state"], issues=tuple(item["issues"]), reason=item["reason"])


def observed(value: Any, *, source: str) -> ObservedValue:
    """Build an observed value without overloading ``None`` as unknown."""

    return ObservedValue("observed", value=value, source=source)


def captured_bytes(data: bytes, *, media_type: str, source: str) -> ObservedValue:
    """Retain exact already-sanitized bytes in a self-verifying JSON envelope."""

    if type(data) is not bytes:
        raise EvidenceArtifactError("captured byte data must be bytes")
    _nonempty(media_type, where="captured byte media_type")
    return observed(
        {
            "format": EVIDENCE_BYTES_FORMAT,
            "media_type": media_type,
            "bytes": len(data),
            "sha256": sha256_bytes(data),
            "base64": base64.b64encode(data).decode("ascii"),
        },
        source=source,
    )


def unknown(reason: str) -> ObservedValue:
    """Build an explicitly unknown observation."""

    return ObservedValue("unknown", reason=reason)


def absent(reason: str) -> ObservedValue:
    """Build an explicitly absent observation."""

    return ObservedValue("absent", reason=reason)


def not_applicable(reason: str) -> ObservedValue:
    """Build an explicitly inapplicable observation."""

    return ObservedValue("not_applicable", reason=reason)


def _observation(value: ObservedValue | Mapping[str, Any], *, where: str) -> ObservedValue:
    if isinstance(value, ObservedValue):
        return value
    return ObservedValue.from_dict(value, where=where)


@dataclass(frozen=True)
class AttemptObservation:
    """Terminal evidence for one recorded adapter-boundary attempt.

    An interrupted start may be unknown; this never attests a downstream
    provider invocation or hidden SDK/gateway retries.
    """

    ended_at: datetime | str
    duration: ObservedValue | Mapping[str, Any]
    transport: ObservedValue | Mapping[str, Any]
    response_headers: ObservedValue | Mapping[str, Any]
    raw_response: ObservedValue | Mapping[str, Any]
    actual_route: ObservedValue | Mapping[str, Any]
    generation_ids: ObservedValue | Mapping[str, Any]
    finish: ObservedValue | Mapping[str, Any]
    refusal: ObservedValue | Mapping[str, Any]
    truncation: ObservedValue | Mapping[str, Any]
    raw_candidate: ObservedValue | Mapping[str, Any]
    raw_tool_arguments: ObservedValue | Mapping[str, Any]
    reasoning: ObservedValue | Mapping[str, Any]
    stages: Mapping[str, ValidationStage | Mapping[str, Any]]
    usage: Mapping[str, ObservedValue | Mapping[str, Any]]
    cost: ObservedValue | Mapping[str, Any]
    failure: Mapping[str, Any] | None = None
    next_action: Literal[
        "none",
        "http_retry",
        "apparatus_retry",
        "same_model_repair",
        "model_fallback",
        "transport_fallback",
    ] = "none"
    extensions: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "ended_at", _iso(self.ended_at, where="attempt ended_at"))
        for name in (
            "duration",
            "transport",
            "response_headers",
            "raw_response",
            "actual_route",
            "generation_ids",
            "finish",
            "refusal",
            "truncation",
            "raw_candidate",
            "raw_tool_arguments",
            "reasoning",
            "cost",
        ):
            object.__setattr__(
                self,
                name,
                _observation(getattr(self, name), where=f"attempt {name}"),
            )
        transport = cast(ObservedValue, self.transport)
        if transport.state == "observed":
            transport_value = _object(transport.value, where="attempt transport value")
            for key in ("outcome", "http_status"):
                if key not in transport_value:
                    raise EvidenceArtifactError(f"attempt transport is missing {key!r}")
            outcome = transport_value["outcome"]
            if not isinstance(outcome, str) or outcome not in {
                "response",
                "http_error",
                "transport_error",
                "cancelled",
                "timeout",
            }:
                raise EvidenceArtifactError("attempt transport outcome is invalid")
            http_status = transport_value["http_status"]
            if http_status is not None:
                _integer(
                    http_status, where="attempt transport http_status", minimum=100, maximum=599
                )

        actual_route = cast(ObservedValue, self.actual_route)
        if actual_route.state == "observed":
            route_value = _object(actual_route.value, where="attempt actual_route value")
            for key in ("model", "provider"):
                if key not in route_value:
                    raise EvidenceArtifactError(f"attempt actual_route is missing {key!r}")
                _nonempty(route_value[key], where=f"attempt actual_route.{key}")

        response_headers = cast(ObservedValue, self.response_headers)
        if response_headers.state == "observed":
            headers = _object(response_headers.value, where="attempt response_headers value")
            if not all(
                isinstance(key, str) and isinstance(value, str) for key, value in headers.items()
            ):
                raise EvidenceArtifactError(
                    "attempt response_headers must map strings to strings after sanitization"
                )

        generation_ids = cast(ObservedValue, self.generation_ids)
        if generation_ids.state == "observed":
            _object(generation_ids.value, where="attempt generation_ids value")

        finish = cast(ObservedValue, self.finish)
        if finish.state == "observed":
            finish_value = _object(finish.value, where="attempt finish value")
            for key in ("native", "normalized"):
                if key not in finish_value:
                    raise EvidenceArtifactError(f"attempt finish is missing {key!r}")
                _nonempty(finish_value[key], where=f"attempt finish.{key}")

        refusal = cast(ObservedValue, self.refusal)
        if refusal.state == "observed":
            refusal_value = _object(refusal.value, where="attempt refusal value")
            if type(refusal_value.get("detected")) is not bool:
                raise EvidenceArtifactError("attempt refusal.detected must be a boolean")

        truncation = cast(ObservedValue, self.truncation)
        if truncation.state == "observed":
            truncation_value = _object(truncation.value, where="attempt truncation value")
            if type(truncation_value.get("detected")) is not bool:
                raise EvidenceArtifactError("attempt truncation.detected must be a boolean")

        reasoning = cast(ObservedValue, self.reasoning)
        if reasoning.state == "observed":
            reasoning_value = _object(reasoning.value, where="attempt reasoning value")
            if type(reasoning_value.get("present")) is not bool:
                raise EvidenceArtifactError("attempt reasoning.present must be a boolean")
        duration = cast(ObservedValue, self.duration)
        if duration.state == "observed":
            if (
                isinstance(duration.value, bool)
                or not isinstance(duration.value, (int, float))
                or not math.isfinite(duration.value)
                or duration.value < 0
            ):
                raise EvidenceArtifactError(
                    "observed attempt duration must be a finite nonnegative number of milliseconds"
                )

        if not isinstance(self.stages, Mapping):
            raise EvidenceArtifactError("attempt stages must be an object")
        if set(self.stages) != set(_STAGES):
            raise EvidenceArtifactError(f"attempt stages must contain exactly {list(_STAGES)}")
        stages: dict[str, ValidationStage] = {}
        for name in _STAGES:
            value = self.stages[name]
            stages[name] = (
                value
                if isinstance(value, ValidationStage)
                else ValidationStage.from_dict(value, where=f"attempt stage {name}")
            )
        if stages["parse"].state != "pass" and stages["schema"].state in {"pass", "fail"}:
            raise EvidenceArtifactError("attempt stage schema ran after parse did not pass")
        if stages["schema"].state != "pass" and stages["semantic"].state in {
            "pass",
            "fail",
        }:
            raise EvidenceArtifactError("attempt stage semantic ran after schema did not pass")
        if stages["schema"].state != "pass" and stages["decode"].state in {"pass", "fail"}:
            raise EvidenceArtifactError("attempt stage decode ran after schema did not pass")
        if stages["semantic"].state == "fail" and stages["decode"].state in {"pass", "fail"}:
            raise EvidenceArtifactError("attempt stage decode ran after semantic failed")
        object.__setattr__(self, "stages", stages)

        token_names = {"input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"}
        if not isinstance(self.usage, Mapping):
            raise EvidenceArtifactError("attempt usage must be an object")
        if set(self.usage) != token_names:
            raise EvidenceArtifactError(f"attempt usage must contain exactly {sorted(token_names)}")
        usage: dict[str, ObservedValue] = {}
        for name in sorted(token_names):
            item = _observation(self.usage[name], where=f"attempt usage {name}")
            if item.state == "observed":
                _integer(item.value, where=f"attempt usage {name}", maximum=TOKEN_COUNT_MAX)
            usage[name] = item
        object.__setattr__(self, "usage", usage)

        cost = cast(ObservedValue, self.cost)
        if cost.state == "observed":
            item = _exact_keys(cost.value, {"amount", "currency"}, where="attempt cost value")
            amount = item["amount"]
            if not isinstance(amount, str):
                raise EvidenceArtifactError("attempt cost amount must be a decimal string")
            try:
                decimal = Decimal(amount)
            except InvalidOperation as error:
                raise EvidenceArtifactError(
                    "attempt cost amount must be a decimal string"
                ) from error
            if not decimal.is_finite() or decimal < 0:
                raise EvidenceArtifactError("attempt cost amount must be finite and nonnegative")
            _nonempty(item["currency"], where="attempt cost currency")
        if self.failure is not None:
            failure = _object(self.failure, where="attempt failure")
            for key in ("kind", "type", "message"):
                if key not in failure:
                    raise EvidenceArtifactError(f"attempt failure is missing {key!r}")
                _nonempty(failure[key], where=f"attempt failure.{key}")
            object.__setattr__(self, "failure", failure)
        if not isinstance(self.next_action, str) or (
            self.next_action != "none" and self.next_action not in _RECOVERIES
        ):
            raise EvidenceArtifactError(f"invalid next_action {self.next_action!r}")
        object.__setattr__(self, "extensions", _object(self.extensions, where="attempt extensions"))

    def as_dict(self) -> dict[str, JsonValue]:
        def value(name: str) -> dict[str, JsonValue]:
            return cast(ObservedValue, getattr(self, name)).as_dict()

        return _object(
            {
                "ended_at": cast(str, self.ended_at),
                "duration": value("duration"),
                "transport": value("transport"),
                "response_headers": value("response_headers"),
                "raw_response": value("raw_response"),
                "actual_route": value("actual_route"),
                "generation_ids": value("generation_ids"),
                "finish": value("finish"),
                "refusal": value("refusal"),
                "truncation": value("truncation"),
                "raw_candidate": value("raw_candidate"),
                "raw_tool_arguments": value("raw_tool_arguments"),
                "reasoning": value("reasoning"),
                "stages": {
                    name: cast(ValidationStage, self.stages[name]).as_dict() for name in _STAGES
                },
                "usage": {
                    name: cast(ObservedValue, item).as_dict() for name, item in self.usage.items()
                },
                "cost": value("cost"),
                "failure": dict(self.failure) if self.failure is not None else None,
                "next_action": self.next_action,
                "extensions": dict(self.extensions),
            },
            where="attempt observation snapshot",
        )

    @classmethod
    def from_dict(cls, value: Any, *, where: str = "attempt observation") -> Self:
        item = _exact_keys(
            value,
            {
                "ended_at",
                "duration",
                "transport",
                "response_headers",
                "raw_response",
                "actual_route",
                "generation_ids",
                "finish",
                "refusal",
                "truncation",
                "raw_candidate",
                "raw_tool_arguments",
                "reasoning",
                "stages",
                "usage",
                "cost",
                "failure",
                "next_action",
                "extensions",
            },
            where=where,
        )
        return cls(**item)


def _validate_cost_currency(
    observation: AttemptObservation,
    protocol: CampaignProtocol,
    *,
    where: str,
) -> None:
    cost = cast(ObservedValue, observation.cost)
    if cost.state != "observed":
        return
    value = cast(dict[str, JsonValue], cost.value)
    observed_currency = cast(str, value["currency"])
    frozen_currency = cast(str, protocol.pricing["currency"])
    if observed_currency != frozen_currency:
        raise EvidenceArtifactError(
            f"{where} cost currency {observed_currency!r} differs from "
            f"frozen pricing currency {frozen_currency!r}"
        )


@dataclass(frozen=True)
class RootObservation:
    """Terminal client-owned outcome for one planned root."""

    status: Literal["observed", "not_evaluable"]
    ended_at: datetime | str
    duration: ObservedValue | Mapping[str, Any]
    selected_attempt_id: str | None
    outcome: ObservedValue | Mapping[str, Any]
    signals: Mapping[str, Any]
    reason: str | None = None
    extensions: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.status, str) or self.status not in {"observed", "not_evaluable"}:
            raise EvidenceArtifactError("root status must be 'observed' or 'not_evaluable'")
        object.__setattr__(self, "ended_at", _iso(self.ended_at, where="root ended_at"))
        object.__setattr__(self, "duration", _observation(self.duration, where="root duration"))
        duration = cast(ObservedValue, self.duration)
        if duration.state == "observed":
            if (
                isinstance(duration.value, bool)
                or not isinstance(duration.value, (int, float))
                or not math.isfinite(duration.value)
                or duration.value < 0
            ):
                raise EvidenceArtifactError(
                    "observed root duration must be a finite nonnegative number of milliseconds"
                )
        object.__setattr__(self, "outcome", _observation(self.outcome, where="root outcome"))
        object.__setattr__(self, "signals", _object(self.signals, where="root signals"))
        object.__setattr__(self, "extensions", _object(self.extensions, where="root extensions"))
        if self.status == "observed":
            if self.selected_attempt_id is None:
                raise EvidenceArtifactError("observed roots require selected_attempt_id")
            if self.reason is not None:
                raise EvidenceArtifactError("observed roots cannot have a not-evaluable reason")
            if cast(ObservedValue, self.outcome).state != "observed":
                raise EvidenceArtifactError("observed roots require an observed app-owned outcome")
        else:
            if self.selected_attempt_id is not None:
                raise EvidenceArtifactError("not-evaluable roots cannot select an attempt")
            _nonempty(self.reason, where="not-evaluable root reason")
            if cast(ObservedValue, self.outcome).state == "observed":
                raise EvidenceArtifactError("not-evaluable roots cannot claim an observed outcome")
        if self.selected_attempt_id is not None:
            if not _SHA256.fullmatch(self.selected_attempt_id):
                raise EvidenceArtifactError("selected_attempt_id must be a full lowercase sha256")

    def as_dict(self) -> dict[str, JsonValue]:
        return _object(
            {
                "status": self.status,
                "ended_at": cast(str, self.ended_at),
                "duration": cast(ObservedValue, self.duration).as_dict(),
                "selected_attempt_id": self.selected_attempt_id,
                "outcome": cast(ObservedValue, self.outcome).as_dict(),
                "signals": dict(self.signals),
                "reason": self.reason,
                "extensions": dict(self.extensions),
            },
            where="root observation snapshot",
        )

    @classmethod
    def from_dict(cls, value: Any, *, where: str = "root observation") -> Self:
        item = _exact_keys(
            value,
            {
                "status",
                "ended_at",
                "duration",
                "selected_attempt_id",
                "outcome",
                "signals",
                "reason",
                "extensions",
            },
            where=where,
        )
        return cls(**item)


@dataclass(frozen=True)
class EvidenceIssue:
    """Stable, machine-readable validation finding."""

    severity: Literal["error", "warning"]
    code: str
    path: tuple[str | int, ...]
    message: str
    root_id: str | None = None
    attempt_id: str | None = None


@dataclass(frozen=True)
class EvidenceValidationReport:
    """Independent integrity and completeness result for a bundle."""

    integrity: Literal["valid", "invalid"]
    status: BundleStatus
    campaign_id: str | None
    dimensions: Mapping[str, Literal["complete", "incomplete", "unknown"]]
    counts: Mapping[str, int]
    issues: tuple[EvidenceIssue, ...]

    @property
    def valid(self) -> bool:
        return self.integrity == "valid"

    @property
    def complete(self) -> bool:
        return self.valid and self.status == "complete"

    def assert_valid(self, *, require_complete: bool = False) -> None:
        if not self.valid:
            details = "; ".join(f"{issue.code}: {issue.message}" for issue in self.issues[:5])
            raise EvidenceArtifactError(f"invalid evidence bundle: {details}")
        if require_complete and self.status != "complete":
            raise EvidenceIncomplete(f"evidence bundle status is {self.status}, not complete")


@dataclass(frozen=True)
class _BundleData:
    protocol: CampaignProtocol
    protocol_document: dict[str, Any]
    registration: dict[str, Any]
    journal: tuple[dict[str, Any], ...]
    attempts: tuple[dict[str, Any], ...]
    roots: tuple[dict[str, Any], ...]
    manifest: dict[str, Any] | None
    summary: dict[str, Any] | None


@dataclass(frozen=True)
class _State:
    root_starts: dict[str, dict[str, Any]]
    attempt_starts: dict[str, dict[str, Any]]
    attempt_terminals: dict[str, dict[str, Any]]
    root_terminals: dict[str, dict[str, Any]]
    resolutions: dict[str, dict[str, Any]]
    max_sequence: int

    @property
    def ambiguous_attempt_ids(self) -> tuple[str, ...]:
        return tuple(sorted(set(self.attempt_starts) - set(self.attempt_terminals)))


def _abandoned_attempt_ids(state: _State, root_id: str) -> tuple[str, ...]:
    return tuple(
        sorted(
            attempt_id
            for attempt_id, resolution in state.resolutions.items()
            if resolution.get("action") == "abandon"
            and state.attempt_starts[attempt_id].get("root_id") == root_id
        )
    )


def _latest_recorded_event_at(state: _State) -> datetime | None:
    values = [
        _parse_time(terminal["observation"]["ended_at"], where="attempt ended_at")
        for terminal in state.attempt_terminals.values()
    ]
    values.extend(
        _parse_time(terminal["observation"]["ended_at"], where="root ended_at")
        for terminal in state.root_terminals.values()
    )
    values.extend(
        _parse_time(resolution["resolved_at"], where="ambiguity resolved_at")
        for resolution in state.resolutions.values()
    )
    return max(values) if values else None


def _artifact_ids(protocol: CampaignProtocol) -> set[str]:
    ids: set[str] = set()

    def visit(value: Any, *, where: str) -> None:
        if value is None:
            return
        if isinstance(value, str):
            ids.add(_safe_id(value, where=where))
            return
        if type(value) is list or isinstance(value, tuple):
            for index, item in enumerate(value):
                visit(item, where=f"{where}[{index}]")
            return
        if type(value) is dict:
            for key, item in value.items():
                visit(item, where=f"{where}.{key}")
            return
        raise EvidenceArtifactError(f"{where} must contain only artifact ids")

    def visit_reference(value: Any, *, where: str) -> None:
        reference = _artifact_reference(value, where=where)
        if reference.state == "observed":
            ids.add(cast(str, reference.value))

    visit(protocol.artifact_roles, where="artifact_roles")
    execution = protocol.execution
    visit_reference(
        execution["runner_entrypoint_artifact"],
        where="execution.runner_entrypoint_artifact",
    )
    visit(execution["dependency_artifact_ids"], where="execution.dependency_artifact_ids")
    visit_reference(execution["dirty_patch_artifact"], where="execution.dirty_patch_artifact")
    visit_reference(
        execution["dependency_lock_artifact"],
        where="execution.dependency_lock_artifact",
    )
    pricing = protocol.pricing
    visit_reference(pricing["source_artifact"], where="pricing.source_artifact")
    visit_reference(pricing["tariff_artifact"], where="pricing.tariff_artifact")
    visit_reference(
        protocol.sanitization["implementation_artifact"],
        where="sanitization.implementation_artifact",
    )
    return ids


def _record(kind: str, sequence: int, payload: Mapping[str, Any]) -> dict[str, JsonValue]:
    cloned = _object(payload, where=f"{kind} payload")
    return {
        "format": RECORD_FORMAT,
        "version": FORMAT_VERSION,
        "sequence": sequence,
        "kind": kind,
        "payload_sha256": sha256_bytes(canonical_json_bytes(cloned, where=f"{kind} payload")),
        "payload": cloned,
    }


def _unwrap_record(value: Any, *, where: str, kinds: set[str]) -> tuple[int, str, dict[str, Any]]:
    record = _exact_keys(
        value,
        {"format", "version", "sequence", "kind", "payload_sha256", "payload"},
        where=where,
    )
    if record["format"] != RECORD_FORMAT or record["version"] != FORMAT_VERSION:
        raise EvidenceArtifactError(f"{where} has unsupported record format/version")
    sequence = _integer(record["sequence"], where=f"{where}.sequence")
    kind = record["kind"]
    if not isinstance(kind, str) or kind not in kinds:
        raise EvidenceArtifactError(f"{where}.kind must be one of {sorted(kinds)}")
    payload = _object(record["payload"], where=f"{where}.payload")
    digest = record["payload_sha256"]
    expected = sha256_bytes(canonical_json_bytes(payload, where=f"{where}.payload"))
    if digest != expected:
        raise EvidenceArtifactError(f"{where}.payload_sha256 does not match its payload")
    return sequence, kind, payload


def _state_from_records(
    journal: Iterable[dict[str, Any]],
    attempts: Iterable[dict[str, Any]],
    roots: Iterable[dict[str, Any]],
) -> _State:
    combined: list[tuple[int, str, dict[str, Any], str]] = []
    for index, value in enumerate(journal, 1):
        sequence, kind, payload = _unwrap_record(
            value,
            where=f"journal.jsonl:{index}",
            kinds={"root_started", "attempt_started", "ambiguity_resolved"},
        )
        combined.append((sequence, kind, payload, f"journal.jsonl:{index}"))
    for index, value in enumerate(attempts, 1):
        sequence, kind, payload = _unwrap_record(
            value,
            where=f"attempts.jsonl:{index}",
            kinds={"attempt_terminal"},
        )
        combined.append((sequence, kind, payload, f"attempts.jsonl:{index}"))
    for index, value in enumerate(roots, 1):
        sequence, kind, payload = _unwrap_record(
            value,
            where=f"roots.jsonl:{index}",
            kinds={"root_terminal"},
        )
        combined.append((sequence, kind, payload, f"roots.jsonl:{index}"))
    combined.sort(key=lambda item: item[0])
    sequences = [item[0] for item in combined]
    if sequences != list(range(len(sequences))):
        raise EvidenceArtifactError(
            "record sequence must be globally unique and contiguous from zero"
        )

    root_starts: dict[str, dict[str, Any]] = {}
    attempt_starts: dict[str, dict[str, Any]] = {}
    attempt_terminals: dict[str, dict[str, Any]] = {}
    root_terminals: dict[str, dict[str, Any]] = {}
    resolutions: dict[str, dict[str, Any]] = {}
    for _, kind, payload, where in combined:
        if kind == "root_started":
            root_id = _safe_id(payload.get("root_id"), where=f"{where}.payload.root_id")
            if root_id in root_starts:
                raise EvidenceArtifactError(f"duplicate root start for {root_id!r}")
            root_starts[root_id] = payload
        elif kind == "attempt_started":
            attempt_id = payload.get("attempt_id")
            if not isinstance(attempt_id, str) or _SHA256.fullmatch(attempt_id) is None:
                raise EvidenceArtifactError(f"{where}.payload.attempt_id must be a full sha256")
            if attempt_id in attempt_starts:
                raise EvidenceArtifactError(f"duplicate attempt start {attempt_id}")
            root_id = _safe_id(payload.get("root_id"), where=f"{where}.payload.root_id")
            if root_id not in root_starts:
                raise EvidenceArtifactError(f"{where} starts an attempt before its root")
            if root_id in root_terminals:
                raise EvidenceArtifactError(f"{where} starts an attempt after its root terminal")
            if any(
                start.get("root_id") == root_id and prior_id not in attempt_terminals
                for prior_id, start in attempt_starts.items()
            ):
                raise EvidenceArtifactError(
                    f"{where} starts a second attempt before its predecessor terminal"
                )
            attempt_starts[attempt_id] = payload
        elif kind == "ambiguity_resolved":
            attempt_id = payload.get("attempt_id")
            if not isinstance(attempt_id, str) or attempt_id not in attempt_starts:
                raise EvidenceArtifactError(f"{where} resolves an unknown attempt")
            if attempt_id in resolutions:
                raise EvidenceArtifactError(f"duplicate ambiguity resolution for {attempt_id}")
            if attempt_id in attempt_terminals:
                raise EvidenceArtifactError(f"{where} resolves an already terminal attempt")
            resolutions[attempt_id] = payload
        elif kind == "attempt_terminal":
            attempt_id = payload.get("attempt_id")
            if not isinstance(attempt_id, str) or attempt_id not in attempt_starts:
                raise EvidenceArtifactError(f"{where} terminates an unknown attempt")
            if attempt_id in attempt_terminals:
                raise EvidenceArtifactError(f"duplicate attempt terminal {attempt_id}")
            root_id = attempt_starts[attempt_id].get("root_id")
            if root_id in root_terminals:
                raise EvidenceArtifactError(f"{where} terminates an attempt after its root")
            attempt_terminals[attempt_id] = payload
        else:
            root_id = _safe_id(payload.get("root_id"), where=f"{where}.payload.root_id")
            if root_id not in root_starts:
                raise EvidenceArtifactError(f"{where} terminates a root that never started")
            if root_id in root_terminals:
                raise EvidenceArtifactError(f"duplicate root terminal {root_id!r}")
            open_attempts = [
                attempt_id
                for attempt_id, start in attempt_starts.items()
                if start.get("root_id") == root_id and attempt_id not in attempt_terminals
            ]
            if open_attempts:
                raise EvidenceArtifactError(
                    f"{where} terminates root with open attempts: {open_attempts}"
                )
            root_terminals[root_id] = payload

    return _State(
        root_starts=root_starts,
        attempt_starts=attempt_starts,
        attempt_terminals=attempt_terminals,
        root_terminals=root_terminals,
        resolutions=resolutions,
        max_sequence=sequences[-1] if sequences else -1,
    )


class EvidenceWriter:
    """Single-owner append-only writer for one local evidence bundle."""

    def __init__(
        self,
        path: Path,
        protocol: CampaignProtocol,
        lock: CampaignLock,
        state: _State,
        *,
        clock: Callable[[], datetime],
        registered_at: str,
        resumed_ambiguous: Iterable[str] = (),
    ) -> None:
        self._path = path
        self._protocol = CampaignProtocol.from_dict(protocol.as_dict())
        self._lock = lock
        self._state = state
        self._clock = clock
        self._registered_at = _iso(registered_at, where="registered_at")
        self._mutex = threading.RLock()
        self._closed = False
        self._sealed = (path / "manifest.json").exists()
        self._poisoned: str | None = None
        self._resumed_ambiguous = set(resumed_ambiguous)
        self._planned = {root.root_id: root for root in self._protocol.planned_roots}

    @property
    def path(self) -> Path:
        """The immutable absolute directory protected by this writer's lock."""

        return self._path

    @property
    def protocol(self) -> CampaignProtocol:
        """Return a detached snapshot; mutating nested caller data cannot alter the run."""

        return CampaignProtocol.from_dict(self._protocol.as_dict())

    @classmethod
    def create(
        cls,
        path: str | os.PathLike[str],
        protocol: CampaignProtocol,
        artifacts: Iterable[FrozenArtifact] = (),
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> Self:
        """Freeze a new campaign and return only after registration is durable."""

        if not isinstance(protocol, CampaignProtocol):
            raise EvidenceArtifactError("protocol must be a CampaignProtocol")
        frozen_protocol = CampaignProtocol.from_dict(protocol.as_dict())
        out = Path(path)
        out = ensure_safe_bundle_root(out)
        lock = CampaignLock(out / ".evidence.lock")
        try:
            lock.acquire()
        except RunLocked as error:
            raise EvidenceBundleLocked(str(error)) from error
        except LockUnavailable as error:
            raise EvidenceLockUnavailable(str(error)) from error
        except BenchArtifactError as error:
            raise _evidence_error(error) from error

        now = clock or _now
        try:
            _assert_lock_owned(lock)
            occupied = sorted(item.name for item in out.iterdir() if item.name != ".evidence.lock")
            if occupied:
                raise EvidenceStateError(f"evidence bundle directory is not empty: {occupied}")
            try:
                supplied = tuple(artifacts)
            except TypeError as error:
                raise EvidenceArtifactError(
                    "artifacts must be an iterable of FrozenArtifact values"
                ) from error
            if not all(isinstance(item, FrozenArtifact) for item in supplied):
                raise EvidenceArtifactError("artifacts must contain FrozenArtifact values")
            ids = [item.id for item in supplied]
            if len(ids) != len(set(ids)):
                raise EvidenceArtifactError("artifact ids must be unique")
            required = _artifact_ids(frozen_protocol)
            missing = sorted(required - set(ids))
            extra = sorted(set(ids) - required)
            if missing or extra:
                raise EvidenceArtifactError(
                    f"artifact closure mismatch (missing={missing}, unreferenced={extra})"
                )
            artifact_index: list[dict[str, JsonValue]] = []
            written: set[str] = set()
            for artifact in sorted(supplied, key=lambda item: item.id):
                digest = sha256_bytes(artifact.data)
                relative = f"artifacts/sha256/{digest}"
                target = out.joinpath(*PurePosixPath(relative).parts)
                if digest not in written:
                    _assert_lock_owned(lock)
                    atomic_write_bytes(target, artifact.data)
                    written.add(digest)
                artifact_index.append(
                    {
                        "id": artifact.id,
                        "media_type": artifact.media_type,
                        "path": relative,
                        "sha256": digest,
                        "bytes": len(artifact.data),
                    }
                )
            protocol_document: dict[str, Any] = {
                "format": FORMAT,
                "version": FORMAT_VERSION,
                "campaign": frozen_protocol.as_dict(),
                "artifacts": artifact_index,
            }
            protocol_bytes = canonical_json_bytes(protocol_document, where="protocol") + b"\n"
            _assert_lock_owned(lock)
            atomic_write_bytes(out / "protocol.json", protocol_bytes)
            for name in ("journal.jsonl", "attempts.jsonl", "roots.jsonl"):
                _assert_lock_owned(lock)
                atomic_write_bytes(out / name, b"")
            registered_at = _iso(now(), where="registration clock")
            registration: dict[str, JsonValue] = {
                "format": FORMAT,
                "version": FORMAT_VERSION,
                "campaign_id": frozen_protocol.campaign_id,
                "protocol_sha256": sha256_bytes(protocol_bytes),
                "artifact_count": len(supplied),
                "registered_at": registered_at,
            }
            _assert_lock_owned(lock)
            atomic_write_bytes(
                out / "registration.json",
                canonical_json_bytes(registration, where="registration") + b"\n",
            )
            _assert_lock_owned(lock)
            state = _State({}, {}, {}, {}, {}, -1)
            return cls(
                out,
                frozen_protocol,
                lock,
                state,
                clock=now,
                registered_at=registered_at,
            )
        except BaseException:
            lock.release()
            raise

    @classmethod
    def resume(
        cls,
        path: str | os.PathLike[str],
        *,
        protocol: CampaignProtocol | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> Self:
        """Resume an unsealed valid bundle without hiding interrupted attempts."""

        out = ensure_safe_bundle_root(Path(path))
        lock = CampaignLock(out / ".evidence.lock")
        try:
            lock.acquire()
        except RunLocked as error:
            raise EvidenceBundleLocked(str(error)) from error
        except LockUnavailable as error:
            raise EvidenceLockUnavailable(str(error)) from error
        except BenchArtifactError as error:
            raise _evidence_error(error) from error
        try:
            _assert_lock_owned(lock)
            data = _load_bundle(out)
            _assert_lock_owned(lock)
            if data.manifest is not None:
                raise EvidenceStateError("sealed evidence bundles are immutable")
            if protocol is not None:
                frozen = canonical_json_bytes(data.protocol.as_dict(), where="frozen protocol")
                requested = canonical_json_bytes(protocol.as_dict(), where="resume protocol")
                if frozen != requested:
                    raise EvidenceResumeMismatch("resume protocol differs from the frozen protocol")
            state = _validate_semantics(data, sealed=False)
            if data.summary is not None:
                derived_status = data.summary.get("status")
                if not isinstance(derived_status, str) or derived_status not in {
                    "complete",
                    "not_evaluable",
                }:
                    raise EvidenceArtifactError("partial summary has invalid status")
                expected_summary = _derive_summary(
                    data.protocol,
                    state,
                    status=derived_status,
                )
                if canonical_json_bytes(
                    data.summary, where="partial summary"
                ) != canonical_json_bytes(expected_summary, where="derived partial summary"):
                    raise EvidenceArtifactError("partial summary drift")
            return cls(
                out,
                data.protocol,
                lock,
                state,
                clock=clock or _now,
                registered_at=cast(str, data.registration["registered_at"]),
                resumed_ambiguous=state.ambiguous_attempt_ids,
            )
        except (TypeError, AttributeError, KeyError) as error:
            lock.release()
            raise EvidenceArtifactError(f"malformed evidence bundle: {error}") from error
        except BaseException:
            lock.release()
            raise

    def __enter__(self) -> Self:
        self._ensure_open(allow_sealed=True)
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()

    @property
    def ambiguous_attempt_ids(self) -> tuple[str, ...]:
        with self._mutex:
            return self._state.ambiguous_attempt_ids

    def close(self) -> None:
        with self._mutex:
            if self._closed:
                return
            self._closed = True
            self._lock.release()

    def _ensure_open(self, *, allow_sealed: bool = False) -> None:
        if self._closed:
            raise EvidenceStateError("evidence writer is closed")
        if self._poisoned is not None:
            raise EvidenceStateError(
                "evidence writer state is uncertain after a durable-write verification failure; "
                f"close and independently validate/resume it ({self._poisoned})"
            )
        self._assert_owned()
        if self._sealed and not allow_sealed:
            raise EvidenceStateError("sealed evidence bundles are immutable")

    def _assert_owned(self) -> None:
        try:
            self._lock.assert_owned()
        except BenchArtifactError as error:
            self._poisoned = str(error)
            raise EvidenceStateError(
                "evidence campaign path no longer identifies the locked directory; "
                "writer is now fail-closed"
            ) from error

    def _refresh(self) -> None:
        self._assert_owned()
        journal = strict_load_jsonl(self._path / "journal.jsonl", where="journal.jsonl")
        self._assert_owned()
        attempts = strict_load_jsonl(self._path / "attempts.jsonl", where="attempts.jsonl")
        self._assert_owned()
        roots = strict_load_jsonl(self._path / "roots.jsonl", where="roots.jsonl")
        self._assert_owned()
        self._state = _state_from_records(journal, attempts, roots)

    def _append(self, filename: str, kind: str, payload: Mapping[str, Any]) -> None:
        sequence = self._state.max_sequence + 1
        record = _record(kind, sequence, payload)
        try:
            self._assert_owned()
            append_jsonl(
                self._path / filename,
                record,
                where=f"{filename} {kind}",
            )
            self._assert_owned()
            self._refresh()
        except BaseException as error:
            self._poisoned = str(error)
            if isinstance(error, Exception):
                raise EvidenceArtifactError(
                    "record append may be durable but could not be verified; writer is now fail-closed"
                ) from error
            raise

    def _assert_reconciled(self) -> None:
        unresolved = self._resumed_ambiguous & set(self._state.ambiguous_attempt_ids)
        if unresolved:
            raise AmbiguousEvidenceAttempt(
                "interrupted attempts require explicit resolution before new paid work: "
                + ", ".join(sorted(unresolved))
            )

    def start_root(self, root_id: str) -> None:
        """Durably mark a planned root started."""

        with self._mutex:
            self._ensure_open()
            self._assert_reconciled()
            root_id = _safe_id(root_id, where="root_id")
            if root_id not in self._planned:
                raise EvidenceStateError(f"root {root_id!r} is not in the frozen population")
            if root_id in self._state.root_starts:
                raise EvidenceStateError(f"root {root_id!r} already started")
            plan = self._planned[root_id]
            started_at = _iso(self._clock(), where="root start clock")
            if _parse_time(started_at, where="root started_at") < _parse_time(
                self._registered_at, where="registration registered_at"
            ):
                raise EvidenceStateError("root started_at precedes campaign registration")
            self._append(
                "journal.jsonl",
                "root_started",
                {
                    "campaign_id": self._protocol.campaign_id,
                    "root_id": root_id,
                    "planned_root": plan.as_dict(),
                    "started_at": started_at,
                },
            )

    def start_attempt(
        self,
        root_id: str,
        *,
        logical_request: ObservedValue | Mapping[str, Any],
        effective_request: ObservedValue | Mapping[str, Any],
        requested_route: Mapping[str, Any],
        purpose: Literal[
            "initial",
            "http_retry",
            "apparatus_retry",
            "same_model_repair",
            "model_fallback",
            "transport_fallback",
        ] = "initial",
        predecessor_attempt_id: str | None = None,
        policy_id: str | None = None,
        execution_generation: int = 1,
        possible_duplicate: bool = False,
    ) -> str:
        """Fsync request conditions before the caller crosses the paid boundary."""

        with self._mutex:
            self._ensure_open()
            self._assert_reconciled()
            root_id = _safe_id(root_id, where="root_id")
            if root_id not in self._state.root_starts:
                raise EvidenceStateError(f"root {root_id!r} must start before an attempt")
            if root_id in self._state.root_terminals:
                raise EvidenceStateError(f"root {root_id!r} is already terminal")
            if not isinstance(purpose, str) or purpose not in _PURPOSES:
                raise EvidenceStateError(f"unsupported attempt purpose {purpose!r}")
            _integer(execution_generation, where="execution_generation", minimum=1)
            if type(possible_duplicate) is not bool:
                raise EvidenceArtifactError("possible_duplicate must be a boolean")

            starts = sorted(
                (
                    payload
                    for payload in self._state.attempt_starts.values()
                    if payload.get("root_id") == root_id
                ),
                key=lambda payload: cast(int, payload["ordinal"]),
            )
            if any(
                payload["attempt_id"] not in self._state.attempt_terminals for payload in starts
            ):
                raise EvidenceStateError(
                    "a root cannot start a second attempt before the prior terminal"
                )
            ordinal = len(starts)
            policy: JsonValue | None = None
            if ordinal == 0:
                if (
                    purpose != "initial"
                    or predecessor_attempt_id is not None
                    or policy_id is not None
                ):
                    raise EvidenceStateError(
                        "the first attempt must be initial without predecessor or recovery policy"
                    )
                if possible_duplicate:
                    raise EvidenceStateError(
                        "an initial attempt cannot be marked possible_duplicate"
                    )
                if execution_generation != 1:
                    raise EvidenceStateError("an initial attempt must use execution_generation=1")
            else:
                previous = starts[-1]
                expected_predecessor = cast(str, previous["attempt_id"])
                if predecessor_attempt_id != expected_predecessor:
                    raise EvidenceStateError("recovery must name the immediately preceding attempt")
                terminal = self._state.attempt_terminals[expected_predecessor]
                expected_purpose = terminal["observation"]["next_action"]
                if purpose != expected_purpose or purpose == "initial":
                    raise EvidenceStateError(
                        f"recovery purpose {purpose!r} does not match predecessor action {expected_purpose!r}"
                    )
                if not policy_id:
                    raise EvidenceStateError("recovery attempts require a frozen policy_id")
                _safe_id(policy_id, where="recovery policy_id")
                policy_key = _POLICY_BY_PURPOSE[purpose]
                policy = self._protocol.retry_policies[policy_key]
                if type(policy) is dict and "id" in policy and policy["id"] != policy_id:
                    raise EvidenceStateError("recovery policy_id differs from the frozen policy")
                expected_generation = cast(int, previous["execution_generation"]) + 1
                if execution_generation != expected_generation:
                    raise EvidenceStateError(
                        "recovery execution_generation must increment its predecessor by one"
                    )
                resolution = self._state.resolutions.get(expected_predecessor)
                if (
                    resolution is not None
                    and resolution["action"] == "rerun"
                    and not possible_duplicate
                ):
                    raise EvidenceStateError(
                        "a rerun after an interrupted paid attempt must set possible_duplicate=true"
                    )

            logical = _observation(logical_request, where="logical_request")
            effective = _observation(effective_request, where="effective_request")
            route = _requested_route(requested_route, where="requested_route")
            if ordinal == 0:
                route_error = _planned_route_error(route, self._planned[root_id])
            else:
                route_error = _recovery_route_error(
                    purpose=purpose,
                    route=route,
                    predecessor_route=starts[-1]["requested_route"],
                    policy=policy,
                )
            if route_error is not None:
                raise EvidenceStateError(route_error)

            started_at = _iso(self._clock(), where="attempt start clock")
            lower_bound = self._state.root_starts[root_id]["started_at"]
            lower_bound_name = "root start"
            if ordinal > 0:
                predecessor_terminal = self._state.attempt_terminals[
                    cast(str, starts[-1]["attempt_id"])
                ]
                lower_bound = predecessor_terminal["observation"]["ended_at"]
                lower_bound_name = "predecessor terminal"
            if _parse_time(started_at, where="attempt started_at") < _parse_time(
                lower_bound, where=lower_bound_name
            ):
                raise EvidenceStateError(f"attempt started_at precedes its {lower_bound_name}")

            attempt_id = hashlib.sha256(
                canonical_json_bytes(
                    {
                        "campaign_id": self._protocol.campaign_id,
                        "root_id": root_id,
                        "ordinal": ordinal,
                    },
                    where="attempt identity",
                )
            ).hexdigest()
            if attempt_id in self._state.attempt_starts:
                raise EvidenceStateError(f"attempt {attempt_id} already exists")
            self._append(
                "journal.jsonl",
                "attempt_started",
                {
                    "campaign_id": self._protocol.campaign_id,
                    "root_id": root_id,
                    "attempt_id": attempt_id,
                    "ordinal": ordinal,
                    "purpose": purpose,
                    "predecessor_attempt_id": predecessor_attempt_id,
                    "policy_id": policy_id,
                    "execution_generation": execution_generation,
                    "possible_duplicate": possible_duplicate,
                    "started_at": started_at,
                    "logical_request": logical.as_dict(),
                    "effective_request": effective.as_dict(),
                    "requested_route": route,
                },
            )
            return attempt_id

    def record_attempt(self, attempt_id: str, observation: AttemptObservation) -> None:
        """Append and fsync one terminal attempt observation."""

        with self._mutex:
            self._ensure_open()
            if not isinstance(attempt_id, str) or _SHA256.fullmatch(attempt_id) is None:
                raise EvidenceStateError("attempt_id does not identify a started attempt")
            start = self._state.attempt_starts.get(attempt_id)
            if start is None:
                raise EvidenceStateError(f"attempt {attempt_id} never started")
            if attempt_id in self._resumed_ambiguous and attempt_id not in self._state.resolutions:
                raise AmbiguousEvidenceAttempt(
                    "an interrupted attempt requires resolve_ambiguous_attempt before terminalization"
                )
            if attempt_id in self._state.attempt_terminals:
                raise EvidenceStateError(f"attempt {attempt_id} is already terminal")
            root_id = cast(str, start["root_id"])
            if root_id in self._state.root_terminals:
                raise EvidenceStateError(f"root {root_id!r} is already terminal")
            if not isinstance(observation, AttemptObservation):
                raise EvidenceArtifactError("observation must be an AttemptObservation")
            _validate_cost_currency(
                observation,
                self._protocol,
                where=f"attempt {attempt_id}",
            )
            if _parse_time(observation.ended_at, where="attempt ended_at") < _parse_time(
                start["started_at"], where="attempt started_at"
            ):
                raise EvidenceArtifactError("attempt ended_at precedes its durable start")
            start_digest = sha256_bytes(
                canonical_json_bytes(start, where=f"attempt {attempt_id} start")
            )
            self._append(
                "attempts.jsonl",
                "attempt_terminal",
                {
                    "campaign_id": self._protocol.campaign_id,
                    "root_id": root_id,
                    "attempt_id": attempt_id,
                    "ordinal": start["ordinal"],
                    "start_payload_sha256": start_digest,
                    "purpose": start["purpose"],
                    "predecessor_attempt_id": start["predecessor_attempt_id"],
                    "policy_id": start["policy_id"],
                    "execution_generation": start["execution_generation"],
                    "possible_duplicate": start["possible_duplicate"],
                    "started_at": start["started_at"],
                    "logical_request": start["logical_request"],
                    "effective_request": start["effective_request"],
                    "requested_route": start["requested_route"],
                    "observation": observation.as_dict(),
                },
            )

    def resolve_ambiguous_attempt(
        self,
        attempt_id: str,
        action: Literal["rerun", "abandon", "reconciled"],
        *,
        evidence_ref: str | None = None,
        observation: AttemptObservation | None = None,
    ) -> None:
        """Resolve an interrupted paid boundary without erasing uncertainty.

        ``rerun`` records the interrupted attempt as unknown and permits a next
        ``apparatus_retry`` carrying ``possible_duplicate=True``. ``abandon``
        records unknown evidence so the root can terminate not-evaluable.
        ``reconciled`` requires caller-supplied terminal evidence and an
        immutable frozen artifact reference explaining the reconciliation.
        """

        with self._mutex:
            self._ensure_open()
            if not isinstance(attempt_id, str) or _SHA256.fullmatch(attempt_id) is None:
                raise EvidenceStateError("attempt_id does not identify a started attempt")
            if attempt_id not in self._state.attempt_starts:
                raise EvidenceStateError(f"attempt {attempt_id!r} never started")
            if attempt_id in self._state.attempt_terminals:
                raise EvidenceStateError(f"attempt {attempt_id} is already terminal")
            if attempt_id not in self._resumed_ambiguous:
                raise AmbiguousEvidenceAttempt(
                    "ambiguity resolution is restricted to an unterminated attempt "
                    "discovered by EvidenceWriter.resume"
                )
            if not isinstance(action, str) or action not in {
                "rerun",
                "abandon",
                "reconciled",
            }:
                raise EvidenceArtifactError(f"invalid ambiguity action {action!r}")
            if action == "reconciled":
                if observation is None or evidence_ref is None:
                    raise EvidenceArtifactError(
                        "reconciled ambiguity requires observation and evidence_ref"
                    )
                if not isinstance(observation, AttemptObservation):
                    raise EvidenceArtifactError(
                        "reconciled ambiguity observation must be an AttemptObservation"
                    )
                _validate_cost_currency(
                    observation,
                    self._protocol,
                    where=f"attempt {attempt_id}",
                )
                if _parse_time(observation.ended_at, where="attempt ended_at") < _parse_time(
                    self._state.attempt_starts[attempt_id]["started_at"],
                    where="attempt started_at",
                ):
                    raise EvidenceArtifactError("attempt ended_at precedes its durable start")
                _safe_id(evidence_ref, where="ambiguity evidence_ref")
                self._assert_owned()
                known_artifacts = {
                    item["id"]
                    for item in cast(
                        list[dict[str, Any]], _read_protocol_document(self._path)["artifacts"]
                    )
                }
                if evidence_ref not in known_artifacts:
                    raise EvidenceArtifactError("ambiguity evidence_ref is not a frozen artifact")
            elif evidence_ref is not None or observation is not None:
                raise EvidenceArtifactError(
                    f"{action} ambiguity resolution cannot attach reconciled observation/evidence"
                )
            existing_resolution = self._state.resolutions.get(attempt_id)
            if existing_resolution is None:
                resolved_at = _iso(self._clock(), where="ambiguity resolution clock")
                if _parse_time(resolved_at, where="ambiguity resolved_at") < _parse_time(
                    self._state.attempt_starts[attempt_id]["started_at"],
                    where="attempt started_at",
                ):
                    raise EvidenceStateError("ambiguity resolved_at precedes its attempt start")
                self._append(
                    "journal.jsonl",
                    "ambiguity_resolved",
                    {
                        "campaign_id": self._protocol.campaign_id,
                        "attempt_id": attempt_id,
                        "action": action,
                        "evidence_ref": evidence_ref,
                        "resolved_at": resolved_at,
                    },
                )
            elif (
                existing_resolution["action"] != action
                or existing_resolution["evidence_ref"] != evidence_ref
            ):
                raise EvidenceStateError("ambiguity already has a different durable resolution")
            else:
                resolved_at = cast(str, existing_resolution["resolved_at"])
            if observation is None:
                reason = f"interrupted attempt explicitly resolved as {action}"
                stage = ValidationStage("unknown", reason=reason)
                observation = AttemptObservation(
                    ended_at=resolved_at,
                    duration=unknown(reason),
                    transport=unknown(reason),
                    response_headers=unknown(reason),
                    raw_response=unknown(reason),
                    actual_route=unknown(reason),
                    generation_ids=unknown(reason),
                    finish=unknown(reason),
                    refusal=unknown(reason),
                    truncation=unknown(reason),
                    raw_candidate=unknown(reason),
                    raw_tool_arguments=unknown(reason),
                    reasoning=unknown(reason),
                    stages={name: stage for name in _STAGES},
                    usage={
                        name: unknown(reason)
                        for name in (
                            "input_tokens",
                            "output_tokens",
                            "cached_tokens",
                            "reasoning_tokens",
                        )
                    },
                    cost=unknown(reason),
                    failure={
                        "kind": "ambiguous_interruption",
                        "type": "AmbiguousEvidenceAttempt",
                        "message": reason,
                    },
                    next_action="apparatus_retry" if action == "rerun" else "none",
                )
            self.record_attempt(attempt_id, observation)
            self._resumed_ambiguous.discard(attempt_id)

    def record_root(self, root_id: str, observation: RootObservation) -> None:
        """Append one terminal root after all its attempts are terminal."""

        with self._mutex:
            self._ensure_open()
            root_id = _safe_id(root_id, where="root_id")
            start = self._state.root_starts.get(root_id)
            if start is None:
                raise EvidenceStateError(f"root {root_id!r} never started")
            if root_id in self._state.root_terminals:
                raise EvidenceStateError(f"root {root_id!r} is already terminal")
            if not isinstance(observation, RootObservation):
                raise EvidenceArtifactError("observation must be a RootObservation")
            if _parse_time(observation.ended_at, where="root ended_at") < _parse_time(
                start["started_at"], where="root started_at"
            ):
                raise EvidenceArtifactError("root ended_at precedes its durable start")
            starts = sorted(
                (
                    payload
                    for payload in self._state.attempt_starts.values()
                    if payload["root_id"] == root_id
                ),
                key=lambda payload: cast(int, payload["ordinal"]),
            )
            open_attempts = [
                payload["attempt_id"]
                for payload in starts
                if payload["attempt_id"] not in self._state.attempt_terminals
            ]
            if open_attempts:
                raise AmbiguousEvidenceAttempt(
                    f"root {root_id!r} has unterminated attempts: {open_attempts}"
                )
            attempt_ids = [cast(str, payload["attempt_id"]) for payload in starts]
            root_ended_at = _parse_time(observation.ended_at, where="root ended_at")
            for attempt_id in attempt_ids:
                attempt_ended_at = self._state.attempt_terminals[attempt_id]["observation"][
                    "ended_at"
                ]
                if root_ended_at < _parse_time(
                    attempt_ended_at, where=f"attempt {attempt_id} ended_at"
                ):
                    raise EvidenceArtifactError(
                        "root ended_at precedes one of its terminal attempts"
                    )
                resolution = self._state.resolutions.get(attempt_id)
                if resolution is not None and root_ended_at < _parse_time(
                    resolution["resolved_at"],
                    where=f"attempt {attempt_id} ambiguity resolved_at",
                ):
                    raise EvidenceArtifactError(
                        "root ended_at precedes one of its ambiguity resolutions"
                    )
            abandoned = _abandoned_attempt_ids(self._state, root_id)
            if abandoned and observation.status != "not_evaluable":
                raise EvidenceStateError(
                    f"root {root_id!r} has explicitly abandoned attempts and must be "
                    f"not_evaluable: {list(abandoned)}"
                )
            if observation.status == "observed":
                if observation.selected_attempt_id not in attempt_ids:
                    raise EvidenceStateError("root selected_attempt_id does not belong to the root")
                if not attempt_ids:
                    raise EvidenceStateError("an observed root must contain at least one attempt")
            if attempt_ids:
                last = self._state.attempt_terminals[attempt_ids[-1]]["observation"]
                if last["next_action"] != "none":
                    raise EvidenceStateError(
                        "root cannot terminate while its final attempt declares recovery"
                    )
            self._append(
                "roots.jsonl",
                "root_terminal",
                {
                    "campaign_id": self._protocol.campaign_id,
                    "root_id": root_id,
                    "planned_root": self._planned[root_id].as_dict(),
                    "started_at": start["started_at"],
                    "attempt_ids": attempt_ids,
                    "observation": observation.as_dict(),
                },
            )

    def seal(
        self,
        status: Literal["complete", "not_evaluable"] = "complete",
    ) -> EvidenceValidationReport:
        """Derive structural summary and write the hash manifest last."""

        with self._mutex:
            self._ensure_open()
            self._assert_reconciled()
            if not isinstance(status, str) or status not in {"complete", "not_evaluable"}:
                raise EvidenceArtifactError("seal status must be complete or not_evaluable")
            missing = sorted(set(self._planned) - set(self._state.root_terminals))
            extra = sorted(set(self._state.root_terminals) - set(self._planned))
            if missing or extra:
                raise EvidenceIncomplete(
                    f"terminal root population mismatch (missing={missing}, extra={extra})"
                )
            ambiguous = self._state.ambiguous_attempt_ids
            if ambiguous:
                raise AmbiguousEvidenceAttempt(
                    "cannot seal with ambiguous attempts: " + ", ".join(ambiguous)
                )
            root_statuses = [
                terminal["observation"]["status"]
                for terminal in self._state.root_terminals.values()
            ]
            if status == "complete" and any(item != "observed" for item in root_statuses):
                raise EvidenceIncomplete(
                    "a complete seal requires every planned root to be observed"
                )
            if status == "not_evaluable" and all(item == "observed" for item in root_statuses):
                raise EvidenceStateError(
                    "not_evaluable seal requires at least one explicit not-evaluable root"
                )
            for start in self._state.attempt_starts.values():
                if status == "complete":
                    if start["logical_request"]["state"] != "observed":
                        raise EvidenceIncomplete(
                            "complete evidence requires observed logical requests"
                        )
                    if start["effective_request"]["state"] != "observed":
                        raise EvidenceIncomplete(
                            "complete evidence requires observed effective requests"
                        )

            sealed_at = _iso(self._clock(), where="seal clock")
            parsed_sealed_at = _parse_time(sealed_at, where="manifest sealed_at")
            if parsed_sealed_at < _parse_time(
                self._registered_at, where="registration registered_at"
            ):
                raise EvidenceStateError("seal clock precedes campaign registration")
            latest_event = _latest_recorded_event_at(self._state)
            if latest_event is not None and parsed_sealed_at < latest_event:
                raise EvidenceStateError("seal clock precedes recorded terminal evidence")

            summary = _derive_summary(self._protocol, self._state, status=status)
            self._assert_owned()
            atomic_write_bytes(
                self._path / "summary.json",
                canonical_json_bytes(summary, where="summary") + b"\n",
            )
            self._assert_owned()
            manifest = _build_manifest(
                self._path,
                campaign_id=self._protocol.campaign_id,
                status=status,
                sealed_at=sealed_at,
            )
            self._assert_owned()
            manifest_path = self._path / "manifest.json"
            manifest_bytes = canonical_json_bytes(manifest, where="manifest") + b"\n"
            try:
                atomic_write_bytes(manifest_path, manifest_bytes)
            except BaseException as error:
                # os.replace publishes the commit marker before the directory
                # fsync that makes its name durable.  An error can therefore
                # mean either "not installed" or "installed but durability is
                # unknown".  Never let this writer overwrite that boundary.
                self._sealed = manifest_path.exists() or manifest_path.is_symlink()
                self._poisoned = f"manifest commit outcome is uncertain: {error}"
                if isinstance(error, Exception):
                    raise EvidenceArtifactError(
                        "manifest commit may have published; writer is now fail-closed"
                    ) from error
                raise
            self._sealed = True
            self._assert_owned()
            report = validate_evidence_bundle(self._path)
            self._assert_owned()
            report.assert_valid(require_complete=status == "complete")
            return report


def _read_protocol_document(path: Path) -> dict[str, Any]:
    document = _exact_keys(
        strict_load_json(path / "protocol.json", where="protocol.json"),
        {"format", "version", "campaign", "artifacts"},
        where="protocol.json",
    )
    if document["format"] != FORMAT or document["version"] != FORMAT_VERSION:
        raise EvidenceArtifactError("protocol.json has unsupported format/version")
    if type(document["artifacts"]) is not list:
        raise EvidenceArtifactError("protocol.json.artifacts must be an array")
    return document


def _validate_artifacts(
    path: Path,
    document: dict[str, Any],
    protocol: CampaignProtocol,
) -> None:
    seen_ids: set[str] = set()
    by_digest: dict[str, tuple[int, bytes]] = {}
    for index, raw in enumerate(document["artifacts"]):
        where = f"protocol.json.artifacts[{index}]"
        item = _exact_keys(raw, {"id", "media_type", "path", "sha256", "bytes"}, where=where)
        artifact_id = _safe_id(item["id"], where=f"{where}.id")
        if artifact_id in seen_ids:
            raise EvidenceArtifactError(f"duplicate artifact id {artifact_id!r}")
        seen_ids.add(artifact_id)
        _nonempty(item["media_type"], where=f"{where}.media_type")
        digest = item["sha256"]
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
            raise EvidenceArtifactError(f"{where}.sha256 must be a lowercase sha256")
        size = _integer(item["bytes"], where=f"{where}.bytes")
        expected_path = f"artifacts/sha256/{digest}"
        if item["path"] != expected_path:
            raise EvidenceArtifactError(f"{where}.path is not content-addressed by its sha256")
        source = contained_regular_file(path, expected_path, where=f"artifact {artifact_id!r}")
        raw_bytes = read_regular_bytes(source, where=f"artifact {artifact_id!r}")
        if len(raw_bytes) != size or sha256_bytes(raw_bytes) != digest:
            raise EvidenceArtifactError(
                f"artifact {artifact_id!r} bytes/hash do not match protocol"
            )
        prior = by_digest.get(digest)
        if prior is not None and prior != (size, raw_bytes):
            raise EvidenceArtifactError(f"artifact digest collision for {digest}")
        by_digest[digest] = (size, raw_bytes)
    required = _artifact_ids(protocol)
    missing = sorted(required - seen_ids)
    unreferenced = sorted(seen_ids - required)
    if missing or unreferenced:
        raise EvidenceArtifactError(
            f"artifact closure mismatch (missing={missing}, unreferenced={unreferenced})"
        )


def _validate_registration(path: Path, document: dict[str, Any]) -> dict[str, Any]:
    registration = _exact_keys(
        strict_load_json(path / "registration.json", where="registration.json"),
        {
            "format",
            "version",
            "campaign_id",
            "protocol_sha256",
            "artifact_count",
            "registered_at",
        },
        where="registration.json",
    )
    if registration["format"] != FORMAT or registration["version"] != FORMAT_VERSION:
        raise EvidenceArtifactError("registration.json has unsupported format/version")
    protocol_path = contained_regular_file(path, "protocol.json", where="protocol.json")
    protocol_bytes = read_regular_bytes(protocol_path, where="protocol bytes")
    if registration["protocol_sha256"] != sha256_bytes(protocol_bytes):
        raise EvidenceArtifactError("registration protocol hash drift")
    if registration["artifact_count"] != len(document["artifacts"]):
        raise EvidenceArtifactError("registration artifact_count drift")
    _parse_time(registration["registered_at"], where="registration.registered_at")
    return registration


def _load_bundle(path: Path) -> _BundleData:
    document = _read_protocol_document(path)
    protocol = CampaignProtocol.from_dict(document["campaign"])
    _validate_artifacts(path, document, protocol)
    _closed_payload_files(
        path,
        document,
        include_summary=(path / "summary.json").exists() or (path / "summary.json").is_symlink(),
    )
    registration = _validate_registration(path, document)
    if registration["campaign_id"] != protocol.campaign_id:
        raise EvidenceArtifactError("registration campaign_id differs from protocol")
    journal = strict_load_jsonl(path / "journal.jsonl", where="journal.jsonl")
    attempts = strict_load_jsonl(path / "attempts.jsonl", where="attempts.jsonl")
    roots = strict_load_jsonl(path / "roots.jsonl", where="roots.jsonl")
    manifest_path = path / "manifest.json"
    summary_path = path / "summary.json"
    manifest = (
        strict_load_json(manifest_path, where="manifest.json") if manifest_path.exists() else None
    )
    summary = (
        strict_load_json(summary_path, where="summary.json") if summary_path.exists() else None
    )
    if manifest is not None and summary is None:
        raise EvidenceArtifactError("sealed bundle is missing summary.json")
    return _BundleData(
        protocol=protocol,
        protocol_document=document,
        registration=registration,
        journal=journal,
        attempts=attempts,
        roots=roots,
        manifest=cast(dict[str, Any] | None, manifest),
        summary=cast(dict[str, Any] | None, summary),
    )


def _validate_start_payload(
    payload: dict[str, Any], protocol: CampaignProtocol, planned: dict[str, PlannedRoot]
) -> None:
    item = _exact_keys(
        payload,
        {"campaign_id", "root_id", "planned_root", "started_at"},
        where="root_started payload",
    )
    if item["campaign_id"] != protocol.campaign_id:
        raise EvidenceArtifactError("root start campaign_id drift")
    root_id = _safe_id(item["root_id"], where="root start root_id")
    if root_id not in planned:
        raise EvidenceArtifactError(f"unplanned root start {root_id!r}")
    if canonical_json_bytes(
        item["planned_root"], where="root start planned_root"
    ) != canonical_json_bytes(planned[root_id].as_dict(), where="protocol planned_root"):
        raise EvidenceArtifactError(f"root {root_id!r} planned coordinates drifted")
    _parse_time(item["started_at"], where=f"root {root_id!r} started_at")


def _validate_attempt_start_payload(
    payload: dict[str, Any], protocol: CampaignProtocol, state: _State
) -> None:
    item = _exact_keys(
        payload,
        {
            "campaign_id",
            "root_id",
            "attempt_id",
            "ordinal",
            "purpose",
            "predecessor_attempt_id",
            "policy_id",
            "execution_generation",
            "possible_duplicate",
            "started_at",
            "logical_request",
            "effective_request",
            "requested_route",
        },
        where="attempt_started payload",
    )
    if item["campaign_id"] != protocol.campaign_id:
        raise EvidenceArtifactError("attempt start campaign_id drift")
    root_id = _safe_id(item["root_id"], where="attempt start root_id")
    if root_id not in state.root_starts:
        raise EvidenceArtifactError("attempt started before its root")
    ordinal = _integer(item["ordinal"], where="attempt ordinal")
    expected_id = hashlib.sha256(
        canonical_json_bytes(
            {"campaign_id": protocol.campaign_id, "root_id": root_id, "ordinal": ordinal},
            where="attempt identity",
        )
    ).hexdigest()
    if item["attempt_id"] != expected_id:
        raise EvidenceArtifactError("attempt_id is not the deterministic full identity")
    if not isinstance(item["purpose"], str) or item["purpose"] not in _PURPOSES:
        raise EvidenceArtifactError("attempt purpose is unsupported")
    _integer(item["execution_generation"], where="execution_generation", minimum=1)
    if type(item["possible_duplicate"]) is not bool:
        raise EvidenceArtifactError("possible_duplicate must be a boolean")
    _parse_time(item["started_at"], where="attempt started_at")
    ObservedValue.from_dict(item["logical_request"], where="logical_request")
    ObservedValue.from_dict(item["effective_request"], where="effective_request")
    route = _requested_route(item["requested_route"], where="requested_route")
    if item["purpose"] == "initial":
        planned_root = next(root for root in protocol.planned_roots if root.root_id == root_id)
        route_error = _planned_route_error(route, planned_root)
        if route_error is not None:
            raise EvidenceArtifactError(route_error)


def _validate_attempt_terminal_payload(
    payload: dict[str, Any], protocol: CampaignProtocol, state: _State
) -> None:
    item = _exact_keys(
        payload,
        {
            "campaign_id",
            "root_id",
            "attempt_id",
            "ordinal",
            "start_payload_sha256",
            "purpose",
            "predecessor_attempt_id",
            "policy_id",
            "execution_generation",
            "possible_duplicate",
            "started_at",
            "logical_request",
            "effective_request",
            "requested_route",
            "observation",
        },
        where="attempt_terminal payload",
    )
    attempt_id = item["attempt_id"]
    start = state.attempt_starts[attempt_id]
    copied = {
        "campaign_id",
        "root_id",
        "attempt_id",
        "ordinal",
        "purpose",
        "predecessor_attempt_id",
        "policy_id",
        "execution_generation",
        "possible_duplicate",
        "started_at",
        "logical_request",
        "effective_request",
        "requested_route",
    }
    for key in copied:
        if canonical_json_bytes(item[key], where=f"terminal {key}") != canonical_json_bytes(
            start[key], where=f"start {key}"
        ):
            raise EvidenceArtifactError(f"attempt terminal changed frozen start field {key!r}")
    digest = sha256_bytes(canonical_json_bytes(start, where="attempt start payload"))
    if item["start_payload_sha256"] != digest:
        raise EvidenceArtifactError("attempt terminal start_payload_sha256 drift")
    observation = AttemptObservation.from_dict(item["observation"])
    _validate_cost_currency(observation, protocol, where=f"attempt {attempt_id}")
    if _parse_time(observation.ended_at, where="attempt ended_at") < _parse_time(
        start["started_at"], where="attempt started_at"
    ):
        raise EvidenceArtifactError("attempt ended_at precedes started_at")
    if item["campaign_id"] != protocol.campaign_id:
        raise EvidenceArtifactError("attempt terminal campaign_id drift")


def _validate_root_terminal_payload(
    payload: dict[str, Any],
    protocol: CampaignProtocol,
    state: _State,
    planned: dict[str, PlannedRoot],
) -> None:
    item = _exact_keys(
        payload,
        {
            "campaign_id",
            "root_id",
            "planned_root",
            "started_at",
            "attempt_ids",
            "observation",
        },
        where="root_terminal payload",
    )
    if item["campaign_id"] != protocol.campaign_id:
        raise EvidenceArtifactError("root terminal campaign_id drift")
    root_id = _safe_id(item["root_id"], where="root terminal root_id")
    if root_id not in planned:
        raise EvidenceArtifactError(f"unplanned root terminal {root_id!r}")
    if canonical_json_bytes(
        item["planned_root"], where="terminal planned root"
    ) != canonical_json_bytes(planned[root_id].as_dict(), where="protocol planned root"):
        raise EvidenceArtifactError("root terminal planned coordinates drift")
    if item["started_at"] != state.root_starts[root_id]["started_at"]:
        raise EvidenceArtifactError("root terminal changed started_at")
    if type(item["attempt_ids"]) is not list:
        raise EvidenceArtifactError("root terminal attempt_ids must be an array")
    expected = [
        start["attempt_id"]
        for start in sorted(
            (start for start in state.attempt_starts.values() if start["root_id"] == root_id),
            key=lambda start: cast(int, start["ordinal"]),
        )
    ]
    if item["attempt_ids"] != expected:
        raise EvidenceArtifactError("root terminal attempt_ids drift from ordered attempt journal")
    if any(attempt_id not in state.attempt_terminals for attempt_id in expected):
        raise EvidenceArtifactError("root terminal includes an unterminated attempt")
    if expected and state.attempt_terminals[expected[-1]]["observation"]["next_action"] != "none":
        raise EvidenceArtifactError("root terminal leaves a declared recovery transition dangling")
    observation = RootObservation.from_dict(item["observation"])
    abandoned = _abandoned_attempt_ids(state, root_id)
    if abandoned and observation.status != "not_evaluable":
        raise EvidenceArtifactError(
            f"root {root_id!r} has explicitly abandoned attempts and must be "
            f"not_evaluable: {list(abandoned)}"
        )
    if observation.status == "observed" and observation.selected_attempt_id not in expected:
        raise EvidenceArtifactError("root selected attempt does not belong to the root")
    if _parse_time(observation.ended_at, where="root ended_at") < _parse_time(
        item["started_at"], where="root started_at"
    ):
        raise EvidenceArtifactError("root ended_at precedes started_at")


def _validate_transitions(state: _State, protocol: CampaignProtocol) -> None:
    by_root: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for start in state.attempt_starts.values():
        by_root[start["root_id"]].append(start)
    for root_id, starts in by_root.items():
        starts.sort(key=lambda item: cast(int, item["ordinal"]))
        ordinals = [item["ordinal"] for item in starts]
        if ordinals != list(range(len(starts))):
            raise EvidenceArtifactError(f"root {root_id!r} attempt ordinals are not contiguous")
        for index, start in enumerate(starts):
            if index == 0:
                if (
                    start["purpose"] != "initial"
                    or start["predecessor_attempt_id"] is not None
                    or start["policy_id"] is not None
                    or start["possible_duplicate"]
                    or start["execution_generation"] != 1
                ):
                    raise EvidenceArtifactError(f"root {root_id!r} has an invalid initial attempt")
                continue
            predecessor = starts[index - 1]
            predecessor_id = predecessor["attempt_id"]
            if start["predecessor_attempt_id"] != predecessor_id:
                raise EvidenceArtifactError("attempt recovery skips its immediate predecessor")
            terminal = state.attempt_terminals.get(predecessor_id)
            if terminal is None:
                raise EvidenceArtifactError("attempt recovery follows a nonterminal predecessor")
            expected = terminal["observation"]["next_action"]
            if start["purpose"] != expected or expected not in _RECOVERIES:
                raise EvidenceArtifactError("attempt recovery transition is impossible")
            policy_key = _POLICY_BY_PURPOSE[expected]
            policy = protocol.retry_policies[policy_key]
            if not start["policy_id"]:
                raise EvidenceArtifactError("recovery attempt is missing policy_id")
            _safe_id(start["policy_id"], where="recovery attempt policy_id")
            if type(policy) is dict and "id" in policy and policy["id"] != start["policy_id"]:
                raise EvidenceArtifactError("recovery attempt policy_id drift")
            if start["execution_generation"] != predecessor["execution_generation"] + 1:
                raise EvidenceArtifactError(
                    "recovery execution_generation does not increment its predecessor"
                )
            route_error = _recovery_route_error(
                purpose=expected,
                route=start["requested_route"],
                predecessor_route=predecessor["requested_route"],
                policy=policy,
            )
            if route_error is not None:
                raise EvidenceArtifactError(route_error)
            resolution = state.resolutions.get(predecessor_id)
            if (
                resolution is not None
                and resolution["action"] == "rerun"
                and not start["possible_duplicate"]
            ):
                raise EvidenceArtifactError("rerun after ambiguity lost possible_duplicate=true")


def _validate_semantics(data: _BundleData, *, sealed: bool) -> _State:
    state = _state_from_records(data.journal, data.attempts, data.roots)
    planned = {root.root_id: root for root in data.protocol.planned_roots}
    registered_at = _parse_time(
        data.registration["registered_at"], where="registration.registered_at"
    )
    for payload in state.root_starts.values():
        _validate_start_payload(payload, data.protocol, planned)
        if _parse_time(payload["started_at"], where="root started_at") < registered_at:
            raise EvidenceArtifactError("root started_at precedes campaign registration")
    for payload in state.attempt_starts.values():
        _validate_attempt_start_payload(payload, data.protocol, state)
        started_at = _parse_time(payload["started_at"], where="attempt started_at")
        root_started_at = _parse_time(
            state.root_starts[payload["root_id"]]["started_at"], where="root started_at"
        )
        if started_at < root_started_at:
            raise EvidenceArtifactError("attempt started_at precedes its root start")
        predecessor_id = payload["predecessor_attempt_id"]
        if predecessor_id is not None:
            predecessor_terminal = state.attempt_terminals.get(predecessor_id)
            if predecessor_terminal is None:
                raise EvidenceArtifactError(
                    "recovery attempt names a nonterminal or unknown predecessor"
                )
            predecessor_ended_at = _parse_time(
                predecessor_terminal["observation"]["ended_at"],
                where="predecessor attempt ended_at",
            )
            if started_at < predecessor_ended_at:
                raise EvidenceArtifactError(
                    "recovery attempt started_at precedes its predecessor terminal"
                )
    for payload in state.attempt_terminals.values():
        _validate_attempt_terminal_payload(payload, data.protocol, state)
    for payload in state.root_terminals.values():
        _validate_root_terminal_payload(payload, data.protocol, state, planned)
        root_ended_at = _parse_time(payload["observation"]["ended_at"], where="root ended_at")
        if any(
            root_ended_at
            < _parse_time(
                state.attempt_terminals[attempt_id]["observation"]["ended_at"],
                where=f"attempt {attempt_id} ended_at",
            )
            for attempt_id in payload["attempt_ids"]
        ):
            raise EvidenceArtifactError("root ended_at precedes a terminal attempt")
        if any(
            root_ended_at
            < _parse_time(
                state.resolutions[attempt_id]["resolved_at"],
                where=f"attempt {attempt_id} ambiguity resolved_at",
            )
            for attempt_id in payload["attempt_ids"]
            if attempt_id in state.resolutions
        ):
            raise EvidenceArtifactError("root ended_at precedes an ambiguity resolution")
    _validate_transitions(state, data.protocol)
    artifact_ids = {item["id"] for item in data.protocol_document["artifacts"]}
    for attempt_id, resolution in state.resolutions.items():
        _exact_keys(
            resolution,
            {"campaign_id", "attempt_id", "action", "evidence_ref", "resolved_at"},
            where="ambiguity resolution",
        )
        if resolution["campaign_id"] != data.protocol.campaign_id:
            raise EvidenceArtifactError("ambiguity resolution campaign_id drift")
        if resolution["attempt_id"] != attempt_id:
            raise EvidenceArtifactError("ambiguity resolution attempt_id drift")
        if not isinstance(resolution["action"], str) or resolution["action"] not in {
            "rerun",
            "abandon",
            "reconciled",
        }:
            raise EvidenceArtifactError("ambiguity resolution action is invalid")
        if resolution["action"] == "reconciled":
            if resolution["evidence_ref"] not in artifact_ids:
                raise EvidenceArtifactError(
                    "reconciled ambiguity does not reference a frozen artifact"
                )
        elif resolution["evidence_ref"] is not None:
            raise EvidenceArtifactError("non-reconciled ambiguity cannot attach evidence_ref")
        resolved_at = _parse_time(resolution["resolved_at"], where="ambiguity resolved_at")
        if resolved_at < _parse_time(
            state.attempt_starts[attempt_id]["started_at"], where="attempt started_at"
        ):
            raise EvidenceArtifactError("ambiguity resolved_at precedes its attempt start")
        if attempt_id in state.attempt_terminals:
            next_action = state.attempt_terminals[attempt_id]["observation"]["next_action"]
            if resolution["action"] == "rerun" and next_action != "apparatus_retry":
                raise EvidenceArtifactError("rerun ambiguity must declare apparatus_retry")
            if resolution["action"] == "abandon" and next_action != "none":
                raise EvidenceArtifactError("abandoned ambiguity cannot declare recovery")
    if sealed:
        expected_roots = set(planned)
        actual_roots = set(state.root_terminals)
        if actual_roots != expected_roots:
            raise EvidenceArtifactError(
                "sealed bundle terminal topology differs from planned roots"
            )
        if state.ambiguous_attempt_ids:
            raise EvidenceArtifactError("sealed bundle contains ambiguous attempts")
    return state


def _state_counts(values: Iterable[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(item["state"] for item in values)
    return {state: counts.get(state, 0) for state in sorted(_OBSERVATION_STATES)}


def _derive_summary(
    protocol: CampaignProtocol,
    state: _State,
    *,
    status: Literal["complete", "not_evaluable"],
) -> dict[str, Any]:
    terminal_attempts = sorted(
        state.attempt_terminals.values(),
        key=lambda item: (item["root_id"], item["ordinal"]),
    )
    terminal_roots = sorted(state.root_terminals.values(), key=lambda item: item["root_id"])
    stage_counts: dict[str, dict[str, int]] = {}
    for stage in _STAGES:
        counts = Counter(
            item["observation"]["stages"][stage]["state"] for item in terminal_attempts
        )
        stage_counts[stage] = {
            name: counts.get(name, 0) for name in ("pass", "fail", "not_run", "unknown")
        }

    usage: dict[str, dict[str, Any]] = {}
    for token_name in ("input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"):
        values = [item["observation"]["usage"][token_name] for item in terminal_attempts]
        usage[token_name] = {
            "states": _state_counts(values),
            "observed_count": sum(item["state"] == "observed" for item in values),
            "observed_sum": sum(
                cast(int, item["value"]) for item in values if item["state"] == "observed"
            ),
        }

    cost_states = [item["observation"]["cost"] for item in terminal_attempts]
    costs: defaultdict[str, Decimal] = defaultdict(Decimal)
    for item in cost_states:
        if item["state"] == "observed":
            costs[item["value"]["currency"]] += Decimal(item["value"]["amount"])

    route_counts: Counter[bytes] = Counter()
    route_values: dict[bytes, JsonValue] = {}
    for item in terminal_attempts:
        route = item["observation"]["actual_route"]
        if route["state"] == "observed":
            encoded = canonical_json_bytes(route["value"], where="actual route summary")
            route_counts[encoded] += 1
            route_values[encoded] = route["value"]

    durations = [item["observation"]["duration"] for item in terminal_attempts]
    observed_durations = [
        Decimal(str(item["value"])) for item in durations if item["state"] == "observed"
    ]
    record_payloads = {
        "attempts": terminal_attempts,
        "roots": terminal_roots,
    }
    return {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "campaign_id": protocol.campaign_id,
        "status": status,
        "source_payloads_sha256": sha256_bytes(
            canonical_json_bytes(record_payloads, where="summary source payloads")
        ),
        "counts": {
            "planned_roots": len(protocol.planned_roots),
            "started_roots": len(state.root_starts),
            "terminal_roots": len(state.root_terminals),
            "observed_roots": sum(
                item["observation"]["status"] == "observed" for item in terminal_roots
            ),
            "not_evaluable_roots": sum(
                item["observation"]["status"] == "not_evaluable" for item in terminal_roots
            ),
            "attempts": len(terminal_attempts),
            "possible_duplicate_attempts": sum(
                bool(item["possible_duplicate"]) for item in terminal_attempts
            ),
        },
        "attempts_by_purpose": dict(
            sorted(Counter(item["purpose"] for item in terminal_attempts).items())
        ),
        "validation_stages": stage_counts,
        "usage": usage,
        "cost": {
            "states": _state_counts(cost_states),
            "observed_by_currency": [
                {"currency": currency, "amount": format(amount, "f")}
                for currency, amount in sorted(costs.items())
            ],
        },
        "duration_ms": {
            "states": _state_counts(durations),
            "observed_count": len(observed_durations),
            "observed_sum": format(sum(observed_durations, Decimal()), "f"),
        },
        "actual_routes": [
            {"route": route_values[encoded], "attempts": route_counts[encoded]}
            for encoded in sorted(route_counts)
        ],
        "refusal_states": _state_counts(
            item["observation"]["refusal"] for item in terminal_attempts
        ),
        "truncation_states": _state_counts(
            item["observation"]["truncation"] for item in terminal_attempts
        ),
    }


def _walk_payload_files(path: Path) -> list[Path]:
    files: list[Path] = []
    for current_text, dir_names, file_names in os.walk(path, topdown=True, followlinks=False):
        current = Path(current_text)
        for name in tuple(dir_names):
            candidate = current / name
            if candidate.is_symlink():
                raise EvidenceArtifactError(
                    f"bundle inventory must not traverse symlink {candidate}"
                )
        for name in file_names:
            candidate = current / name
            relative = candidate.relative_to(path).as_posix()
            if relative in {".evidence.lock", "manifest.json"}:
                continue
            if candidate.is_symlink() or not candidate.is_file():
                raise EvidenceArtifactError(
                    f"bundle payload must be a regular nonsymlink file: {relative}"
                )
            info = candidate.stat(follow_symlinks=False)
            if info.st_nlink != 1:
                raise EvidenceArtifactError(f"bundle payload must not be hard-linked: {relative}")
            files.append(candidate)
    return sorted(files, key=lambda item: item.relative_to(path).as_posix())


def _expected_payload_paths(
    document: dict[str, Any],
    *,
    include_summary: bool,
) -> set[str]:
    expected = set(_REQUIRED_PAYLOAD_PATHS)
    for index, raw in enumerate(document["artifacts"]):
        where = f"protocol.json.artifacts[{index}]"
        if type(raw) is not dict:
            raise EvidenceArtifactError(f"{where} must be an object")
        item = cast(dict[str, Any], raw)
        digest = item.get("sha256")
        relative = item.get("path")
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
            raise EvidenceArtifactError(f"{where}.sha256 must be a lowercase sha256")
        if relative != f"artifacts/sha256/{digest}":
            raise EvidenceArtifactError(f"{where}.path is not content-addressed by its sha256")
        expected.add(cast(str, relative))
    if include_summary:
        expected.add("summary.json")
    return expected


def _closed_payload_files(
    path: Path,
    document: dict[str, Any],
    *,
    include_summary: bool,
) -> list[Path]:
    """Return the exact registered payload population or fail closed.

    Manifest publication must never turn a file that happened to be present
    into campaign evidence.  The only variable payload names are the
    content-addressed artifact paths frozen in ``protocol.json`` and the
    derived ``summary.json`` once it exists.
    """

    expected = _expected_payload_paths(document, include_summary=include_summary)
    actual_sources = _walk_payload_files(path)
    actual = {source.relative_to(path).as_posix(): source for source in actual_sources}
    missing = sorted(expected - set(actual))
    unexpected = sorted(set(actual) - expected)
    if missing or unexpected:
        raise EvidenceArtifactError(
            f"bundle payload inventory mismatch (missing={missing}, unexpected={unexpected})"
        )
    return [actual[relative] for relative in sorted(expected)]


def _build_manifest(
    path: Path,
    *,
    campaign_id: str,
    status: Literal["complete", "not_evaluable"],
    sealed_at: str,
) -> dict[str, Any]:
    document = _read_protocol_document(path)
    protocol = CampaignProtocol.from_dict(document["campaign"])
    _validate_artifacts(path, document, protocol)
    _validate_registration(path, document)
    entries: list[dict[str, Any]] = []
    for source in _closed_payload_files(path, document, include_summary=True):
        relative = source.relative_to(path).as_posix()
        raw = read_regular_bytes(source, where=f"manifest source {relative}")
        records: int | None = None
        if source.suffix == ".jsonl":
            records = len(strict_load_jsonl(source, where=relative))
        entries.append(
            {
                "path": relative,
                "sha256": sha256_bytes(raw),
                "bytes": len(raw),
                "records": records,
            }
        )
    return {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "campaign_id": campaign_id,
        "status": status,
        "sealed_at": sealed_at,
        "files": entries,
    }


def _validate_manifest(path: Path, data: _BundleData, state: _State) -> str:
    manifest = _exact_keys(
        data.manifest,
        {"format", "version", "campaign_id", "status", "sealed_at", "files"},
        where="manifest.json",
    )
    if manifest["format"] != FORMAT or manifest["version"] != FORMAT_VERSION:
        raise EvidenceArtifactError("manifest.json has unsupported format/version")
    if manifest["campaign_id"] != data.protocol.campaign_id:
        raise EvidenceArtifactError("manifest campaign_id drift")
    status = manifest["status"]
    if not isinstance(status, str) or status not in {"complete", "not_evaluable"}:
        raise EvidenceArtifactError("manifest status is invalid")
    sealed_at = _parse_time(manifest["sealed_at"], where="manifest.sealed_at")
    registered_at = _parse_time(
        data.registration["registered_at"], where="registration.registered_at"
    )
    latest_terminal = _latest_recorded_event_at(state)
    if sealed_at < registered_at:
        raise EvidenceArtifactError("manifest sealed_at precedes campaign registration")
    if latest_terminal is not None and sealed_at < latest_terminal:
        raise EvidenceArtifactError("manifest sealed_at precedes terminal evidence")
    if type(manifest["files"]) is not list:
        raise EvidenceArtifactError("manifest.files must be an array")
    expected_sources = _closed_payload_files(
        path,
        data.protocol_document,
        include_summary=True,
    )
    expected_paths = [source.relative_to(path).as_posix() for source in expected_sources]
    actual_paths: list[str] = []
    for index, raw_entry in enumerate(manifest["files"]):
        where = f"manifest.files[{index}]"
        entry = _exact_keys(raw_entry, {"path", "sha256", "bytes", "records"}, where=where)
        relative = entry["path"]
        if not isinstance(relative, str):
            raise EvidenceArtifactError(f"{where}.path must be a string")
        source = contained_regular_file(path, relative, where=where)
        actual_paths.append(relative)
        raw = read_regular_bytes(source, where=relative)
        if entry["sha256"] != sha256_bytes(raw) or entry["bytes"] != len(raw):
            raise EvidenceArtifactError(f"manifest hash/size drift for {relative}")
        if source.suffix == ".jsonl":
            count = len(strict_load_jsonl(source, where=relative))
            if entry["records"] != count:
                raise EvidenceArtifactError(f"manifest record-count drift for {relative}")
        elif entry["records"] is not None:
            raise EvidenceArtifactError(f"manifest records must be null for {relative}")
    if actual_paths != sorted(actual_paths) or len(actual_paths) != len(set(actual_paths)):
        raise EvidenceArtifactError("manifest file inventory must be sorted and unique")
    if actual_paths != expected_paths:
        missing = sorted(set(expected_paths) - set(actual_paths))
        unlisted = sorted(set(actual_paths) - set(expected_paths))
        raise EvidenceArtifactError(
            f"manifest file inventory drift (missing={missing}, unexpected={unlisted})"
        )
    expected_summary = _derive_summary(data.protocol, state, status=status)
    if canonical_json_bytes(data.summary, where="summary.json") != canonical_json_bytes(
        expected_summary, where="derived summary"
    ):
        raise EvidenceArtifactError(
            "summary.json is not mechanically derived from immutable terminal attempts and roots"
        )
    root_statuses = [item["observation"]["status"] for item in state.root_terminals.values()]
    if status == "complete" and any(item != "observed" for item in root_statuses):
        raise EvidenceArtifactError("complete manifest includes not-evaluable roots")
    if status == "complete" and any(
        start[which]["state"] != "observed"
        for start in state.attempt_starts.values()
        for which in ("logical_request", "effective_request")
    ):
        raise EvidenceArtifactError("complete manifest includes unobserved request evidence")
    if status == "not_evaluable" and all(item == "observed" for item in root_statuses):
        raise EvidenceArtifactError("not_evaluable manifest lacks a not-evaluable root")
    return cast(str, status)


def _completeness_dimensions(
    state: _State, protocol: CampaignProtocol
) -> dict[str, Literal["complete", "incomplete", "unknown"]]:
    attempts = list(state.attempt_terminals.values())
    topology = (
        "complete"
        if set(state.root_terminals) == {root.root_id for root in protocol.planned_roots}
        else "incomplete"
    )
    execution = (
        "complete"
        if (
            topology == "complete"
            and len(state.attempt_starts) == len(state.attempt_terminals)
            and not state.ambiguous_attempt_ids
        )
        else "incomplete"
    )
    requests = (
        "complete"
        if execution == "complete"
        and state.attempt_starts
        and all(
            start[which]["state"] == "observed"
            for start in state.attempt_starts.values()
            for which in ("logical_request", "effective_request")
        )
        else "incomplete"
    )
    attribution = (
        "complete"
        if execution == "complete"
        and attempts
        and all(
            terminal["observation"]["actual_route"]["state"] == "observed" for terminal in attempts
        )
        else "incomplete"
    )
    usage = (
        "complete"
        if execution == "complete"
        and attempts
        and all(
            value["state"] == "observed"
            for terminal in attempts
            for value in terminal["observation"]["usage"].values()
        )
        else "incomplete"
    )
    pricing = (
        "complete"
        if execution == "complete"
        and attempts
        and all(terminal["observation"]["cost"]["state"] == "observed" for terminal in attempts)
        else "incomplete"
    )
    source_references = [
        _artifact_reference(protocol.execution[key], where=f"execution.{key}")
        for key in sorted(_EXECUTION_ARTIFACT_REFERENCE_KEYS)
    ]
    source_references.extend(
        _artifact_reference(protocol.pricing[key], where=f"pricing.{key}")
        for key in sorted(_PRICING_ARTIFACT_REFERENCE_KEYS)
    )
    source_references.append(
        _artifact_reference(
            protocol.sanitization["implementation_artifact"],
            where="sanitization.implementation_artifact",
        )
    )
    source_states = {reference.state for reference in source_references}
    sources: Literal["complete", "incomplete", "unknown"]
    if "absent" in source_states:
        sources = "incomplete"
    elif "unknown" in source_states:
        sources = "unknown"
    else:
        # An explicit not-applicable reason is complete evidence for a source
        # that the registered execution does not use.
        sources = "complete"
    scan_result = _observation(
        protocol.sanitization["scan_result"], where="sanitization.scan_result"
    )
    sanitization: Literal["complete", "incomplete", "unknown"]
    if scan_result.state == "observed":
        sanitization = "complete"
    elif scan_result.state == "unknown":
        sanitization = "unknown"
    else:
        sanitization = "incomplete"
    return {
        "topology": topology,
        "execution": execution,
        "requests": requests,
        "attribution": attribution,
        "usage": usage,
        "pricing": pricing,
        "sources": sources,
        "sanitization": sanitization,
    }


def _preflight_issues(path: Path) -> tuple[EvidenceIssue, ...]:
    issues: list[EvidenceIssue] = []
    documents = ("protocol.json", "registration.json")
    journals = ("journal.jsonl", "attempts.jsonl", "roots.jsonl")
    optional_documents = tuple(
        name for name in ("summary.json", "manifest.json") if (path / name).exists()
    )
    for name in documents + journals + optional_documents:
        target = path / name
        if not target.exists() and not target.is_symlink():
            issues.append(
                EvidenceIssue(
                    "error",
                    "artifact.missing",
                    (name,),
                    f"required bundle file is missing: {name}",
                )
            )
            continue
        try:
            if name.endswith(".jsonl"):
                strict_load_jsonl(target, where=name)
            else:
                strict_load_json(target, where=name)
        except (BenchArtifactError, OSError, UnicodeError, ValueError) as error:
            issues.append(
                EvidenceIssue(
                    "error",
                    "jsonl.invalid" if name.endswith(".jsonl") else "json.invalid",
                    (name,),
                    str(error),
                )
            )
    return tuple(issues)


def _bundle_fingerprint(root: Path) -> tuple[tuple[str, str], ...]:
    sources = _walk_payload_files(root)
    manifest = root / "manifest.json"
    if manifest.exists() or manifest.is_symlink():
        contained_regular_file(root, "manifest.json", where="manifest.json")
        sources.append(manifest)
    return tuple(
        (
            source.relative_to(root).as_posix(),
            sha256_bytes(
                read_regular_bytes(source, where=f"snapshot {source.relative_to(root).as_posix()}")
            ),
        )
        for source in sorted(sources, key=lambda item: item.relative_to(root).as_posix())
    )


def _fingerprint_has_atomic_temporary(
    fingerprint: tuple[tuple[str, str], ...],
) -> bool:
    return any(
        _ATOMIC_TEMP_NAME.fullmatch(PurePosixPath(relative).name) is not None
        for relative, _ in fingerprint
    )


def _concurrent_validation_report(
    last_report: EvidenceValidationReport | None,
) -> EvidenceValidationReport:
    issue = EvidenceIssue(
        "error",
        "artifact.concurrent_mutation",
        (),
        "bundle is at an active writer boundary; retry after the writer reaches a durable boundary",
    )
    return EvidenceValidationReport(
        integrity="invalid",
        status="invalid",
        campaign_id=last_report.campaign_id if last_report is not None else None,
        dimensions={},
        counts={},
        issues=(issue,),
    )


def _validate_root_once(root: Path) -> EvidenceValidationReport:
    try:
        preflight = _preflight_issues(root)
        if preflight:
            return EvidenceValidationReport(
                integrity="invalid",
                status="invalid",
                campaign_id=None,
                dimensions={},
                counts={},
                issues=preflight,
            )
        data = _load_bundle(root)
        sealed = data.manifest is not None
        state = _validate_semantics(data, sealed=sealed)
        status: BundleStatus
        if sealed:
            status = cast(BundleStatus, _validate_manifest(root, data, state))
        elif state.ambiguous_attempt_ids:
            status = "ambiguous"
        else:
            status = "open"
            if data.summary is not None:
                # A crash between summary and manifest remains visible but can
                # be safely re-sealed because summary is purely derived.
                derived_status = data.summary.get("status")
                if not isinstance(derived_status, str) or derived_status not in {
                    "complete",
                    "not_evaluable",
                }:
                    raise EvidenceArtifactError("partial summary has invalid status")
                expected = _derive_summary(data.protocol, state, status=derived_status)
                if canonical_json_bytes(
                    data.summary, where="partial summary"
                ) != canonical_json_bytes(expected, where="derived partial summary"):
                    raise EvidenceArtifactError("partial summary drift")
        dimensions = _completeness_dimensions(state, data.protocol)
        planned = {root.root_id for root in data.protocol.planned_roots}
        issues: list[EvidenceIssue] = []
        missing = sorted(planned - set(state.root_terminals))
        for root_id in missing:
            issues.append(
                EvidenceIssue(
                    "warning",
                    "topology.missing_terminal_root",
                    ("roots",),
                    "planned root has no terminal observation",
                    root_id=root_id,
                )
            )
        for attempt_id in state.ambiguous_attempt_ids:
            issues.append(
                EvidenceIssue(
                    "warning",
                    "transition.ambiguous_attempt",
                    ("attempts",),
                    "attempt started without a terminal observation",
                    attempt_id=attempt_id,
                )
            )
        if not sealed and data.summary is not None:
            issues.append(
                EvidenceIssue(
                    "warning",
                    "summary.unsealed",
                    ("summary.json",),
                    "derived summary exists but manifest seal is absent",
                )
            )
        counts = {
            "planned_roots": len(planned),
            "started_roots": len(state.root_starts),
            "terminal_roots": len(state.root_terminals),
            "missing_roots": len(missing),
            "started_attempts": len(state.attempt_starts),
            "terminal_attempts": len(state.attempt_terminals),
            "ambiguous_attempts": len(state.ambiguous_attempt_ids),
        }
        return EvidenceValidationReport(
            integrity="valid",
            status=status,
            campaign_id=data.protocol.campaign_id,
            dimensions=dimensions,
            counts=counts,
            issues=tuple(issues),
        )
    except (
        BenchArtifactError,
        OSError,
        UnicodeError,
        ValueError,
        TypeError,
        AttributeError,
        KeyError,
    ) as error:
        issue = EvidenceIssue(
            "error",
            "artifact.invalid",
            (),
            str(error),
        )
        return EvidenceValidationReport(
            integrity="invalid",
            status="invalid",
            campaign_id=None,
            dimensions={},
            counts={},
            issues=(issue,),
        )


def validate_evidence_bundle(path: str | os.PathLike[str]) -> EvidenceValidationReport:
    """Independently validate integrity, topology, transitions, and derivation.

    Invalid input is returned as a typed report rather than raising.  Calls
    made while a writer is active use before/after content fingerprints and
    retry rather than mistaking a moving multi-journal read for corruption.
    Call :meth:`EvidenceValidationReport.assert_valid` at trust boundaries.
    """

    try:
        source = Path(path)
        if not source.exists():
            issue = EvidenceIssue(
                "error",
                "artifact.missing_bundle",
                (),
                f"evidence bundle does not exist: {source}",
            )
            return EvidenceValidationReport("invalid", "invalid", None, {}, {}, (issue,))
        root = ensure_safe_bundle_root(source)
        if (root / ".evidence.lock").exists() or (root / ".evidence.lock").is_symlink():
            contained_regular_file(root, ".evidence.lock", where="campaign lock")
        last_report: EvidenceValidationReport | None = None
        for _ in range(4):
            try:
                before = _bundle_fingerprint(root)
                report = _validate_root_once(root)
                after = _bundle_fingerprint(root)
            except (
                BenchArtifactError,
                OSError,
                UnicodeError,
                ValueError,
                TypeError,
                AttributeError,
                KeyError,
            ):
                if _campaign_lock_is_held(root / ".evidence.lock"):
                    continue
                raise
            if before == after:
                if _fingerprint_has_atomic_temporary(before) and _campaign_lock_is_held(
                    root / ".evidence.lock"
                ):
                    return _concurrent_validation_report(report)
                return report
            last_report = report
        return _concurrent_validation_report(last_report)
    except (
        BenchArtifactError,
        OSError,
        UnicodeError,
        ValueError,
        TypeError,
        AttributeError,
        KeyError,
    ) as error:
        issue = EvidenceIssue("error", "artifact.invalid", (), str(error))
        return EvidenceValidationReport(
            integrity="invalid",
            status="invalid",
            campaign_id=None,
            dimensions={},
            counts={},
            issues=(issue,),
        )


__all__ = [
    "AmbiguousEvidenceAttempt",
    "AttemptObservation",
    "CampaignProtocol",
    "EvidenceArtifactError",
    "EVIDENCE_BUNDLE_FORMAT",
    "EVIDENCE_BYTES_FORMAT",
    "EVIDENCE_FORMAT_VERSION",
    "EVIDENCE_RECORD_FORMAT",
    "EvidenceBundleLocked",
    "EvidenceIncomplete",
    "EvidenceIssue",
    "EvidenceLockUnavailable",
    "EvidenceResumeMismatch",
    "EvidenceStateError",
    "EvidenceValidationReport",
    "EvidenceWriter",
    "FrozenArtifact",
    "ObservedValue",
    "PlannedRoot",
    "RootObservation",
    "ValidationStage",
    "absent",
    "captured_bytes",
    "not_applicable",
    "observed",
    "unknown",
    "validate_evidence_bundle",
]

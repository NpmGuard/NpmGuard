"""Provider-neutral evaluation orchestration.

A cell is one lever assignment. A root is one ``(cell, case, repeat)``
observation. Roots, rather than whole cells, are scheduled and checkpointed.
A start journal makes the paid-call ambiguity window explicit: completed roots
and per-cell scores resume from their checkpoints, untouched work runs, and
interrupted work stops resume for caller reconciliation instead of being
silently charged twice.
The app owns prompts, schemas, validators, decoders, and scores; the harness owns
only population identity, scheduling, typed artifacts, and attribution.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import inspect
import json
import math
import os
import re
import uuid
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterator, Literal, cast

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm.bench.expand import Cell, expand


_FORMAT_VERSION = 3
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class BenchArtifactError(ValueError):
    """An eval artifact is not strict, deterministic JSON."""


class ResumeMismatch(BenchArtifactError):
    """A run directory belongs to a different frozen campaign."""


class IncomparableRuns(BenchArtifactError):
    """Two summaries do not describe the same population and judge."""


class RunLocked(BenchArtifactError):
    """Another process or task already owns this run directory."""


class AmbiguousRoot(BenchArtifactError):
    """A root started but did not durably record a terminal observation."""


class AmbiguousScore(BenchArtifactError):
    """A scorer started but did not durably record terminal signals."""


class LockUnavailable(BenchArtifactError):
    """The platform cannot provide the campaign's single-owner lock."""


class RetryableCellError(Exception):
    """The measuring apparatus failed, not the system under test."""


@dataclass(frozen=True)
class BenchCase:
    """One provider-neutral input in the fixed evaluation population."""

    id: str
    payload: Any

    def __post_init__(self) -> None:
        if not _SAFE_ID.fullmatch(self.id):
            raise ValueError(
                "case id must be 1-96 safe characters: letters, digits, dot, underscore, dash"
            )
        _ensure_json(self.payload, path=f"case {self.id!r} payload")


@dataclass(frozen=True)
class BenchIdentity:
    """Semantic identity used for safe resume and comparable-run checks."""

    suite: str = "anonymous"
    dataset: str = "unspecified"
    runner: str = "unspecified"

    def __post_init__(self) -> None:
        for name, value in asdict(self).items():
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"bench identity {name} must be a non-empty string")


@dataclass(frozen=True)
class CellContext:
    """One root's inputs and unique ledger attribution key."""

    levers: dict[str, Any]
    repeat: int
    context_id: str
    case_id: str = "default"
    case: Any = None


FailureKind = Literal["system_under_test", "apparatus_exhausted"]


@dataclass(frozen=True)
class FailureObservation:
    kind: FailureKind
    exception_type: str
    message: str
    apparatus_attempts: int


@dataclass(frozen=True)
class RepeatResult:
    status: Literal["ok", "error"]
    output: Any = None
    error: FailureObservation | None = None
    context_id: str = ""
    case_id: str = "default"
    repeat: int = 0
    apparatus_attempts: int = 1
    execution_generation: int = 1
    possible_duplicate: bool = False


@dataclass(frozen=True)
class BenchConfig:
    levers: dict[str, Any]
    repeats: int = 1
    concurrency: int = 4
    cell_retries: int = 2
    cases: tuple[BenchCase, ...] = field(default_factory=lambda: (BenchCase("default", None),))

    def __post_init__(self) -> None:
        cases = tuple(self.cases)
        object.__setattr__(self, "cases", cases)
        if not cases:
            raise ValueError("BenchConfig requires at least one case")
        case_ids = [case.id for case in cases]
        if len(case_ids) != len(set(case_ids)):
            raise ValueError("BenchConfig case ids must be unique")
        if not _is_int(self.repeats) or self.repeats < 1:
            raise ValueError("BenchConfig repeats must be >= 1")
        if not _is_int(self.concurrency) or self.concurrency < 1:
            raise ValueError("BenchConfig concurrency must be >= 1")
        if not _is_int(self.cell_retries) or self.cell_retries < 0:
            raise ValueError("BenchConfig cell_retries must be >= 0")
        _ensure_json(self.levers, path="levers")
        for name, value in self.levers.items():
            if isinstance(value, list) and not value:
                raise ValueError(f"lever axis {name!r} must not be empty")


RunCell = Callable[[CellContext], Awaitable[Any]]
Score = Callable[[dict[str, Any], list[RepeatResult]], Any]


@dataclass(frozen=True)
class _Root:
    cell: Cell
    case: BenchCase
    repeat: int
    implicit_default: bool
    campaign_id: str

    @property
    def key(self) -> str:
        return f"{self.cell.id}|{self.case.id}|{self.repeat}"

    @property
    def context_id(self) -> str:
        campaign = hashlib.sha256(self.campaign_id.encode()).hexdigest()[:16]
        root = hashlib.sha256(self.key.encode()).hexdigest()[:32]
        return f"b:{campaign}:{root}"

    @property
    def filename(self) -> str:
        return f"{self.case.id}--{self.repeat}.json"


@dataclass(frozen=True)
class _ExecutionProvenance:
    generation: int = 1
    possible_duplicate: bool = False

    def rerun(self) -> "_ExecutionProvenance":
        return _ExecutionProvenance(
            generation=self.generation + 1,
            possible_duplicate=True,
        )


@dataclass
class Bench:
    run_cell: RunCell
    score: Score
    meta: dict[str, Any] = field(default_factory=dict)
    identity: BenchIdentity = field(default_factory=BenchIdentity)
    campaign_id_factory: Callable[[], str] = field(default_factory=lambda: lambda: uuid.uuid4().hex)

    async def run(
        self,
        config: BenchConfig,
        out_dir: str | Path,
        *,
        resume: bool = False,
        rerun_ambiguous: bool = False,
    ) -> dict[str, Any]:
        out = Path(out_dir)
        with _run_lock(out):
            return await self._run_locked(
                config,
                out,
                resume=resume,
                rerun_ambiguous=rerun_ambiguous,
            )

    async def _run_locked(
        self,
        config: BenchConfig,
        out: Path,
        *,
        resume: bool,
        rerun_ambiguous: bool,
    ) -> dict[str, Any]:
        if rerun_ambiguous and not resume:
            raise ValueError("rerun_ambiguous requires resume=True")
        config_payload = _config_dict(config)
        identity_payload = asdict(self.identity)
        _ensure_json(self.meta, path="meta")
        meta_payload = _json_clone(self.meta)
        fingerprints = _fingerprints(config_payload, identity_payload, meta_payload)
        base_run_record = {
            "format_version": _FORMAT_VERSION,
            "identity": identity_payload,
            **fingerprints,
        }

        if resume:
            stored = _read_json(out / "run.json", label="run identity")
            if (
                not isinstance(stored, dict)
                or set(stored) != {*base_run_record, "campaign_id"}
                or {key: stored[key] for key in base_run_record} != base_run_record
                or not _valid_campaign_id(stored["campaign_id"])
            ):
                raise ResumeMismatch(
                    "resume fingerprint mismatch: config, cases, identity, or meta changed"
                )
            campaign_id = stored["campaign_id"]
            stored_config = _read_json(out / "config.json", label="run config")
            stored_meta = _read_json(out / "meta.json", label="run meta")
            if _json_text(stored_config) != _json_text(config_payload):
                raise ResumeMismatch("resume config artifact does not match run identity")
            if _json_text(stored_meta) != _json_text(meta_payload):
                raise ResumeMismatch("resume meta artifact does not match run identity")
        else:
            existing = sorted(path.name for path in out.iterdir() if path.name != ".bench.lock")
            if existing:
                raise BenchArtifactError(
                    "run directory is not empty or is partially initialized; use a fresh directory"
                )
            campaign_id = self.campaign_id_factory()
            if not _valid_campaign_id(campaign_id):
                raise BenchArtifactError("campaign_id_factory must return a safe non-empty id")
            run_record = {**base_run_record, "campaign_id": campaign_id}
            _atomic_write_json(out / "config.json", config_payload)
            _atomic_write_json(out / "meta.json", meta_payload)
            # Commit marker last: its presence means the supporting identity
            # artifacts were atomically replaced and directory-fsynced first.
            _atomic_write_json(out / "run.json", run_record)

        frozen_cases = tuple(
            BenchCase(item["id"], item["payload"]) for item in config_payload["cases"]
        )
        cells = expand(config_payload["levers"])
        cells_dir = out / "cells"
        cells_dir.mkdir(parents=True, exist_ok=True)
        implicit_default = len(frozen_cases) == 1 and frozen_cases[0] == BenchCase("default", None)
        roots = [
            _Root(
                cell=cell,
                case=case,
                repeat=repeat,
                implicit_default=implicit_default,
                campaign_id=campaign_id,
            )
            for case in frozen_cases
            for repeat in range(config.repeats)
            for cell in cells
        ]
        results: dict[str, RepeatResult] = {}
        missing: list[tuple[_Root, _ExecutionProvenance]] = []
        ambiguous: list[str] = []
        for root in roots:
            checkpoint = _root_path(cells_dir, root)
            if resume and checkpoint.exists():
                results[root.key] = _load_root(checkpoint, root, fingerprints["resume_fingerprint"])
            elif resume and _started_path(cells_dir, root).exists():
                provenance = _load_started(
                    _started_path(cells_dir, root),
                    root,
                    fingerprints["resume_fingerprint"],
                )
                ambiguous.append(root.key)
                if rerun_ambiguous:
                    missing.append((root, provenance.rerun()))
            else:
                missing.append((root, _ExecutionProvenance()))

        if ambiguous and not rerun_ambiguous:
            raise AmbiguousRoot(
                "roots started without terminal checkpoints; reconcile provider/ledger state "
                f"before retrying: {ambiguous}"
            )

        iterator = iter(missing)

        async def worker() -> None:
            for root, provenance in iterator:
                # artifact writes fsync (twice per root) — off-loop, or every
                # slow-disk flush stalls all in-flight provider calls
                await asyncio.to_thread(
                    _write_started,
                    _started_path(cells_dir, root),
                    root,
                    fingerprints["resume_fingerprint"],
                    provenance,
                )
                result = await self._repeat(root, config.cell_retries, provenance)
                await asyncio.to_thread(
                    _write_root,
                    _root_path(cells_dir, root),
                    root,
                    result,
                    fingerprints["resume_fingerprint"],
                )
                results[root.key] = result

        if missing:
            workers = [
                asyncio.create_task(worker()) for _ in range(min(config.concurrency, len(missing)))
            ]
            try:
                await asyncio.gather(*workers)
            except BaseException:
                for task in workers:
                    task.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                raise

        def ordered_results(cell: Cell) -> list[RepeatResult]:
            return [
                results[_Root(cell, case, repeat, implicit_default, campaign_id).key]
                for case in frozen_cases
                for repeat in range(config.repeats)
            ]

        score_signals: dict[str, Any] = {}
        missing_scores: list[tuple[Cell, _ExecutionProvenance]] = []
        ambiguous_scores: list[str] = []
        for cell in cells:
            checkpoint = _score_path(cells_dir, cell)
            started = _score_started_path(cells_dir, cell)
            if resume and checkpoint.exists():
                score_signals[cell.id] = _load_score(
                    checkpoint,
                    cell,
                    fingerprints["resume_fingerprint"],
                )
            elif resume and started.exists():
                provenance = _load_score_started(
                    started,
                    cell,
                    fingerprints["resume_fingerprint"],
                )
                ambiguous_scores.append(cell.id)
                if rerun_ambiguous:
                    missing_scores.append((cell, provenance.rerun()))
            elif resume and (_cell_path(cells_dir, cell) / "signals.json").exists():
                raise BenchArtifactError(
                    f"cell {cell.id!r} has signals without a terminal score checkpoint"
                )
            else:
                missing_scores.append((cell, _ExecutionProvenance()))

        if ambiguous_scores and not rerun_ambiguous:
            raise AmbiguousScore(
                "scores started without terminal checkpoints; reconcile scorer/ledger state "
                f"before retrying: {ambiguous_scores}"
            )

        for cell, provenance in missing_scores:
            _write_score_started(
                _score_started_path(cells_dir, cell),
                cell,
                fingerprints["resume_fingerprint"],
                provenance,
            )
            ordered = ordered_results(cell)
            score_results = [_clone_result(result) for result in ordered]
            signals = await _maybe_await(self.score(_json_clone(cell.levers), score_results))
            _ensure_json(signals, path=f"signals for cell {cell.id!r}")
            frozen_signals = _json_clone(signals)
            _write_score(
                _score_path(cells_dir, cell),
                cell,
                frozen_signals,
                fingerprints["resume_fingerprint"],
                provenance,
            )
            score_signals[cell.id] = frozen_signals

        for cell in cells:
            _write_cell(
                _cell_path(cells_dir, cell),
                cell,
                ordered_results(cell),
                score_signals[cell.id],
            )

        summary = _summarize(out, cells, fingerprints, identity_payload)
        _atomic_write_json(out / "summary.json", summary)
        _atomic_write_text(out / "summary.md", _summary_md(summary))
        return summary

    async def _repeat(
        self,
        root: _Root,
        cell_retries: int,
        provenance: _ExecutionProvenance,
    ) -> RepeatResult:
        last: RetryableCellError | None = None
        for apparatus_attempt in range(1, cell_retries + 2):
            try:
                output = await self.run_cell(
                    CellContext(
                        levers=_json_clone(root.cell.levers),
                        repeat=root.repeat,
                        context_id=root.context_id,
                        case_id=root.case.id,
                        case=_json_clone(root.case.payload),
                    )
                )
                _ensure_json(output, path=f"output for root {root.key!r}")
                return RepeatResult(
                    status="ok",
                    output=_json_clone(output),
                    context_id=root.context_id,
                    case_id=root.case.id,
                    repeat=root.repeat,
                    apparatus_attempts=apparatus_attempt,
                    execution_generation=provenance.generation,
                    possible_duplicate=provenance.possible_duplicate,
                )
            except RetryableCellError as error:
                last = error
                continue
            except asyncio.CancelledError:
                raise
            except BenchArtifactError:
                raise
            except Exception as error:
                return RepeatResult(
                    status="error",
                    error=_failure("system_under_test", error, apparatus_attempt),
                    context_id=root.context_id,
                    case_id=root.case.id,
                    repeat=root.repeat,
                    apparatus_attempts=apparatus_attempt,
                    execution_generation=provenance.generation,
                    possible_duplicate=provenance.possible_duplicate,
                )
        assert last is not None
        attempts = cell_retries + 1
        return RepeatResult(
            status="error",
            error=_failure("apparatus_exhausted", last, attempts),
            context_id=root.context_id,
            case_id=root.case.id,
            repeat=root.repeat,
            apparatus_attempts=attempts,
            execution_generation=provenance.generation,
            possible_duplicate=provenance.possible_duplicate,
        )

    def main(self, argv: list[str] | None = None) -> None:
        """CLI: ``python bench/run.py config.json out/ [--resume] [--diff A B]``."""
        parser = argparse.ArgumentParser()
        parser.add_argument("config", nargs="?", help="config JSON path")
        parser.add_argument("out", nargs="?", help="output directory")
        parser.add_argument("--resume", action="store_true")
        parser.add_argument(
            "--rerun-ambiguous",
            action="store_true",
            help="explicitly repeat roots/scores that started without a terminal checkpoint",
        )
        parser.add_argument("--diff", nargs=2, metavar=("A", "B"), help="compare two run dirs")
        args = parser.parse_args(argv)

        if args.diff:
            report = diff_runs(args.diff[0], args.diff[1])
            print(_json_text(report, indent=2))
            return
        if not args.config or not args.out:
            parser.error("config and out are required unless --diff")
        raw = _read_json(Path(args.config), label="bench config")
        allowed = {
            "levers",
            "lever_order",
            "cases",
            "repeats",
            "concurrency",
            "cell_retries",
        }
        if not isinstance(raw, dict) or set(raw) - allowed or "levers" not in raw:
            parser.error("config has unknown keys or is missing levers")
        if not isinstance(raw["levers"], dict):
            parser.error("config levers must be an object")
        lever_order = raw.get("lever_order", list(raw["levers"]))
        if (
            not isinstance(lever_order, list)
            or not all(isinstance(key, str) for key in lever_order)
            or len(lever_order) != len(set(lever_order))
            or set(lever_order) != set(raw["levers"])
        ):
            parser.error("config lever_order must list every lever exactly once")
        levers = {key: raw["levers"][key] for key in lever_order}
        cases = tuple(
            BenchCase(item["id"], item["payload"])
            for item in raw.get("cases", [{"id": "default", "payload": None}])
        )
        config = BenchConfig(
            levers=levers,
            cases=cases,
            repeats=raw.get("repeats", 1),
            concurrency=raw.get("concurrency", 4),
            cell_retries=raw.get("cell_retries", 2),
        )
        summary = asyncio.run(
            self.run(
                config,
                args.out,
                resume=args.resume,
                rerun_ambiguous=args.rerun_ambiguous,
            )
        )
        print(_summary_md(summary))


def _failure(kind: FailureKind, error: Exception, attempts: int) -> FailureObservation:
    error_type = type(error)
    return FailureObservation(
        kind=kind,
        exception_type=f"{error_type.__module__}.{error_type.__qualname__}",
        message=str(error),
        apparatus_attempts=attempts,
    )


def _valid_campaign_id(value: Any) -> bool:
    return isinstance(value, str) and _SAFE_ID.fullmatch(value) is not None


@contextmanager
def _run_lock(out: Path) -> Iterator[None]:
    try:
        import fcntl
    except (ImportError, ModuleNotFoundError) as error:
        raise LockUnavailable(
            "bench execution requires Unix fcntl locking; corpus and replay utilities "
            "remain importable on this platform"
        ) from error

    out.mkdir(parents=True, exist_ok=True)
    lock_path = out / ".bench.lock"
    lock_flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(lock_path, lock_flags, 0o600)
    except OSError as error:
        raise BenchArtifactError(f"cannot open private run lock {lock_path}: {error}") from error
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RunLocked(f"run directory is already active: {out}") from error
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _ensure_json(value: Any, *, path: str) -> None:
    try:
        _ensure_json_value(value, path=path, ancestors=set())
    except RecursionError as error:
        raise BenchArtifactError(f"{path} exceeds the supported JSON nesting depth") from error


def _ensure_json_value(value: Any, *, path: str, ancestors: set[int]) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise BenchArtifactError(f"{path} must contain only finite JSON numbers")
        return
    if isinstance(value, list):
        marker = id(value)
        if marker in ancestors:
            raise BenchArtifactError(f"{path} contains cyclic JSON")
        ancestors.add(marker)
        try:
            for index, item in enumerate(value):
                _ensure_json_value(item, path=f"{path}[{index}]", ancestors=ancestors)
        finally:
            ancestors.remove(marker)
        return
    if isinstance(value, dict):
        marker = id(value)
        if marker in ancestors:
            raise BenchArtifactError(f"{path} contains cyclic JSON")
        ancestors.add(marker)
        try:
            for key, item in value.items():
                if not isinstance(key, str):
                    raise BenchArtifactError(f"{path} JSON object keys must be strings")
                _ensure_json_value(item, path=f"{path}.{key}", ancestors=ancestors)
        finally:
            ancestors.remove(marker)
        return
    raise BenchArtifactError(f"{path} contains unsupported JSON value {type(value).__name__}")


def _json_text(value: Any, *, indent: int | None = None) -> str:
    _ensure_json(value, path="artifact")
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        indent=indent,
        sort_keys=True,
        separators=(",", ":") if indent is None else None,
    )


def _json_clone(value: Any) -> Any:
    return _strict_json_loads(_json_text(value), label="artifact")


def _strict_json_loads(raw: str, *, label: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise BenchArtifactError(f"{label} contains duplicate key {key!r}")
            result[key] = value
        return result

    def constant(value: str) -> None:
        raise BenchArtifactError(f"{label} contains non-finite number {value}")

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except BenchArtifactError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        raise BenchArtifactError(f"invalid {label} JSON: {error}") from error


def _read_json(path: Path, *, label: str) -> Any:
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise BenchArtifactError(f"cannot read {label} {path}: {error}") from error
    value = _strict_json_loads(raw, label=label)
    _ensure_json(value, path=label)
    return value


def _atomic_write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary, descriptor = _open_private_temporary(path)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _open_private_temporary(path: Path) -> tuple[Path, int]:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    for _ in range(128):
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            descriptor = os.open(temporary, flags, 0o600)
        except FileExistsError:
            continue
        return temporary, descriptor
    raise BenchArtifactError(f"cannot allocate an exclusive temporary for {path}")


def _atomic_write_json(path: Path, value: Any) -> None:
    _atomic_write_text(path, _json_text(value, indent=2) + "\n")


def _canonical_digest(value: Any) -> str:
    return hashlib.sha256(_json_text(value).encode()).hexdigest()


def _config_dict(config: BenchConfig) -> dict[str, Any]:
    return {
        "levers": _json_clone(config.levers),
        "lever_order": list(config.levers),
        "cases": [{"id": case.id, "payload": _json_clone(case.payload)} for case in config.cases],
        "repeats": config.repeats,
        "concurrency": config.concurrency,
        "cell_retries": config.cell_retries,
    }


def _fingerprints(
    config: dict[str, Any], identity: dict[str, str], meta: dict[str, Any]
) -> dict[str, str]:
    resume = _canonical_digest({"config": config, "identity": identity, "meta": meta})
    lever_shape = []
    for name in config["lever_order"]:
        value = config["levers"][name]
        if isinstance(value, list) and len(value) > 1:
            lever_shape.append({"name": name, "kind": "axis"})
        else:
            constant = value[0] if isinstance(value, list) else value
            lever_shape.append({"name": name, "kind": "constant", "value": constant})
    comparison_config = {
        "lever_shape": lever_shape,
        "cases": config["cases"],
        "repeats": config["repeats"],
    }
    comparison = _canonical_digest({"config": comparison_config, "identity": identity})
    return {"resume_fingerprint": resume, "comparison_fingerprint": comparison}


def _root_path(cells_dir: Path, root: _Root) -> Path:
    return _contained(cells_dir, root.cell.id, "roots", root.filename)


def _started_path(cells_dir: Path, root: _Root) -> Path:
    return _contained(cells_dir, root.cell.id, "starts", root.filename)


def _score_path(cells_dir: Path, cell: Cell) -> Path:
    return _contained(cells_dir, cell.id, "score.json")


def _score_started_path(cells_dir: Path, cell: Cell) -> Path:
    return _contained(cells_dir, cell.id, "score-start.json")


def _cell_path(cells_dir: Path, cell: Cell) -> Path:
    return _contained(cells_dir, cell.id)


def _contained(root: Path, *parts: str) -> Path:
    candidate = root.joinpath(*parts)
    try:
        candidate.resolve(strict=False).relative_to(root.resolve(strict=False))
    except ValueError as error:
        raise BenchArtifactError(f"artifact path escapes run directory: {candidate}") from error
    return candidate


def _result_dict(result: RepeatResult) -> dict[str, Any]:
    return {
        "status": result.status,
        "output": result.output,
        "error": asdict(result.error) if result.error is not None else None,
        "context_id": result.context_id,
        "case_id": result.case_id,
        "repeat": result.repeat,
        "apparatus_attempts": result.apparatus_attempts,
        "execution_generation": result.execution_generation,
        "possible_duplicate": result.possible_duplicate,
    }


def _clone_result(result: RepeatResult) -> RepeatResult:
    value = _json_clone(_result_dict(result))
    return _result_from_dict(value, label="score result snapshot")


def _result_from_dict(value: Any, *, label: str) -> RepeatResult:
    expected = {
        "status",
        "output",
        "error",
        "context_id",
        "case_id",
        "repeat",
        "apparatus_attempts",
        "execution_generation",
        "possible_duplicate",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise BenchArtifactError(f"{label} result has an invalid shape")
    if value["status"] not in {"ok", "error"}:
        raise BenchArtifactError(f"{label} result has an invalid status")
    if not isinstance(value["context_id"], str) or not 0 < len(value["context_id"]) <= 64:
        raise BenchArtifactError(f"{label} context_id must be a 1-64 character string")
    if not isinstance(value["case_id"], str) or not _SAFE_ID.fullmatch(value["case_id"]):
        raise BenchArtifactError(f"{label} case_id is invalid")
    if (
        not _is_int(value["repeat"])
        or value["repeat"] < 0
        or not _is_int(value["apparatus_attempts"])
        or value["apparatus_attempts"] < 1
        or not _is_int(value["execution_generation"])
        or value["execution_generation"] < 1
        or not isinstance(value["possible_duplicate"], bool)
    ):
        raise BenchArtifactError(
            f"{label} repeat/apparatus_attempts/execution_generation provenance is invalid"
        )
    if value["possible_duplicate"] != (value["execution_generation"] > 1):
        raise BenchArtifactError(f"{label} execution generation/duplicate marker is incoherent")
    error_value = value["error"]
    error = None
    if error_value is not None:
        error_keys = {"kind", "exception_type", "message", "apparatus_attempts"}
        if not isinstance(error_value, dict) or set(error_value) != error_keys:
            raise BenchArtifactError(f"{label} failure observation has an invalid shape")
        if error_value["kind"] not in {"system_under_test", "apparatus_exhausted"}:
            raise BenchArtifactError(f"{label} failure observation has an invalid kind")
        if (
            not isinstance(error_value["exception_type"], str)
            or not isinstance(error_value["message"], str)
            or not _is_int(error_value["apparatus_attempts"])
            or error_value["apparatus_attempts"] != value["apparatus_attempts"]
        ):
            raise BenchArtifactError(f"{label} failure observation has invalid field types")
        error = FailureObservation(**error_value)
    if (value["status"] == "ok") == (error is not None):
        raise BenchArtifactError(f"{label} status/error combination is incoherent")
    if value["status"] == "error" and value["output"] is not None:
        raise BenchArtifactError(f"{label} failed result must not contain output")
    result = RepeatResult(
        status=value["status"],
        output=value["output"],
        error=error,
        context_id=value["context_id"],
        case_id=value["case_id"],
        repeat=value["repeat"],
        apparatus_attempts=value["apparatus_attempts"],
        execution_generation=value["execution_generation"],
        possible_duplicate=value["possible_duplicate"],
    )
    _ensure_json(_result_dict(result), path=label)
    return result


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _write_root(path: Path, root: _Root, result: RepeatResult, fingerprint: str) -> None:
    _atomic_write_json(
        path,
        {
            "format_version": _FORMAT_VERSION,
            "resume_fingerprint": fingerprint,
            "cell_id": root.cell.id,
            "case_id": root.case.id,
            "repeat": root.repeat,
            "execution_generation": result.execution_generation,
            "possible_duplicate": result.possible_duplicate,
            "result": _result_dict(result),
        },
    )


def _write_started(
    path: Path,
    root: _Root,
    fingerprint: str,
    provenance: _ExecutionProvenance,
) -> None:
    _atomic_write_json(
        path,
        {
            "format_version": _FORMAT_VERSION,
            "resume_fingerprint": fingerprint,
            "cell_id": root.cell.id,
            "case_id": root.case.id,
            "repeat": root.repeat,
            "context_id": root.context_id,
            "execution_generation": provenance.generation,
            "possible_duplicate": provenance.possible_duplicate,
            "state": "started",
        },
    )


def _load_started(path: Path, root: _Root, fingerprint: str) -> _ExecutionProvenance:
    label = f"start journal {path}"
    value = _read_json(path, label=label)
    expected = {
        "format_version",
        "resume_fingerprint",
        "cell_id",
        "case_id",
        "repeat",
        "context_id",
        "execution_generation",
        "possible_duplicate",
        "state",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise BenchArtifactError(f"{label} has an invalid shape")
    identity = (
        value["format_version"],
        value["resume_fingerprint"],
        value["cell_id"],
        value["case_id"],
        value["repeat"],
        value["context_id"],
        value["execution_generation"],
        value["possible_duplicate"],
        value["state"],
    )
    wanted = (
        _FORMAT_VERSION,
        fingerprint,
        root.cell.id,
        root.case.id,
        root.repeat,
        root.context_id,
        value["execution_generation"],
        value["possible_duplicate"],
        "started",
    )
    if _json_text(list(identity)) != _json_text(list(wanted)):
        raise ResumeMismatch(f"{label} belongs to a different root or campaign")
    return _provenance_from_values(
        value["execution_generation"],
        value["possible_duplicate"],
        label=label,
    )


def _load_root(path: Path, root: _Root, fingerprint: str) -> RepeatResult:
    label = f"checkpoint {path}"
    value = _read_json(path, label=label)
    expected = {
        "format_version",
        "resume_fingerprint",
        "cell_id",
        "case_id",
        "repeat",
        "execution_generation",
        "possible_duplicate",
        "result",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise BenchArtifactError(f"{label} has an invalid shape")
    identity = (
        value["format_version"],
        value["resume_fingerprint"],
        value["cell_id"],
        value["case_id"],
        value["repeat"],
        value["execution_generation"],
        value["possible_duplicate"],
    )
    wanted = (
        _FORMAT_VERSION,
        fingerprint,
        root.cell.id,
        root.case.id,
        root.repeat,
        value["execution_generation"],
        value["possible_duplicate"],
    )
    if _json_text(list(identity)) != _json_text(list(wanted)):
        raise ResumeMismatch(f"{label} belongs to a different root or campaign")
    result = _result_from_dict(value["result"], label=label)
    if (
        result.context_id != root.context_id
        or result.case_id != root.case.id
        or result.repeat != root.repeat
        or result.execution_generation != value["execution_generation"]
        or result.possible_duplicate != value["possible_duplicate"]
    ):
        raise ResumeMismatch(f"{label} result attribution does not match its root")
    _provenance_from_values(
        value["execution_generation"],
        value["possible_duplicate"],
        label=label,
    )
    return result


def _provenance_from_values(
    generation: Any,
    possible_duplicate: Any,
    *,
    label: str,
) -> _ExecutionProvenance:
    if not _is_int(generation) or generation < 1 or not isinstance(possible_duplicate, bool):
        raise BenchArtifactError(f"{label} has invalid execution provenance")
    if possible_duplicate != (generation > 1):
        raise BenchArtifactError(f"{label} execution generation/duplicate marker is incoherent")
    return _ExecutionProvenance(generation, possible_duplicate)


def _write_score_started(
    path: Path,
    cell: Cell,
    fingerprint: str,
    provenance: _ExecutionProvenance,
) -> None:
    _atomic_write_json(
        path,
        {
            "format_version": _FORMAT_VERSION,
            "resume_fingerprint": fingerprint,
            "cell_id": cell.id,
            "execution_generation": provenance.generation,
            "possible_duplicate": provenance.possible_duplicate,
            "state": "started",
        },
    )


def _load_score_started(
    path: Path,
    cell: Cell,
    fingerprint: str,
) -> _ExecutionProvenance:
    label = f"score start journal {path}"
    value = _read_json(path, label=label)
    expected = {
        "format_version",
        "resume_fingerprint",
        "cell_id",
        "execution_generation",
        "possible_duplicate",
        "state",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise BenchArtifactError(f"{label} has an invalid shape")
    if (
        value["format_version"] != _FORMAT_VERSION
        or value["resume_fingerprint"] != fingerprint
        or value["cell_id"] != cell.id
        or value["state"] != "started"
    ):
        raise ResumeMismatch(f"{label} belongs to a different cell or campaign")
    return _provenance_from_values(
        value["execution_generation"],
        value["possible_duplicate"],
        label=label,
    )


def _write_score(
    path: Path,
    cell: Cell,
    signals: Any,
    fingerprint: str,
    provenance: _ExecutionProvenance,
) -> None:
    _atomic_write_json(
        path,
        {
            "format_version": _FORMAT_VERSION,
            "resume_fingerprint": fingerprint,
            "cell_id": cell.id,
            "execution_generation": provenance.generation,
            "possible_duplicate": provenance.possible_duplicate,
            "signals": signals,
        },
    )


def _load_score(path: Path, cell: Cell, fingerprint: str) -> Any:
    label = f"score checkpoint {path}"
    value = _read_json(path, label=label)
    expected = {
        "format_version",
        "resume_fingerprint",
        "cell_id",
        "execution_generation",
        "possible_duplicate",
        "signals",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise BenchArtifactError(f"{label} has an invalid shape")
    if (
        value["format_version"] != _FORMAT_VERSION
        or value["resume_fingerprint"] != fingerprint
        or value["cell_id"] != cell.id
    ):
        raise ResumeMismatch(f"{label} belongs to a different cell or campaign")
    _provenance_from_values(
        value["execution_generation"],
        value["possible_duplicate"],
        label=label,
    )
    return _json_clone(value["signals"])


def _write_cell(cell_dir: Path, cell: Cell, results: list[RepeatResult], signals: Any) -> None:
    _atomic_write_json(cell_dir / "levers.json", cell.levers)
    _atomic_write_json(cell_dir / "outputs.json", [_result_dict(result) for result in results])
    _atomic_write_json(cell_dir / "signals.json", signals)


def _summarize(
    out: Path,
    cells: list[Cell],
    fingerprints: dict[str, str],
    identity: dict[str, str],
) -> dict[str, Any]:
    rows = []
    with_non_error = all_error = 0
    for cell in cells:
        cell_dir = _cell_path(out / "cells", cell)
        signals = _read_json(cell_dir / "signals.json", label=f"signals for {cell.id}")
        outputs = _read_json(cell_dir / "outputs.json", label=f"outputs for {cell.id}")
        errors = sum(1 for output in outputs if output["status"] == "error")
        if errors == len(outputs) and outputs:
            all_error += 1
        else:
            with_non_error += 1
        rows.append(
            {
                "id": cell.id,
                "levers": cell.levers,
                "signals": signals,
                "errors": errors,
                "roots": len(outputs),
            }
        )
    return {
        "format_version": _FORMAT_VERSION,
        **fingerprints,
        "identity": identity,
        "cells_with_non_error_roots": with_non_error,
        "cells_all_roots_error": all_error,
        "total": len(cells),
        "roots": sum(row["roots"] for row in rows),
        "cells": rows,
    }


def _summary_md(summary: dict[str, Any]) -> str:
    lines = [
        "# bench summary — "
        f"{summary['cells_with_non_error_roots']}/{summary['total']} cells have a "
        f"non-error root ({summary['cells_all_roots_error']} all-root error)",
        "",
        "| cell | roots | signals | errors |",
        "|---|---:|---|---:|",
    ]
    for row in summary["cells"]:
        lines.append(
            f"| {row['id']} | {row['roots']} | {_json_text(row['signals'])} | {row['errors']} |"
        )
    return "\n".join(lines) + "\n"


def diff_runs(dir_a: str | Path, dir_b: str | Path) -> dict[str, Any]:
    """Compare signals only when population, cases, and judge identity match."""
    a = _load_summary(Path(dir_a) / "summary.json", label="summary A")
    b = _load_summary(Path(dir_b) / "summary.json", label="summary B")
    defaults = {"suite": "anonymous", "dataset": "unspecified", "runner": "unspecified"}
    identities = (a.get("identity"), b.get("identity"))
    if any(
        not isinstance(identity, dict)
        or set(identity) != set(defaults)
        or any(identity[key] == default for key, default in defaults.items())
        for identity in identities
    ):
        raise IncomparableRuns(
            "comparison requires an explicit suite, dataset, and runner identity"
        )
    if a.get("comparison_fingerprint") != b.get("comparison_fingerprint"):
        raise IncomparableRuns("comparison fingerprint mismatch")
    by_id_a = {row["id"]: row for row in a["cells"]}
    by_id_b = {row["id"]: row for row in b["cells"]}
    shared = sorted(by_id_a.keys() & by_id_b.keys())
    for cell_id in shared:
        if _json_text(by_id_a[cell_id]["levers"]) != _json_text(by_id_b[cell_id]["levers"]):
            raise IncomparableRuns(f"cell {cell_id!r} identifies different lever assignments")
    return {
        "comparison_fingerprint": a["comparison_fingerprint"],
        "changed": [
            {
                "id": cell_id,
                "a": by_id_a[cell_id]["signals"],
                "b": by_id_b[cell_id]["signals"],
            }
            for cell_id in shared
            if _json_text(by_id_a[cell_id]["signals"]) != _json_text(by_id_b[cell_id]["signals"])
        ],
        "unchanged": [
            cell_id
            for cell_id in shared
            if _json_text(by_id_a[cell_id]["signals"]) == _json_text(by_id_b[cell_id]["signals"])
        ],
        "only_in_a": sorted(by_id_a.keys() - by_id_b.keys()),
        "only_in_b": sorted(by_id_b.keys() - by_id_a.keys()),
    }


def _load_summary(path: Path, *, label: str) -> dict[str, Any]:
    value = _read_json(path, label=label)
    keys = {
        "format_version",
        "resume_fingerprint",
        "comparison_fingerprint",
        "identity",
        "cells_with_non_error_roots",
        "cells_all_roots_error",
        "total",
        "roots",
        "cells",
    }
    if not isinstance(value, dict) or set(value) != keys:
        raise BenchArtifactError(f"{label} has an invalid shape")
    if not _is_int(value["format_version"]) or value["format_version"] != _FORMAT_VERSION:
        raise BenchArtifactError(f"{label} has an unsupported format version")
    for name in ("resume_fingerprint", "comparison_fingerprint"):
        if not isinstance(value[name], str) or not _SHA256.fullmatch(value[name]):
            raise BenchArtifactError(f"{label} {name} must be a canonical sha256")
    identity = value["identity"]
    identity_keys = {"suite", "dataset", "runner"}
    if (
        not isinstance(identity, dict)
        or set(identity) != identity_keys
        or any(not isinstance(identity[key], str) or not identity[key].strip() for key in identity)
    ):
        raise BenchArtifactError(f"{label} identity has an invalid shape")
    count_names = (
        "cells_with_non_error_roots",
        "cells_all_roots_error",
        "total",
        "roots",
    )
    if any(not _is_int(value[name]) or value[name] < 0 for name in count_names):
        raise BenchArtifactError(f"{label} counters must be non-negative integers")
    rows = value["cells"]
    if not isinstance(rows, list):
        raise BenchArtifactError(f"{label} cells must be an array")
    seen: set[str] = set()
    computed_roots = 0
    computed_all_error = 0
    row_keys = {"id", "levers", "signals", "errors", "roots"}
    for index, row_value in enumerate(rows):
        where = f"{label} cells[{index}]"
        if not isinstance(row_value, dict) or set(row_value) != row_keys:
            raise BenchArtifactError(f"{where} has an invalid shape")
        row = cast(dict[str, Any], row_value)
        if not _valid_cell_id(row["id"]):
            raise BenchArtifactError(f"{where} id is not a safe cell id")
        cell_id = cast(str, row["id"])
        if cell_id in seen:
            raise BenchArtifactError(f"{label} contains duplicate cell id {cell_id!r}")
        seen.add(cell_id)
        if not isinstance(row["levers"], dict):
            raise BenchArtifactError(f"{where} levers must be an object")
        errors_value, roots_value = row["errors"], row["roots"]
        if not _is_int(errors_value) or not _is_int(roots_value):
            raise BenchArtifactError(f"{where} errors/roots are incoherent")
        errors, roots = cast(int, errors_value), cast(int, roots_value)
        if roots < 1 or not 0 <= errors <= roots:
            raise BenchArtifactError(f"{where} errors/roots are incoherent")
        computed_roots += roots
        computed_all_error += errors == roots
    if value["total"] != len(rows) or value["roots"] != computed_roots:
        raise BenchArtifactError(f"{label} aggregate cell/root counts are incoherent")
    if (
        value["cells_all_roots_error"] != computed_all_error
        or value["cells_with_non_error_roots"] != len(rows) - computed_all_error
    ):
        raise BenchArtifactError(f"{label} aggregate health counts are incoherent")
    return value


def _valid_cell_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 200
        and value not in {".", ".."}
        and "/" not in value
        and "\\" not in value
        and not any(ord(character) < 32 for character in value)
    )


async def ledger_cost(
    session_factory: async_sessionmaker, context_kind: str, context_id: str
) -> float:
    """Sum resolved physical-attempt cost for one attributed bench root."""
    from kit_llm.capture import llm_attempts, llm_runs

    async with session_factory() as session:
        total = await session.scalar(
            sa.select(sa.func.coalesce(sa.func.sum(llm_attempts.c.cost_usd), 0.0))
            .select_from(llm_attempts.join(llm_runs, llm_attempts.c.run_id == llm_runs.c.id))
            .where(llm_runs.c.context_kind == context_kind, llm_runs.c.context_id == context_id)
        )
    return float(total)


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value

"""The runner. Bench(run_cell, score) owns orchestration; the app owns the
two callables and everything domain. A cell = one lever assignment, run
`repeats` times (nondeterminism needs samples); score sees all repeats and
produces the cell's signals. Cells run concurrently under a semaphore. A
run is resumable: a completed cell's directory is its checkpoint.

apparatus vs system-under-test: run_cell raises RetryableCellError for its
OWN infra failures (a browser that won't launch, a dropped socket) — those
retry, they are NOT the model failing. Any other exception is a real
failed repeat, recorded as one; the measurement is not corrupted by
counting a broken thermometer's reading."""

import argparse
import asyncio
import inspect
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm.bench.expand import Cell, expand


class RetryableCellError(Exception):
    """The measuring apparatus failed, not the system under test. The
    harness retries the repeat; it does not count against quality."""


@dataclass(frozen=True)
class CellContext:
    """Handed to run_cell for one repeat. `context_id` is unique per
    repeat — pass it to llm.run(context=('bench', ctx.context_id)) so the
    cell's cost is attributable in the ledger."""

    levers: dict[str, Any]
    repeat: int
    context_id: str


@dataclass(frozen=True)
class RepeatResult:
    status: str  # "ok" | "error"
    output: Any = None
    error: str | None = None
    # the context_id this repeat ran under — pass it to ledger_cost for
    # cost attribution without reconstructing the harness's cell-id format
    context_id: str = ""


@dataclass(frozen=True)
class BenchConfig:
    levers: dict[str, Any]
    repeats: int = 1
    concurrency: int = 4
    cell_retries: int = 2


RunCell = Callable[[CellContext], Awaitable[Any]]
Score = Callable[[dict[str, Any], list[RepeatResult]], Any]


@dataclass
class Bench:
    run_cell: RunCell
    score: Score
    meta: dict[str, Any] = field(default_factory=dict)

    async def run(
        self, config: BenchConfig, out_dir: str | Path, *, resume: bool = False
    ) -> dict[str, Any]:
        out = Path(out_dir)
        cells_dir = out / "cells"
        cells_dir.mkdir(parents=True, exist_ok=True)
        (out / "config.json").write_text(json.dumps(_config_dict(config), indent=2))
        # meta passthrough: verbatim, the harness never interprets it
        (out / "meta.json").write_text(json.dumps(self.meta, indent=2, default=str))

        cells = expand(config.levers)
        state = _load_state(out) if resume else {}
        lock = asyncio.Lock()
        semaphore = asyncio.Semaphore(config.concurrency)

        async def process(cell: Cell) -> None:
            if state.get(cell.id) == "done":
                return  # resume: the cell dir is its checkpoint
            async with semaphore:
                results = [
                    await self._repeat(cell, r, config.cell_retries)
                    for r in range(config.repeats)
                ]
                signals = await _maybe_await(self.score(cell.levers, results))
                _write_cell(cells_dir / cell.id, cell, results, signals)
            async with lock:
                state[cell.id] = "done"
                _save_state(out, state)

        await asyncio.gather(*(process(cell) for cell in cells))
        summary = _summarize(out, cells)
        (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
        (out / "summary.md").write_text(_summary_md(summary))
        return summary

    async def _repeat(self, cell: Cell, repeat: int, cell_retries: int) -> RepeatResult:
        context_id = f"{cell.id}#{repeat}"
        last: Exception | None = None
        for _ in range(cell_retries + 1):
            try:
                output = await self.run_cell(
                    CellContext(levers=cell.levers, repeat=repeat, context_id=context_id)
                )
                return RepeatResult(status="ok", output=output, context_id=context_id)
            except RetryableCellError as error:
                last = error  # apparatus failure — retry, don't blame the model
                continue
            except Exception as error:
                return RepeatResult(status="error", error=repr(error), context_id=context_id)
        return RepeatResult(
            status="error", error=f"apparatus retries exhausted: {last!r}", context_id=context_id
        )

    def main(self, argv: list[str] | None = None) -> None:
        """CLI: `python bench/run.py config.json out/ [--resume] [--diff A B]`."""
        parser = argparse.ArgumentParser()
        parser.add_argument("config", nargs="?", help="config JSON path")
        parser.add_argument("out", nargs="?", help="output directory")
        parser.add_argument("--resume", action="store_true")
        parser.add_argument("--diff", nargs=2, metavar=("A", "B"), help="compare two run dirs")
        args = parser.parse_args(argv)

        if args.diff:
            report = diff_runs(args.diff[0], args.diff[1])
            print(json.dumps(report, indent=2, default=str))
            return
        if not args.config or not args.out:
            parser.error("config and out are required unless --diff")
        raw = json.loads(Path(args.config).read_text())
        config = BenchConfig(
            levers=raw["levers"],
            repeats=raw.get("repeats", 1),
            concurrency=raw.get("concurrency", 4),
            cell_retries=raw.get("cell_retries", 2),
        )
        summary = asyncio.run(self.run(config, args.out, resume=args.resume))
        print(_summary_md(summary))


# -- persistence -----------------------------------------------------------------

def _config_dict(config: BenchConfig) -> dict[str, Any]:
    return {
        "levers": config.levers,
        "repeats": config.repeats,
        "concurrency": config.concurrency,
        "cell_retries": config.cell_retries,
    }


def _write_cell(
    cell_dir: Path, cell: Cell, results: list[RepeatResult], signals: Any
) -> None:
    cell_dir.mkdir(parents=True, exist_ok=True)
    (cell_dir / "levers.json").write_text(json.dumps(cell.levers, indent=2, default=str))
    (cell_dir / "outputs.json").write_text(
        json.dumps([r.__dict__ for r in results], indent=2, default=str)
    )
    (cell_dir / "signals.json").write_text(json.dumps(signals, indent=2, default=str))


def _load_state(out: Path) -> dict[str, str]:
    path = out / "state.json"
    return json.loads(path.read_text()) if path.exists() else {}


def _save_state(out: Path, state: dict[str, str]) -> None:
    (out / "state.json").write_text(json.dumps(state, indent=2))


def _summarize(out: Path, cells: list[Cell]) -> dict[str, Any]:
    rows = []
    ok = failed = 0
    for cell in cells:
        cell_dir = out / "cells" / cell.id
        signals = json.loads((cell_dir / "signals.json").read_text())
        outputs = json.loads((cell_dir / "outputs.json").read_text())
        errors = sum(1 for o in outputs if o["status"] == "error")
        if errors == len(outputs) and outputs:
            failed += 1
        else:
            ok += 1
        rows.append({"id": cell.id, "levers": cell.levers, "signals": signals, "errors": errors})
    return {"cells_ok": ok, "cells_failed": failed, "total": len(cells), "cells": rows}


def _summary_md(summary: dict[str, Any]) -> str:
    lines = [
        f"# bench summary — {summary['cells_ok']}/{summary['total']} cells ok"
        f" ({summary['cells_failed']} failed)",
        "",
        "| cell | signals | errors |",
        "|---|---|---|",
    ]
    for row in summary["cells"]:
        lines.append(f"| {row['id']} | {json.dumps(row['signals'])} | {row['errors']} |")
    return "\n".join(lines) + "\n"


# -- diff ------------------------------------------------------------------------

def diff_runs(dir_a: str | Path, dir_b: str | Path) -> dict[str, Any]:
    """Compare two run directories' signals by cell id. Shared cells show
    (a, b) side by side; cells present in only one run are listed."""
    a = json.loads((Path(dir_a) / "summary.json").read_text())
    b = json.loads((Path(dir_b) / "summary.json").read_text())
    by_id_a = {row["id"]: row["signals"] for row in a["cells"]}
    by_id_b = {row["id"]: row["signals"] for row in b["cells"]}
    shared = sorted(by_id_a.keys() & by_id_b.keys())
    return {
        "changed": [
            {"id": cid, "a": by_id_a[cid], "b": by_id_b[cid]}
            for cid in shared
            if by_id_a[cid] != by_id_b[cid]
        ],
        "unchanged": [cid for cid in shared if by_id_a[cid] == by_id_b[cid]],
        "only_in_a": sorted(by_id_a.keys() - by_id_b.keys()),
        "only_in_b": sorted(by_id_b.keys() - by_id_a.keys()),
    }


# -- cost helper (optional; apps call it inside score) ---------------------------

async def ledger_cost(
    session_factory: async_sessionmaker, context_kind: str, context_id: str
) -> float:
    """Sum resolved attempt cost for one bench context — the building
    block for a cost signal. Apps call this in score() with the
    ctx.context_id they passed to llm.run. Kept a helper, not harness
    machinery, so the harness stays domain-agnostic."""
    from kit_llm.capture import llm_attempts, llm_runs

    async with session_factory() as session:
        total = await session.scalar(
            sa.select(sa.func.coalesce(sa.func.sum(llm_attempts.c.cost_usd), 0.0))
            .select_from(
                llm_attempts.join(llm_runs, llm_attempts.c.run_id == llm_runs.c.id)
            )
            .where(llm_runs.c.context_kind == context_kind, llm_runs.c.context_id == context_id)
        )
    return float(total)


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value

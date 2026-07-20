"""The bench harness building blocks. What every LLM app rebuilds — lever
expansion, repeats, concurrency, per-cell persistence, resume, summary,
diff — factored behind two app-provided callables (run_cell, score). The
domain (scenarios, fixtures, judges, ground truth, metrics) stays in the
app; only the machinery lives here.

An LLM system is nondeterministic, so "does it work" is unanswerable —
replaced by "how often, how well, at what cost, over a fixed input
population". A bench run varies levers one at a time and measures; cells
run through llm.run, so cost lands in the same ledger with
context_kind='bench'."""

from kit_llm.bench.expand import Cell, expand
from kit_llm.bench.harness import (
    Bench,
    BenchConfig,
    CellContext,
    RepeatResult,
    RetryableCellError,
    diff_runs,
    ledger_cost,
)

__all__ = [
    "Bench",
    "BenchConfig",
    "Cell",
    "CellContext",
    "RepeatResult",
    "RetryableCellError",
    "diff_runs",
    "expand",
    "ledger_cost",
]

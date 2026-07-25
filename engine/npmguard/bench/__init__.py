"""The bench domain (v2) — a pinned corpus driven through the LIVE engine, with
every judgement DERIVED at read time.

Replaces ``npmguard/bench.py``, which read a directory of snapshot JSON and scored
it on two primitives that no longer exist (``expectedCapabilities ⊆
report.capabilities``, ``proof.kind == "TEST_CONFIRMED"``). Both were already vacuous on the pinned corpus before the
schema moved — every entry carried ``expected.capabilities: []``, so ``detected``
had degenerated to ``verdict == "DANGEROUS"`` and ``verified`` was 0/20 by
construction. The module's core line was a stored JUDGEMENT
(``{"DANGEROUS": "detected", "SAFE": "missed"}``), which is why a schema change
made its rows unreadable instead of re-projectable.

Layout, and what each half is allowed to know:

- :mod:`.corpus` — the pinned expectations, as committed FILES. No table.
- :mod:`.store` — the two facts a run must store: its four identifiers and its
  ``(entry, runIndex) -> auditId`` mapping. Appended to the durable log. No table.
- :mod:`.read` — assembles a stored run from ``audit_id``s alone (G24).
- :mod:`.projector` — PURE. ``expected × observed -> outcome -> rates``.
- :mod:`.fidelity` — PURE. Render fidelity as code over sealed artifacts (B-12).
- :mod:`.runner` — ``npmguard-ops bench run``, on the unbilled lane.
- :mod:`.routes` — read-only HTTP. No bench route may enqueue work.
"""

from .corpus import Corpus, Entry, find_corpus, load_corpora
from .fidelity import FidelityCounts, counts_for, counts_over
from .projector import EntryBucket, Outcome, Rate, RunMetrics, project
from .read import LoadedRun, load_run, load_runs
from .store import Attempt, BenchRunStore, RunDescriptor

__all__ = [
    "Attempt",
    "BenchRunStore",
    "Corpus",
    "Entry",
    "EntryBucket",
    "FidelityCounts",
    "LoadedRun",
    "Outcome",
    "Rate",
    "RunDescriptor",
    "RunMetrics",
    "counts_for",
    "counts_over",
    "find_corpus",
    "load_corpora",
    "load_run",
    "load_runs",
    "project",
]

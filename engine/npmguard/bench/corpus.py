"""The corpus + its entries — the ``expected`` side, and the only part of the
bench domain that is a FILE rather than a row.

§4.3 of the platform design lists four bench tables (``bench_corpora``,
``bench_entries``, ``bench_runs``, ``bench_run_items``). Two of them are deleted
here rather than built, and the reason is not economy — it is that a corpus is
already an immutable, content-addressed, version-controlled artifact:

- **A corpus is pinned by a hash of its own bytes** (``manifestSha``,
  ``shared/src/bench.ts:44-46``). A table row holding a copy of a committed file
  can disagree with the file; a hash of the file cannot. Loading the manifest and
  hashing it IS the identity check, so a row would be a second copy of a fact
  whose whole purpose is to be singular.
- **Corpora are immutable once tagged** (methodology §8.1). Mutability is the only
  thing a table buys over a file, and this entity is defined by not having it.
- **Ids are derivable.** ``BenchCorpus.id`` / ``BenchEntry.id`` are ints on the
  wire, so they are derived from the identity that already exists
  (``datasetVersion`` / ``fixtureName``) by :func:`corpus_id` / :func:`entry_id`,
  not assigned by a sequence. Two processes reading the same committed manifest
  therefore agree on every id without a shared table — which is also what makes
  ``audit_sets.origin_ref`` (a NOT NULL int subject id) expressible for a
  ``bench_run`` with no corpus table to point at.

INVARIANT: entry ids are unique within a corpus. Asserted at load time in
:func:`_entries` — the derivation is a truncated hash, so uniqueness is a real
property of the corpus that a collision would silently break (two entries would
score as one). Not re-checked anywhere downstream.

Fixture names are the package name the engine is asked to audit:
``resolve.py:38-41`` short-circuits any ``test-pkg-*`` name to
``sandbox/test-fixtures/<name>``, so a corpus entry's ``fixtureName`` is both the
on-disk directory and the audit's ``package_name``. Those directories are LIVE
MALWARE (F-G7): nothing here reads, installs, or executes them — this module
touches the manifest only.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import cast, get_args

from ..config import REPO_ROOT
from ..contract import models as contract
from ..contract.kinds import BenchCorpusSource, BenchVerdict

# Corpus manifests live beside the dataset material they describe.
DATASET_DIR = (REPO_ROOT / "bench" / "dataset").resolve()

# Every field of `BenchEntry` that is not derived. Spelled out so a manifest with
# a stale v1 field (`expected.capabilities`, `expected.kind`, `difficulty` — all
# retired by methodology §11) fails to load instead of carrying dead weight
# forward: the whole class of bug this domain died of was a reader trusting a
# field the writer had stopped meaning.
ENTRY_FIELDS = frozenset(
    {
        "fixtureName",
        "packageName",
        "version",
        "category",
        "expectedVerdict",
        "discoveryDate",
        "rationale",
        "sourceId",
    }
)

MANIFEST_FIELDS = frozenset(
    {"name", "version", "source", "datasetVersion", "generatedAt", "entries"}
)


def _derived_id(*parts: str) -> int:
    """A stable positive 31-bit id from an identity string.

    31 bits, not 63: the wire is JSON and these ids reach a browser, and a
    sequence-free id is only useful if it is the same everywhere it is computed.
    """
    digest = hashlib.blake2b("\x00".join(parts).encode(), digest_size=4).digest()
    return int.from_bytes(digest, "big") & 0x7FFF_FFFF


def corpus_id(dataset_version: str) -> int:
    """The corpus's wire id AND its ``audit_sets.origin_ref``."""
    return _derived_id("corpus", dataset_version)


def entry_id(dataset_version: str, fixture_name: str) -> int:
    return _derived_id("entry", dataset_version, fixture_name)


@dataclass(frozen=True, slots=True)
class Entry:
    """One pinned expectation. Never mutated by a run."""

    id: int
    corpus_id: int
    fixture_name: str
    package_name: str
    version: str
    category: str
    expected_verdict: BenchVerdict
    discovery_date: str | None
    rationale: str | None
    source_id: str | None

    def as_wire(self) -> contract.BenchEntry:
        return contract.BenchEntry(
            id=self.id,
            corpusId=self.corpus_id,
            fixtureName=self.fixture_name,
            packageName=self.package_name,
            version=self.version,
            category=self.category,
            expectedVerdict=self.expected_verdict,
            discoveryDate=self.discovery_date,
            rationale=self.rationale,
            sourceId=self.source_id,
        )


@dataclass(frozen=True, slots=True)
class Corpus:
    id: int
    name: str
    version: str
    source: BenchCorpusSource
    dataset_version: str
    manifest_sha: str
    generated_at: str
    path: Path
    entries: tuple[Entry, ...]

    def by_fixture(self, fixture_name: str) -> Entry | None:
        return next((e for e in self.entries if e.fixture_name == fixture_name), None)

    def as_wire(self) -> contract.BenchCorpus:
        return contract.BenchCorpus(
            id=self.id,
            name=self.name,
            version=self.version,
            datasetVersion=self.dataset_version,
            source=self.source,
            manifestSha=self.manifest_sha,
            generatedAt=self.generated_at,
            entryCount=len(self.entries),
        )


def manifest_sha(path: Path) -> str:
    """The hash a run pins its corpus by — over the file's BYTES.

    Not over a re-serialization of the parsed content: a formatting-only rewrite
    is still a change to the artifact a published number cites, and a hash that
    forgives it cannot catch a corpus edited under a fixed identity.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()


BENCH_VERDICTS: frozenset[BenchVerdict] = frozenset(get_args(BenchVerdict))
BENCH_CORPUS_SOURCES: frozenset[BenchCorpusSource] = frozenset(get_args(BenchCorpusSource))


def _one_of[T: str](value: object, allowed: frozenset[T], what: str) -> T:
    """``value``, checked against the contract vocabulary it claims to be in.

    A manifest is an on-disk artifact a published number cites, so a value
    outside the contract has to fail at load with the offending value named —
    not flow on as a string nothing downstream branches on.
    """
    if value not in allowed:
        raise ValueError(f"{what}: {value!r} is not one of {sorted(allowed)}")
    return cast(T, value)  # the membership check above IS the narrowing


def _entries(payload: dict, dataset_version: str, cid: int) -> tuple[Entry, ...]:
    entries: list[Entry] = []
    for raw in payload["entries"]:
        unknown = set(raw) - ENTRY_FIELDS
        if unknown:
            raise ValueError(
                f"{dataset_version}: entry {raw.get('fixtureName')!r} carries "
                f"non-BenchEntry field(s) {sorted(unknown)}; v1's expectedKind / "
                "expectedCapabilities / difficulty are retired (methodology §11)"
            )
        entries.append(
            Entry(
                id=entry_id(dataset_version, raw["fixtureName"]),
                corpus_id=cid,
                fixture_name=raw["fixtureName"],
                package_name=raw["packageName"],
                version=raw["version"],
                category=raw["category"],
                expected_verdict=_one_of(
                    raw["expectedVerdict"], BENCH_VERDICTS, f"{dataset_version}: expectedVerdict"
                ),
                discovery_date=raw["discoveryDate"],
                rationale=raw["rationale"],
                source_id=raw["sourceId"],
            )
        )
    ids = {entry.id for entry in entries}
    assert len(ids) == len(entries), (
        f"{dataset_version}: derived entry ids collide — {len(entries) - len(ids)} "
        "duplicate(s). Two entries scoring as one is silent, so this is fatal; "
        "rename a fixture or widen _derived_id."
    )
    return tuple(entries)


def load_manifest(path: Path) -> Corpus:
    payload = json.loads(path.read_text(encoding="utf-8"))
    missing = MANIFEST_FIELDS - set(payload)
    if missing:
        raise ValueError(f"{path}: corpus manifest is missing {sorted(missing)}")
    dataset_version = payload["datasetVersion"]
    cid = corpus_id(dataset_version)
    return Corpus(
        id=cid,
        name=payload["name"],
        version=payload["version"],
        source=_one_of(payload["source"], BENCH_CORPUS_SOURCES, f"{path}: source"),
        dataset_version=dataset_version,
        manifest_sha=manifest_sha(path),
        generated_at=payload["generatedAt"],
        path=path,
        entries=_entries(payload, dataset_version, cid),
    )


def load_corpora(dataset_dir: Path | None = None) -> list[Corpus]:
    """Every corpus manifest on disk, newest dataset first."""
    root = dataset_dir or DATASET_DIR
    if not root.is_dir():
        return []
    corpora = [load_manifest(path) for path in sorted(root.glob("*.json"))]
    return sorted(corpora, key=lambda c: c.generated_at, reverse=True)


def find_corpus(selector: str, dataset_dir: Path | None = None) -> Corpus:
    """Resolve a ``--corpus`` selector: a ``datasetVersion`` or ``name-version``.

    Both spellings are accepted because the design doc's own CLI example
    (`--corpus datadog-0.2.0`, §5.3) and the committed manifest's
    `datasetVersion` (`0.2.0-datadog`) disagree, and refusing one of them would
    make a documented command wrong.
    """
    corpora = load_corpora(dataset_dir)
    match = next(
        (
            c
            for c in corpora
            if selector in {c.dataset_version, f"{c.name}-{c.version}"}
        ),
        None,
    )
    if match is None:
        known = ", ".join(sorted(c.dataset_version for c in corpora)) or "(none)"
        raise ValueError(f"no corpus matches {selector!r}; known datasetVersions: {known}")
    return match


def load_corpus_by_id(cid: int, dataset_dir: Path | None = None) -> Corpus | None:
    return next((c for c in load_corpora(dataset_dir) if c.id == cid), None)


__all__ = [
    "DATASET_DIR",
    "ENTRY_FIELDS",
    "Corpus",
    "Entry",
    "corpus_id",
    "entry_id",
    "find_corpus",
    "load_corpora",
    "load_corpus_by_id",
    "load_manifest",
    "manifest_sha",
]

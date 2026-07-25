# CLASS MAP — bench.corpus: the pinned expectations, as committed FILES
# (seam: the filesystem. `load_manifest` over a temp manifest for the rules, and
#  over the REAL committed corpus for the classes that are claims about it.)
#
#   C1  a manifest loads into Entry records whose fields are exactly BenchEntry's
#   C2  a manifest carrying a RETIRED v1 field is refused, naming the field —
#       `expected.capabilities` / `expected.kind` / `difficulty` (methodology §11).
#       A data file with a field no reader means is how v1 died
#   C3  a manifest missing a required key is refused
#   C4  ids are DERIVED and stable: the same file read twice, in any process,
#       yields the same corpus id and the same entry ids — which is what lets
#       audit_sets.origin_ref hold a NOT NULL integer subject id with no corpus
#       table behind it
#   C5  entry ids are unique within a corpus, asserted at load (two entries
#       scoring as one would be silent)
#   C6  manifestSha is over the file's BYTES, so a formatting-only rewrite is a
#       different corpus — a hash that forgives it cannot catch a corpus edited
#       under a fixed identity
#   C7  --corpus accepts either the datasetVersion or name-version, because the
#       design doc's own CLI example and the committed manifest disagree
#   C8  an unknown selector names what it knows
# The committed corpus, as claims about the real file:
#   C9  20 entries, all expectedVerdict DANGEROUS, two strata at 14/6
#   C10 zero negative controls today — so specificity is UNMEASURABLE and the
#       recall figure is unfalsifiable in exactly the way v1.1 §6 warned about
#   C11 the wire shape is the contract's BenchCorpus / BenchEntry

import json
from pathlib import Path

import pytest

from npmguard.bench import corpus as corpus_module
from npmguard.contract import models as contract

REPO_BENCH = Path(__file__).resolve().parents[2] / "bench" / "dataset"

ENTRY = {
    "fixtureName": "test-pkg-bench-dd-c-example-v1.0.0",
    "packageName": "example",
    "version": "1.0.0",
    "category": "datadog-compromised",
    "expectedVerdict": "DANGEROUS",
    "discoveryDate": "2025-09-16",
    "rationale": "known malicious",
    "sourceId": "2025-09-16-example-v1.0.0.zip",
}
MANIFEST = {
    "name": "unit",
    "version": "0.1",
    "source": "datadog",
    "datasetVersion": "0.1-unit",
    "generatedAt": "2026-07-25T00:00:00Z",
    "entries": [ENTRY],
}


def _write(tmp_path: Path, payload: dict, name: str = "unit-0.1.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_a_manifest_loads_into_entries(tmp_path: Path) -> None:
    """C1."""
    corpus = corpus_module.load_manifest(_write(tmp_path, MANIFEST))
    assert (corpus.name, corpus.version, corpus.source) == ("unit", "0.1", "datadog")
    assert corpus.dataset_version == "0.1-unit"
    entry = corpus.entries[0]
    assert entry.fixture_name == ENTRY["fixtureName"]
    assert entry.expected_verdict == "DANGEROUS"
    assert entry.discovery_date == "2025-09-16"
    assert corpus.by_fixture(ENTRY["fixtureName"]) is entry
    assert corpus.by_fixture("nope") is None


@pytest.mark.parametrize(
    "retired", [{"difficulty": None}, {"expected": {}}, {"pkg": {"name": "x"}}]
)
def test_a_retired_v1_field_is_refused(tmp_path: Path, retired: dict) -> None:
    """C2: the v1 manifest carried `difficulty: null` on all 20 entries,
    `expected.capabilities: []` on all 20, and `expected.kind: "AI_STATIC"` on all
    20 — the last two are precisely why v1's `detected` had degenerated to a
    verdict comparison and its `verified` was 0/20 by construction."""
    payload = {**MANIFEST, "entries": [{**ENTRY, **retired}]}
    with pytest.raises(ValueError, match="non-BenchEntry field"):
        corpus_module.load_manifest(_write(tmp_path, payload))


def test_a_manifest_missing_a_key_is_refused(tmp_path: Path) -> None:
    """C3."""
    payload = {key: value for key, value in MANIFEST.items() if key != "datasetVersion"}
    with pytest.raises(ValueError, match="missing"):
        corpus_module.load_manifest(_write(tmp_path, payload))


def test_ids_are_derived_and_stable(tmp_path: Path) -> None:
    """C4: no sequence, no table. Two reads agree, and so do two processes."""
    first = corpus_module.load_manifest(_write(tmp_path, MANIFEST))
    second = corpus_module.load_manifest(_write(tmp_path, MANIFEST, "copy.json"))
    assert first.id == second.id == corpus_module.corpus_id("0.1-unit")
    assert first.entries[0].id == corpus_module.entry_id("0.1-unit", ENTRY["fixtureName"])
    assert 0 < first.id <= 0x7FFF_FFFF
    # A different dataset version is a different corpus.
    assert corpus_module.corpus_id("0.2-unit") != first.id


def test_entry_ids_are_unique_within_a_corpus(tmp_path: Path) -> None:
    """C5: the derivation is a truncated hash, so uniqueness is a property of the
    corpus rather than of the function, and a collision must be fatal."""
    payload = {**MANIFEST, "entries": [ENTRY, {**ENTRY, "packageName": "other"}]}
    with pytest.raises(AssertionError, match="collide"):
        corpus_module.load_manifest(_write(tmp_path, payload))


def test_manifest_sha_is_over_the_bytes(tmp_path: Path) -> None:
    """C6: a reformat is a different artifact. A published number cites the file,
    not the parse."""
    compact = _write(tmp_path, MANIFEST, "a.json")
    pretty = tmp_path / "b.json"
    pretty.write_text(json.dumps(MANIFEST, indent=2), encoding="utf-8")
    assert corpus_module.manifest_sha(compact) != corpus_module.manifest_sha(pretty)
    assert corpus_module.load_manifest(compact).entries == corpus_module.load_manifest(pretty).entries


def test_the_selector_accepts_both_spellings(tmp_path: Path) -> None:
    """C7: `--corpus datadog-0.2.0` (design §5.3) and `0.2.0-datadog` (the
    committed datasetVersion) are the same corpus, and refusing one would make a
    documented command wrong."""
    _write(tmp_path, MANIFEST)
    assert corpus_module.find_corpus("0.1-unit", tmp_path).dataset_version == "0.1-unit"
    assert corpus_module.find_corpus("unit-0.1", tmp_path).dataset_version == "0.1-unit"


def test_an_unknown_selector_names_what_it_knows(tmp_path: Path) -> None:
    """C8."""
    _write(tmp_path, MANIFEST)
    with pytest.raises(ValueError, match="0.1-unit"):
        corpus_module.find_corpus("nope", tmp_path)
    assert corpus_module.load_corpora(tmp_path / "missing") == []


def test_the_committed_corpus_is_what_the_methodology_describes() -> None:
    """C9/C10: claims about the real file. All 20 entries are DANGEROUS and there
    are ZERO negative controls, so specificity is currently unmeasurable — which is
    why §6.5 says not to publish a headline from this corpus at any performance
    level, and why B-8 funds 75 clean entries first. A 20-entry run is a smoke test
    for the harness, labelled as such."""
    corpus = corpus_module.load_manifest(REPO_BENCH / "manifest.full.json")
    assert corpus.dataset_version == "0.2.0-datadog"
    assert len(corpus.entries) == 20
    assert {entry.expected_verdict for entry in corpus.entries} == {"DANGEROUS"}
    strata = {}
    for entry in corpus.entries:
        strata[entry.category] = strata.get(entry.category, 0) + 1
    assert strata == {"datadog-compromised": 14, "datadog-malicious-intent": 6}
    assert not [entry for entry in corpus.entries if entry.expected_verdict == "SAFE"]
    # Every fixture name is a `test-pkg-*` local-fixture name, which is what makes
    # `resolve.py` short-circuit to sandbox/test-fixtures instead of the registry.
    assert all(entry.fixture_name.startswith("test-pkg-bench-dd-") for entry in corpus.entries)


def test_the_wire_shape_is_the_contract() -> None:
    """C11."""
    corpus = corpus_module.load_manifest(REPO_BENCH / "manifest.full.json")
    wire = corpus.as_wire()
    assert isinstance(wire, contract.BenchCorpus)
    assert wire.entryCount == len(corpus.entries) == 20
    assert wire.manifestSha == corpus.manifest_sha
    assert isinstance(corpus.entries[0].as_wire(), contract.BenchEntry)

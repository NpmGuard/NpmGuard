# CLASS MAP — report_store (seam: DATA_DIR patched to a tmpdir; pure filesystem)
# Axes: version source (inventory-real / requested / neither / "latest") ×
#       load resolution (exact filename / embedded-version scan / newest-mtime) ×
#       file health (valid / corrupt / concurrently rewritten) ×
#       name shape (plain / scoped @org/pkg / escaping)
#   C1  inventory version present → saved as <real>.json (CLAUDE.md: real version authoritative)
#   C2  real ≠ requested → the stale requested-version alias file is deleted
#   C3  no inventory version, requested present → <requested>.json
#   C4  NEITHER version → ValueError, nothing persisted (a latest.json alias must never exist)
#   C5  requested=="latest" with real present → <real>.json only, no stray "latest" handling
#   C6  concurrent saves of same pkg/ver → readers never observe torn JSON (atomic replace)
#   C7  path escape ('../evil') → ValueError on save AND load
#   C8  scoped @org/pkg → nested dir round-trip; list_reports reassembles the scoped name
#   C9  load exact version → filename hit
#   C10 load version with renamed file → found via embedded-version scan
#   C11 load versionless → newest file by mtime
#   C12 corrupt JSON skipped in ALL THREE load paths: exact-filename hit (falls
#       through to the scan), version scan, and newest versionless candidate
#   C13 missing dir / dir with no parseable report → None
#   C14 extract_report_version: absent trace / inventory w/o metadata / non-string version
#       → None; the FIRST inventory phase wins (early return)
#   C15 list_reports visibility + order: test-pkg-*/test-package*/-bench- names are
#       saved but NOT listed (the mechanism keeping malware-fixture reports out of
#       the public listing); verdict-less files skipped; ordering newest-first
# Adversarial pass: W5 2026-07-23 — "can a reader ever see a half-written file?" →
#   C6 probes the os.replace atomicity with live readers during repeated rewrites.
import json
import os
import threading
from typing import Any

import pytest

from npmguard.report_store import (
    extract_report_version,
    list_reports,
    load_report,
    save_report,
)


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    root = tmp_path / "reports"
    monkeypatch.setattr("npmguard.report_store.DATA_DIR", root)
    return root


def _report(version: str | None = None, *, verdict: str = "SAFE", pad: str = "") -> dict[str, Any]:
    trace = []
    if version is not None:
        trace.append({"phase": "inventory", "output": {"metadata": {"version": version}}})
    return {"verdict": verdict, "trace": trace, "pad": pad}


def test_real_inventory_version_names_the_file(data_dir) -> None:
    """C1: the tarball's real version (from the inventory trace) is the filename."""
    saved = save_report("left-pad", "1.0.0", _report("2.0.0"))
    assert saved == "2.0.0"
    assert (data_dir / "left-pad" / "2.0.0.json").is_file()
    assert not (data_dir / "left-pad" / "1.0.0.json").exists()


def test_requested_alias_deleted_when_real_differs(data_dir) -> None:
    """C2: a stale file under the requested version is removed once the real
    version is known — one report, one concrete name."""
    (data_dir / "left-pad").mkdir(parents=True)
    (data_dir / "left-pad" / "1.0.0.json").write_text("{}", encoding="utf-8")
    save_report("left-pad", "1.0.0", _report("2.0.0"))
    assert not (data_dir / "left-pad" / "1.0.0.json").exists()
    assert (data_dir / "left-pad" / "2.0.0.json").is_file()


def test_requested_version_used_when_inventory_silent(data_dir) -> None:
    """C3: no version in the report → the concrete requested version names the file."""
    assert save_report("left-pad", "1.3.0", _report(None)) == "1.3.0"
    assert (data_dir / "left-pad" / "1.3.0.json").is_file()


def test_no_version_anywhere_is_an_error_not_latest_json(data_dir) -> None:
    """C4: neither the report nor the request carries a concrete version →
    ValueError and nothing persisted. Honors CLAUDE.md: never a latest.json alias."""
    with pytest.raises(ValueError, match="latest.json alias must never be persisted"):
        save_report("left-pad", "latest", _report(None))
    assert not (data_dir / "left-pad").exists()


def test_requested_latest_with_real_version_saves_real_only(data_dir) -> None:
    """C5: "latest" is legal request INPUT; with a real version present the file
    is <real>.json and no "latest"-named residue appears."""
    assert save_report("left-pad", "latest", _report("2.0.0")) == "2.0.0"
    files = sorted(file.name for file in (data_dir / "left-pad").iterdir())
    assert files == ["2.0.0.json"]


def test_concurrent_rewrites_never_expose_torn_json(data_dir) -> None:
    """C6: save is tmp-file + os.replace, so a reader polling the file during
    repeated large rewrites always parses complete JSON (never a partial write)."""
    pad = "x" * 200_000
    save_report("left-pad", "1.0.0", _report("2.0.0", pad=pad))
    path = data_dir / "left-pad" / "2.0.0.json"
    stop = threading.Event()
    torn: list[Exception] = []

    def reader() -> None:
        while not stop.is_set():
            try:
                parsed = json.loads(path.read_text(encoding="utf-8"))
                assert parsed["pad"], "pad missing — partial content"
            except Exception as exc:  # noqa: BLE001 - collected for the assertion below
                torn.append(exc)

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for round_number in range(15):
            save_report("left-pad", "1.0.0", _report("2.0.0", pad=f"{round_number}{pad}"))
    finally:
        stop.set()
        thread.join(timeout=10)
    assert not thread.is_alive()
    assert torn == []


def test_path_escape_rejected_on_save_and_load(data_dir) -> None:
    """C7: a package name that resolves outside the data dir is refused by both
    save and load — the report store is not a path-traversal primitive."""
    with pytest.raises(ValueError, match="escapes data directory"):
        save_report("../evil", "1.0.0", _report("1.0.0"))
    with pytest.raises(ValueError, match="escapes data directory"):
        load_report("../evil")
    assert not (data_dir.parent / "evil").exists()


def test_scoped_package_round_trip_and_listing(data_dir) -> None:
    """C8: @org/pkg nests one directory level; load resolves it and list_reports
    reassembles the scoped name from the nested layout."""
    save_report("@org/pkg", "1.0.0", _report("1.0.0"))
    assert (data_dir / "@org" / "pkg" / "1.0.0.json").is_file()
    loaded = load_report("@org/pkg", "1.0.0")
    assert loaded is not None and loaded[1] == "1.0.0"
    rows = list_reports()
    assert [row["packageName"] for row in rows] == ["@org/pkg"]
    assert rows[0]["version"] == "1.0.0"
    assert rows[0]["verdict"] == "SAFE"


def test_load_exact_version_filename(data_dir) -> None:
    """C9: a requested version whose file exists loads by direct filename hit."""
    save_report("left-pad", "1.0.0", _report("1.0.0", verdict="DANGEROUS"))
    loaded = load_report("left-pad", "1.0.0")
    assert loaded is not None
    report, version = loaded
    assert report["verdict"] == "DANGEROUS"
    assert version == "1.0.0"


def test_load_version_via_embedded_scan(data_dir) -> None:
    """C10: when no file carries the requested name, the directory is scanned and
    the report whose embedded inventory version matches is returned."""
    save_report("left-pad", "2.0.0", _report("2.0.0"))
    os.rename(
        data_dir / "left-pad" / "2.0.0.json",
        data_dir / "left-pad" / "renamed-by-hand.json",
    )
    loaded = load_report("left-pad", "2.0.0")
    assert loaded is not None and loaded[1] == "2.0.0"
    assert load_report("left-pad", "9.9.9") is None


def test_load_versionless_returns_newest_by_mtime(data_dir) -> None:
    """C11: a versionless load (including requested=="latest") serves the newest
    report file by mtime."""
    save_report("left-pad", "1.0.0", _report("1.0.0"))
    save_report("left-pad", "2.0.0", _report("2.0.0", verdict="DANGEROUS"))
    old = data_dir / "left-pad" / "1.0.0.json"
    new = data_dir / "left-pad" / "2.0.0.json"
    os.utime(old, (1_000_000, 1_000_000))
    os.utime(new, (2_000_000, 2_000_000))
    for requested in (None, "latest"):
        loaded = load_report("left-pad", requested)
        assert loaded is not None
        assert loaded[1] == "2.0.0"
        assert loaded[0]["verdict"] == "DANGEROUS"


def test_corrupt_files_skipped_in_all_load_paths(data_dir) -> None:
    """C12: a corrupt JSON file is skipped by every load path — the version scan,
    the versionless newest-mtime pick, AND the exact-filename hit. The exact hit
    is only a fast path over the scan, and the api.py caller maps None to a 404
    while having no JSONDecodeError handling (a raise would 500 the endpoint),
    so a corrupt exact file must degrade like every other corrupt file: fall
    through to the embedded-version scan, then None if nothing matches."""
    save_report("left-pad", "1.0.0", _report("1.0.0"))
    good = data_dir / "left-pad" / "1.0.0.json"
    corrupt = data_dir / "left-pad" / "zz-corrupt.json"
    corrupt.write_text('{"verdict": "SAFE", "trace": [truncated', encoding="utf-8")
    os.utime(good, (1_000_000, 1_000_000))
    os.utime(corrupt, (2_000_000, 2_000_000))  # corrupt file is the NEWEST
    versionless = load_report("left-pad")
    assert versionless is not None and versionless[1] == "1.0.0"
    scanned = load_report("left-pad", "1.0.0")
    assert scanned is not None and scanned[1] == "1.0.0"
    # Exact-filename hit on the corrupt file: treated as missing, not a crash.
    assert load_report("left-pad", "zz-corrupt") is None
    # And the fall-through actually recovers: corrupt <version>.json, but the
    # report lives on under another filename with the version embedded.
    (data_dir / "left-pad" / "2.0.0.json").write_text("[truncated", encoding="utf-8")
    renamed = data_dir / "left-pad" / "renamed-by-hand.json"
    renamed.write_text(json.dumps(_report("2.0.0", verdict="DANGEROUS")), encoding="utf-8")
    recovered = load_report("left-pad", "2.0.0")
    assert recovered is not None
    assert recovered[0]["verdict"] == "DANGEROUS"
    assert recovered[1] == "2.0.0"


def test_missing_or_unreadable_dir_returns_none(data_dir) -> None:
    """C13: no directory, or a directory holding only unparseable files → None."""
    assert load_report("never-audited") is None
    directory = data_dir / "broken-pkg"
    directory.mkdir(parents=True)
    (directory / "not-a-report.json").write_text("not json at all", encoding="utf-8")
    assert load_report("broken-pkg") is None
    assert load_report("broken-pkg", "1.0.0") is None


def test_listing_hides_fixture_names_skips_verdictless_orders_newest(data_dir) -> None:
    """C15: list_reports hides test-pkg-*/test-package*/-bench- packages even
    though their reports ARE on disk, skips files without a verdict, and sorts
    the visible rows newest-auditedAt-first."""
    save_report("test-pkg-env-exfil", "2.0.1", _report("2.0.1", verdict="DANGEROUS"))
    save_report("test-package-demo", "1.0.0", _report("1.0.0"))
    save_report("acme-bench-dd-probe", "1.0.0", _report("1.0.0"))
    save_report("older-pkg", "1.0.0", _report("1.0.0"))
    save_report("newer-pkg", "1.0.0", _report("1.0.0", verdict="DANGEROUS"))
    # verdict-less report file: present on disk, never listed
    (data_dir / "verdictless-pkg").mkdir(parents=True)
    (data_dir / "verdictless-pkg" / "1.0.0.json").write_text(
        json.dumps({"trace": []}), encoding="utf-8"
    )
    os.utime(data_dir / "older-pkg" / "1.0.0.json", (1_000_000, 1_000_000))
    os.utime(data_dir / "newer-pkg" / "1.0.0.json", (2_000_000, 2_000_000))

    rows = list_reports()
    assert [row["packageName"] for row in rows] == ["newer-pkg", "older-pkg"]
    assert rows[0]["verdict"] == "DANGEROUS"
    # positive pair: the hidden reports really exist on disk
    assert (data_dir / "test-pkg-env-exfil" / "2.0.1.json").is_file()
    assert (data_dir / "acme-bench-dd-probe" / "1.0.0.json").is_file()


def test_extract_version_edge_shapes(data_dir) -> None:
    """C14: absent/empty trace, inventory without metadata, and non-string
    versions all yield None; the first inventory phase wins via early return."""
    assert extract_report_version({}) is None
    assert extract_report_version({"trace": []}) is None
    assert extract_report_version({"trace": [{"phase": "inventory", "output": None}]}) is None
    assert (
        extract_report_version(
            {"trace": [{"phase": "inventory", "output": {"metadata": {"version": 7}}}]}
        )
        is None
    )
    first_wins = {
        "trace": [
            {"phase": "inventory", "output": {"metadata": {}}},
            {"phase": "inventory", "output": {"metadata": {"version": "9.9.9"}}},
        ]
    }
    assert extract_report_version(first_wins) is None  # early return on the FIRST phase

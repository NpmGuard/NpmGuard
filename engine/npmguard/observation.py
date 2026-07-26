from __future__ import annotations

import asyncio
import contextlib
import json
import posixpath
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import Settings
from .contract.models import Budget, ObserveFlags, RunArtifact, RunError, ToolCall, Trigger
from .docker import (
    TMPFS_TMP,
    DockerOutputTooLargeError,
    TmpfsMount,
    VolumeMount,
    default_container_spec,
    docker_exec,
    instrumentation_source,
    spec_to_docker_args,
    write_file_in_container,
)
from .errors import DockerUnavailableError
from .evidence import (
    INSTRUMENT_PATH,
    compute_event_summary,
    parse_l4_trace,
    seal_run_artifact,
    sha256_hex,
    synthetic_event,
)
from .experiments import compile_experiment, compose, merge_container_spec
from .sensors import (
    parse_strace_log,
    snapshot_post,
    snapshot_pre,
    start_pcap,
    stop_pcap,
    wrap_with_strace,
)

SANDBOX_WORKDIR = "/pkg"

# `docker run` can fail transiently under concurrent-audit load; retry the
# side-effect-free container start this many times before deferring the audit.
_CONTAINER_START_ATTEMPTS = 3

DEFAULT_OBSERVE: dict[str, Any] = {
    "kernel": False,
    "network": False,
    "fsDiff": False,
    "node": True,
    "inspector": False,
}
DEFAULT_BUDGET: dict[str, Any] = {
    "wallMs": 60_000,
    "maxSyscalls": None,
    "maxBytesCapture": 1_000_000,
}


class RunUnderObservationError(RuntimeError):
    def __init__(self, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.detail = detail


# The observe/budget for a load check: only the node sensor, short wall budget —
# we care whether the program-under-test can be constructed, not what it does.
LOAD_CHECK_OBSERVE = {
    "kernel": False,
    "network": False,
    "node": True,
    "fsDiff": False,
    "inspector": False,
}
LOAD_CHECK_BUDGET = {"wallMs": 10_000}


def is_unresolved_module(error: RunError | None) -> bool:
    """True when a run crashed because a module could not be resolved — the program
    under test was never constructed. Shared by the orchestrator (defer, don't refute)
    and the hypothesis dry-run gate (a fixable bad require in model-authored code)."""
    return (
        error is not None
        and error.kind == "CrashError"
        and ("Cannot find module" in error.detail or "MODULE_NOT_FOUND" in error.detail)
    )


# The one RunError kind the orchestrator will REFUTE on: SetupError, SensorError
# and TimeoutError all route to DEFERRED (orchestrator.py, the error_kind check).
# So it is the only kind a coverage gap has to displace.
_REFUTABLE_ERROR_KIND = "CrashError"


def coverage_gap(previous: RunError | None, detail: str) -> RunError:
    """The error a run carries once a sensor's evidence could not be retrieved WHOLE.

    Error latching keeps the FIRST cause, because the first thing that went wrong is
    what the artifact should name. But `kind` is not only a diagnosis — it is what
    bars REFUTED — so a CrashError latched before the pcap transfer failed would let
    a judge refute on a timeline that is missing evidence nobody knows was lost,
    which is a coverage gap laundered into SAFE. A gap therefore displaces a
    refutable kind and folds the earlier cause into the detail, so both survive in
    cause order; against a kind that already defers it changes nothing.
    """
    if previous is None:
        return RunError(kind="SensorError", detail=detail)
    if previous.kind != _REFUTABLE_ERROR_KIND:
        return previous
    return RunError(kind="SensorError", detail=f"{previous.detail}; then {detail}")


async def dry_run_load(
    package_path: Path, experiment: list[ToolCall], settings: Settings
) -> RunError | None:
    """Cheaply check that a generated experiment's payload actually loads: run the
    trigger with only the node sensor. Returns the load failure if a module could not
    be resolved (a bad require path in model-authored driver/preload code — deps are
    already provisioned by now), else None. Best-effort: an unavailable sandbox skips
    the gate and lets the full-oracle run surface real infrastructure faults."""
    try:
        artifact = await run_under_observation(
            package_path,
            experiment,
            settings,
            observe=LOAD_CHECK_OBSERVE,
            budget=LOAD_CHECK_BUDGET,
        )
    except (DockerUnavailableError, RunUnderObservationError):
        return None
    return artifact.error if is_unresolved_module(artifact.error) else None


def build_trigger_command(trigger: Trigger, l4: bool) -> list[str]:
    """TOTAL over `TriggerKind`: every declared kind has a command here, so a
    trigger that compiles is a trigger that runs. Adding a kind without a case
    below is a boot-time failure, not a SetupError inside a paid audit."""
    flags = ["--require", INSTRUMENT_PATH] if l4 else []
    if trigger.kind == "entrypoint":
        # Resolve like a shell against the sandbox workdir: an absolute path (e.g. a
        # planted /pkg/driver.js) stays absolute; a relative path resolves against
        # /pkg. require() the absolute result so there is no node_modules ambiguity.
        spec = posixpath.normpath(posixpath.join(SANDBOX_WORKDIR, trigger.target))
    else:
        # A subpath export is a module specifier, not a filesystem path.
        spec = trigger.target
    # Mirror a normal `node <spec> <argv...>` invocation: argv[1] is the entry,
    # argv[2:] the caller's args. `--` guards args that start with "-". stdin is
    # piped separately at exec time (docker exec -i), not encoded in argv.
    return ["node", *flags, "-e", f"require({json.dumps(spec)})", "--", spec, *(trigger.argv or [])]


async def run_under_observation(
    package_path: Path,
    experiment: list[ToolCall],
    settings: Settings,
    *,
    observe: dict | None = None,
    budget: dict | None = None,
) -> RunArtifact:
    run_id = f"run_{uuid4().hex[:26]}"
    compiled = compile_experiment(experiment)
    observed = ObserveFlags(**{**DEFAULT_OBSERVE, **(observe or {})})
    limits = Budget(**{**DEFAULT_BUDGET, **(budget or {})})
    base = default_container_spec(
        settings,
        volumes=[VolumeMount(str(package_path), "/pkg-src", True)],
        tmpfs=[
            TMPFS_TMP,
            TmpfsMount("/pkg", "rw,size=256m,uid=1000,gid=1000,mode=0755"),
            TmpfsMount("/home/node", "rw,size=64m,uid=1000,gid=1000,mode=0755"),
        ],
        workdir="/pkg",
        network_mode="bridge" if observed.network else "none",
        cap_add=([] if not observed.kernel else ["SYS_PTRACE"])
        + ([] if not observed.network else ["NET_RAW", "SETUID", "SETGID"]),
    )
    setup = compose(compiled.setup)
    # The setup record starts as what the experiment ASKED for and is replaced, after
    # the run, by what each manipulation turns out to have done (`setup.observers`).
    # Nothing between here and the seal may treat this as an account of the run.
    applied = setup.applied
    spec = merge_container_spec(base, setup)
    container = f"npmguard-run-{run_id[4:16]}"
    created_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    started = time.monotonic()
    events = list(setup.events)
    error: RunError | None = None
    exit_code = None
    timed_out = False
    stdout_hash = stderr_hash = fs_diff_hash = pcap_hash = strace_hash = None

    # Container start is a transient point under concurrent load — the docker
    # daemon can briefly fail to allocate (daemon/resource contention). It is the
    # first side-effect-free step, so retry it a few times with backoff before
    # giving up (a fresh `docker run` almost always succeeds), clearing any
    # half-created name between attempts. The docker stderr is preserved in
    # RunUnderObservationError.detail so a genuine (non-transient) failure stays
    # diagnosable rather than surfacing as an opaque "Worker error".
    start = None
    for attempt in range(_CONTAINER_START_ATTEMPTS):
        try:
            start = await docker_exec(spec_to_docker_args(spec, container), 30_000)
        except FileNotFoundError as exc:
            raise DockerUnavailableError() from exc
        except asyncio.CancelledError:
            # `docker run -d` can have created the container daemon-side before the
            # cancel landed, and the main try/finally below is not active yet — so a
            # worker cancelled here (graceful shutdown / per-hypothesis timeout) would
            # otherwise leak it. Remove it before re-raising; rm -f on a name that was
            # never created is a harmless no-op.
            with contextlib.suppress(Exception):
                await docker_exec(["rm", "-f", container], 10_000)
            raise
        if start.exit_code == 0:
            break
        await docker_exec(["rm", "-f", container], 10_000)
        if attempt < _CONTAINER_START_ATTEMPTS - 1:
            await asyncio.sleep(0.5 * (attempt + 1))
    if start.exit_code:
        raise RunUnderObservationError(
            "failed to start sandbox container",
            f"docker run exit={start.exit_code} after {_CONTAINER_START_ATTEMPTS} attempts: "
            f"{start.stderr[:500]}",
        )

    try:
        if observed.network:
            # start_pcap returns only once tcpdump has confirmed it is capturing
            # (readiness barrier in sensors.py) — no warm-up sleep needed here.
            try:
                await start_pcap(container)
            except Exception as exc:
                error = RunError(kind="SensorError", detail=str(exc))

        if error is None:
            copied = await docker_exec(
                ["exec", container, "sh", "-c", "cp -a /pkg-src/. /pkg/"], 30_000
            )
            if copied.exit_code:
                error = RunError(
                    kind="SetupError",
                    detail=f"failed to copy /pkg-src to /pkg: {copied.stderr[:300]}",
                )

        if error is None and observed.node:
            try:
                await write_file_in_container(
                    container,
                    INSTRUMENT_PATH,
                    instrumentation_source(bool(observed.inspector)),
                )
            except Exception as exc:
                error = RunError(
                    kind="SensorError", detail=f"failed to write L4 instrumentation: {exc}"
                )

        if error is None:
            for hook in setup.post_starts:
                try:
                    await hook(container)
                except Exception as exc:
                    error = RunError(kind="SetupError", detail=str(exc))
                    break

        run_start_sec = time.time()
        if error is None and observed.fsDiff:
            try:
                await snapshot_pre(container)
            except Exception as exc:
                error = RunError(kind="SensorError", detail=str(exc))

        if error is None:
            command = build_trigger_command(compiled.trigger, bool(observed.node))
            wrapped = wrap_with_strace(command) if observed.kernel else command
            stdin_bytes = (
                compiled.trigger.stdin.encode()
                if compiled.trigger.stdin is not None
                else None
            )
            exec_args = ["exec", *(["-i"] if stdin_bytes is not None else []), container, *wrapped]
            try:
                result = await docker_exec(exec_args, int(limits.wallMs), stdin=stdin_bytes)
            except DockerOutputTooLargeError as exc:
                # The trigger wrote more than one transfer can carry (`error` is
                # still None here — nothing else has run). Its stdout is BOTH the
                # L4 trace and a hashed capture, so a prefix would seal stdoutHash
                # over a fragment of the run and hand the judge a trace that just
                # stops. No hash is computed, the gap is named in the timeline, and
                # SensorError routes to DEFER.
                #
                # L1 is deliberately not read after this: abandoning the transfer
                # kills the local docker client, not the traced process inside the
                # container, so /tmp/strace.log is still being written and anything
                # read from it is torn. The pcap below IS still collected —
                # stop_pcap TERMs tcpdump and waits for its flush, so that file is
                # whole — which keeps a real exfiltration confirmable from L2 while
                # the gap bars a refutation.
                error = RunError(kind="SensorError", detail=str(exc))
                events.append(synthetic_event("truncated", str(exc)))
            else:
                exit_code, timed_out = result.exit_code, result.timed_out
                # Sound because of the seam's invariant: a returned stream is the
                # process's complete output, or `timed_out` marks it as cut short
                # by the kill. docker_exec never hands back a silent prefix, so
                # these hashes cannot attest a fragment as the whole stream.
                stdout_hash = sha256_hex(result.stdout) if result.stdout else None
                stderr_hash = sha256_hex(result.stderr) if result.stderr else None
                if timed_out:
                    error = RunError(
                        kind="TimeoutError",
                        detail=f"wall-clock budget ({limits.wallMs}ms) exceeded; container killed",
                    )
                    events.append(
                        synthetic_event(
                            "truncated", f"wall-clock budget ({limits.wallMs}ms) exceeded"
                        )
                    )
                elif exit_code != 0:
                    error = RunError(
                        kind="CrashError",
                        detail=f"node exited {exit_code}; stderr: {result.stderr[:500]}",
                    )
                if observed.node:
                    l4 = parse_l4_trace(result.stdout)
                    if l4 is None and error is None:
                        error = RunError(
                            kind="SensorError",
                            detail="L4 trace markers absent from stdout (instrumentation evaded or suppressed)",
                        )
                    elif l4:
                        events.extend(l4)
                if observed.kernel:
                    try:
                        trace = await docker_exec(
                            ["exec", container, "cat", "/tmp/strace.log"], 10_000
                        )
                    except DockerOutputTooLargeError as exc:
                        # A chatty run can outgrow one transfer. The log is hashed
                        # into straceLogHash and parsed into every L1 event, so a
                        # prefix would seal a hash over part of the trace and show
                        # the judge a syscall record that ENDS early — which reads
                        # exactly like a package that stopped acting. Raising at
                        # the seam is what keeps parse_strace_log from having to
                        # GUESS truncation from an incomplete last line.
                        error = coverage_gap(error, str(exc))
                        events.append(synthetic_event("truncated", str(exc)))
                    else:
                        if trace.exit_code == 0 and trace.stdout:
                            events.extend(parse_strace_log(trace.stdout, run_start_sec))
                            strace_hash = sha256_hex(trace.stdout)
                        else:
                            error = coverage_gap(
                                error, f"strace log unreadable: {trace.stderr[:300]}"
                            )

        if observed.fsDiff and (error is None or error.kind not in {"SetupError", "SensorError"}):
            try:
                diff_events, raw_diff = await snapshot_post(container, run_start_sec)
                events.extend(diff_events)
                fs_diff_hash = sha256_hex(raw_diff) if raw_diff else None
            except Exception as exc:
                error = coverage_gap(error, f"fs-diff post-snapshot failed: {exc}")

        if observed.network and (error is None or error.kind != "SetupError"):
            try:
                pcap = await stop_pcap(container)
                events.extend(pcap.events)
                # INVARIANT: pcapHash is the hash of the WHOLE capture. stop_pcap
                # either returns every byte tcpdump wrote or raises — a transfer past
                # the cap raises at the docker seam (DockerOutputTooLargeError) rather
                # than decoding into a short pcap, so a non-null pcapHash MEANS "this
                # is the capture" instead of sealing a prefix with error=null.
                pcap_hash = sha256_hex(pcap.raw_pcap) if pcap.raw_pcap else None
            except Exception as exc:
                # Any failure here is missing network evidence: a capture that died
                # mid-run, a parse that failed, or a transfer that could not be
                # completed. It must reach the judge as an incomplete capture rather
                # than as an empty L2 section, and it must bar REFUTED even when the
                # run itself already crashed.
                detail = f"pcap stop/parse failed: {exc}"
                error = coverage_gap(error, detail)
                events.append(synthetic_event("truncated", detail))

        # Read back what the setup actually DID, while the container is still alive —
        # last, so a coverage gap discovered here cannot gate the sensor collection
        # above out of the artifact (both fs-diff and pcap skip on a SetupError).
        # Skipped only when setup itself failed: then no trigger ran, nothing was
        # manipulated, and the compile-time record — which asserts nothing — is
        # already the truth. A `gap` is a manipulation that did not apply; the run
        # happened and its evidence can still CONFIRM, but SetupError bars the
        # orchestrator from REFUTING, so a coverage gap can never become SAFE.
        if error is None or error.kind != "SetupError":
            for observe_setup in setup.observers:
                try:
                    observation = await observe_setup(container, applied)
                except Exception as exc:
                    if error is None:
                        error = RunError(kind="SetupError", detail=f"setup read-back failed: {exc}")
                    continue
                applied = observation.applied
                events.extend(observation.events)
                if observation.gap and error is None:
                    error = RunError(kind="SetupError", detail=observation.gap)
    finally:
        with contextlib.suppress(Exception):
            await docker_exec(["rm", "-f", container], 10_000)

    events.sort(key=lambda event: event.timestamp)
    return seal_run_artifact(
        {
            "runId": run_id,
            "triggerUsed": compiled.trigger,
            "setupApplied": applied,
            "observe": observed,
            "budget": limits,
            "wallMs": round((time.monotonic() - started) * 1000),
            "exitCode": exit_code,
            "timedOut": timed_out,
            "events": events,
            "stdoutHash": stdout_hash,
            "stderrHash": stderr_hash,
            "fsDiffHash": fs_diff_hash,
            "pcapHash": pcap_hash,
            "straceLogHash": strace_hash,
            "inspectorLogHash": None,
            "eventSummary": compute_event_summary(events),
            "error": error,
            "createdAt": created_at,
        }
    )

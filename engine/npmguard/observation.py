from __future__ import annotations

import asyncio
import contextlib
import json
import posixpath
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from .config import Settings
from .contract.models import Budget, ObserveFlags, RunArtifact, RunError, ToolCall, Trigger
from .docker import (
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

DEFAULT_OBSERVE = {
    "kernel": False,
    "network": False,
    "fsDiff": False,
    "node": True,
    "inspector": False,
}
DEFAULT_BUDGET = {"wallMs": 60_000, "maxSyscalls": None, "maxBytesCapture": 1_000_000}


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


def build_trigger_command(trigger: Trigger, l4: bool) -> list[str] | None:
    flags = ["--require", "/tmp/_instrument.js"] if l4 else []
    if trigger.kind == "entrypoint":
        # Resolve like a shell against the sandbox workdir: an absolute path (e.g. a
        # planted /pkg/driver.js) stays absolute; a relative path resolves against
        # /pkg. require() the absolute result so there is no node_modules ambiguity.
        spec = posixpath.normpath(posixpath.join(SANDBOX_WORKDIR, trigger.target))
    elif trigger.kind == "subpath":
        # A subpath export is a module specifier, not a filesystem path.
        spec = trigger.target
    else:
        return None
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
            TmpfsMount("/tmp", "rw,noexec,nosuid,size=64m"),
            TmpfsMount("/pkg", "rw,size=256m,uid=1000,gid=1000,mode=0755"),
            TmpfsMount("/home/node", "rw,size=64m,uid=1000,gid=1000,mode=0755"),
        ],
        workdir="/pkg",
        network_mode="bridge" if observed.network else "none",
        cap_add=([] if not observed.kernel else ["SYS_PTRACE"])
        + ([] if not observed.network else ["NET_RAW", "SETUID", "SETGID"]),
    )
    setup = compose(compiled.setup)
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
            await asyncio.sleep(0.3)
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
                    "/tmp/_instrument.js",
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
            if command is None:
                error = RunError(
                    kind="SetupError",
                    detail=f"trigger.kind='{compiled.trigger.kind}' has no run command",
                )
            else:
                wrapped = wrap_with_strace(command) if observed.kernel else command
                stdin_bytes = (
                    compiled.trigger.stdin.encode()
                    if compiled.trigger.stdin is not None
                    else None
                )
                exec_args = ["exec", *(["-i"] if stdin_bytes is not None else []), container, *wrapped]
                result = await docker_exec(exec_args, int(limits.wallMs), stdin=stdin_bytes)
                exit_code, timed_out = result.exit_code, result.timed_out
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
                    trace = await docker_exec(["exec", container, "cat", "/tmp/strace.log"], 10_000)
                    if trace.exit_code == 0 and trace.stdout:
                        events.extend(parse_strace_log(trace.stdout, run_start_sec))
                        strace_hash = sha256_hex(trace.stdout)
                    elif error is None:
                        error = RunError(
                            kind="SensorError",
                            detail=f"strace log unreadable: {trace.stderr[:300]}",
                        )

        if observed.fsDiff and (error is None or error.kind not in {"SetupError", "SensorError"}):
            try:
                diff_events, raw_diff = await snapshot_post(container, run_start_sec)
                events.extend(diff_events)
                fs_diff_hash = sha256_hex(raw_diff) if raw_diff else None
            except Exception as exc:
                if error is None:
                    error = RunError(
                        kind="SensorError", detail=f"fs-diff post-snapshot failed: {exc}"
                    )

        if observed.network and (error is None or error.kind != "SetupError"):
            try:
                pcap = await stop_pcap(container)
                events.extend(pcap.events)
                pcap_hash = sha256_hex(pcap.raw_pcap) if pcap.raw_pcap else None
            except Exception as exc:
                if error is None:
                    error = RunError(kind="SensorError", detail=f"pcap stop/parse failed: {exc}")
    finally:
        with contextlib.suppress(Exception):
            await docker_exec(["rm", "-f", container], 10_000)

    events.sort(key=lambda event: event.timestamp)
    return seal_run_artifact(
        {
            "runId": run_id,
            "triggerUsed": compiled.trigger,
            "setupApplied": setup.applied,
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

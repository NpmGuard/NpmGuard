from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import shlex
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

from .contract.models import (
    EvidenceEvent,
    FilePatchRef,
    PlantedFileRef,
    SetupApplied,
    StubUrlRef,
    ToolCall,
    Trigger,
)
from .docker import (
    ContainerSpec,
    TmpfsMount,
    VolumeMount,
    docker_exec,
    read_file_in_container,
    write_file_in_container,
)
from .evidence import sha256_hex, synthetic_event

PostStart = Callable[[str], Awaitable[None]]
ASSETS = Path(__file__).with_name("assets")


class ExperimentCompileError(ValueError):
    pass


@dataclass(frozen=True)
class SetupObservation:
    """What a manipulation turned out to have done, read back after the run.

    `applied` replaces the pre-run record wholesale: a setup record is a claim about
    the RUN, so anything a manipulation can only assert after the fact belongs here
    and nowhere else. `gap` names a manipulation that did NOT apply — the run still
    happened and its evidence can still CONFIRM, but the run must never REFUTE on a
    manipulation that was never in force, so the caller turns a gap into a
    `SetupError` (→ DEFER).
    """

    applied: SetupApplied
    events: list[EvidenceEvent] = field(default_factory=list)
    gap: str | None = None


# Runs after the trigger, while the container is still alive: (container, applied)
# → what actually happened. Raising is equivalent to "the read-back itself failed",
# which the caller also reports as a SetupError.
SetupObserver = Callable[[str, SetupApplied], Awaitable[SetupObservation]]


@dataclass
class Manipulation:
    envs: dict[str, str] = field(default_factory=dict)
    ld_preload: str | None = None
    preload: str | None = None
    hostname: str | None = None
    extra_hosts: list[str] = field(default_factory=list)
    tmpfs: list[TmpfsMount] = field(default_factory=list)
    volumes: list[VolumeMount] = field(default_factory=list)
    cap_add: list[str] = field(default_factory=list)
    post_start: PostStart | None = None
    observe: SetupObserver | None = None
    applied: dict[str, Any] = field(default_factory=dict)
    events: list[Any] = field(default_factory=list)


@dataclass(frozen=True)
class CompiledExperiment:
    setup: list[Manipulation]
    trigger: Trigger


@dataclass
class ComposedSetup:
    envs: dict[str, str]
    ld_preload: str | None
    preload: str | None
    hostname: str | None
    extra_hosts: list[str]
    tmpfs: list[TmpfsMount]
    volumes: list[VolumeMount]
    cap_add: list[str]
    post_starts: list[PostStart]
    observers: list[SetupObserver]
    applied: SetupApplied
    events: list[Any]


def _record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ExperimentCompileError(f"invalid args for tool '{label}': expected object")
    return value


def _strings(value: Any, label: str) -> dict[str, str]:
    data = _record(value, label)
    if any(not isinstance(key, str) or not isinstance(item, str) for key, item in data.items()):
        raise ExperimentCompileError(f"invalid args for tool '{label}': expected string values")
    return data


def _set_env(args: dict[str, Any]) -> Manipulation:
    values = _strings(args.get("env"), "setEnv")
    return Manipulation(envs=dict(values), applied={"env": dict(values)})


def _plant_files(args: dict[str, Any]) -> Manipulation:
    files = args.get("files")
    if not isinstance(files, list) or not files:
        raise ExperimentCompileError("invalid args for tool 'plantFiles': files must be non-empty")
    specs = []
    refs = []
    for item in files:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("path"), str)
            or not isinstance(item.get("content"), str)
        ):
            raise ExperimentCompileError(
                "invalid args for tool 'plantFiles': path/content must be strings"
            )
        if not PurePosixPath(item["path"]).is_absolute():
            raise ExperimentCompileError(
                "invalid args for tool 'plantFiles': path must be absolute"
            )
        specs.append((item["path"], item["content"]))
        refs.append(PlantedFileRef(path=item["path"], contentHash=sha256_hex(item["content"])))

    async def apply(container: str) -> None:
        for path, content in specs:
            await write_file_in_container(container, path, content)

    return Manipulation(post_start=apply, applied={"plantFiles": refs})


def _set_date(args: dict[str, Any]) -> Manipulation:
    iso = args.get("iso")
    if not isinstance(iso, str):
        raise ExperimentCompileError("invalid args for tool 'setDate': iso must be a string")
    try:
        date = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError as error:
        raise ExperimentCompileError(f"invalid args for tool 'setDate': {error}") from error
    if date.tzinfo is None:
        raise ExperimentCompileError("invalid args for tool 'setDate': timezone offset required")
    faketime = date.astimezone(__import__("datetime").UTC).strftime("@%Y-%m-%d %H:%M:%S")
    return Manipulation(
        envs={"FAKETIME": faketime}, ld_preload="/usr/lib/libfaketime.so.1", applied={"date": iso}
    )


def _preload(args: dict[str, Any]) -> Manipulation:
    code = args.get("code")
    if not isinstance(code, str):
        raise ExperimentCompileError("invalid args for tool 'preload': code must be a string")

    async def apply(container: str) -> None:
        await write_file_in_container(container, "/tmp/npmguard-preload.js", code)

    return Manipulation(
        preload="/tmp/npmguard-preload.js",
        post_start=apply,
        applied={"preloadHash": sha256_hex(code)},
    )


def _patch_file(args: dict[str, Any]) -> Manipulation:
    patches = args.get("patches")
    if not isinstance(patches, list) or not patches:
        raise ExperimentCompileError("invalid args for tool 'patchFile': patches must be non-empty")
    normalized = []
    refs = []
    for patch in patches:
        if not isinstance(patch, dict) or not isinstance(patch.get("path"), str):
            raise ExperimentCompileError("invalid args for tool 'patchFile': path must be a string")
        path = PurePosixPath(patch["path"])
        if path.is_absolute() or ".." in path.parts:
            raise ExperimentCompileError(
                "invalid args for tool 'patchFile': path must stay under package root"
            )
        replacements = patch.get("replacements")
        if not isinstance(replacements, list) or not replacements:
            raise ExperimentCompileError(
                "invalid args for tool 'patchFile': replacements must be non-empty"
            )
        clean = []
        for replacement in replacements:
            if (
                not isinstance(replacement, dict)
                or not isinstance(replacement.get("pattern"), str)
                or not isinstance(replacement.get("replacement"), str)
            ):
                raise ExperimentCompileError(
                    "invalid args for tool 'patchFile': pattern/replacement must be strings"
                )
            clean.append((replacement["pattern"], replacement["replacement"]))
        normalized.append((str(path), clean))
        refs.append(
            FilePatchRef(
                path=str(path),
                patchHash=sha256_hex(
                    json.dumps(
                        [{"pattern": f"str:{a}", "replacement": b} for a, b in clean],
                        separators=(",", ":"),
                    )
                ),
            )
        )

    async def apply(container: str) -> None:
        for path, replacements in normalized:
            original = await read_file_in_container(container, f"/pkg/{path}")
            changed = original
            for pattern, replacement in replacements:
                changed = changed.replace(pattern, replacement)
            if changed != original:
                await write_file_in_container(container, f"/pkg/{path}", changed)

    return Manipulation(post_start=apply, applied={"patches": refs})


STUB_PORT = 18080
_STUB_PROXY = "/tmp/npmguard-stub-proxy.js"
# The proxy's STATE lives on a tmpfs owned by root and mode 0755: world-readable, so
# the engine can poll and read it as the container user, but writable only by root.
# The package under audit runs as uid 1000 and the ledger is read AFTER it has run —
# on a uid-1000 tmpfs it could append forged rows, kill the proxy and bind the port
# itself, or plant the .err marker. So the proxy is launched `--user 0`: uid 1000 can
# neither signal nor ptrace a root process, nor write this directory (all verified in
# a real container). The redirect it sits behind is already out of reach — no
# NET_ADMIN. The script itself stays on /tmp because it is written by the engine as
# the container user; by the time the package runs, the proxy has already loaded it.
STUB_STATE_DIR = "/npmguard-stub"
STUB_STATE_TMPFS = TmpfsMount(STUB_STATE_DIR, "rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0755")
_STUB_READY = f"{STUB_STATE_DIR}/npmguard-stub-proxy.ready"
_STUB_ERR = f"{STUB_STATE_DIR}/npmguard-stub-proxy.err"
_STUB_LOG = f"{STUB_STATE_DIR}/npmguard-stub-proxy.log"
_STUB_SERVED = f"{STUB_STATE_DIR}/npmguard-stub-proxy.served"
# The stub is installed by translating the destination inside the container's own
# network namespace, below every client library. Everything else about a stub —
# whether it fired, what it answered — is read back from the proxy afterwards.
_IPTABLES = "iptables"


@dataclass(frozen=True)
class StubTarget:
    """The connection a stub pattern must have redirected into the proxy.

    `host` is the address the package will actually dial: a pattern's IP literal as
    written, or `127.0.0.1` for a pattern naming a host (which is pinned there by an
    `--add-host` entry so an exfil endpoint that does not resolve still connects).
    `host is None` means the pattern wildcards the authority, so every destination on
    `port` is redirected — which is what such a pattern asks for, and the collateral
    is bounded and visible: a request to an authority no stub matches is answered 502
    by the proxy and appears in the timeline as exactly that. A pattern with a
    LITERAL authority redirects only that authority, so a run can still observe, say,
    a real second-stage download over http from a host the experiment never stubbed.
    """

    host: str | None
    port: int
    add_host: str | None  # "<name>:127.0.0.1" when the pattern named a host


def stub_intercept_target(pattern: str) -> StubTarget | None:
    """The redirect a stub pattern needs, or None when the pattern is out of the
    mechanism's reach.

    Only `http://` is reachable: intercepting TLS would need a MitM CA the sandbox
    deliberately does not ship, and any other scheme is not HTTP at all. Returning
    None is not an error — the experiment still runs, and the caller reports the
    unreachable stub as a coverage gap so the run can never REFUTE on it.
    """
    scheme = "http://"
    if not pattern.startswith(scheme):
        return None
    authority = re.split(r"[/?#]", pattern[len(scheme) :], maxsplit=1)[0]
    if not authority:
        return None
    if authority.startswith("["):  # [::1]:9999 — the port colon follows the bracket
        close = authority.find("]")
        rest = authority[close + 1 :] if close > 0 else ""
        if close < 0 or (rest and not rest.startswith(":")):
            return None
        host, port_text = authority[1:close], rest[1:]
    else:
        host, separator, port_text = authority.rpartition(":")
        if not separator:
            host, port_text = port_text, ""
    if not host:
        return None
    if port_text and not port_text.isdigit():
        return None  # a wildcarded or malformed port names no connection to redirect
    port = int(port_text) if port_text else 80
    if not 0 < port < 65536:
        return None
    if "*" in host:
        return StubTarget(host=None, port=port, add_host=None)
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # A name: pin it to loopback so the connect happens at all (a nonexistent
        # exfil host otherwise fails at DNS and the stub never sees a request), and
        # redirect loopback traffic on its port into the proxy.
        return StubTarget(host="127.0.0.1", port=port, add_host=f"{host}:127.0.0.1")
    if address.version != 4:
        return None  # only IPv4 redirects are installed; ip6tables is not in scope
    return StubTarget(host=host, port=port, add_host=None)


def _redirect_rule(target: StubTarget) -> list[str]:
    """The iptables arguments for one redirect, used verbatim to add (-A), to verify
    (-C) after install, and to verify again after the run — so "installed" and
    "still installed" are decided by the same expression, never by parsing output."""
    match = ["-p", "tcp", *(["-d", target.host] if target.host else [])]
    return [
        "-t",
        "nat",
        "OUTPUT",
        *match,
        "--dport",
        str(target.port),
        "-j",
        "REDIRECT",
        "--to-ports",
        str(STUB_PORT),
    ]


def _iptables_script(action: str, targets: list[StubTarget]) -> str:
    return "set -e; " + "; ".join(
        shlex.join([_IPTABLES, rule[0], rule[1], action, *rule[2:]])
        for rule in (_redirect_rule(target) for target in targets)
    )


async def _iptables(container: str, action: str, targets: list[StubTarget]):
    # --privileged grants NET_ADMIN to THIS exec only. The container itself keeps
    # cap_drop=ALL, so the package under audit can neither read the nat table nor
    # remove a rule: the redirect is not a global it can restore.
    return await docker_exec(
        [
            "exec",
            "--privileged",
            "--user",
            "0",
            container,
            "sh",
            "-c",
            _iptables_script(action, targets),
        ],
        15_000,
    )


def _stub_url(args: dict[str, Any]) -> Manipulation:
    stubs = args.get("stubs")
    if not isinstance(stubs, list) or not stubs:
        raise ExperimentCompileError("invalid args for tool 'stubUrl': stubs must be non-empty")
    clean: list[dict[str, Any]] = []
    refs = []
    for stub in stubs:
        if not isinstance(stub, dict) or not isinstance(stub.get("pattern"), str):
            raise ExperimentCompileError(
                "invalid args for tool 'stubUrl': pattern must be a string"
            )
        headers = stub.get("responseHeaders", {"Content-Type": "text/plain"})
        if not isinstance(headers, dict) or any(
            not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()
        ):
            raise ExperimentCompileError(
                "invalid args for tool 'stubUrl': responseHeaders must contain strings"
            )
        clean.append(
            {
                "pattern": stub["pattern"],
                "responseStatus": int(stub.get("responseStatus", 200)),
                "responseBody": str(stub.get("responseBody", "ok")),
                "responseHeaders": headers,
            }
        )
        # INVARIANT: the compiled record asserts NOTHING about responses. At compile
        # time nothing has been served, so `responseHash` can only be null; `observe`
        # below fills it in from the proxy's ledger. Hashing the PLAN here would make
        # a sealed artifact attest a canned response for a stub that never
        # intercepted anything.
        refs.append(StubUrlRef(pattern=stub["pattern"], responseHash=None))

    targets = [stub_intercept_target(item["pattern"]) for item in clean]
    reachable = [target for target in targets if target is not None]
    unreachable = [item["pattern"] for item, target in zip(clean, targets, strict=True) if not target]
    envs = {
        "NPMGUARD_STUBS": json.dumps(clean, separators=(",", ":")),
        "NPMGUARD_STUB_PORT": str(STUB_PORT),
    }
    # No HTTP_PROXY/HTTPS_PROXY here, deliberately. Node core's http/https ignore
    # them, and so does Node 22's global fetch/undici (verified in the sandbox image:
    # every client dialled the real endpoint and the proxy logged nothing) — so as an
    # interception mechanism they are inert, which lets a stub no-op while the
    # artifact claims a response was served. They are also actively harmful
    # alongside the redirect: a client that DOES honour them (axios) would route ALL
    # its traffic to the proxy and get 502s for endpoints no stub declared, silently
    # breaking behaviour the run is supposed to observe. One mechanism, one semantics.

    async def apply(container: str) -> None:
        await write_file_in_container(
            container, _STUB_PROXY, (ASSETS / "stub-proxy.js").read_bytes()
        )
        # Launch detached and as root, capturing the proxy's own stderr to its state
        # tmpfs (docker logs only shows PID 1, so an exec -d crash is otherwise
        # invisible). NPMGUARD_STUB_DIR rides on the exec rather than the container
        # env: the package has no business knowing where the ledger it cannot write is.
        result = await docker_exec(
            [
                "exec",
                "-d",
                "--user",
                "0",
                "-e",
                f"NPMGUARD_STUB_DIR={STUB_STATE_DIR}",
                container,
                "sh",
                "-c",
                f"node {_STUB_PROXY} 2>{_STUB_LOG}",
            ],
            10_000,
        )
        if result.exit_code:
            raise RuntimeError(f"stubUrl proxy failed to launch: {result.stderr[:300]}")
        # Deterministic bounded wait on the proxy's OWN signals: a positive .ready
        # marker (listen callback) succeeds; a .err marker (bad env / bind failure /
        # any uncaught throw) fails FAST with the captured reason; otherwise time out
        # at 120s. Polling with TCP probes instead can distinguish neither a crash from
        # a slow bind nor a cold start from a hang.
        probe = (
            f"if [ -f {_STUB_READY} ]; then echo READY; "
            f"elif [ -f {_STUB_ERR} ]; then echo ERR; "
            f"cat {_STUB_ERR}; cat {_STUB_LOG} 2>/dev/null; fi"
        )
        deadline = asyncio.get_running_loop().time() + 120.0
        ready = False
        while asyncio.get_running_loop().time() < deadline:
            check = await docker_exec(["exec", container, "sh", "-c", probe], 5_000)
            out = (check.stdout or "").strip()
            if out.startswith("READY"):
                ready = True
                break
            if out.startswith("ERR"):
                raise RuntimeError(f"stubUrl proxy crashed on startup: {out[3:].strip()[:400]}")
            await asyncio.sleep(0.1)
        if not ready:
            tail = await docker_exec(
                ["exec", container, "sh", "-c", f"cat {_STUB_LOG} 2>/dev/null"], 5_000
            )
            detail = (tail.stdout or "").strip()
            raise RuntimeError(
                "stubUrl proxy did not become ready within 120s"
                + (f": {detail[:300]}" if detail else " (no stderr captured)")
            )
        if not reachable:
            return
        # INVARIANT: the redirect is installed only AFTER the proxy is confirmed
        # listening. Reversed, there is a window in which the stubbed port resolves
        # to nothing and a request that should have been stubbed dies with
        # ECONNREFUSED — a manipulation that half-applied.
        added = await _iptables(container, "-A", reachable)
        if added.exit_code:
            raise RuntimeError(
                "stubUrl could not install the transparent redirect "
                f"({_IPTABLES} exit={added.exit_code}): {(added.stderr or added.stdout)[:300]} "
                "— the sandbox image must provide iptables (rebuild npmguard-sandbox:v1)"
            )
        # INVARIANT: post_start returns ⟺ every reachable stub authority is redirected
        # into a proxy confirmed listening. `-C` re-asks the kernel with the same rule
        # expression that was added, so a rule the kernel silently normalised away
        # cannot pass for installed. On any failure raise (→ SetupError → DEFER); a
        # trigger must never fire believing it is stubbed when it is not.
        verified = await _iptables(container, "-C", reachable)
        if verified.exit_code:
            raise RuntimeError(
                "stubUrl redirect did not verify after install "
                f"({_IPTABLES} -C exit={verified.exit_code}): {(verified.stderr or verified.stdout)[:300]}"
            )

    async def observe(container: str, applied: SetupApplied) -> SetupObservation:
        recorded = list(applied.stubUrls or [])
        # INVARIANT: exactly one stub manipulation exists per experiment
        # (compile_experiment merges them), so the composed record is this
        # manipulation's list, positionally. That is what lets a ledger row's stub
        # INDEX address a ref without re-implementing pattern matching in Python.
        assert len(recorded) == len(clean), (
            f"stubUrl observe: composed setup carries {len(recorded)} stub refs for "
            f"{len(clean)} compiled stubs — more than one stub manipulation reached compose"
        )
        gaps = [f"stubUrl pattern {pattern!r} cannot be intercepted" for pattern in unreachable]
        events: list[EvidenceEvent] = []

        # Continuity, mirroring stop_pcap: the redirect and the proxy must BOTH still
        # be in force now. The package cannot remove a rule (no NET_ADMIN) and cannot
        # kill the proxy (different session, and it would show here) — so this check
        # is what turns "installed before the trigger" into "in force for the whole
        # run", and its failure means requests may have reached the real endpoint.
        if reachable:
            still = await _iptables(container, "-C", reachable)
            if still.exit_code:
                gaps.append(
                    "the stub redirect was not in force at the end of the run "
                    f"({_IPTABLES} -C exit={still.exit_code})"
                )
        # `-u 0` is the point: only a ROOT process counts as the proxy, so a uid-1000
        # decoy with a matching cmdline cannot vouch for a proxy the package killed
        # (and it cannot kill this one anyway). A .err marker means the proxy died with
        # a reason — an independent signal, and one the package cannot plant either.
        health = await docker_exec(
            [
                "exec",
                container,
                "sh",
                "-c",
                f"if [ -f {_STUB_ERR} ]; then echo ERR; cat {_STUB_ERR}; "
                f"elif pgrep -u 0 -f {shlex.quote(_STUB_PROXY)} >/dev/null; then echo ALIVE; "
                "else echo DEAD; fi",
            ],
            10_000,
        )
        report = (health.stdout or "").strip()
        if health.exit_code or not report.startswith("ALIVE"):
            gaps.append(
                "the stub proxy was not healthy at the end of the run: "
                + (report[:300] or f"probe exit={health.exit_code}")
            )

        ledger = await docker_exec(
            ["exec", container, "sh", "-c", f"[ -f {_STUB_SERVED} ] && cat {_STUB_SERVED} || true"],
            15_000,
        )
        if ledger.exit_code:
            raise RuntimeError(f"stubUrl ledger unreadable: {ledger.stderr[:300]}")
        served: dict[int, list[str]] = {}
        for line in (ledger.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"stubUrl ledger row is not JSON: {error}") from error
            index, digest = row.get("stub"), row.get("responseHash")
            if index is None:
                continue  # a request no stub matched — the proxy answered 502
            if not isinstance(index, int) or not 0 <= index < len(recorded):
                raise RuntimeError(f"stubUrl ledger names stub #{index}, which does not exist")
            served.setdefault(index, []).append(str(digest))

        updated = []
        for index, ref in enumerate(recorded):
            digests = served.get(index, [])
            # INVARIANT: a stub's canned response is fixed, so every response it
            # served hashes identically. Differing digests would mean the ledger and
            # the stub list disagree about which stub answered — refuse to pick one.
            assert len(set(digests)) <= 1, (
                f"stubUrl observe: stub #{index} ({ref.pattern!r}) served "
                f"{len(set(digests))} distinct responses — ledger/stub-list mismatch"
            )
            # INVARIANT: responseHash comes from the ledger or is null. There is no
            # third source, so past this line the state "attests a response nobody
            # served" is unrepresentable — the plan is not an input here.
            updated.append(
                ref.model_copy(update={"responseHash": digests[0] if digests else None})
            )
        for gap in gaps:
            events.append(synthetic_event("setup_bypass", gap))
        return SetupObservation(
            applied=applied.model_copy(update={"stubUrls": updated}),
            events=events,
            gap="; ".join(gaps) or None,
        )

    return Manipulation(
        envs=envs,
        extra_hosts=[target.add_host for target in reachable if target.add_host],
        tmpfs=[STUB_STATE_TMPFS],
        post_start=apply,
        observe=observe,
        applied={"stubUrls": refs},
    )


BUILDERS = {
    "setEnv": _set_env,
    "plantFiles": _plant_files,
    "setDate": _set_date,
    "stubUrl": _stub_url,
    "patchFile": _patch_file,
    "preload": _preload,
}


def compile_experiment(experiment: list[ToolCall]) -> CompiledExperiment:
    setup: list[Manipulation] = []
    trigger = None
    # Every stubUrl call folds into ONE manipulation, at the position of the first.
    # A stub manipulation carries the whole stub list in a single env var, so two of
    # them would have the second silently overwrite the first (compose's envs.update)
    # while `applied.stubUrls` still listed both — an artifact naming stubs that were
    # never loaded into the proxy. Folding removes the state instead of detecting it;
    # the tool already takes an array, so a second call adds nothing a merge loses.
    stub_slot: int | None = None
    stubs: list[Any] = []
    for call in experiment:
        args = _record(call.args or {}, call.tool)
        if call.tool == "stubUrl":
            _stub_url(args)  # validate this call's own args, in call order
            if stub_slot is None:
                stub_slot = len(setup)
                setup.append(Manipulation())  # placeholder, filled in below
            stubs.extend(args["stubs"])
            continue
        if call.tool == "trigger":
            if trigger is not None:
                raise ExperimentCompileError(
                    "experiment has more than one trigger — a run has exactly one entrypoint"
                )
            kind, target = args.get("kind"), args.get("target")
            if kind not in {"entrypoint", "subpath"} or not isinstance(
                target, str
            ):
                raise ExperimentCompileError("invalid args for tool 'trigger'")
            argv = args.get("argv", [])
            if not isinstance(argv, list) or any(not isinstance(item, str) for item in argv):
                raise ExperimentCompileError(
                    "invalid args for tool 'trigger': argv must contain strings"
                )
            stdin = args.get("stdin")
            if stdin is not None and not isinstance(stdin, str):
                raise ExperimentCompileError(
                    "invalid args for tool 'trigger': stdin must be a string or null"
                )
            trigger = Trigger(kind=kind, target=target, argv=argv, stdin=stdin)
        elif call.tool in BUILDERS:
            setup.append(BUILDERS[call.tool](args))
        else:
            raise ExperimentCompileError(
                f"unknown tool '{call.tool}' (known: {', '.join([*BUILDERS, 'trigger'])})"
            )
    if trigger is None:
        raise ExperimentCompileError("experiment has no trigger — nothing to run")
    if stub_slot is not None:
        setup[stub_slot] = _stub_url({"stubs": stubs})
    return CompiledExperiment(setup, trigger)


def compose(primitives: list[Manipulation]) -> ComposedSetup:
    envs: dict[str, str] = {}
    ld_preload = preload = hostname = None
    hosts: list[str] = []
    mounts: list[TmpfsMount] = []
    volumes: list[VolumeMount] = []
    caps: list[str] = []
    hooks: list[PostStart] = []
    observers: list[SetupObserver] = []
    events = []
    applied: dict[str, Any] = {
        "env": {},
        "date": None,
        "plantFiles": [],
        "stubUrls": [],
        "hostname": None,
        "locale": None,
        "patches": [],
        "preloadHash": None,
    }
    for primitive in primitives:
        envs.update(primitive.envs)
        if primitive.ld_preload:
            ld_preload = primitive.ld_preload
        if primitive.preload:
            preload = primitive.preload
        if primitive.hostname:
            hostname = primitive.hostname
        hosts.extend(primitive.extra_hosts)
        mounts.extend(primitive.tmpfs)
        volumes.extend(primitive.volumes)
        caps.extend(primitive.cap_add)
        if primitive.post_start:
            hooks.append(primitive.post_start)
        if primitive.observe:
            observers.append(primitive.observe)
        events.extend(primitive.events)
        for key, value in primitive.applied.items():
            if key in {"plantFiles", "stubUrls", "patches"}:
                applied[key].extend(value)
            elif key == "env":
                applied[key].update(value)
            else:
                applied[key] = value
    return ComposedSetup(
        envs,
        ld_preload,
        preload,
        hostname,
        list(dict.fromkeys(hosts)),
        list(dict.fromkeys(mounts)),
        volumes,
        list(dict.fromkeys(caps)),
        hooks,
        observers,
        SetupApplied(**applied),
        events,
    )


def merge_container_spec(base: ContainerSpec, setup: ComposedSetup) -> ContainerSpec:
    base.envs.update(setup.envs)
    base.ld_preload = setup.ld_preload or base.ld_preload
    base.preload = setup.preload or base.preload
    base.hostname = setup.hostname or base.hostname
    base.extra_hosts = list(dict.fromkeys([*base.extra_hosts, *setup.extra_hosts]))
    # Deduped by MOUNT PATH: docker refuses two mounts on the same target, and a
    # manipulation may legitimately ask for one the base spec already provides.
    by_path = {mount.path: mount for mount in [*base.tmpfs, *setup.tmpfs]}
    base.tmpfs = list(by_path.values())
    base.volumes.extend(setup.volumes)
    base.cap_add = list(dict.fromkeys([*base.cap_add, *setup.cap_add]))
    return base


TOOL_CATALOG = """- setEnv (setup): Inject environment variables to plant credentials or defeat environment gates.
- plantFiles (setup): Seed absolute-path files such as /home/node/.npmrc with bait content.
- setDate (setup): Freeze wall-clock time at an ISO timestamp using libfaketime.
- stubUrl (setup): Return canned HTTP responses for URL patterns using * as wildcard.
- patchFile (setup): Rewrite package files with exact string replacements before execution.
- preload (setup): Inject a Node preload script before the package entrypoint loads.
- trigger (trigger): Invoke exactly one entrypoint, lifecycle hook, bin, or subpath."""

# Injected into every hypothesis prompt. The most common way a generated experiment
# fails to run is a require() written like a filesystem path but resolved by Node as a
# package: `require('src/x.js')` searches node_modules, not the package. Runtime deps
# are installed before hypothesize, so this is the remaining self-inflicted load failure.
EXPERIMENT_CODE_GUIDANCE = (
    "When you author JavaScript (a preload script, a custom driver, or a patchFile "
    "replacement), reference package files by a relative path with a leading './' "
    "(require('./src/x.js')) or by an absolute path under /pkg (require('/pkg/src/x.js')). "
    "A bare specifier like require('src/x.js') is resolved as a node_modules PACKAGE and "
    "fails with \"Cannot find module\". Planted file paths must be absolute (/pkg/... or "
    "/home/node/...). The sandbox working directory is /pkg."
)

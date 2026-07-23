from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

from .contract.models import (
    FilePatchRef,
    PlantedFileRef,
    SetupApplied,
    StubUrlRef,
    ToolCall,
    Trigger,
)
from .docker import (
    ContainerSpec,
    VolumeMount,
    docker_exec,
    read_file_in_container,
    write_file_in_container,
)
from .evidence import sha256_hex

PostStart = Callable[[str], Awaitable[None]]
ASSETS = Path(__file__).with_name("assets")


class ExperimentCompileError(ValueError):
    pass


@dataclass
class Manipulation:
    envs: dict[str, str] = field(default_factory=dict)
    ld_preload: str | None = None
    preload: str | None = None
    hostname: str | None = None
    volumes: list[VolumeMount] = field(default_factory=list)
    cap_add: list[str] = field(default_factory=list)
    post_start: PostStart | None = None
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
    volumes: list[VolumeMount]
    cap_add: list[str]
    post_starts: list[PostStart]
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


def _stub_url(args: dict[str, Any]) -> Manipulation:
    stubs = args.get("stubs")
    if not isinstance(stubs, list) or not stubs:
        raise ExperimentCompileError("invalid args for tool 'stubUrl': stubs must be non-empty")
    clean = []
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
        item = {
            "pattern": stub["pattern"],
            "responseStatus": int(stub.get("responseStatus", 200)),
            "responseBody": str(stub.get("responseBody", "ok")),
            "responseHeaders": headers,
        }
        clean.append(item)
        refs.append(
            StubUrlRef(
                pattern=item["pattern"],
                responseHash=sha256_hex(
                    json.dumps(
                        {
                            "status": item["responseStatus"],
                            "body": item["responseBody"],
                            "headers": stub.get("responseHeaders", {}),
                        },
                        separators=(",", ":"),
                    )
                ),
            )
        )
    envs = {
        "HTTP_PROXY": "http://127.0.0.1:18080",
        "HTTPS_PROXY": "http://127.0.0.1:18080",
        "http_proxy": "http://127.0.0.1:18080",
        "https_proxy": "http://127.0.0.1:18080",
        "NO_PROXY": "",
        "NPMGUARD_STUBS": json.dumps(clean, separators=(",", ":")),
        "NPMGUARD_STUB_PORT": "18080",
    }

    async def apply(container: str) -> None:
        await write_file_in_container(
            container, "/tmp/npmguard-stub-proxy.js", (ASSETS / "stub-proxy.js").read_bytes()
        )
        result = await docker_exec(
            ["exec", "-d", container, "node", "/tmp/npmguard-stub-proxy.js"], 10_000
        )
        if result.exit_code:
            raise RuntimeError(f"stubUrl proxy failed: {result.stderr[:300]}")
        readiness = "require('net').connect(18080,'127.0.0.1',()=>process.exit(0)).on('error',()=>process.exit(1))"
        for _ in range(30):
            result = await docker_exec(["exec", container, "node", "-e", readiness], 2_000)
            if result.exit_code == 0:
                return
            await asyncio.sleep(0.05)
        raise RuntimeError("stubUrl proxy did not become ready")

    return Manipulation(envs=envs, post_start=apply, applied={"stubUrls": refs})


BUILDERS = {
    "setEnv": _set_env,
    "plantFiles": _plant_files,
    "setDate": _set_date,
    "stubUrl": _stub_url,
    "patchFile": _patch_file,
    "preload": _preload,
}


def compile_experiment(experiment: list[ToolCall]) -> CompiledExperiment:
    setup = []
    trigger = None
    for call in experiment:
        args = _record(call.args or {}, call.tool)
        if call.tool == "trigger":
            if trigger is not None:
                raise ExperimentCompileError(
                    "experiment has more than one trigger — a run has exactly one entrypoint"
                )
            kind, target = args.get("kind"), args.get("target")
            if kind not in {"entrypoint", "lifecycle", "bin", "subpath"} or not isinstance(
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
    return CompiledExperiment(setup, trigger)


def compose(primitives: list[Manipulation]) -> ComposedSetup:
    envs: dict[str, str] = {}
    ld_preload = preload = hostname = None
    volumes: list[VolumeMount] = []
    caps: list[str] = []
    hooks: list[PostStart] = []
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
        volumes.extend(primitive.volumes)
        caps.extend(primitive.cap_add)
        if primitive.post_start:
            hooks.append(primitive.post_start)
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
        volumes,
        list(dict.fromkeys(caps)),
        hooks,
        SetupApplied(**applied),
        events,
    )


def merge_container_spec(base: ContainerSpec, setup: ComposedSetup) -> ContainerSpec:
    base.envs.update(setup.envs)
    base.ld_preload = setup.ld_preload or base.ld_preload
    base.preload = setup.preload or base.preload
    base.hostname = setup.hostname or base.hostname
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

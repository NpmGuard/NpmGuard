# CLASS MAP — experiment compile/compose/merge (pure; no docker calls executed —
# post_start hooks are captured, never awaited here)
# Axes: trigger cardinality, tool name validity, per-tool arg shape, setup
#       composition conflicts, container-spec merge precedence
#   C1 zero / two triggers / unknown tool → ExperimentCompileError
#   C2 happy path: setup compiles and composes into a sealed description
#      (envs + planted-file refs with content hashes)
#   C3 per-tool invalid-args matrix — each builder rejects malformed args with a
#      tool-named error instead of deferring the failure into the sandbox
#   C4 compose env conflict — later setEnv wins per key, distinct keys merge
#   C5 compose single-slot conflict — last preload wins the slot, both post_start
#      hooks are kept, applied.preloadHash records the winner
#   C6 merge_container_spec — setup envs override base envs, base-only keys
#      survive, ld_preload backfills, cap_add dedupes
# Adversarial pass: 2026-07-23/W6 — added the arg-matrix, conflict, and merge
# axes (only C1/C2 existed before).
import pytest

from npmguard.contract.models import ToolCall
from npmguard.docker import ContainerSpec
from npmguard.evidence import sha256_hex
from npmguard.experiments import (
    ExperimentCompileError,
    compile_experiment,
    compose,
    merge_container_spec,
)


def call(tool: str, **args) -> ToolCall:
    return ToolCall(tool=tool, args=args)


def _trigger() -> ToolCall:
    return call("trigger", kind="entrypoint", target="index.js", argv=[])


def test_compiler_requires_exactly_one_known_trigger() -> None:
    """C1: no trigger, two triggers, and unknown tools are compile errors."""
    with pytest.raises(ExperimentCompileError, match="no trigger"):
        compile_experiment([call("setEnv", env={"TOKEN": "bait"})])
    with pytest.raises(ExperimentCompileError, match="more than one"):
        compile_experiment(
            [
                call("trigger", kind="entrypoint", target="index.js"),
                call("trigger", kind="bin", target="cli.js"),
            ]
        )
    with pytest.raises(ExperimentCompileError, match="unknown tool"):
        compile_experiment(
            [
                call("shell", command="rm -rf /"),
                call("trigger", kind="entrypoint", target="index.js"),
            ]
        )


def test_setup_compiles_and_composes_into_a_sealed_description() -> None:
    """C2: envs and planted files land in the composed, hash-sealed setup."""
    compiled = compile_experiment(
        [
            call("setEnv", env={"NPM_TOKEN": "canary"}),
            call("plantFiles", files=[{"path": "/home/node/.npmrc", "content": "bait"}]),
            call("trigger", kind="entrypoint", target="index.js", argv=[]),
        ]
    )
    setup = compose(compiled.setup)
    assert compiled.trigger.target == "index.js"
    assert setup.envs["NPM_TOKEN"] == "canary"
    assert setup.applied.plantFiles[0].path == "/home/node/.npmrc"
    assert setup.applied.plantFiles[0].contentHash


@pytest.mark.parametrize(
    ("bad_call", "message"),
    [
        pytest.param(call("setEnv", env={"A": 1}), "setEnv", id="setEnv-non-string-value"),
        pytest.param(call("setEnv", env="A=1"), "setEnv", id="setEnv-non-object"),
        pytest.param(call("plantFiles", files=[]), "plantFiles", id="plantFiles-empty"),
        pytest.param(
            call("plantFiles", files=[{"path": "rel/x.js", "content": "x"}]),
            "must be absolute",
            id="plantFiles-relative-path",
        ),
        pytest.param(
            call("plantFiles", files=[{"path": "/x.js"}]),
            "path/content",
            id="plantFiles-missing-content",
        ),
        pytest.param(call("setDate", iso=20260101), "setDate", id="setDate-non-string"),
        pytest.param(call("setDate", iso="not-a-date"), "setDate", id="setDate-garbage"),
        pytest.param(
            call("setDate", iso="2026-01-01T00:00:00"),
            "timezone offset required",
            id="setDate-naive",
        ),
        pytest.param(call("patchFile", patches=[]), "patchFile", id="patchFile-empty"),
        pytest.param(
            call("patchFile", patches=[{"path": "/etc/passwd", "replacements": [{"pattern": "a", "replacement": "b"}]}]),
            "stay under package root",
            id="patchFile-absolute",
        ),
        pytest.param(
            call("patchFile", patches=[{"path": "../escape.js", "replacements": [{"pattern": "a", "replacement": "b"}]}]),
            "stay under package root",
            id="patchFile-dotdot",
        ),
        pytest.param(
            call("patchFile", patches=[{"path": "index.js", "replacements": []}]),
            "replacements must be non-empty",
            id="patchFile-no-replacements",
        ),
        pytest.param(call("stubUrl", stubs=[]), "stubUrl", id="stubUrl-empty"),
        pytest.param(
            call("stubUrl", stubs=[{"pattern": "*", "responseHeaders": {"X": 1}}]),
            "responseHeaders",
            id="stubUrl-non-string-header",
        ),
        pytest.param(call("preload", code=42), "preload", id="preload-non-string"),
        pytest.param(
            call("trigger", kind="magic", target="index.js"),
            "trigger",
            id="trigger-unknown-kind",
        ),
        pytest.param(
            call("trigger", kind="entrypoint", target="index.js", argv=[1]),
            "argv",
            id="trigger-non-string-argv",
        ),
    ],
)
def test_per_tool_invalid_args_matrix(bad_call: ToolCall, message: str) -> None:
    """C3: each builder rejects its malformed args at compile time."""
    with pytest.raises(ExperimentCompileError, match=message):
        compile_experiment([bad_call, _trigger()] if bad_call.tool != "trigger" else [bad_call])


def test_compose_env_conflict_later_wins() -> None:
    """C4: later setEnv overrides colliding keys; distinct keys merge; the
    applied record reflects the effective (post-conflict) env."""
    compiled = compile_experiment(
        [
            call("setEnv", env={"A": "first", "B": "keep"}),
            call("setEnv", env={"A": "second"}),
            _trigger(),
        ]
    )
    setup = compose(compiled.setup)
    assert setup.envs == {"A": "second", "B": "keep"}
    assert setup.applied.env == {"A": "second", "B": "keep"}


def test_compose_preload_conflict_last_wins_slot_hooks_kept() -> None:
    """C5: preload is a single slot — the last one wins the path and the applied
    hash, while both plant hooks remain (the later write overwrites in-container)."""
    compiled = compile_experiment(
        [call("preload", code="first()"), call("preload", code="second()"), _trigger()]
    )
    setup = compose(compiled.setup)
    assert setup.preload == "/tmp/npmguard-preload.js"
    assert len(setup.post_starts) == 2
    assert setup.applied.preloadHash == sha256_hex("second()")


def test_merge_container_spec_precedence() -> None:
    """C6: setup env wins on collision, base-only keys survive, ld_preload
    backfills from setup, cap_add merges deduplicated."""
    base = ContainerSpec(
        image="npmguard-sandbox:v1",
        memory="512m",
        cpus=1.0,
        network_mode="none",
        envs={"BASE_ONLY": "yes", "FAKETIME": "base"},
        cap_add=["NET_RAW"],
    )
    compiled = compile_experiment(
        [
            call("setEnv", env={"NPM_TOKEN": "canary"}),
            call("setDate", iso="2027-01-02T03:04:05Z"),
            _trigger(),
        ]
    )
    merged = merge_container_spec(base, compose(compiled.setup))
    assert merged.envs["BASE_ONLY"] == "yes"
    assert merged.envs["NPM_TOKEN"] == "canary"
    assert merged.envs["FAKETIME"].startswith("@2027-01-02")  # setup overrode base
    assert merged.ld_preload == "/usr/lib/libfaketime.so.1"
    assert merged.cap_add == ["NET_RAW"]

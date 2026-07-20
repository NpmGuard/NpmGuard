import pytest

from npmguard.contract.models import ToolCall
from npmguard.experiments import ExperimentCompileError, compile_experiment, compose


def call(tool: str, **args) -> ToolCall:
    return ToolCall(tool=tool, args=args)


def test_compiler_requires_exactly_one_known_trigger() -> None:
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

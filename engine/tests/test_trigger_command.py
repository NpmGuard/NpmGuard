# CLASS MAP — build_trigger_command (pure: Trigger → node argv or None)
# Axes: target path shape (absolute / bare-relative / dot-relative / subpath),
#       trigger kind, argv passthrough, L4 instrumentation flag
#   C1 absolute planted driver required verbatim
#   C2 bare relative resolves against /pkg workdir
#   C3 ./ relative resolves against /pkg workdir
#   C4 argv mirrors normal node invocation (entry at [1], args after)
#   C5 dash-leading argv guarded by the -- separator
#   C6 subpath is a module specifier, never a filesystem path
#   C7 lifecycle/bin kinds have no run command (None)
#   C8 l4=True injects the --require instrumentation preamble; l4=False does not
# Adversarial pass: 2026-07-23/W6 — already the best-partitioned file in the
# audit; header added, partitions unchanged.
from npmguard.contract.models import Trigger
from npmguard.observation import build_trigger_command


def _require_spec(command: list[str] | None) -> str:
    assert command is not None
    index = command.index("-e")
    return command[index + 1]


def _argv(command: list[str] | None) -> list[str]:
    assert command is not None
    return command[command.index("--") + 1 :]


def test_absolute_planted_driver_is_required_as_is() -> None:
    """C1: plantFiles mandates absolute paths, so the ubiquitous "plant a driver at
    /pkg/npmguard-driver.js then trigger it" pattern must require that exact path."""
    trigger = Trigger(kind="entrypoint", target="/pkg/npmguard-driver.js")
    assert _require_spec(build_trigger_command(trigger, l4=True)) == 'require("/pkg/npmguard-driver.js")'


def test_bare_relative_resolves_against_workdir() -> None:
    """C2: bare relative targets resolve under /pkg."""
    trigger = Trigger(kind="entrypoint", target="src/index.js")
    assert _require_spec(build_trigger_command(trigger, l4=False)) == 'require("/pkg/src/index.js")'


def test_dot_relative_resolves_against_workdir() -> None:
    """C3: ./ relative targets resolve under /pkg."""
    trigger = Trigger(kind="entrypoint", target="./lib/main.js")
    assert _require_spec(build_trigger_command(trigger, l4=False)) == 'require("/pkg/lib/main.js")'


def test_argv_mirrors_normal_node_invocation() -> None:
    """C4: process.argv looks like `node <entry> a b`: entry at [1], args at [2:]."""
    trigger = Trigger(kind="entrypoint", target="/pkg/driver.js", argv=["a", "b"])
    assert _argv(build_trigger_command(trigger, l4=False)) == ["/pkg/driver.js", "a", "b"]


def test_argv_dashes_are_guarded_by_separator() -> None:
    """C5: "--" precedes the argv so node stops option-parsing before the caller's args."""
    trigger = Trigger(kind="entrypoint", target="/pkg/driver.js", argv=["--flag", "-x"])
    command = build_trigger_command(trigger, l4=False)
    assert command is not None and "--" in command
    assert _argv(command) == ["/pkg/driver.js", "--flag", "-x"]


def test_subpath_is_a_module_specifier_not_a_path() -> None:
    """C6: subpath is required as a module specifier."""
    trigger = Trigger(kind="subpath", target="lodash/fp")
    assert _require_spec(build_trigger_command(trigger, l4=False)) == 'require("lodash/fp")'


def test_lifecycle_and_bin_have_no_run_command() -> None:
    """C7: lifecycle/bin have no run command."""
    assert build_trigger_command(Trigger(kind="lifecycle", target="postinstall"), l4=False) is None
    assert build_trigger_command(Trigger(kind="bin", target="cli"), l4=False) is None


def test_l4_flag_injects_instrumentation_require() -> None:
    """C8: l4=True prepends the --require instrumentation preamble."""
    trigger = Trigger(kind="entrypoint", target="/pkg/driver.js")
    assert build_trigger_command(trigger, l4=True)[:3] == ["node", "--require", "/tmp/_instrument.js"]
    assert "--require" not in build_trigger_command(trigger, l4=False)

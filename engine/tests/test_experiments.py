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
#      survive, ld_preload backfills, cap_add dedupes, extra_hosts dedupe-merge
#   C7 stub_intercept_target — which connection a stub pattern reaches: literal
#      host+port, default port, IP literal, wildcard authority, and the patterns
#      OUT of reach (https, other schemes, no scheme, IPv6, non-numeric port)
#   C8 a compiled stubUrl asserts NOTHING about responses — responseHash is null
#      until the proxy's ledger is read back, so the plan is never a fact
#   C9 two stubUrl calls fold into ONE manipulation carrying every pattern (the
#      stub list rides in a single env var, so a second manipulation would
#      overwrite the first while applied.stubUrls still listed both)
#  C10 a stub pattern naming a HOST pins it in the container's /etc/hosts; an IP
#      literal and a wildcard authority pin nothing
# C7-C10 prove what the compiler decides before any container exists. The half that
# needs a real sandbox — that the redirect actually intercepts, for every client —
# is tests/e2e/test_stub_intercept.py.
import json

import pytest

from npmguard.contract.models import ToolCall
from npmguard.docker import ContainerSpec
from npmguard.evidence import sha256_hex
from npmguard.experiments import (
    ExperimentCompileError,
    compile_experiment,
    compose,
    merge_container_spec,
    stub_intercept_target,
)
from tests.support.optional import present


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
    assert present(setup.applied.plantFiles)[0].path == "/home/node/.npmrc"
    assert present(setup.applied.plantFiles)[0].contentHash


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
    backfills from setup, cap_add and extra_hosts merge deduplicated."""
    base = ContainerSpec(
        image="npmguard-sandbox:v1",
        memory="512m",
        cpus=1.0,
        network_mode="none",
        envs={"BASE_ONLY": "yes", "FAKETIME": "base"},
        cap_add=["NET_RAW"],
        extra_hosts=["evil.example:127.0.0.1"],
    )
    compiled = compile_experiment(
        [
            call("setEnv", env={"NPM_TOKEN": "canary"}),
            call("setDate", iso="2027-01-02T03:04:05Z"),
            call("stubUrl", stubs=[{"pattern": "http://evil.example/a"}]),
            _trigger(),
        ]
    )
    merged = merge_container_spec(base, compose(compiled.setup))
    assert merged.envs["BASE_ONLY"] == "yes"
    assert merged.envs["NPM_TOKEN"] == "canary"
    assert merged.envs["FAKETIME"].startswith("@2027-01-02")  # setup overrode base
    assert merged.ld_preload == "/usr/lib/libfaketime.so.1"
    assert merged.cap_add == ["NET_RAW"]
    assert merged.extra_hosts == ["evil.example:127.0.0.1"]  # base + setup, deduped


@pytest.mark.parametrize(
    ("pattern", "expected"),
    [
        # in reach: (redirect host or None for "any", port, /etc/hosts pin)
        ("http://localhost:9999/exfil", ("127.0.0.1", 9999, "localhost:127.0.0.1")),
        ("http://exfil.example.com/*", ("127.0.0.1", 80, "exfil.example.com:127.0.0.1")),
        ("http://169.254.169.254/latest/meta-data/*", ("169.254.169.254", 80, None)),
        ("http://10.0.0.5:8080/collect", ("10.0.0.5", 8080, None)),
        ("http://*/collect", (None, 80, None)),
        ("http://*:8080/collect", (None, 8080, None)),
        # out of reach → a coverage gap, never a silent no-op
        ("https://evil.example/collect", None),
        ("*", None),
        ("evil.example/collect", None),
        ("ftp://evil.example/x", None),
        ("http://[::1]:9999/x", None),
        ("http://localhost:*/exfil", None),
        ("http:///nohost", None),
    ],
)
def test_stub_intercept_target_matrix(pattern: str, expected: tuple | None) -> None:
    """C7: the pattern → connection oracle. A pattern the redirect cannot reach
    returns None, which the run reports as a coverage gap — the only two honest
    answers are "redirected" and "not covered", never "assumed applied"."""
    target = stub_intercept_target(pattern)
    if expected is None:
        assert target is None
    else:
        assert target is not None
        assert (target.host, target.port, target.add_host) == expected


def test_compiled_stub_asserts_nothing_about_responses() -> None:
    """C8: the compiled record carries the pattern and a NULL responseHash. Hashing
    the planned response here is what let a sealed artifact attest a canned reply for
    a stub that never intercepted anything (explainer §24.0); the hash can only come
    from the proxy's ledger after the run."""
    compiled = compile_experiment(
        [
            call(
                "stubUrl",
                stubs=[{"pattern": "http://localhost:9999/exfil", "responseBody": "ok"}],
            ),
            _trigger(),
        ]
    )
    setup = compose(compiled.setup)
    assert [(ref.pattern, ref.responseHash) for ref in present(setup.applied.stubUrls)] == [
        ("http://localhost:9999/exfil", None)
    ]
    assert len(setup.observers) == 1  # the ledger read-back is armed


def test_two_stub_calls_fold_into_one_manipulation() -> None:
    """C9: both patterns reach the proxy. The stub list rides in ONE env var, so two
    stub manipulations would have compose's envs.update drop the first while
    applied.stubUrls still named it — an artifact listing a stub the proxy never
    loaded. Folding removes that state instead of detecting it."""
    compiled = compile_experiment(
        [
            call("stubUrl", stubs=[{"pattern": "http://a.example/1"}]),
            call("setEnv", env={"NPM_TOKEN": "canary"}),
            call("stubUrl", stubs=[{"pattern": "http://b.example/2"}]),
            _trigger(),
        ]
    )
    setup = compose(compiled.setup)
    assert [ref.pattern for ref in present(setup.applied.stubUrls)] == [
        "http://a.example/1",
        "http://b.example/2",
    ]
    loaded = [stub["pattern"] for stub in json.loads(setup.envs["NPMGUARD_STUBS"])]
    assert loaded == ["http://a.example/1", "http://b.example/2"]
    assert len(setup.post_starts) == 1 and len(setup.observers) == 1
    assert setup.extra_hosts == ["a.example:127.0.0.1", "b.example:127.0.0.1"]


def test_only_named_stub_hosts_are_pinned_in_etc_hosts() -> None:
    """C10: a name is pinned to loopback (a nonexistent exfil host otherwise dies at
    DNS and the stub never sees the request); an IP literal and a wildcard authority
    need no pin, and pinning them would be wrong."""
    compiled = compile_experiment(
        [
            call(
                "stubUrl",
                stubs=[
                    {"pattern": "http://exfil.example.com/*"},
                    {"pattern": "http://169.254.169.254/latest/*"},
                    {"pattern": "http://*/collect"},
                ],
            ),
            _trigger(),
        ]
    )
    assert compose(compiled.setup).extra_hosts == ["exfil.example.com:127.0.0.1"]

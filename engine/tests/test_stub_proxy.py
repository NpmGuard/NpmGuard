# CLASS MAP — the stub proxy END TO END: the REAL assets/stub-proxy.js executed by a
# REAL node, driven over real HTTP, asserted through its own served ledger.
#
# This tier exists for the same reason test_instrumentation_l4.py does: the unit is
# JavaScript, and the defects were in what it MATCHES and what it RECORDS, so nothing
# short of running it could falsify them. The wildcard bug below survived a green
# suite for its whole life because every test of a stub pattern was a test of Python.
#
# Axes: request form (origin / absolute) × pattern shape (literal, wildcard, regex
#       metacharacters, port) × match outcome × ledger contents
#   C1 a wildcard pattern matches a sub-path — `*` is the ONE wildcard, and it used
#      to compile to a quantifier on the preceding character instead
#   C2 every other regex metacharacter is LITERAL: `.` does not match any char and
#      `+`/`?` do not quantify, so a stub cannot match an endpoint nobody declared
#   C3 origin-form (what the transparent redirect delivers, authority in the Host
#      header) and absolute-form (explicit proxy client) resolve to the same URL,
#      port included
#   C4 the ledger records what was SERVED: the matched stub's index and a hash over
#      the response actually written, one row per request, in order
#   C5 an unmatched request is answered 502 and ledgered with stub=null, so it can
#      never be read as a stub having applied
#   C6 first match wins when two patterns overlap

from __future__ import annotations

import hashlib
import json
import shutil
import socket
import subprocess
import time
from http.client import HTTPConnection
from pathlib import Path

import pytest

PROXY = Path(__file__).resolve().parents[1] / "npmguard" / "assets" / "stub-proxy.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None,
    reason="node is not on PATH — the stub proxy is JavaScript and must be run to be proven",
)

PLAIN = {"Content-Type": "text/plain"}


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def expected_hash(status: int, headers: dict[str, str], body: str) -> str:
    """The ledger's hash, recomputed from the plan — a second implementation on
    purpose, so a drift between plan and served response is a red test."""
    return hashlib.sha256(
        json.dumps(
            {"status": status, "body": body, "headers": headers}, separators=(",", ":")
        ).encode()
    ).hexdigest()


class Proxy:
    """The real stub-proxy.js, on a free port, markers and ledger under tmp_path."""

    def __init__(self, tmp_path: Path, stubs: list[dict]) -> None:
        self.dir = tmp_path
        self.port = _free_port()
        # The proxy's own stderr goes to a file (not a pipe nobody drains): it is the
        # only place its per-request decisions are visible when an assertion fails.
        self.log_path = tmp_path / "proxy.log"
        self.log = self.log_path.open("w")
        self.process = subprocess.Popen(
            ["node", str(PROXY)],
            env={
                "PATH": "/usr/bin:/bin:/usr/local/bin",
                "NPMGUARD_STUBS": json.dumps(stubs, separators=(",", ":")),
                "NPMGUARD_STUB_PORT": str(self.port),
                "NPMGUARD_STUB_DIR": str(tmp_path),
            },
            stdout=self.log,
            stderr=subprocess.STDOUT,
        )
        # Same barrier the engine uses: wait on the proxy's own .ready / .err markers.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if (tmp_path / "npmguard-stub-proxy.ready").exists():
                return
            if (tmp_path / "npmguard-stub-proxy.err").exists():
                raise AssertionError(
                    (tmp_path / "npmguard-stub-proxy.err").read_text()
                )
            time.sleep(0.02)
        raise AssertionError("stub proxy did not become ready")

    def request(self, path: str, *, host: str, method: str = "GET", absolute: bool = False):
        """One request, in origin-form (the redirect's shape) or absolute-form."""
        connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request(method, f"http://{host}{path}" if absolute else path, headers={"Host": host})
        response = connection.getresponse()
        body = response.read().decode()
        connection.close()
        return response.status, body

    def ledger(self) -> list[dict]:
        path = self.dir / "npmguard-stub-proxy.served"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

    def close(self) -> None:
        self.process.terminate()
        self.process.wait(timeout=10)
        self.log.close()


@pytest.fixture
def proxy(tmp_path):
    made: list[Proxy] = []

    def factory(stubs: list[dict]) -> Proxy:
        made.append(Proxy(tmp_path, stubs))
        return made[-1]

    yield factory
    for instance in made:
        instance.close()


def _stub(pattern: str, body: str = "ok", status: int = 200, headers: dict | None = None) -> dict:
    return {
        "pattern": pattern,
        "responseStatus": status,
        "responseBody": body,
        "responseHeaders": PLAIN if headers is None else headers,
    }


def test_a_wildcard_matches_a_subpath(proxy) -> None:
    """C1: `http://host/latest/meta-data/*` must answer `/latest/meta-data/iam/x`.
    It did not: `*` was never escaped, so it survived into the regex as a quantifier
    on the preceding `/` and the pattern only matched the bare directory. Every
    wildcard stub in the recorded corpus — the running example's IMDS stub included —
    was inert for that reason."""
    server = proxy([_stub("http://169.254.169.254/latest/meta-data/*", body="IMDS")])
    assert server.request("/latest/meta-data/iam/security-credentials", host="169.254.169.254") == (
        200,
        "IMDS",
    )
    assert server.request("/latest/meta-data/", host="169.254.169.254") == (200, "IMDS")
    assert server.request("/latest/other", host="169.254.169.254")[0] == 502


def test_every_other_metacharacter_is_literal(proxy) -> None:
    """C2: only `*` is a wildcard. A `.` in a host must not match an arbitrary
    character, and `+`/`?` must not quantify — a stub that matched an endpoint the
    experiment never declared would answer traffic the run is supposed to observe."""
    server = proxy([_stub("http://a.example/x+y?z=1", body="LITERAL")])
    assert server.request("/x+y?z=1", host="a.example") == (200, "LITERAL")
    assert server.request("/xy?z=1", host="a.example")[0] == 502  # `+` did not quantify
    assert server.request("/x+y?z=", host="a.example")[0] == 502  # `?` did not quantify
    assert server.request("/x+y?z=1", host="aXexample")[0] == 502  # `.` is not "any char"


def test_origin_and_absolute_forms_resolve_to_the_same_url(proxy) -> None:
    """C3: the transparent redirect delivers origin-form with the authority in the
    Host header; an explicit proxy client sends absolute-form. Both must be matched
    against the authority the package asked for, port included."""
    server = proxy([_stub("http://localhost:9999/exfil", body="EXFIL")])
    assert server.request("/exfil", host="localhost:9999", method="POST") == (200, "EXFIL")
    assert server.request("/exfil", host="localhost:9999", absolute=True) == (200, "EXFIL")
    # a different port is a different endpoint, and must not be answered
    assert server.request("/exfil", host="localhost:8888")[0] == 502
    assert [row["url"] for row in server.ledger()][:2] == [
        "http://localhost:9999/exfil",
        "http://localhost:9999/exfil",
    ]


def test_the_ledger_records_the_response_actually_written(proxy) -> None:
    """C4: one row per request, carrying the matched stub's INDEX and a hash over the
    status/headers/body as sent. This is the only thing the sealed artifact will say
    about a stub, so it has to be a fact about the run and not the plan."""
    server = proxy(
        [
            _stub("http://a.example/one", body="ONE"),
            _stub("http://a.example/two", body="TWO", status=418, headers={"X-Stub": "yes"}),
        ]
    )
    server.request("/two", host="a.example")
    server.request("/one", host="a.example", method="POST")
    server.request("/two", host="a.example")
    assert [(row["stub"], row["method"], row["responseHash"]) for row in server.ledger()] == [
        (1, "GET", expected_hash(418, {"X-Stub": "yes"}, "TWO")),
        (0, "POST", expected_hash(200, PLAIN, "ONE")),
        (1, "GET", expected_hash(418, {"X-Stub": "yes"}, "TWO")),
    ]


def test_an_unmatched_request_is_ledgered_as_no_stub(proxy) -> None:
    """C5: a 502 is recorded with stub=null. The engine keys the artifact off the
    index, so an unmatched request can never raise a stub's responseHash out of null
    — "the proxy answered something" is not "this stub applied"."""
    server = proxy([_stub("http://a.example/declared")])
    status, body = server.request("/undeclared", host="a.example")
    assert status == 502 and "no matching stub" in body
    assert [row["stub"] for row in server.ledger()] == [None]


def test_first_matching_stub_wins(proxy) -> None:
    """C6: overlapping patterns resolve in declaration order, so a broad wildcard
    placed after a specific pattern cannot shadow it."""
    server = proxy([_stub("http://a.example/exact", body="SPECIFIC"), _stub("http://a.example/*", body="BROAD")])
    assert server.request("/exact", host="a.example") == (200, "SPECIFIC")
    assert server.request("/other", host="a.example") == (200, "BROAD")
    assert [row["stub"] for row in server.ledger()] == [0, 1]

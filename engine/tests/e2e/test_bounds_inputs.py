# CLASS MAP — bounds + error-y inputs (e2e: real engine, shrunken K5 knobs, registry stub)
# Axes: bound kind (wait-queue depth / execution concurrency / package size) × session
#       state counted (executing / queued / done) × input shape (name / semver / body /
#       package content)
# Single-owner rework (2026): the running-count session cap (NPMGUARD-0050) is retired.
# Two independent bounds now — execution concurrency = max_concurrent
# (NPMGUARD_MAX_RUNNING_SESSIONS) and the wait-queue depth = queue_size
# (NPMGUARD_QUEUE_SIZE). Over-concurrency QUEUES; only a full wait queue refuses (0040).
#   S24 queue full (QUEUE_SIZE=1, max_concurrent=1: one executing + one queued) → the next
#       admission is 503 NPMGUARD-0040 retryable [C5-adjacent]
#   S25a (flip) max_concurrent=1 + a busy worker → the second concurrent audit is ACCEPTED
#       and QUEUES (200 + audit_enqueued), never refused (0050 is gone)
#   S25b done sessions free their execution slot — the next audit runs
#   S25c (flip) a queued-but-unstarted session counts toward the WAIT-QUEUE bound, so a full
#       queue refuses the next admission with 0040 (not the retired 0050 cap)
#   S28 two concurrent free audits of the same pkg@version both complete; a reader
#       polling GET /package/:name/report never sees a torn/corrupt report (F2 atomic save)
#   S29 scoped @org/pkg end-to-end PROBE: audit → nested report dir → /package route →
#       /packages disk-scan reassembly
#   S35 input-validation matrix: bad names/semver/body → 400 on every audit entry route;
#       zero-source-file package PROBE → flag phase over an empty set
#   S36 the PER-AUDIT SPEND bound (NPMGUARD_MAX_SOURCE_FILES=2, a 3-source package):
#       synchronous POST /audit → HTTP 413 NPMGUARD-0003 non-retryable, the mock LLM
#       sees ZERO requests, and no report is written. The third bound in this file and
#       the only one that is about MONEY rather than capacity: FLAG is one model call
#       per source file, so an oversized package can burn a whole audit's price and
#       then time out with nothing delivered
#   S36b (flip) the same package at a bound of exactly 3 completes SAFE — so S36 is the
#       bound refusing, not the package being unauditable, and `>` is not `>=`
#
# Blackbox: engine HTTP + SSE + report files; bounds shrunk via public env knobs (K5).

from __future__ import annotations

import asyncio
import io
import json
import tarfile

import httpx
import pytest

from tests.e2e.llm_mock import SAFE_FLAG_BODY, SAFE_INTENT_BODY, scripted_safe_roles
from tests.support.sse import (
    SseFrame,
    collect_frames,
    iter_frames,
    require_terminal_frame,
)
from tests.support.waits import wait_report_file

pytestmark = pytest.mark.e2e

ENV_EXFIL_PKG = "test-pkg-env-exfil"
ENV_EXFIL_VERSION = "2.0.1"
SCOPED_PKG = "@npmguard-test/demo-pkg"
ZERO_SOURCE_PKG = "npmguard-zero-src-pkg"
OVERSIZED_PKG = "npmguard-oversized-pkg"
OVERSIZED_SOURCES = 3  # FLAG-eligible .js files; the bound below is set under it
CRE_KEY = "cre-test-key"

AUDIT_DEADLINE_SECONDS = 90.0
EVENT_WAIT_SECONDS = 30.0
HTTP_TIMEOUT_SECONDS = 30.0
REPORT_POLL_INTERVAL_SECONDS = 0.05
STALL_DELAY_MS = 120_000
STALL_LLM_TIMEOUT_SECONDS = 180.0


def _stalling_roles() -> dict:
    return {
        "intent": {
            "kind": "delay",
            "delay_ms": STALL_DELAY_MS,
            "then": {"kind": "static", "body": SAFE_INTENT_BODY},
        },
        "flag": {"kind": "static", "body": SAFE_FLAG_BODY},
    }


async def _post(url: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        return await client.post(url, **kwargs)


async def _get(url: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        return await client.get(url, **kwargs)


async def _first_frame_of_type(
    base_url: str, audit_id: str, event_type: str, deadline: float = EVENT_WAIT_SECONDS
) -> SseFrame:
    async with asyncio.timeout(deadline):
        async for frame in iter_frames(base_url, audit_id, deadline=deadline):
            if frame.type == event_type:
                return frame
    raise AssertionError(f"stream for {audit_id} closed without a {event_type} frame")


def _tgz(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(f"package/{name}")
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def _add_registry_package(
    registry_stub, name: str, version: str, files: dict[str, str]
) -> None:
    packument = {
        "name": name,
        "version": version,
        "description": "e2e synthetic package",
        "dist": {"tarball": f"https://registry.invalid/{name.replace('/', '-')}-{version}.tgz"},
    }
    registry_stub.add_package(packument, _tgz(files))


# ---------------------------------------------------------------------------
# S24 / S25 — bounds
# ---------------------------------------------------------------------------


async def test_queue_full_returns_retryable_503(engine_factory, mock_llm):
    """S24: with max_concurrent=1 (one executing, not counted toward the queue) and
    NPMGUARD_QUEUE_SIZE=1, a third CRE audit (one executing + one queued fills the
    bound) → 503 NPMGUARD-0040 retryable in the _audit_error shape."""
    mock_llm.load(scripted_roles=_stalling_roles())
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        cre_api_key=CRE_KEY,
        queue_size=1,
        max_running_sessions=1,  # one executes; further admissions must QUEUE
        llm_timeout_seconds=STALL_LLM_TIMEOUT_SECONDS,
    )

    def enqueue() -> httpx.Response:
        return httpx.post(
            f"{engine.base_url}/audit",
            json={"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION},
            headers={"x-api-key": CRE_KEY},
            timeout=HTTP_TIMEOUT_SECONDS,
        )

    first = enqueue()
    assert first.status_code == 202
    # bounded wait: the single worker has DEQUEUED the first audit (it emits audit_started)
    await _first_frame_of_type(engine.base_url, first.json()["auditId"], "audit_started")

    second = enqueue()
    assert second.status_code == 202  # fills the size-1 queue

    third = enqueue()
    assert third.status_code == 503, third.text
    body = third.json()
    assert body["code"] == "NPMGUARD-0040"
    assert body["retryable"] is True
    assert body["error"] == "Audit failed"


async def test_second_concurrent_audit_queues_not_refused(engine_factory, mock_llm):
    """S25a (flip): MAX_RUNNING_SESSIONS bounds execution CONCURRENCY, not admission.
    With max_concurrent=1 and a busy worker, a second concurrent audit is ACCEPTED
    and QUEUES (200 + audit_enqueued on its channel) rather than being refused — the
    running-count cap (NPMGUARD-0050) is retired in favor of the wait-queue bound."""
    mock_llm.load(scripted_roles=_stalling_roles())
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        max_running_sessions=1,
        queue_size=5,  # room to queue — the concurrency bound must not refuse
        llm_timeout_seconds=STALL_LLM_TIMEOUT_SECONDS,
    )
    started = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    await _first_frame_of_type(engine.base_url, started["auditId"], "audit_started")

    second = await _post(
        f"{engine.base_url}/audit/stream",
        json={"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION},
    )
    assert second.status_code == 200, second.text  # queued behind the worker, not refused
    audit_id = second.json()["auditId"]
    # admitted-and-waiting is observable: audit_enqueued is durable on its channel
    enqueued = await _first_frame_of_type(engine.base_url, audit_id, "audit_enqueued")
    assert enqueued.type == "audit_enqueued"


async def test_done_sessions_do_not_count_toward_cap(engine_factory, mock_llm):
    """S25b: a completed audit frees its cap slot — the next audit is accepted."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url, max_running_sessions=1)

    first = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    frames = await collect_frames(
        engine.base_url, first["auditId"], deadline=AUDIT_DEADLINE_SECONDS
    )
    assert require_terminal_frame(frames).payload["verdict"] == "SAFE"

    second = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    frames = await collect_frames(
        engine.base_url, second["auditId"], deadline=AUDIT_DEADLINE_SECONDS
    )
    assert require_terminal_frame(frames).payload["verdict"] == "SAFE"


async def test_queued_sessions_count_toward_queue_bound(engine_factory, mock_llm):
    """S25c (flip): a QUEUED-but-unstarted session counts toward the wait-queue bound
    (queue_size), not the retired running-count cap. With max_concurrent=1 and
    queue_size=1, one executing (not counted) + one queued fills the bound, so the
    next admission is refused with NPMGUARD-0040 (queue full) — never the old 0050."""
    mock_llm.load(scripted_roles=_stalling_roles())
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        cre_api_key=CRE_KEY,
        max_running_sessions=1,
        queue_size=1,
        llm_timeout_seconds=STALL_LLM_TIMEOUT_SECONDS,
    )
    first = await _post(
        f"{engine.base_url}/audit",
        json={"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION},
        headers={"x-api-key": CRE_KEY},
    )
    assert first.status_code == 202
    await _first_frame_of_type(engine.base_url, first.json()["auditId"], "audit_started")

    queued = await _post(
        f"{engine.base_url}/audit",
        json={"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION},
        headers={"x-api-key": CRE_KEY},
    )
    assert queued.status_code == 202  # admitted into the size-1 wait queue (queued_count=1)

    refused = await _post(
        f"{engine.base_url}/audit/stream",
        json={"packageName": ENV_EXFIL_PKG, "version": ENV_EXFIL_VERSION},
    )
    assert refused.status_code == 503, refused.text
    # free /audit/stream refusal goes through the route catch → the flat _audit_error shape
    assert refused.json()["code"] == "NPMGUARD-0040"  # the queued session filled the bound


# ---------------------------------------------------------------------------
# S36 — the per-audit spend bound
# ---------------------------------------------------------------------------


def _oversized_package() -> dict[str, str]:
    files = {
        "package.json": json.dumps(
            {"name": OVERSIZED_PKG, "version": "1.0.0", "main": "index.js", "license": "MIT"}
        )
    }
    files.update(
        {f"lib/s{index}.js": "module.exports = 1;\n" for index in range(OVERSIZED_SOURCES)}
    )
    return files


async def test_oversized_package_is_refused_413_without_a_model_call(
    engine_factory, mock_llm, registry_stub
):
    """S36: NPMGUARD_MAX_SOURCE_FILES=2 against a 3-source package. The synchronous
    /audit path awaits the future, so the refusal reaches the caller as its own HTTP
    status: 413 NPMGUARD-0003, retryable=False — a client must not loop on an input
    that cannot become acceptable by waiting.

    The mock LLM is loaded with NOTHING, so any model call whatsoever lands in its
    unmatched log. That is the assertion that matters: FLAG spends one model call per
    source file, and a bound that trips after the first call still loses the money it
    exists to save. Zero unmatched requests is a positive proof of zero spend at the
    HTTP boundary, not an inference from the absence of a crash."""
    mock_llm.load()  # no bundles, no scripted roles: every call is unmatched
    _add_registry_package(registry_stub, OVERSIZED_PKG, "1.0.0", _oversized_package())
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        registry_url=registry_stub.base_url,
        env={"NPMGUARD_MAX_SOURCE_FILES": str(OVERSIZED_SOURCES - 1)},
    )

    refused = await _post(
        f"{engine.base_url}/audit", json={"packageName": OVERSIZED_PKG, "version": "1.0.0"}
    )
    assert refused.status_code == 413, refused.text
    body = refused.json()
    assert body["code"] == "NPMGUARD-0003"
    assert body["retryable"] is False
    assert "NPMGUARD_MAX_SOURCE_FILES" in body["message"]  # names the knob to change

    assert mock_llm.unmatched()["count"] == 0, mock_llm.unmatched()["entries"]
    assert mock_llm.status()["consumed"] == 0
    # A refusal is not a partial audit: nothing is filed under data/reports.
    assert not (engine.data_dir / "reports" / OVERSIZED_PKG).exists()


async def test_the_same_package_at_the_bound_completes(
    engine_factory, mock_llm, registry_stub
):
    """S36b (flip): the identical package with the bound set to exactly 3 audits to a
    verdict. Without this, S36 would also pass against a package the engine simply
    cannot process, and against a `>=` comparison that refuses the packages an
    operator sized the number for."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    _add_registry_package(registry_stub, OVERSIZED_PKG, "1.0.0", _oversized_package())
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        registry_url=registry_stub.base_url,
        env={"NPMGUARD_MAX_SOURCE_FILES": str(OVERSIZED_SOURCES)},
    )

    started = engine.start_audit(OVERSIZED_PKG, "1.0.0")
    frames = await collect_frames(
        engine.base_url, started["auditId"], deadline=AUDIT_DEADLINE_SECONDS
    )
    terminal = require_terminal_frame(frames)
    assert terminal.type == "verdict_reached", event_types_dump(frames)
    assert terminal.payload["verdict"] == "SAFE"


# ---------------------------------------------------------------------------
# S28 — concurrent same-package audits + torn-read probe
# ---------------------------------------------------------------------------


async def test_concurrent_same_package_audits_and_atomic_report_reads(
    engine_factory, mock_llm
):
    """S28 [C1]: two simultaneous free audits of one pkg@version both complete, and a
    reader polling GET /package/:name/report never observes a torn/corrupt report —
    once visible, the report stays visible and valid (F2 tmp+rename atomic save)."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url)

    first = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    second = engine.start_audit(ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    assert first["auditId"] != second["auditId"]

    stop = asyncio.Event()

    async def poll_reports() -> int:
        seen_ok = 0
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            while not stop.is_set():
                response = await client.get(
                    f"{engine.base_url}/package/{ENV_EXFIL_PKG}/report"
                )
                if response.status_code == 200:
                    body = response.json()  # invalid JSON would raise here
                    assert body["packageName"] == ENV_EXFIL_PKG
                    assert body["report"]["verdict"] in ("SAFE", "DANGEROUS")
                    seen_ok += 1
                else:
                    assert response.status_code == 404
                    assert seen_ok == 0, (
                        "report vanished after being visible — corrupt/torn write "
                        "(F2 regression: save must be tmp-file + os.replace)"
                    )
                await asyncio.sleep(REPORT_POLL_INTERVAL_SECONDS)
        return seen_ok

    poller = asyncio.create_task(poll_reports())
    try:
        first_frames, second_frames = await asyncio.gather(
            collect_frames(engine.base_url, first["auditId"], deadline=AUDIT_DEADLINE_SECONDS),
            collect_frames(engine.base_url, second["auditId"], deadline=AUDIT_DEADLINE_SECONDS),
        )
    finally:
        stop.set()
    await poller
    assert require_terminal_frame(first_frames).payload["verdict"] == "SAFE"
    assert require_terminal_frame(second_frames).payload["verdict"] == "SAFE"

    # positive probe after the writes: the report is present and valid.
    # The terminal frame precedes save_report (see tests/support/waits.py) —
    # wait bounded for the file before reading it over HTTP.
    wait_report_file(
        engine.data_dir / "reports" / ENV_EXFIL_PKG / f"{ENV_EXFIL_VERSION}.json"
    )
    final = await _get(f"{engine.base_url}/package/{ENV_EXFIL_PKG}/report")
    assert final.status_code == 200
    assert final.json()["report"]["verdict"] == "SAFE"


# ---------------------------------------------------------------------------
# S29 — scoped package probe
# ---------------------------------------------------------------------------


async def test_scoped_package_end_to_end(engine_factory, mock_llm, registry_stub):
    """S29 probe: @org/pkg audits end-to-end — nested report dir, /package/{name:path}
    route, and /packages disk-scan reassembling the scoped name."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    _add_registry_package(
        registry_stub,
        SCOPED_PKG,
        "1.0.0",
        {
            "package.json": json.dumps(
                {"name": SCOPED_PKG, "version": "1.0.0", "main": "index.js", "license": "MIT"}
            ),
            "index.js": "module.exports = { answer: 42 };\n",
        },
    )
    engine = engine_factory(llm_url=mock_llm.v1_url, registry_url=registry_stub.base_url)

    started = engine.start_audit(SCOPED_PKG, "1.0.0")
    frames = await collect_frames(
        engine.base_url, started["auditId"], deadline=AUDIT_DEADLINE_SECONDS
    )
    assert require_terminal_frame(frames).payload["verdict"] == "SAFE"

    # nested directory layout: data/reports/@npmguard-test/demo-pkg/1.0.0.json
    # (bounded wait: the terminal frame precedes save_report — observed flake,
    # see tests/support/waits.py)
    persisted = engine.data_dir / "reports" / "@npmguard-test" / "demo-pkg" / "1.0.0.json"
    wait_report_file(persisted)
    assert persisted.is_file()

    wrapped = await _get(f"{engine.base_url}/package/{SCOPED_PKG}/report")
    assert wrapped.status_code == 200, wrapped.text
    assert wrapped.json()["packageName"] == SCOPED_PKG
    assert wrapped.json()["report"]["verdict"] == "SAFE"

    listing = await _get(
        f"{engine.base_url}/packages", headers={"accept": "application/json"}
    )
    assert listing.status_code == 200
    entries = {item["packageName"]: item for item in listing.json()["packages"]}
    assert SCOPED_PKG in entries, f"disk scan lost the scoped name: {sorted(entries)}"
    assert entries[SCOPED_PKG]["version"] == "1.0.0"
    assert entries[SCOPED_PKG]["verdict"] == "SAFE"


# ---------------------------------------------------------------------------
# S35 — input validation matrix + zero-source package
# ---------------------------------------------------------------------------


# One engine boot for the whole table — each row is its own equivalence class.
BAD_AUDIT_PAYLOADS = {
    "traversal-name": {"packageName": "../evil"},
    "empty-name": {"packageName": ""},
    "uppercase-name": {"packageName": "UPPER-Case"},
    "name-over-214-chars": {"packageName": "a" * 215},
    "leading-dot": {"packageName": ".hidden"},
    "bad-semver": {"packageName": "ok-pkg", "version": "not-a-semver!"},
    "short-semver": {"packageName": "ok-pkg", "version": "1.2"},
}


def test_invalid_audit_inputs_rejected(engine):
    """S35: malformed package names / versions → 400 on /audit AND /audit/stream."""
    for case, payload in BAD_AUDIT_PAYLOADS.items():
        for route in ("/audit", "/audit/stream"):
            response = httpx.post(
                f"{engine.base_url}{route}", json=payload, timeout=HTTP_TIMEOUT_SECONDS
            )
            assert response.status_code == 400, f"{case} on {route}: {response.text}"


def test_invalid_read_inputs_rejected(engine):
    """S35: bad names on the read routes → 400 (route-level valid_package_name gate);
    non-JSON audit bodies → 400."""
    for name in ("UPPER-Case", "_underscore-lead"):
        report = httpx.get(
            f"{engine.base_url}/package/{name}/report", timeout=HTTP_TIMEOUT_SECONDS
        )
        assert report.status_code == 400, f"/package/{name}/report: {report.text}"
        resolve = httpx.get(
            f"{engine.base_url}/resolve/{name}", timeout=HTTP_TIMEOUT_SECONDS
        )
        assert resolve.status_code == 400, f"/resolve/{name}: {resolve.text}"

    bad_semver = httpx.get(
        f"{engine.base_url}/package/ok-pkg/report",
        params={"version": "not-semver"},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    assert bad_semver.status_code == 400

    not_json = httpx.post(
        f"{engine.base_url}/audit",
        content=b"this is not json",
        headers={"content-type": "application/json"},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    assert not_json.status_code == 400
    assert not_json.json()["error"] == "Invalid JSON body"


async def test_zero_source_file_package(engine_factory, mock_llm, registry_stub):
    """S35 probe: a package with NO js/ts sources — the flag phase runs over an empty
    set and the audit must still land on an explicit verdict, never a hang or crash."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    _add_registry_package(
        registry_stub,
        ZERO_SOURCE_PKG,
        "1.0.0",
        {
            "package.json": json.dumps(
                {"name": ZERO_SOURCE_PKG, "version": "1.0.0", "license": "MIT"}
            ),
            "README.md": "no source files at all\n",
        },
    )
    engine = engine_factory(llm_url=mock_llm.v1_url, registry_url=registry_stub.base_url)

    started = engine.start_audit(ZERO_SOURCE_PKG, "1.0.0")
    frames = await collect_frames(
        engine.base_url, started["auditId"], deadline=AUDIT_DEADLINE_SECONDS
    )
    terminal = require_terminal_frame(frames)
    assert terminal.type == "verdict_reached", event_types_dump(frames)
    assert terminal.payload["verdict"] == "SAFE"
    assert terminal.payload["counts"]["total"] == 0


def event_types_dump(frames) -> str:
    return "events: " + ", ".join(str(frame.type) for frame in frames)

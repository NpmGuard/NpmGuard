# CLASS MAP — e2e verdict paths: real uvicorn engine + mock LLM over real HTTP
#   (+ registry stub / live docker sandbox where marked). One class per scenario.
# Axes: verdict outcome × LLM source (scripted vs recorded bundle) × sandbox
#   (none / live docker) × flag route (LLM flag vs huge-file auto-flag)
#   S1  clean SAFE       — zero-flag scripted roles, registry-resolved package,
#                          no sandbox; report file persisted under the real version
#   S2  DANGEROUS        — recorded intent/flag/hypothesis chain replayed + LIVE
#                          docker experiments + content-aware scripted judge
#                          (malicious=true cites real live event ids)
#   S3  REFUTED → SAFE   — benign fixture forced through flag→hypothesis→sandbox,
#                          judge malicious=false cites nothing → all REFUTED
#   S35 huge-file route  — >500,000-char source auto-FLAGGED without an LLM read,
#                          forced dynamic run under docker → judged → SAFE
# Adversarial pass: W4a — "does any verdict path share NPMGUARD_MOCK_LLM?" No:
#   every class runs the real openai_compatible provider against the mock server
#   (C8 is not load-bearing here). DANGEROUS bundles intentionally leave recorded
#   judge/propose/agent exchanges unconsumed (live timelines are nondeterministic,
#   design brief §judge/agent strategy) — those tests assert zero non-agent
#   unmatched requests plus verdict reproduction instead of assert_consumed
#   (agent tool-loops may diverge live; agent logic is proven at the slice tier).

from __future__ import annotations

import gzip
import io
import json
import tarfile
from pathlib import Path

import pytest
import sqlalchemy as sa

from tests.e2e.llm_mock import SAFE_INTENT_BODY, MockLlmClient, scripted_safe_roles
from tests.support.harness import ENGINE_ROOT
from tests.support.sse import (
    collect_frames,
    event_types,
    find_frames,
    terminal_frame,
)
from tests.support.waits import wait_report_file as _wait_report_file

pytestmark = pytest.mark.e2e

LLM_FIXTURES = ENGINE_ROOT / "tests" / "fixtures" / "llm"
SSE_FIXTURES = ENGINE_ROOT / "tests" / "fixtures" / "sse"

# Scripted SAFE audits finish in seconds; generous bound, never a bare sleep.
SAFE_VERDICT_DEADLINE_SECONDS = 120.0
# Live-docker DANGEROUS audits run ~14 dry-run + full-oracle sandbox experiments.
DOCKER_VERDICT_DEADLINE_SECONDS = 1800.0


def _report_path(engine, package_name: str, version: str) -> Path:
    return engine.data_dir / "reports" / package_name / f"{version}.json"


def _tgz(files: dict[str, str]) -> bytes:
    """npm-layout tarball (package/ prefix) built in memory."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as archive:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(f"package/{name}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue())


async def test_s1_clean_safe_via_registry(engine_factory, mock_llm: MockLlmClient, registry_stub):
    """S1 [C15,C2]: zero-flag scripted roles over the fake HTTP provider → SAFE;
    package resolved from the registry stub; report persisted under the real version.
    C2 (LLM capture): every audit LLM call lands in SQL — llm_runs rows keyed
    (context_kind='audit', context_id=auditId) for the roles this scenario
    exercises, with llm_attempts rows joined to each run."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url, registry_url=registry_stub.base_url)

    started = engine.start_audit("chalk", version="5.6.2")
    audit_id = started["auditId"]
    frames = await collect_frames(
        engine.base_url, audit_id, deadline=SAFE_VERDICT_DEADLINE_SECONDS
    )

    terminal = terminal_frame(frames)
    assert terminal is not None and terminal.type == "verdict_reached", event_types(frames)
    assert terminal.data["verdict"] == "SAFE"
    assert terminal.data["counts"]["total"] == 0
    assert "audit_error" not in event_types(frames)

    report = _wait_report_file(_report_path(engine, "chalk", "5.6.2"))
    assert report["verdict"] == "SAFE"
    assert report["schemaVersion"] == 2

    # C2 (LLM capture): SQL — not process memory — holds the LLM audit trail.
    # DB rows are a sanctioned observable (pattern: test_payments_flow._row_count).
    sync_url = engine.db_url.replace("+aiosqlite", "").replace("+asyncpg", "")
    capture_db = sa.create_engine(sync_url)
    try:
        with capture_db.connect() as connection:
            runs = connection.execute(
                sa.text(
                    "SELECT id, role FROM llm_runs"
                    " WHERE context_kind = 'audit' AND context_id = :audit_id"
                ),
                {"audit_id": audit_id},
            ).all()
            captured_roles = {role for _, role in runs}
            # intent + flag are the roles S1 exercises (scripted_safe_roles).
            assert {"intent", "flag"} <= captured_roles, captured_roles
            attempt_counts = dict(
                connection.execute(
                    sa.text(
                        "SELECT run_id, COUNT(*) FROM llm_attempts"
                        " WHERE run_id IN (SELECT id FROM llm_runs"
                        "   WHERE context_kind = 'audit' AND context_id = :audit_id)"
                        " GROUP BY run_id"
                    ),
                    {"audit_id": audit_id},
                ).all()
            )
            runs_without_attempts = [
                run_id for run_id, _ in runs if attempt_counts.get(run_id, 0) < 1
            ]
            assert runs_without_attempts == [], runs_without_attempts
    finally:
        capture_db.dispose()
    # mock_llm teardown asserts zero unmatched (all traffic scripted).


@pytest.mark.docker
@pytest.mark.parametrize(
    "bundle_name",
    ["test-pkg-env-exfil@2.0.1", "test-pkg-dns-exfil@0.2.1"],
)
async def test_s2_dangerous_confirmed_live_docker(
    engine_factory, mock_llm: MockLlmClient, bundle_name: str
):
    """S2 [C4,C15]: recorded intent/flag/hypothesis chain + LIVE docker experiments
    + content-aware scripted judge (malicious=true, cites real event ids) → DANGEROUS.

    teardown_checks off: recorded judge/propose/agent exchanges are intentionally
    unconsumed (live timelines embed runIds/wall-clock — brief §judge/agent
    strategy); the strong assertion here is zero unmatched requests EXCEPT the
    agent role: MIXED-path bundles may re-enter the agentic fallback live, whose
    tool-loop prompts are structurally nondeterministic — agent logic is proven
    at the slice tier, and the divergence must stay contained to that role."""
    bundle = LLM_FIXTURES / bundle_name
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    mock_llm.load(
        bundle_dirs=[str(bundle)],
        scripted_roles={
            "judge": {"kind": "judge", "malicious": True},
            "hypothesis": {"kind": "hypothesis", "claim_kind": "env_exfil"},
        },
    )
    mock_llm.teardown_checks = False
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        triage_model=manifest["models"]["triage"],
        investigation_model=manifest["models"]["investigation"],
    )

    package = manifest["package"]
    started = engine.start_audit(package, version=manifest["packageVersion"])
    audit_id = started["auditId"]
    frames = await collect_frames(
        engine.base_url, audit_id, deadline=DOCKER_VERDICT_DEADLINE_SECONDS
    )

    terminal = terminal_frame(frames)
    assert terminal is not None and terminal.type == "verdict_reached", (
        f"types={event_types(frames)} unmatched={mock_llm.unmatched()}"
    )
    assert terminal.data["verdict"] == "DANGEROUS"
    assert terminal.data["counts"]["confirmed"] >= 1
    resolved_states = {frame.data["state"] for frame in find_frames(frames, "hypothesis_resolved")}
    assert "CONFIRMED" in resolved_states

    # Live run emits the same event vocabulary the recorded audit did.
    skeleton = json.loads((SSE_FIXTURES / f"{package}.skeleton.json").read_text(encoding="utf-8"))
    assert set(event_types(frames)) == set(skeleton["eventTypes"])

    report = _wait_report_file(_report_path(engine, package, manifest["packageVersion"]))
    assert report["verdict"] == "DANGEROUS"
    non_agent_unmatched = [
        entry
        for entry in mock_llm.unmatched()["entries"]
        if "scripted role 'agent'" not in entry["reason"]
    ]
    assert non_agent_unmatched == []


@pytest.mark.docker
async def test_s3_all_refuted_is_safe(engine_factory, mock_llm: MockLlmClient):
    """S3 [C4,C15]: benign fixture forced through flag→hypothesis→LIVE sandbox;
    judge malicious=false with no citations → every hypothesis REFUTED → SAFE.
    Proves refutation requires the full-oracle run (evidence exists), and that a
    no-citation benign verdict never couples to timeline content."""
    mock_llm.load(
        scripted_roles={
            "intent": {"kind": "static", "body": SAFE_INTENT_BODY},
            "flag": {
                "kind": "static",
                "body": {
                    "summary": "Reads environment variables and sends data over the network.",
                    "capabilities": ["ENV_VARS", "NETWORK"],
                    "flags": [
                        {
                            "lines": ["1-1"],
                            "why": "Scripted flag: forced dynamic verification of this file.",
                        }
                    ],
                },
            },
            "hypothesis": {"kind": "hypothesis", "claim_kind": "env_exfil"},
            "judge": {"kind": "judge", "malicious": False},
        }
    )
    engine = engine_factory(llm_url=mock_llm.v1_url)

    started = engine.start_audit("test-pkg-child-success")
    frames = await collect_frames(
        engine.base_url, started["auditId"], deadline=DOCKER_VERDICT_DEADLINE_SECONDS
    )

    terminal = terminal_frame(frames)
    assert terminal is not None and terminal.type == "verdict_reached", event_types(frames)
    assert terminal.data["verdict"] == "SAFE"
    counts = terminal.data["counts"]
    assert counts["confirmed"] == 0
    assert counts["refuted"] >= 1
    assert counts["deferred"] == 0
    resolved_states = {frame.data["state"] for frame in find_frames(frames, "hypothesis_resolved")}
    assert resolved_states == {"REFUTED"}

    report = _wait_report_file(_report_path(engine, "test-pkg-child-success", "1.0.0"))
    assert report["verdict"] == "SAFE"


@pytest.mark.docker
async def test_s35_huge_file_forced_dynamic_route(
    engine_factory, mock_llm: MockLlmClient, registry_stub
):
    """S35 [C15]: a >500,000-char source file is auto-FLAGGED without an LLM read
    (no file_analyzing event) and forced through hypothesis → LIVE sandbox →
    judge — the only verdict route through the too-large branch → SAFE here."""
    huge_source = ("// benign padding line for the auto-flag threshold\n" * 11_000) + (
        "console.log('hugefile ok');\n"
    )
    assert len(huge_source) > 500_000
    registry_stub.add_package(
        {
            "name": "hugefile-lab",
            "version": "1.0.0",
            "description": "oversized-source fixture",
            "dist": {"tarball": "http://registry.invalid/hugefile-lab-1.0.0.tgz"},
        },
        _tgz(
            {
                "package.json": json.dumps(
                    {"name": "hugefile-lab", "version": "1.0.0", "main": "index.js"}
                ),
                "index.js": huge_source,
            }
        ),
    )
    mock_llm.load(
        scripted_roles={
            "intent": {"kind": "static", "body": SAFE_INTENT_BODY},
            # flag is NOT scripted: the only source file takes the auto-flag branch,
            # so a flag-role request would fail loud as unmatched.
            "hypothesis": {"kind": "hypothesis", "claim_kind": "env_exfil"},
            "judge": {"kind": "judge", "malicious": False},
        }
    )
    engine = engine_factory(llm_url=mock_llm.v1_url, registry_url=registry_stub.base_url)

    started = engine.start_audit("hugefile-lab", version="1.0.0")
    frames = await collect_frames(
        engine.base_url, started["auditId"], deadline=DOCKER_VERDICT_DEADLINE_SECONDS
    )

    terminal = terminal_frame(frames)
    assert terminal is not None and terminal.type == "verdict_reached", event_types(frames)
    assert terminal.data["verdict"] == "SAFE"
    assert terminal.data["counts"]["refuted"] >= 1  # the sandbox+judge leg really ran
    # Negative (paired with the positive probes above): the huge file was never
    # read by the flag LLM — the auto-flag branch skips the file_analyzing emit
    # INSIDE the flag phase (the hypothesize phase re-emits file_analyzing per
    # armed flag, so the window matters). The mock teardown seals it: an LLM
    # flag read would surface as an unmatched flag-role request.
    flag_started = next(
        index
        for index, frame in enumerate(frames)
        if frame.type == "phase_started" and frame.data["phase"] == "flag"
    )
    flag_completed = next(
        index
        for index, frame in enumerate(frames)
        if frame.type == "phase_completed" and frame.data["phase"] == "flag"
    )
    flag_window_types = [frame.type for frame in frames[flag_started + 1 : flag_completed]]
    assert "file_analyzing" not in flag_window_types
    assert len(find_frames(frames, "hypothesis_emitted")) >= 1

    report = _wait_report_file(_report_path(engine, "hugefile-lab", "1.0.0"))
    assert report["verdict"] == "SAFE"

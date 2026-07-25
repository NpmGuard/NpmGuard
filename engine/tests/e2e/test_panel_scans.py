# CLASS MAP — panel repo scan + detail + scan-progress SSE (e2e: real engine,
# real GitHub stub behind HTTP, deterministic via cache hits).
# Axes: dep outcome class (SAFE / DANGEROUS / uncached-miss) × scan lifecycle ×
#       the 3-state rollup × the UNNAMED scan SSE.
#   S-scan-1  full sign-in → orgs/repos mirror → POST /panel/repo/:id/scan:
#             - deps pre-seeded as CACHE HITS via data/reports (one DANGEROUS,
#               one SAFE) land verdicts with no real audit/docker [C1]
#             - one uncached dep is a real cache-MISS: it fans a panel job into
#               AuditService, whose audit deterministically FAILS against the
#               hermetic-dead registry, so the dep settles outcome='ERROR' +
#               jobState='failed' — never SAFE, and never a pending spinner that
#               resolves itself (§4.4: "we tried and failed" is a fact) [C2]
#             - GET /panel/repo/:owner/:name rollup is max-severity DANGEROUS and
#               the failed audit is counted in `error`, not hidden [C3]
#             - GET /panel/scan/:id/events streams UNNAMED (data-only) frames:
#               a {type:'progress'} snapshot + a terminal {type:'done'} [C4]
# (The 409-already-running, 402-cap, and 422-no-lockfile branches are covered by
#  the route unit surface; this e2e proves the deterministic cache-hit happy path
#  end to end.)
#
# NOTE (determinism): the happy-path per-dep verdicts come from CACHE HITS, so no
# Docker/LLM/registry is exercised for them. The real cache-MISS fan-out through
# AuditService.admit -> future -> verdict-index is unit-proven in
# tests/test_panel_jobs.py with a fake AuditService; here the single miss is
# steered into a fast, deterministic audit FAILURE (dead registry) so the scan
# still reaches a terminal state without real audit infrastructure.
#
# Blackbox: engine HTTP API (cookies, redirects, JSON, SSE stream).

from __future__ import annotations

import json
import time

import httpx
import pytest

from tests.support.panel import github_env, seed_report

pytestmark = pytest.mark.e2e

HTTP_TIMEOUT_SECONDS = 30.0
SCAN_DONE_TIMEOUT_SECONDS = 90.0
SSE_READ_TIMEOUT_SECONDS = 30.0

OAUTH_CODE = "stub_code"
USER_TOKEN = "user_tok"

# A package-lock.json v3 with two direct deps (both pre-seeded cache hits) and
# one transitive dep with NO report — a real cache miss that fans out a job.
LOCKFILE_CONTENT = json.dumps(
    {
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"safe-dep": "^1.0.0", "danger-dep": "^2.0.0"}},
            "node_modules/safe-dep": {"version": "1.0.0"},
            "node_modules/danger-dep": {"version": "2.0.0"},
            "node_modules/pending-dep": {"version": "3.0.0"},
        },
    }
)


def _sign_in(client: httpx.Client, base: str, github_stub) -> None:
    """Drive the full OAuth web flow so the ng_session cookie + gh_users row
    exist, then mirror orgs + repos into the DB (installations, user_installations,
    repos — everything the scan authorization + caps read)."""
    login = client.get(f"{base}/api/auth/github/login")
    assert login.status_code == 302, login.text
    authorized = client.get(login.headers["location"])
    assert authorized.status_code == 302
    callback = client.get(authorized.headers["location"])
    assert callback.status_code == 302, callback.text
    assert "ng_session" in client.cookies

    orgs = client.get(f"{base}/api/panel/orgs")
    assert orgs.status_code == 200, orgs.text
    repos = client.get(f"{base}/api/panel/repos")
    assert repos.status_code == 200, repos.text


def _poll_scan_done(client: httpx.Client, base: str) -> dict:
    deadline = time.monotonic() + SCAN_DONE_TIMEOUT_SECONDS
    last: dict = {}
    while time.monotonic() < deadline:
        detail = client.get(f"{base}/api/panel/repo/acme/web")
        assert detail.status_code == 200, detail.text
        last = detail.json()
        audit_set = last.get("set")
        if audit_set and audit_set["status"] == "done":
            return last
        time.sleep(0.5)
    raise AssertionError(f"scan did not reach 'done' in time; last detail: {last}")


def _read_sse_frames(
    client: httpx.Client, base: str, scan_id: int, *, headers: dict[str, str] | None = None
) -> tuple[list[dict], list[int]]:
    """Read the audit-set SSE until the terminal ``{type:'done'}`` frame.

    Returns the frame payloads and the `id:` cursors seen. Frames are UNNAMED
    (no `event:` line, so a browser reads them with `onmessage`) but DO carry an
    `id:` — which is what makes Last-Event-ID resume work.
    """
    frames: list[dict] = []
    seqs: list[int] = []
    with client.stream(
        "GET",
        f"{base}/api/panel/scan/{scan_id}/events",
        timeout=SSE_READ_TIMEOUT_SECONDS,
        headers=headers,
    ) as response:
        assert response.status_code == 200, response.read()
        assert "text/event-stream" in response.headers["content-type"]
        for line in response.iter_lines():
            assert not line.startswith("event:"), line
            if line.startswith("id:"):
                seqs.append(int(line[len("id:") :].strip()))
                continue
            if not line.startswith("data:"):
                continue
            payload = json.loads(line[len("data:") :].strip())
            frames.append(payload)
            if payload.get("type") == "done":
                break
    return frames, seqs


def test_s_scan_1_cache_hit_scan_rollup_and_sse(engine_factory, github_stub, app_private_key):
    """S-scan-1 [C1-C5]: pre-seeded cache-hit deps + one failing miss → the audit
    set reaches done, its rollup is max-severity DANGEROUS with the failed audit
    counted in `error`, the UNNAMED-but-id-carrying SSE emits dep + progress +
    done, and a Last-Event-ID resume replays only what came after the cursor."""
    github_stub.set_oauth_code(OAUTH_CODE, USER_TOKEN)
    github_stub.set_user(USER_TOKEN, id=42, login="octocat", email="mona@example.com")
    github_stub.add_installation(500, account_login="acme", account_type="Organization")
    github_stub.add_repo("acme", "web", id=1001, installation_id=500)
    github_stub.set_lockfile("acme", "web", "package-lock.json", LOCKFILE_CONTENT)

    harness = engine_factory(start=False)
    reports = harness.data_dir / "reports"
    seed_report(
        reports, "safe-dep", "1.0.0", {"verdict": "SAFE", "rationale": "clean", "confirmedHypIds": []}
    )
    seed_report(
        reports,
        "danger-dep",
        "2.0.0",
        {"verdict": "DANGEROUS", "rationale": "exfiltrates env", "confirmedHypIds": ["h1", "h2"]},
    )
    harness.extra_env = github_env(
        api_base=github_stub.base_url,
        private_key_path=app_private_key,
        panel_base_url=harness.base_url,
    )
    harness.start()
    base = harness.base_url

    with httpx.Client(follow_redirects=False, timeout=HTTP_TIMEOUT_SECONDS) as client:
        _sign_in(client, base, github_stub)

        # POST scan → 200 {scanId}; the cache-hit deps need no audit, the single
        # miss (pending-dep) fans a job that fails fast against the dead registry.
        scan_resp = client.post(f"{base}/api/panel/repo/1001/scan")
        assert scan_resp.status_code == 200, scan_resp.text
        scan_id = scan_resp.json()["scanId"]
        assert isinstance(scan_id, int)

        detail = _poll_scan_done(client, base)

        # C3: max-severity rollup over the SET's own items, and the failed audit
        # lands in `error` — the counters partition the set
        # (safe+dangerous+error+pending == total). `deps` is the same population,
        # so summing it reproduces the rollup.
        rollup = detail["set"]["rollup"]
        assert rollup["outcome"] == "DANGEROUS", rollup
        assert rollup["dangerous"] == 1
        assert rollup["safe"] == 1
        assert rollup["error"] == 1, rollup
        assert rollup["pending"] == 0, rollup
        assert rollup["total"] == 3
        assert (
            rollup["safe"] + rollup["dangerous"] + rollup["error"] + rollup["pending"]
            == rollup["total"]
        )

        deps = {d["name"]: d for d in detail["deps"]}
        # C1: cache-hit verdicts.
        assert deps["danger-dep"]["outcome"] == "DANGEROUS"
        assert deps["danger-dep"]["evidenceCount"] == 2
        assert deps["danger-dep"]["direct"] is True
        assert deps["safe-dep"]["outcome"] == "SAFE"
        assert deps["safe-dep"]["direct"] is True
        # C2: the audit that could not conclude is ERROR — never SAFE, and never
        # a null that renders as a spinner waiting for a result nothing will
        # produce. jobState says the ATTEMPT failed; outcome says what we know.
        failed_dep = deps["pending-dep"]
        assert failed_dep["outcome"] == "ERROR", failed_dep
        assert failed_dep["jobState"] == "failed", failed_dep
        assert failed_dep["direct"] is False

        # `set` and the repo list's `lastScan` are the same projection, so the
        # dashboard's posture and the detail page cannot disagree.
        assert detail["set"]["status"] == "done"
        assert detail["set"]["id"] == scan_id
        assert detail["repo"]["lastScan"] == detail["set"]
        assert detail["depsTruncated"] is False
        assert len(detail["deps"]) == rollup["total"]

        # C4: the SSE emits dep frames + a progress snapshot + a terminal done.
        frames, seqs = _read_sse_frames(client, base, scan_id)
        types = [f["type"] for f in frames]
        assert "progress" in types, frames
        assert frames[-1] == {"type": "done"}, frames
        progress = [f for f in frames if f["type"] == "progress"][-1]
        assert progress["status"] == "done"
        assert progress["rollup"] == rollup
        # The log carries TRANSITIONS, so a dep frame exists for exactly the item
        # whose state moved — the cache hits were already final when the set was
        # created and never produce one. Their state comes from the detail route,
        # which is where the cap, the ordering and the truncation flag live anyway;
        # seeding a frame per item would put a copy of `audit_set_items` in the
        # durable log and an N-insert transaction in front of this POST's response.
        dep_frames = {f["item"]["name"]: f["item"] for f in frames if f["type"] == "dep"}
        assert set(dep_frames) == {"pending-dep"}, dep_frames
        # And that frame carries the WHOLE contract item — the same object the
        # detail route returns, not a lossier subset of it.
        assert dep_frames["pending-dep"] == deps["pending-dep"]

        # C5: Last-Event-ID resume. Replaying from the last cursor yields only the
        # freshly recomputed final progress + done — never the dep frames again.
        assert seqs == sorted(seqs), seqs
        resumed, _ = _read_sse_frames(
            client, base, scan_id, headers={"Last-Event-ID": str(max(seqs))}
        )
        assert [f["type"] for f in resumed] == ["progress", "done"], resumed
        assert resumed[0]["rollup"] == rollup

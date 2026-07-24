# SCENARIO MAP — public-repo audits + Stripe subscription billing wired into the
# live engine (e2e: real uvicorn, real GitHub stub behind HTTP, real Stripe stub
# behind HTTP, deterministic via pre-seeded cache-hit verdicts + offline-signed
# Stripe webhooks). Proves the FINAL two panel routers (public_repos + billing)
# are included and the /webhooks/stripe subscription branch coexists with the
# UNCHANGED one-off audit branch.
#
#   S-pub-1  public-repo audit end to end [C1-C3]:
#     - sign in → mirror orgs (so installation 500 is owned by the user)
#     - POST /panel/public-repos/scan {repository:'acme/pub', installationId:500}:
#       the credential-free public octokit reads the repo, the SSRF-guarded raw
#       host (github_raw_base → the stub) streams the root lockfile, and every
#       dep is a pre-seeded CACHE HIT (one DANGEROUS) → 201 {scanId}; the snapshot
#       finalizes at creation (no uncached work) [C1]
#     - poll GET /panel/public-repos/:id to status=='done': rollup is worst-dep-
#       wins DANGEROUS, deps carry their cached verdicts, danger sorts first [C2]
#     - an SSRF reference (wrong host) → 400; a PRIVATE repo → 403 [C3]
#
#   S-bill-1  Stripe subscription billing lifts a cap [C4-C6]:
#     - FREE plan capped at ONE protected repo: protect acme/web → 200, protect a
#       SECOND repo acme/api → 402 {cap:true, resource:'protected_repos'} [C4]
#     - POST /panel/billing/checkout {installationId:500} → 200 {url, sessionId}
#       (a mode='subscription' checkout created through the Stripe stub) [C5]
#     - POST a signed customer.subscription.created (metadata.kind=
#       'repo_pro_subscription', installationId=500, status='active') to
#       /webhooks/stripe → 200; GET /panel/billing shows the account flipped to
#       plan 'pro'; the previously-capped SECOND protect now SUCCEEDS (200) [C6]
#     - the one-off audit webhook branch is untouched (its tests stay green in the
#       default suite; here we exercise only the subscription branch)
#
# NOTE (determinism): every per-dep verdict is a pre-seeded cache HIT (no Docker /
# LLM / registry). The Stripe subscription webhook is HMAC-signed offline (real
# Stripe SDK signature verification, no network) and dispatched via
# customer.subscription.created, whose handler mutates billing state WITHOUT any
# Stripe API call — so nothing here touches a real Stripe or GitHub endpoint.
#
# Blackbox: engine HTTP API (cookies, redirects, JSON, 201/402/403 + webhook 200)
# + the Stripe stub's recorded create form.

from __future__ import annotations

import hashlib
import hmac
import json
import time
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

pytestmark = pytest.mark.e2e

HTTP_TIMEOUT_SECONDS = 30.0
SCAN_DONE_TIMEOUT_SECONDS = 60.0

ENCRYPTION_KEY = "00" * 32
OAUTH_CODE = "stub_code"
USER_TOKEN = "user_tok"

STRIPE_KEY = "sk_test_x"
WEBHOOK_SECRET = "whsec_test_secret"
PRO_PRICE_ID = "price_pro_test"

# A package-lock.json v3 with two direct deps, both pre-seeded cache hits
# (one SAFE, one DANGEROUS) so a public snapshot finalizes with no real audit.
PUB_LOCKFILE = json.dumps(
    {
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"safe-dep": "^1.0.0", "danger-dep": "^2.0.0"}},
            "node_modules/safe-dep": {"version": "1.0.0"},
            "node_modules/danger-dep": {"version": "2.0.0"},
        },
    }
)
# A single-dep lockfile for the protectable repos in the billing scenario.
PROTECT_LOCKFILE = json.dumps(
    {
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"safe-dep": "^1.0.0"}},
            "node_modules/safe-dep": {"version": "1.0.0"},
        },
    }
)


@pytest.fixture
def app_private_key(tmp_path: Path) -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    path = tmp_path / "app-key.pem"
    path.write_bytes(pem)
    return str(path)


def _github_env(
    *,
    api_base: str,
    private_key_path: str,
    panel_base_url: str,
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    env = {
        "NPMGUARD_GITHUB_APP_ID": "12345",
        "NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH": private_key_path,
        "NPMGUARD_GITHUB_CLIENT_ID": "Iv1.testclient",
        "NPMGUARD_GITHUB_CLIENT_SECRET": "test-client-secret",
        "NPMGUARD_ENCRYPTION_KEY": ENCRYPTION_KEY,
        "NPMGUARD_GITHUB_API_BASE": api_base,
        "NPMGUARD_PANEL_BASE_URL": panel_base_url,
    }
    if extra:
        env.update(extra)
    return env


def _seed_report(reports_dir: Path, name: str, version: str, report: dict) -> None:
    directory = reports_dir / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{version}.json").write_text(
        json.dumps(report) + "\n", encoding="utf-8"
    )


def _safe() -> dict:
    return {"verdict": "SAFE", "rationale": "clean", "confirmedHypIds": []}


def _dangerous() -> dict:
    return {
        "verdict": "DANGEROUS",
        "rationale": "exfiltrates env",
        "confirmedHypIds": ["h1", "h2"],
    }


def _sign_in(client: httpx.Client, base: str) -> None:
    """Drive the OAuth web flow so the ng_session cookie + gh_users row exist,
    then mirror orgs (installation 500 becomes owned by the user)."""
    login = client.get(f"{base}/api/auth/github/login")
    assert login.status_code == 302, login.text
    authorized = client.get(login.headers["location"])
    assert authorized.status_code == 302
    callback = client.get(authorized.headers["location"])
    assert callback.status_code == 302, callback.text
    assert "ng_session" in client.cookies
    assert client.get(f"{base}/api/panel/orgs").status_code == 200
    assert client.get(f"{base}/api/panel/repos").status_code == 200


def _stripe_signature(payload: bytes, secret: str) -> str:
    timestamp = int(time.time())
    signed = f"{timestamp}.".encode() + payload
    digest = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


def _subscription_created_payload(
    installation_id: int, subscription_id: str, customer_id: str
) -> bytes:
    """A customer.subscription.created event carrying the installation id in
    metadata — its handler links + activates WITHOUT any Stripe API call."""
    event = {
        "id": "evt_sub_0001",
        "object": "event",
        "type": "customer.subscription.created",
        "data": {
            "object": {
                "id": subscription_id,
                "object": "subscription",
                "status": "active",
                "customer": customer_id,
                "metadata": {
                    "kind": "repo_pro_subscription",
                    "installationId": str(installation_id),
                    "accountLogin": "acme",
                },
            }
        },
    }
    return json.dumps(event).encode()


# ---------------------------------------------------------------------------
# S-pub-1 — public-repo audit end to end
# ---------------------------------------------------------------------------


def test_s_pub_1_public_repo_scan_polls_to_dangerous_rollup(
    engine_factory, github_stub, app_private_key
):
    """S-pub-1 [C1-C3]: a public-repo audit reads the repo credential-free, streams
    the lockfile from the SSRF-guarded raw host, resolves every dep from the cache
    (one DANGEROUS), and polls to a done snapshot with a DANGEROUS rollup; an SSRF
    reference → 400 and a private repo → 403."""
    github_stub.set_oauth_code(OAUTH_CODE, USER_TOKEN)
    github_stub.set_user(USER_TOKEN, id=42, login="octocat", email="mona@example.com")
    github_stub.add_installation(500, account_login="acme", account_type="Organization")
    # The public repo audited here is NOT one of the installation's repos — the
    # public octokit reads it directly, credential-free.
    github_stub.add_repo("acme", "pub", id=2001, private=False)
    github_stub.set_lockfile("acme", "pub", "package-lock.json", PUB_LOCKFILE)
    # A private repo the public audit must refuse.
    github_stub.add_repo("acme", "secret", id=2002, private=True)

    harness = engine_factory(start=False)
    reports = harness.data_dir / "reports"
    _seed_report(reports, "safe-dep", "1.0.0", _safe())
    _seed_report(reports, "danger-dep", "2.0.0", _dangerous())
    harness.extra_env = _github_env(
        api_base=github_stub.base_url,
        private_key_path=app_private_key,
        panel_base_url=harness.base_url,
        # The raw-host SSRF allow-list points at the stub so lockfile downloads
        # resolve here instead of raw.githubusercontent.com.
        extra={"NPMGUARD_GITHUB_RAW_BASE": github_stub.base_url},
    )
    harness.start()
    base = harness.base_url

    with httpx.Client(follow_redirects=False, timeout=HTTP_TIMEOUT_SECONDS) as client:
        _sign_in(client, base)

        # C1: POST the public-repo scan → 201 {scanId}. Every dep is a cache hit,
        # so no panel job is enqueued and the snapshot finalizes at creation.
        created = client.post(
            f"{base}/api/panel/public-repos/scan",
            json={"repository": "acme/pub", "installationId": 500},
        )
        assert created.status_code == 201, created.text
        scan_id = created.json()["scanId"]
        assert isinstance(scan_id, int)

        # C2: poll the detail endpoint to done → rollup is worst-dep-wins
        # DANGEROUS; the deps carry their cached verdicts, danger sorts first.
        deadline = time.monotonic() + SCAN_DONE_TIMEOUT_SECONDS
        detail: dict = {}
        while time.monotonic() < deadline:
            resp = client.get(f"{base}/api/panel/public-repos/{scan_id}")
            assert resp.status_code == 200, resp.text
            detail = resp.json()
            if detail["scan"]["status"] == "done":
                break
            time.sleep(0.3)
        assert detail["scan"]["status"] == "done", detail

        rollup = detail["scan"]["rollup"]
        assert rollup["verdict"] == "DANGEROUS", rollup
        assert rollup["dangerous"] == 1
        assert rollup["safe"] == 1
        assert rollup["suspect"] == 0
        assert rollup["unknown"] == 0

        deps = {d["name"]: d for d in detail["dependencies"]}
        assert deps["danger-dep"]["verdict"] == "DANGEROUS"
        assert deps["danger-dep"]["cached"] is True
        assert deps["danger-dep"]["evidenceCount"] == 2
        assert deps["safe-dep"]["verdict"] == "SAFE"
        assert deps["safe-dep"]["cached"] is True
        # Severity-DESC ordering: the DANGEROUS dep is first.
        assert detail["dependencies"][0]["name"] == "danger-dep"
        assert detail["dependenciesTruncated"] is False

        # It also shows up in the user's public-audit history.
        history = client.get(f"{base}/api/panel/public-repos")
        assert history.status_code == 200, history.text
        scans = history.json()["scans"]
        assert any(s["id"] == scan_id and s["fullName"] == "acme/pub" for s in scans)

        # C3: an SSRF reference (wrong host) is rejected at the parse boundary.
        ssrf = client.post(
            f"{base}/api/panel/public-repos/scan",
            json={
                "repository": "https://evil.example.com/acme/pub",
                "installationId": 500,
            },
        )
        assert ssrf.status_code == 400, ssrf.text

        # C3: a PRIVATE repo cannot be audited through the public path.
        private = client.post(
            f"{base}/api/panel/public-repos/scan",
            json={"repository": "acme/secret", "installationId": 500},
        )
        assert private.status_code == 403, private.text
        assert "public repositories" in private.json()["error"].lower()


# ---------------------------------------------------------------------------
# S-bill-1 — Stripe subscription billing lifts a cap
# ---------------------------------------------------------------------------


def test_s_bill_1_subscription_webhook_flips_plan_and_lifts_cap(
    engine_factory, github_stub, stripe_stub, app_private_key
):
    """S-bill-1 [C4-C6]: a free account is capped at one protected repo; a Stripe
    subscription checkout + a signed customer.subscription.created webhook flip it
    to Pro, and the previously-capped second protect then succeeds."""
    github_stub.set_oauth_code(OAUTH_CODE, USER_TOKEN)
    github_stub.set_user(USER_TOKEN, id=42, login="octocat", email="mona@example.com")
    github_stub.add_installation(500, account_login="acme", account_type="Organization")
    github_stub.add_repo("acme", "web", id=1001, installation_id=500)
    github_stub.add_repo("acme", "api", id=1002, installation_id=500)
    github_stub.set_lockfile("acme", "web", "package-lock.json", PROTECT_LOCKFILE)
    github_stub.set_lockfile("acme", "api", "package-lock.json", PROTECT_LOCKFILE)

    harness = engine_factory(
        start=False,
        stripe_api_base=stripe_stub.base_url,
        stripe_secret_key=STRIPE_KEY,
        stripe_webhook_secret=WEBHOOK_SECRET,
    )
    reports = harness.data_dir / "reports"
    _seed_report(reports, "safe-dep", "1.0.0", _safe())
    harness.extra_env = _github_env(
        api_base=github_stub.base_url,
        private_key_path=app_private_key,
        panel_base_url=harness.base_url,
        extra={
            "NPMGUARD_STRIPE_PRO_PRICE_ID": PRO_PRICE_ID,
            # Free plan capped at ONE protected repo so the 2nd protect trips 402.
            "NPMGUARD_FREE_MAX_PROTECTED_REPOS": "1",
        },
    )
    harness.start()
    base = harness.base_url

    with httpx.Client(follow_redirects=False, timeout=HTTP_TIMEOUT_SECONDS) as client:
        _sign_in(client, base)

        # C4: protect the first repo → 200; the second → 402 over the free cap.
        first = client.post(f"{base}/api/panel/repo/1001/protect")
        assert first.status_code == 200, first.text

        over_cap = client.post(f"{base}/api/panel/repo/1002/protect")
        assert over_cap.status_code == 402, over_cap.text
        cap_body = over_cap.json()
        assert cap_body["cap"] is True
        assert cap_body["resource"] == "protected_repos"
        assert cap_body["installationId"] == 500

        # billing starts on the free plan.
        billing = client.get(f"{base}/api/panel/billing")
        assert billing.status_code == 200, billing.text
        payload = billing.json()
        assert payload["checkoutEnabled"] is True
        account = next(a for a in payload["accounts"] if a["installationId"] == 500)
        assert account["plan"] == "free"

        # C5: a subscription checkout is created through the Stripe stub.
        checkout = client.post(
            f"{base}/api/panel/billing/checkout", json={"installationId": 500}
        )
        assert checkout.status_code == 200, checkout.text
        checkout_body = checkout.json()
        assert checkout_body["url"].startswith("https://checkout.stripe.example/")
        assert checkout_body["sessionId"]
        # The create was a mode='subscription' call carrying the price + the kind
        # marker the webhook keys on.
        create_form = stripe_stub.create_forms[-1]
        assert create_form["mode"] == "subscription"
        assert create_form["metadata[kind]"] == "repo_pro_subscription"
        assert create_form["metadata[installationId]"] == "500"

        # C6: a signed customer.subscription.created flips the plan to Pro.
        sub_payload = _subscription_created_payload(500, "sub_test_1", "cus_test_1")
        delivered = client.post(
            f"{base}/webhooks/stripe",
            content=sub_payload,
            headers={"stripe-signature": _stripe_signature(sub_payload, WEBHOOK_SECRET)},
        )
        assert delivered.status_code == 200, delivered.text
        assert delivered.json() == {"received": True}

        billing_after = client.get(f"{base}/api/panel/billing").json()
        account_after = next(
            a for a in billing_after["accounts"] if a["installationId"] == 500
        )
        assert account_after["plan"] == "pro", account_after
        assert account_after["subscriptionStatus"] == "active"

        # The previously-capped second protect now succeeds on the Pro cap.
        lifted = client.post(f"{base}/api/panel/repo/1002/protect")
        assert lifted.status_code == 200, lifted.text
        assert lifted.json() == {"ok": True}

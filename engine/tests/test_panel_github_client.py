# CLASS MAP — panel.github.client + panel.github.content PURE helpers
# (no network, no App key, no DB — the network-touching methods are proven at
#  the e2e tier against the GitHubStub, so only the pure logic lives here)
#
# client.py — base-URL resolution / URL building / OAuth token-expiry:
#   Axes: api base (prod api.github.com / api-less github.com / trailing slash /
#         test stub with port+path) × oauth host derivation × token expiry
#         (no expiry / future / past / boundary) × ttl→absolute-expiry
#   C1  resolve_api_base: override wins, else api.github.com default
#   C2  resolve_oauth_base: api.github.com family → github.com (OAuth host)
#   C3  resolve_oauth_base: a stub base keeps its OWN origin, path stripped
#   C4  callback_redirect_uri: appends /api/auth/github/callback, no double slash
#   C5  build_authorize_url: authorize path + all four query params, encoded
#   C6  install_url: always github.com/apps/<slug>/installations/new
#   C7  token_not_expired: no recorded expiry → usable (non-expiring App)
#   C8  token_not_expired: future expiry usable, past/boundary expiry NOT usable
#   C9  _expires_at_from_ttl: seconds→absolute ISO; 0/None/garbage → None
#
# content.py — contents-vs-blob size branch + SSRF raw-host boundary:
#   C10 is_inline_base64: inline base64 entry → True (decode directly)
#   C11 is_inline_base64: encoding "none" / empty content → False (blob fallback)
#   C12 decode_base64_content: base64 (incl. GitHub 60-col wrapping) → UTF-8
#   C13 validate_raw_url: https + raw.githubusercontent.com passes
#   C14 validate_raw_url: wrong host / non-https / missing URL → ValueError
#
# Adversarial pass — "which dimension is missing?": the oauth-host axis was
#   split so a naive "return api_base" (C2 would pass, C3 would fail) and a
#   naive "always github.com" (C3 would pass, C2/stub path-strip would fail)
#   are both caught; the expiry axis carries the exact boundary (== now) so a
#   `>=` vs `>` slip in token_not_expired is observable.
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest

from npmguard.panel.github import client as gc
from npmguard.panel.github import content as ct


def _settings(github_api_base=None):
    return SimpleNamespace(github_api_base=github_api_base)


# --- client: base URLs -------------------------------------------------------


def test_c1_resolve_api_base():
    assert gc.resolve_api_base(_settings()) == "https://api.github.com"
    assert gc.resolve_api_base(_settings("http://127.0.0.1:9001")) == "http://127.0.0.1:9001"


@pytest.mark.parametrize(
    "api_base",
    [
        "https://api.github.com",
        "https://api.github.com/",
        "https://github.com",
        "https://github.com/",
    ],
)
def test_c2_oauth_base_github_family(api_base):
    assert gc.resolve_oauth_base(api_base) == "https://github.com"


def test_c3_oauth_base_stub_keeps_origin():
    # A test stub: OAuth endpoints must hit the SAME host, path stripped to root.
    assert gc.resolve_oauth_base("http://127.0.0.1:9001") == "http://127.0.0.1:9001"
    assert gc.resolve_oauth_base("http://127.0.0.1:9001/api/v3") == "http://127.0.0.1:9001"


def test_c4_callback_redirect_uri():
    assert (
        gc.callback_redirect_uri("http://localhost:3000")
        == "http://localhost:3000/api/auth/github/callback"
    )
    # A trailing slash on the panel base must not double up.
    assert (
        gc.callback_redirect_uri("https://npmguard.com/")
        == "https://npmguard.com/api/auth/github/callback"
    )


def test_c5_build_authorize_url():
    url = gc.build_authorize_url(
        "https://github.com",
        client_id="Iv1.abc",
        redirect_uri="http://localhost:3000/api/auth/github/callback",
        state="s-123",
    )
    parsed = urlparse(url)
    assert parsed.scheme == "https"
    assert parsed.netloc == "github.com"
    assert parsed.path == "/login/oauth/authorize"
    q = parse_qs(parsed.query)
    assert q["client_id"] == ["Iv1.abc"]
    assert q["redirect_uri"] == ["http://localhost:3000/api/auth/github/callback"]
    assert q["scope"] == ["read:user user:email"]
    assert q["state"] == ["s-123"]


def test_c6_install_url():
    assert gc.install_url("npmguard") == "https://github.com/apps/npmguard/installations/new"


# --- client: OAuth token expiry ---------------------------------------------


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def test_c7_token_not_expired_no_expiry():
    # A token with no recorded expiry never expires (non-expiring App).
    assert gc.token_not_expired(None, gc._fmt_iso(datetime.now(UTC))) is True
    assert gc.token_not_expired("", gc._fmt_iso(datetime.now(UTC))) is True


def test_c8_token_not_expired_future_vs_past_and_boundary():
    now = datetime.now(UTC)
    assert gc.token_not_expired(_iso(now + timedelta(hours=1)), _iso(now)) is True
    assert gc.token_not_expired(_iso(now - timedelta(hours=1)), _iso(now)) is False
    # Boundary: expiry exactly == now is NOT usable (strict > in the rule).
    assert gc.token_not_expired(_iso(now), _iso(now)) is False


def test_c9_expires_at_from_ttl():
    now = datetime(2026, 7, 24, 12, 0, 0, tzinfo=UTC)
    assert gc._expires_at_from_ttl(now, 28800) == "2026-07-24T20:00:00.000Z"
    assert gc._expires_at_from_ttl(now, 0) is None
    assert gc._expires_at_from_ttl(now, None) is None
    assert gc._expires_at_from_ttl(now, "not-a-number") is None
    assert gc._expires_at_from_ttl(now, -5) is None


# --- content: contents-vs-blob size branch ----------------------------------


def test_c10_is_inline_base64_true():
    entry = {"type": "file", "content": "eyJ4IjoxfQ==", "encoding": "base64"}
    assert ct.is_inline_base64(entry) is True


def test_c11_is_inline_base64_false_for_large_files():
    # Files >1MB come back with encoding "none" and empty content → blob path.
    assert ct.is_inline_base64({"content": "", "encoding": "none"}) is False
    assert ct.is_inline_base64({"content": None, "encoding": "base64"}) is False
    assert ct.is_inline_base64({"encoding": "base64"}) is False


def test_c12_decode_base64_content_roundtrip():
    import base64 as b64

    text = '{"name":"acme","version":"1.2.3"}\n'
    raw = b64.b64encode(text.encode()).decode()
    # GitHub wraps base64 at 60 columns — the decoder must tolerate whitespace.
    wrapped = raw[:8] + "\n" + raw[8:]
    assert ct.decode_base64_content(raw) == text
    assert ct.decode_base64_content(wrapped) == text


def test_c13_validate_raw_url_ok():
    url = ct.validate_raw_url(
        "https://raw.githubusercontent.com/o/r/main/package-lock.json",
        "package-lock.json",
    )
    assert url.host == "raw.githubusercontent.com"


@pytest.mark.parametrize(
    "bad",
    [
        None,
        "http://raw.githubusercontent.com/o/r/main/x",  # not https
        "https://evil.example.com/o/r/main/x",  # wrong host
        "https://api.github.com/repos/o/r/contents/x",  # api host, not raw
    ],
)
def test_c14_validate_raw_url_rejects(bad):
    with pytest.raises(ValueError):
        ct.validate_raw_url(bad, "package-lock.json")

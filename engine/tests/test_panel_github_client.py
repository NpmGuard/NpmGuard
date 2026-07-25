# CLASS MAP — panel.github.content: the two places a wrong answer is SILENT.
#
# The URL builders and the OAuth token-expiry arithmetic are deliberately NOT here:
# the e2e tier drives login → authorize → callback through the real routes
# against GitHubStub (tests/e2e/test_panel_auth.py S-panel-1), so a broken api
# base, oauth host, redirect uri or authorize URL fails there — loudly, and on the
# path a user actually takes. Restating them as string equality proved nothing the
# flow does not.
#
# What is kept is the pair whose failure mode is a quiet WRONG ANSWER rather than
# an error:
#   C1  is_inline_base64 / decode_base64_content — GitHub returns file content
#       inline as base64 only up to 1 MB; past that the entry carries
#       encoding "none" and empty content and the blob endpoint is the only route
#       to the bytes. Reading the empty inline content as the file means a large
#       lockfile parses as "no dependencies", which stops dependency alerts with
#       no error anywhere. The decoder must also tolerate GitHub's 60-column
#       wrapping. (The size branch is exercised end to end too — the stub
#       reproduces the >1 MB shape — but the branch is cheap to pin here.)
#   C2  validate_raw_url — the SSRF guard. Nothing at any other tier tries to make
#       the engine fetch an attacker's host, so this is the only proof the
#       rejection arm exists at all.
import base64

import pytest

from npmguard.panel.github import content as ct


def test_c1_inline_content_is_used_only_when_github_actually_sent_it():
    assert ct.is_inline_base64({"type": "file", "content": "eyJ4IjoxfQ==", "encoding": "base64"})
    # >1 MB: content omitted, encoding "none" — the blob fallback, not an empty file.
    assert not ct.is_inline_base64({"content": "", "encoding": "none"})
    assert not ct.is_inline_base64({"content": None, "encoding": "base64"})
    assert not ct.is_inline_base64({"encoding": "base64"})


def test_c1_decoder_tolerates_githubs_column_wrapping():
    text = '{"name":"acme","version":"1.2.3"}\n'
    raw = base64.b64encode(text.encode()).decode()
    assert ct.decode_base64_content(raw) == text
    assert ct.decode_base64_content(raw[:8] + "\n" + raw[8:]) == text


def test_c2_validate_raw_url_accepts_the_raw_host_over_https():
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
def test_c2_validate_raw_url_rejects_everything_else(bad):
    with pytest.raises(ValueError):
        ct.validate_raw_url(bad, "package-lock.json")

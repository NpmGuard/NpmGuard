# CLASS MAP — the replay support layer (tests/support/llm_replay.py)
# Axes: kit-symbol contract × index matching × cursor discipline × prompt drift
#   C1 kit private symbols the reuse map pins exist + are importable (fail at
#      collection, not mid-replay, when kit is re-vendored)
#   C2 ReplayIndex match: exact key hit, cursor advance, per-key ordered list
#   C3 ReplayIndex miss: unknown key → unmatched (fail-loud, no FIFO fallback);
#      cursor exhaustion → unmatched unless repeat
#   C4 assert_consumed: required-but-unconsumed and any-unmatched both raise
#   C5 prompt drift: current hash != pin → FixturePromptDrift (never a skip)
#   C6 committed bundles load clean (sha/messages/prompt pins) + fixture_lint green
# Adversarial pass: W2 — "could a near-miss silently consume the wrong entry?"
#   No: a wrong key raises ReplayUnmatched and is spooled, never served.

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.support.llm_replay import (
    Exchange,
    FixturePromptDrift,
    IndexedReplayProvider,
    ReplayIndex,
    ReplayUnmatched,
    check_prompt_drift,
    load_bundle,
    scan_secrets,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "llm"
BUNDLES = ["chalk@5.6.2", "is-number@7.0.0", "test-pkg-env-exfil@2.0.1", "test-pkg-dns-exfil@0.2.1"]


# ── C1: kit import contract ────────────────────────────────────────────────
def test_kit_reused_symbols_are_importable() -> None:
    """C1: the underscore-private kit symbols the reuse map depends on still exist.
    A kit re-vendor that renames one fails HERE, at collection, not mid-replay."""
    from kit_llm.bench import golden, replay

    assert callable(golden.canonical_sha256)
    for name in ("_BEARER", "_KEY_ASSIGNMENT", "_KNOWN_TOKEN", "_ROOT_DOTENV"):
        assert hasattr(golden, name), f"kit_llm.bench.golden.{name} vanished"
    for name in ("_match_subset", "_provider_result", "_neutral_wire_body", "_strict_object"):
        assert hasattr(replay, name), f"kit_llm.bench.replay.{name} vanished"
    assert hasattr(replay, "ProviderExchange")


# ── C2/C3: ReplayIndex matching + cursor ───────────────────────────────────
def _exchange(id_: str, sha: str, body: dict, *, required=True, repeat=False, status="ok") -> Exchange:
    from kit_llm.bench.golden import canonical_sha256

    messages = body["messages"]
    return Exchange(
        id=id_,
        role="judge",
        kind="completion",
        required=required,
        repeat=repeat,
        synthesized=False,
        attempt_status=status,
        key_model="m",
        key_messages_sha256=canonical_sha256(messages),
        request_body=body,
        response_status=200,
        response_body={"choices": [{"index": 0, "message": {"role": "assistant", "content": "{}"}}]},
        payload={},
    )


def _body(text: str) -> dict:
    return {"model": "m", "messages": [{"role": "user", "content": text}]}


def test_index_matches_by_content_and_advances_cursor() -> None:
    """C2: identical (model, messages) under one key are served in order, then exhausted."""
    body = _body("hello")
    first = _exchange("a", "", body)
    second = _exchange("b", "", body)
    index = ReplayIndex([first, second])
    assert index.match("m", body["messages"]).id == "a"
    assert index.match("m", body["messages"]).id == "b"
    with pytest.raises(ReplayUnmatched, match="cursor exhausted"):
        index.match("m", body["messages"])


def test_index_repeat_serves_last_forever() -> None:
    """C2: a repeat entry keeps serving past the cursor (multi-audit idempotency)."""
    body = _body("again")
    index = ReplayIndex([_exchange("a", "", body, repeat=True)])
    assert index.match("m", body["messages"]).id == "a"
    assert index.match("m", body["messages"]).id == "a"


def test_unknown_key_is_unmatched_not_a_fallback() -> None:
    """C3: a near-miss surfaces as UNMATCHED and is spooled — never silently served."""
    index = ReplayIndex([_exchange("a", "", _body("known"))])
    with pytest.raises(ReplayUnmatched):
        index.match("m", _body("different")["messages"])
    assert len(index.unmatched) == 1
    with pytest.raises(ReplayUnmatched):
        index.match("other-model", _body("known")["messages"])


# ── C4: assert_consumed ────────────────────────────────────────────────────
def test_assert_consumed_flags_unconsumed_required() -> None:
    """C4: a required exchange that was never served fails assert_consumed."""
    index = ReplayIndex([_exchange("a", "", _body("x"), required=True)])
    with pytest.raises(Exception, match="required exchanges never consumed"):
        index.assert_consumed()


def test_assert_consumed_flags_unmatched() -> None:
    """C4: any unmatched request fails assert_consumed even if required ones served."""
    body = _body("y")
    index = ReplayIndex([_exchange("a", "", body, required=True)])
    index.match("m", body["messages"])
    with pytest.raises(ReplayUnmatched):
        index.match("m", _body("stray")["messages"])
    with pytest.raises(Exception, match="unmatched"):
        index.assert_consumed()


async def test_provider_streaming_is_unsupported() -> None:
    """C3: the in-process provider replays completions only; streaming raises loud."""
    provider = IndexedReplayProvider([])
    with pytest.raises(ReplayUnmatched, match="streaming"):
        await provider.stream(None, lambda _t: None)  # type: ignore[arg-type]


# ── C5: prompt drift ───────────────────────────────────────────────────────
def test_prompt_drift_raises_on_hash_mismatch() -> None:
    """C5: a pin that disagrees with the current prompt on disk raises (never skips)."""
    with pytest.raises(FixturePromptDrift, match="judge"):
        check_prompt_drift({"judge": {"version": 1, "hash": "deadbeefcafe"}})


def test_prompt_pins_match_current_prompts() -> None:
    """C5: the committed bundles pin the CURRENT prompt hashes — replay is valid."""
    for bundle_dir in BUNDLES:
        check_prompt_drift(json.loads((FIXTURES / bundle_dir / "manifest.json").read_text())["prompts"])


# ── C6: committed bundles + lint ───────────────────────────────────────────
@pytest.mark.parametrize("bundle_dir", BUNDLES)
def test_committed_bundle_loads_clean(bundle_dir: str) -> None:
    """C6: every committed bundle strict-loads (sha256, messages sha, prompt pins)."""
    bundle = load_bundle(FIXTURES / bundle_dir)
    assert bundle.expected_verdict in {"SAFE", "DANGEROUS"}
    assert bundle.exchanges
    for hyp_id in {h["hypId"] for h in bundle.hypotheses}:
        assert hyp_id in bundle.sandbox


def test_fixture_lint_passes_on_committed_tree() -> None:
    """C6: the full acceptance checklist is green on the committed fixtures tree."""
    from tools.fixture_lint import lint_all

    warnings = lint_all(FIXTURES)
    # size warnings are allowed (full-oracle DANGEROUS artifacts); nothing else
    assert all("MB" in warning or "contract" in warning for warning in warnings), warnings


def test_scan_secrets_flags_a_planted_token() -> None:
    """Sanity: the secret scanner actually fires on a known-token pattern."""
    hits = scan_secrets({"content": "authorization: Bearer sk-or-v1-abcdefabcdef0123456789"})
    assert any(hit.pattern in {"bearer", "known_token"} for hit in hits)

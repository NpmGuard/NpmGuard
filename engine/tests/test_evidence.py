import math

import pytest

from npmguard.evidence import (
    canonicalize,
    content_hash_of,
    merkle_root,
    parse_l4_trace,
    sha256_hex,
)


def test_canonical_json_is_recursive_and_order_independent() -> None:
    left = {"outer": {"z": 1, "a": 2}, "alpha": [3, 1, 2]}
    right = {"alpha": [3, 1, 2], "outer": {"a": 2, "z": 1}}
    assert canonicalize(left) == '{"alpha":[3,1,2],"outer":{"a":2,"z":1}}'
    assert canonicalize(left) == canonicalize(right)
    assert content_hash_of(left) == content_hash_of(right)


def test_canonical_numbers_match_ecmascript_json_stringify() -> None:
    assert canonicalize(1e-7) == "1e-7"
    assert canonicalize(1e-6) == "0.000001"
    assert canonicalize(1e20) == "100000000000000000000"


@pytest.mark.parametrize("number", [math.nan, math.inf, -math.inf])
def test_canonical_json_rejects_non_finite_numbers(number: float) -> None:
    with pytest.raises(ValueError, match="non-finite"):
        canonicalize(number)


def test_merkle_root_duplicates_an_odd_leaf() -> None:
    leaves = [sha256_hex("a"), sha256_hex("b"), sha256_hex("c")]
    expected = sha256_hex(sha256_hex(leaves[0] + leaves[1]) + sha256_hex(leaves[2] + leaves[2]))
    assert merkle_root(leaves) == expected


def test_l4_parser_uses_last_complete_trace_and_normalizes_events() -> None:
    stdout = (
        "noise __NPMGUARD_TRACE__broken__NPMGUARD_TRACE_END__ more "
        '__NPMGUARD_TRACE__[{"type":"env","key":"NPM_TOKEN"},'
        '{"type":"network","method":"POST","url":"https://evil.test/x"}]'
        "__NPMGUARD_TRACE_END__ tail"
    )
    events = parse_l4_trace(stdout)
    assert events is not None
    assert [event.kind for event in events] == ["env_access", "network"]
    assert events[1].normalized["url"] == "https://evil.test/x"

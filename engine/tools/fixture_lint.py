"""Acceptance checklist for committed replay bundles (§fixture-format 7).

Runnable in CI and callable from a unit test (`lint_bundle`, `lint_all`). Static
checks only — the dry-replay acceptance ([10]) lives in the slice tests. Fails
loud with a per-check reason; a hand-edited fixture cannot pass.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from npmguard.contract.models import Hypothesis
from npmguard.evidence import render_timeline
from npmguard.hypothesis_agent import HypothesisProposal
from npmguard.phases import FileFlagResponse, JudgeVerdict, PackageIntent
from tests.support.llm_replay import (
    load_bundle,
    scan_secrets,
    unallowed_secret_hits,
)

BUNDLE_SOFT_CAP = 1_500_000
TOTAL_WARN = 4_000_000
TOTAL_HARD = 8_000_000

_FALLBACK_SLUGS = frozenset(
    {
        "nvidia/nemotron-3-super-120b-a12b:free",
        "minimax/minimax-m3",
        "cohere/north-mini-code:free",
    }
)
# Roles whose recorded completions must parse under a FIXED Pydantic contract.
_STRICT_MODELS = {
    "intent": PackageIntent,
    "flag": FileFlagResponse,
    "judge": JudgeVerdict,
    "propose": HypothesisProposal,
}


class LintFailure(Exception):
    pass


def _dir_size(path: Path) -> int:
    return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())


def _content(exchange) -> str | None:
    choices = exchange.response_body.get("choices") or []
    if not choices:
        return None
    return choices[0].get("message", {}).get("content")


def lint_bundle(
    path: str | Path,
    allowlist: list[dict[str, str]],
    bans: dict[str, object],
) -> list[str]:
    """Return the list of WARNINGS (empty = fully clean); raise LintFailure on any
    hard-check violation."""
    path = Path(path)
    warnings: list[str] = []
    bundle = load_bundle(path)  # [5] sha256/messages-sha + [6] prompt pins

    # [1] provenance complete
    provenance = bundle.manifest.get("provenance", {})
    for field in ("source", "auditIds", "query"):
        if not provenance.get(field):
            raise LintFailure(f"{path.name}: provenance missing {field}")

    # [2] verdict present + not banned
    if bundle.expected_verdict not in {"SAFE", "DANGEROUS"}:
        raise LintFailure(f"{path.name}: bad expectedVerdict {bundle.expected_verdict!r}")
    banned = {k for k in bans if k != "note"}
    if bundle.package in banned or any(
        bundle.package.startswith(b[:-1]) for b in banned if b.endswith("*")
    ):
        raise LintFailure(f"{path.name}: package {bundle.package} is on the ban list")

    # [3] bench-dd absolute ban
    if bundle.package.startswith("test-pkg-bench-dd-"):
        raise LintFailure(f"{path.name}: bench-dd package")
    for file in path.rglob("*.json"):
        if "bench-dd" in file.read_text(encoding="utf-8", errors="ignore"):
            raise LintFailure(f"{path.name}: bench-dd substring in {file.name}")

    # [4] secret scan modulo allowlist
    hits = scan_secrets(bundle.manifest)
    for exchange in bundle.exchanges:
        hits.extend(scan_secrets(exchange.payload))
    unallowed = unallowed_secret_hits(hits, allowlist)
    if unallowed:
        raise LintFailure(
            f"{path.name}: {len(unallowed)} unallowed secret hit(s): "
            + ", ".join(f"{h.pattern}@{h.path}" for h in unallowed[:5])
        )

    # [7] strict-role parse both directions; [9] no cache/cost/real-id
    for exchange in bundle.exchanges:
        for message in exchange.request_body["messages"]:
            if "cache" in message:
                raise LintFailure(f"{path.name}: {exchange.id} has a cache key in messages")
        usage = exchange.response_body.get("usage") or {}
        if "cost" in usage:
            raise LintFailure(f"{path.name}: {exchange.id} response usage.cost not stripped")
        call_id = exchange.response_body.get("id", "")
        if call_id and not str(call_id).startswith("fixture-"):
            raise LintFailure(f"{path.name}: {exchange.id} real provider_call_id not sanitized")
        model_cls = _STRICT_MODELS.get(exchange.role)
        if model_cls is None:
            continue
        content = _content(exchange)
        if content is None:
            continue
        parsed_ok = True
        try:
            model_cls.model_validate(json.loads(content))
        except (ValidationError, ValueError, TypeError):
            parsed_ok = False
        if exchange.attempt_status == "ok" and not parsed_ok:
            raise LintFailure(
                f"{path.name}: {exchange.id} (ok, role {exchange.role}) does not parse "
                f"under current {model_cls.__name__} contract"
            )
        # invalid_output that still parses clean is a SEMANTIC reject (the app-level
        # validate callback — e.g. judge citing an unknown event id — not a schema
        # miss), which is legitimate repair-path gold. Only a schema-parse failure
        # is asserted for the schema-decided roles.
        if (
            exchange.attempt_status == "invalid_output"
            and parsed_ok
            and exchange.role in {"flag", "intent", "propose"}
        ):
            warnings.append(
                f"{path.name}: {exchange.id} (invalid_output, {exchange.role}) parses clean "
                "under the current contract — recorded reject was semantic, not schema"
            )

    # [8] judge citations ⊆ rendered timeline; every hyp id has an artifact
    hyp_ids = {h["hypId"] for h in bundle.hypotheses}
    for hyp_id in hyp_ids:
        if hyp_id not in bundle.sandbox:
            raise LintFailure(f"{path.name}: hypothesis {hyp_id} has no sandbox artifact")
    for hyp_id, artifact in bundle.sandbox.items():
        expected = bundle.sandbox_expected.get(hyp_id, {})
        if expected.get("confirmed") and expected.get("citedEvents"):
            timeline = render_timeline(artifact)
            unknown = set(expected["citedEvents"]) - timeline.ids
            if unknown:
                raise LintFailure(
                    f"{path.name}: {hyp_id} cites events not in rendered timeline: {sorted(unknown)}"
                )
    # rebuild-ability of the graph input
    for hypothesis in bundle.hypotheses:
        Hypothesis.model_validate(hypothesis)

    # [11] model slugs ∈ manifest.models ∪ fallbacks
    allowed_models = set(bundle.models.values()) | _FALLBACK_SLUGS
    for exchange in bundle.exchanges:
        if exchange.key_model not in allowed_models:
            raise LintFailure(f"{path.name}: {exchange.id} model {exchange.key_model} not allowed")

    # [9] size (per-bundle 1.5MB is a soft warn — full-oracle DANGEROUS artifacts
    # inherently exceed it; the enforced ceiling is the 8MB fixtures-tree total)
    size = _dir_size(path)
    if size > BUNDLE_SOFT_CAP:
        warnings.append(f"{path.name}: {size / 1e6:.1f}MB exceeds 1.5MB soft cap")
    return warnings


def lint_all(fixtures_llm_root: str | Path) -> list[str]:
    root = Path(fixtures_llm_root)
    allowlist = json.loads((root / "ALLOWLIST.json").read_text()).get("entries", [])
    bans = json.loads((root / "PINNED.json").read_text()).get("$bans", {})
    warnings: list[str] = []
    bundle_dirs = sorted(
        p for p in root.iterdir() if p.is_dir() and (p / "manifest.json").exists()
    )
    if not bundle_dirs:
        raise LintFailure(f"no bundles under {root}")
    for bundle_dir in bundle_dirs:
        warnings.extend(lint_bundle(bundle_dir, allowlist, bans))

    total = _dir_size(root)
    if total > TOTAL_HARD:
        raise LintFailure(f"fixtures tree {total / 1e6:.1f}MB exceeds 8MB hard cap")
    if total > TOTAL_WARN:
        warnings.append(f"fixtures tree {total / 1e6:.1f}MB exceeds 4MB warn threshold")
    return warnings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lint committed replay bundles")
    parser.add_argument(
        "target",
        nargs="?",
        default="tests/fixtures/llm",
        help="a single bundle dir or the tests/fixtures/llm root",
    )
    args = parser.parse_args(argv)
    target = Path(args.target)
    try:
        if (target / "manifest.json").exists():
            root = target.parent
            allowlist = json.loads((root / "ALLOWLIST.json").read_text()).get("entries", [])
            bans = json.loads((root / "PINNED.json").read_text()).get("$bans", {})
            warnings = lint_bundle(target, allowlist, bans)
        else:
            warnings = lint_all(target)
    except LintFailure as exc:
        print(f"LINT FAIL: {exc}", file=sys.stderr)
        return 1
    for warning in warnings:
        print(f"warn: {warning}")
    print("LINT OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

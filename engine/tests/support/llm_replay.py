"""In-process replay support for committed LLM/sandbox fixtures.

Two consumers share this module: the in-process ``IndexedReplayProvider`` (a
``ProviderPort`` used by slice tests via ``build_npmguard_llm(provider=...)``)
and ``tools/fixture_lint.py`` (which reuses ``load_bundle`` + ``scan_secrets``).
The HTTP mock server (harness-owned) is expected to reuse ``ReplayIndex`` too.

Kit machinery is reused VERBATIM and pinned by ``tests/test_replay_support.py``
so a future kit re-vendor fails at collection, not mid-replay:
``canonical_sha256`` (hashing), the secret regexes, ``_match_subset``/``_strict_object``,
``_provider_result``/``ProviderExchange`` (exchange → ``ProviderResult``), and
``_neutral_wire_body`` (the adapter-equivalent wire body the matcher checks).
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kit_llm.bench.golden import (
    _BEARER,
    _KEY_ASSIGNMENT,
    _KNOWN_TOKEN,
    _ROOT_DOTENV,
    canonical_sha256,
)
from kit_llm.bench.replay import (
    ProviderExchange,
    _match_subset,
    _neutral_wire_body,
    _provider_result,
)
from kit_llm.prompts import load_prompt
from kit_llm.provider import ProviderPort, ProviderRequest, ProviderResult
from npmguard.config import REPO_ROOT, Settings
from npmguard.contract.models import RunArtifact
from npmguard.evidence import RenderedTimeline, render_timeline
from npmguard.orchestrator import ExperimentResult, judge_evidence

# Exactly the keys the OpenAICompatAdapter derives from config that capture does
# NOT record (§fixture-format 1.2). Recorded request envelopes carry only
# model+messages(+tools); these ride as tolerated extras so the matcher pins the
# recorded shape without a fork.
NPMGUARD_ALLOWED_EXTRAS = frozenset(
    {
        "$.model",
        "$.messages",
        "$.usage",
        "$.response_format.json_schema.name",
        "$.temperature",
        "$.max_tokens",
        "$.response_format",
        "$.reasoning",
        "$.tool_choice",
        "$.stream",
    }
)

# Where an allowlisted secret hit must appear verbatim to be waved through
# without an ALLOWLIST.json entry (committed source the corpus legitimately
# embeds: the canary-exfiltrating fixtures and the prompts that quote them).
_ALLOWLIST_SOURCE_DIRS = (
    REPO_ROOT / "sandbox" / "test-fixtures",
    REPO_ROOT / "engine" / "prompts",
)
_SECRET_PATTERNS = (
    ("bearer", _BEARER),
    ("root_dotenv", _ROOT_DOTENV),
    ("key_assignment", _KEY_ASSIGNMENT),
    ("known_token", _KNOWN_TOKEN),
)


class FixtureError(ValueError):
    """A committed bundle is malformed, drifted, or fails an integrity check."""


class FixturePromptDrift(FixtureError):
    """A pinned prompt hash no longer matches the current prompt on disk."""


class ReplayUnmatched(FixtureError):
    """A replay request matched no loaded exchange (fail-loud, never fall back)."""


@dataclass(frozen=True)
class SecretHit:
    pattern: str
    substring: str
    path: str


@dataclass(frozen=True)
class Exchange:
    """One recorded (request, response) pair plus its manifest metadata."""

    id: str
    role: str
    kind: str  # "completion" | "http_error" | "delay"
    required: bool
    repeat: bool
    synthesized: bool
    attempt_status: str
    key_model: str
    key_messages_sha256: str
    request_body: dict[str, Any]
    response_status: int
    response_body: dict[str, Any]
    payload: dict[str, Any]

    @property
    def key(self) -> tuple[str, str]:
        return (self.key_model, self.key_messages_sha256)


@dataclass(frozen=True)
class Bundle:
    package: str
    package_version: str
    expected_verdict: str
    models: dict[str, str]
    exchanges: list[Exchange]
    sandbox: dict[str, RunArtifact]
    sandbox_timeline: dict[str, str]
    sandbox_expected: dict[str, dict[str, Any]]
    hypotheses: list[dict[str, Any]]
    manifest: dict[str, Any]
    path: Path

    def exchanges_for_roles(self, roles: set[str]) -> list[Exchange]:
        return [exchange for exchange in self.exchanges if exchange.role in roles]


def _read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def scan_secrets(value: Any, path: str = "$") -> list[SecretHit]:
    """Run the kit secret regexes (not kit's hard-failing scanner) over a payload,
    returning every hit as (pattern, matched-substring, jsonpath). The exporter and
    the drift lint decide acceptability via the allowlist rule."""
    hits: list[SecretHit] = []
    if isinstance(value, dict):
        for key, child in value.items():
            hits.extend(scan_secrets(child, f"{path}.{key}"))
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            hits.extend(scan_secrets(child, f"{path}[{index}]"))
    elif isinstance(value, str):
        for name, pattern in _SECRET_PATTERNS:
            for match in pattern.finditer(value):
                hits.append(SecretHit(name, match.group(0), path))
    return hits


def _allowlist_corpus() -> str:
    parts: list[str] = []
    for root in _ALLOWLIST_SOURCE_DIRS:
        if not root.exists():
            continue
        for file in root.rglob("*"):
            if file.is_file():
                try:
                    parts.append(file.read_text(encoding="utf-8", errors="ignore"))
                except OSError:
                    continue
    return "\n".join(parts)


def unallowed_secret_hits(
    hits: list[SecretHit], allowlist: list[dict[str, str]]
) -> list[SecretHit]:
    """Filter secret hits down to the ones that are NOT justified: neither present
    verbatim in the committed canary sources nor listed in ALLOWLIST.json."""
    if not hits:
        return []
    corpus = _allowlist_corpus()
    allowed_substrings = {entry["substring"] for entry in allowlist}
    return [
        hit
        for hit in hits
        if hit.substring not in corpus and hit.substring not in allowed_substrings
    ]


def check_prompt_drift(prompts: dict[str, Any], prompts_dir: str | None = None) -> None:
    """Recompute each pinned role's hash with the current prompt on disk; raise
    FixturePromptDrift naming the role and the re-record instruction on mismatch.
    Never a skip — a silent skip would turn a prompt change into vanishing coverage."""
    directory = prompts_dir or str(REPO_ROOT / "engine" / "prompts")
    for role, pin in prompts.items():
        current = load_prompt(directory, role)
        if current.hash != pin["hash"]:
            raise FixturePromptDrift(
                f"prompts/{role}/v{pin['version']}.md changed since this bundle was "
                f"recorded (pinned {pin['hash']}, current {current.hash}). "
                "Re-record: see FIXTURES.md re-record runbook (tools/export_fixtures.py). "
                "Do not edit the fixture by hand."
            )


def load_bundle(path: str | Path, *, verify_prompts: bool = True) -> Bundle:
    """Strict-load a committed bundle: verify per-payload sha256, key/messages
    sha256, prompt pins, then return an immutable Bundle. Secret re-scan is the
    lint's job (it owns the allowlist), so the loader stays cheap for slice tests."""
    root = Path(path)
    manifest = _read_json(root / "manifest.json")
    if manifest.get("suite") != "npmguard-llm-replay":
        raise FixtureError(f"{root}: not an npmguard-llm-replay bundle")
    if verify_prompts:
        check_prompt_drift(manifest["prompts"])

    exchanges: list[Exchange] = []
    for entry in manifest["exchanges"]:
        payload = _read_json(root / entry["path"])
        actual_sha = canonical_sha256(payload)
        if actual_sha != entry["sha256"]:
            raise FixtureError(
                f"{root}: exchange {entry['id']} sha256 mismatch "
                f"(manifest {entry['sha256']}, payload {actual_sha})"
            )
        request_body = payload["request"]["body"]
        messages_sha = canonical_sha256(request_body["messages"])
        if messages_sha != entry["key"]["messagesSha256"]:
            raise FixtureError(
                f"{root}: exchange {entry['id']} messages sha256 mismatch"
            )
        response = payload.get("response", {})
        exchanges.append(
            Exchange(
                id=entry["id"],
                role=entry["role"],
                kind=entry["kind"],
                required=entry.get("required", False),
                repeat=entry.get("repeat", False),
                synthesized=entry.get("synthesized", False),
                attempt_status=entry.get("attemptStatus", "ok"),
                key_model=entry["key"]["model"],
                key_messages_sha256=entry["key"]["messagesSha256"],
                request_body=request_body,
                response_status=response.get("status", 200),
                response_body=response.get("body", {}),
                payload=payload,
            )
        )

    sandbox: dict[str, RunArtifact] = {}
    sandbox_timeline: dict[str, str] = {}
    sandbox_expected: dict[str, dict[str, Any]] = {}
    for entry in manifest.get("sandbox", []):
        artifact_payload = _read_json(root / entry["path"])
        actual_sha = canonical_sha256(artifact_payload)
        if actual_sha != entry["sha256"]:
            raise FixtureError(f"{root}: sandbox {entry['hypothesisId']} sha256 mismatch")
        sandbox[entry["hypothesisId"]] = RunArtifact.model_validate(artifact_payload)
        if entry.get("timelinePath"):
            text = (root / entry["timelinePath"]).read_text(encoding="utf-8")
            if canonical_sha256(text) != entry["timelineSha256"]:
                raise FixtureError(f"{root}: sandbox {entry['hypothesisId']} timeline sha256 mismatch")
            sandbox_timeline[entry["hypothesisId"]] = text
        sandbox_expected[entry["hypothesisId"]] = {
            "confirmed": entry.get("confirmed", False),
            "citedEvents": entry.get("citedEvents", []),
        }

    hypotheses: list[dict[str, Any]] = []
    if manifest.get("hypothesesPath"):
        hypotheses = _read_json(root / manifest["hypothesesPath"])

    return Bundle(
        package=manifest["package"],
        package_version=manifest["packageVersion"],
        expected_verdict=manifest["expectedVerdict"],
        models=manifest["models"],
        exchanges=exchanges,
        sandbox=sandbox,
        sandbox_timeline=sandbox_timeline,
        sandbox_expected=sandbox_expected,
        hypotheses=hypotheses,
        manifest=manifest,
        path=root,
    )


class ReplayIndex:
    """Content-addressed replay: key = (model, sha256(canonical(messages))),
    each key an ordered per-key cursor (§fixture-format 1). Order-free across keys
    so the concurrent flag phase replays at prod concurrency; a near-miss surfaces
    as UNMATCHED (never a silent FIFO fallback that consumes the wrong entry)."""

    def __init__(self, exchanges: list[Exchange]) -> None:
        self._by_key: dict[tuple[str, str], list[Exchange]] = {}
        self._cursor: dict[tuple[str, str], int] = {}
        self._consumed: set[str] = set()
        self._unmatched: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        for exchange in exchanges:
            self._by_key.setdefault(exchange.key, []).append(exchange)

    def match(self, model: str, messages: list[dict[str, Any]]) -> Exchange:
        key = (model, canonical_sha256(messages))
        with self._lock:
            entries = self._by_key.get(key)
            if not entries:
                self._unmatched.append({"model": model, "messagesSha256": key[1]})
                raise ReplayUnmatched(
                    f"npmguard-replay: unmatched request (model={model}, "
                    f"messagesSha256={key[1]}); loaded keys for model: "
                    f"{sum(1 for k in self._by_key if k[0] == model)}"
                )
            cursor = self._cursor.get(key, 0)
            if cursor >= len(entries):
                last = entries[-1]
                if last.repeat:
                    self._consumed.add(last.id)
                    return last
                self._unmatched.append(
                    {"model": model, "messagesSha256": key[1], "reason": "cursor exhausted"}
                )
                raise ReplayUnmatched(
                    f"npmguard-replay: cursor exhausted for key {key} "
                    f"({len(entries)} entries all served)"
                )
            exchange = entries[cursor]
            self._cursor[key] = cursor + 1
            self._consumed.add(exchange.id)
            return exchange

    @property
    def unmatched(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._unmatched)

    def assert_consumed(self) -> None:
        """Every ``required`` exchange was served and nothing went unmatched."""
        with self._lock:
            missing = sorted(
                exchange.id
                for entries in self._by_key.values()
                for exchange in entries
                if exchange.required and exchange.id not in self._consumed
            )
            if self._unmatched:
                raise FixtureError(f"replay saw {len(self._unmatched)} unmatched request(s)")
            if missing:
                raise FixtureError(f"required exchanges never consumed: {missing}")


def _exchange_to_provider(exchange: Exchange) -> ProviderExchange:
    return ProviderExchange(
        id=exchange.id,
        request_method="POST",
        request_path="/v1/chat/completions",
        request_body=exchange.request_body,
        response_status=exchange.response_status,
        response_body=exchange.response_body,
        expected={},
    )


class IndexedReplayProvider(ProviderPort):
    """A ProviderPort over a ReplayIndex. The chain walk, capture, and spend run
    for real against deterministic recorded traffic; matching is content-addressed
    with a full-body subset verify + the response_format role pin."""

    def __init__(self, exchanges: list[Exchange]) -> None:
        self.index = ReplayIndex(exchanges)

    async def complete(self, request: ProviderRequest) -> ProviderResult:
        body = _neutral_wire_body(request)
        exchange = self.index.match(request.model, body["messages"])
        _match_subset(
            body,
            exchange.request_body,
            exchange.id,
            allowed_extras=NPMGUARD_ALLOWED_EXTRAS,
        )
        response_format = body.get("response_format")
        if isinstance(response_format, dict):
            name = (response_format.get("json_schema") or {}).get("name")
            if name is not None and name != exchange.role:
                raise ReplayUnmatched(
                    f"exchange {exchange.id!r}: response_format name {name!r} "
                    f"!= recorded role {exchange.role!r}"
                )
        return _provider_result(_exchange_to_provider(exchange))

    async def stream(self, request: ProviderRequest, on_token: Any) -> ProviderResult:
        raise ReplayUnmatched("IndexedReplayProvider does not replay streaming")

    async def lookup_cost(self, provider_call_id: str) -> float | None:
        return None

    async def aclose(self) -> None:
        return None

    def assert_consumed(self) -> None:
        self.index.assert_consumed()

    @property
    def unmatched(self) -> list[dict[str, Any]]:
        return self.index.unmatched


@dataclass
class RecordedSandbox:
    """Injects recorded run artifacts keyed by hypothesis id, then runs the REAL
    judge over the rendered timeline (render_timeline stays exercised, judge logic
    stays proven on real data). Monkeypatch over ``npmguard.orchestrator.run_experiment``;
    an unknown hypothesis id raises (never a default artifact)."""

    bundle: Bundle
    seen: set[str] = field(default_factory=set)

    async def run_experiment(
        self,
        hypothesis: Any,
        package_path: Path,
        stated_purpose: str,
        settings: Settings,
        llm: Any,
        audit_id: str,
    ) -> ExperimentResult:
        artifact = self.bundle.sandbox.get(hypothesis.hypId)
        if artifact is None:
            raise ReplayUnmatched(
                f"RecordedSandbox: no recorded artifact for hypothesis {hypothesis.hypId!r}"
            )
        self.seen.add(hypothesis.hypId)
        # ids from live render_timeline (keeps the renderer exercised + proves the
        # event-id set is stable); text from the stored record-time timeline (the
        # persisted artifact is RFC-8785 canonicalized and re-rendering it would not
        # byte-reproduce the recorded judge prompt — see export_fixtures).
        rendered = render_timeline(artifact)
        recorded_text = self.bundle.sandbox_timeline.get(hypothesis.hypId)
        timeline = (
            RenderedTimeline(text=recorded_text, ids=rendered.ids)
            if recorded_text is not None
            else rendered
        )
        judgment = await judge_evidence(hypothesis, timeline, stated_purpose, llm, audit_id)
        from npmguard.contract.models import EvidenceRef

        reference = EvidenceRef(kind="run", id=artifact.runId, hash=artifact.contentHash)
        return ExperimentResult(
            judgment.confirmed,
            judgment.reason,
            judgment.cited_events,
            judgment.judge_failed,
            artifact,
            reference,
            timeline.text,
        )

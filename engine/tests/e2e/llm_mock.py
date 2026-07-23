"""OpenAI-compatible replay mock server (fixture-format §5).

Replay: content-addressed on ``(model, sha256(canonical(messages)))`` with a
per-key ordered cursor, full-body verification via kit's ``_match_subset``
(allow-list extended with the adapter-derived keys capture never records), and
a ``response_format.json_schema.name == role`` pin. Unmatched requests answer
HTTP 500 AND spool the full body — fail-loud twice.

Scripted role-fallbacks serve live-docker scenarios where the request content
is nondeterministic (timelines embed runIds/wall-clock): a content-aware judge
that cites REAL event ids parsed from the incoming timeline, an analogous
hypothesis fallback that picks a REAL trigger target from the prompt, plus
static/delay/http_error/truncated kinds. Every scripted completion is
validated against the CURRENT pydantic contract for its role at serve time.

Run standalone: ``uv run python -m tests.e2e.llm_mock --port 0 --spool DIR
[--bundle DIR]...`` (prints ``PORT=<n>``), or in-process via
``create_mock_app`` + ``tests.support.stubs.StubServer``.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from kit_llm.bench.golden import canonical_sha256
from kit_llm.bench.replay import ReplayMismatch, _match_subset, _strict_object
from kit_llm.prompts import load_prompt
from npmguard.hypothesis_agent import HypothesisProposal
from npmguard.phases import FileFlagResponse, JudgeVerdict, PackageIntent, hypothesis_submission

ENGINE_ROOT = Path(__file__).resolve().parents[2]
PROMPTS_DIR = ENGINE_ROOT / "prompts"

# Kit's allow-list ∪ the keys the adapter derives from config that capture
# does not record (fixture-format §1.2).
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

# Current pydantic contracts per role — scripted output is validated against
# these AT SERVE TIME so a drifted contract fails loud in the mock, not as a
# confusing engine-side repair loop.
_ROLE_MODELS: dict[str, Any] = {
    "intent": PackageIntent,
    "flag": FileFlagResponse,
    "judge": JudgeVerdict,
    "propose": HypothesisProposal,
    "hypothesis": hypothesis_submission([]),
}

# Zero-findings bodies proven against the real engine (harness-smoke §1).
# CAUTION: with flags:[] the flag summary must NOT match phases.CRITICAL_SUMMARY
# or the engine rejects the candidate and burns a repair retry.
SAFE_INTENT_BODY = {
    "statedPurpose": "A small utility package (mock intent).",
    "expectedCapabilities": [],
    "rationale": "Mock harness response: nothing beyond plain computation expected.",
}
SAFE_FLAG_BODY = {
    "summary": "Plain utility code; nothing outside the stated purpose.",
    "capabilities": [],
    "flags": [],
}
# One-flag body for DANGEROUS-path scenarios ("1-1" is valid for any file).
FLAGGING_FLAG_BODY = {
    "summary": "Reads environment variables and sends data over the network.",
    "capabilities": ["ENV_VARS", "NETWORK"],
    "flags": [
        {
            "lines": ["1-1"],
            "why": "Scripted flag: suspicious environment access with outbound network use.",
        }
    ],
}

_TIMELINE_ID = re.compile(r"(?m)^(e\d+)\s")
_TRIGGER_TARGETS = re.compile(r"Set triggerTarget to exactly one of: (.+?)\. If", re.S)


class FixturePromptDrift(Exception):
    """A bundle's pinned prompt hash no longer matches the local prompt file."""


class MockLoadError(Exception):
    """A bundle or scripted-role config failed verification at load time."""


def scripted_safe_roles() -> dict[str, dict[str, Any]]:
    """scripted_roles config for a zero-flag SAFE audit (intent + flag only)."""
    return {
        "intent": {"kind": "static", "body": SAFE_INTENT_BODY},
        "flag": {"kind": "static", "body": SAFE_FLAG_BODY},
    }


def _strip_cache(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {key: value for key, value in message.items() if key != "cache"} for message in messages
    ]


def _completion_envelope(model: str, content: str, finish_reason: str = "stop") -> dict[str, Any]:
    return {
        "id": f"chatcmpl-mock-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
            "prompt_tokens_details": {"cached_tokens": 0},
        },
    }


@dataclass
class Exchange:
    id: str
    role: str
    key: tuple[str, str]  # (model, messagesSha256)
    kind: str  # completion | http_error | delay
    request_body: dict[str, Any]
    response: dict[str, Any]  # {"status","body"} or {"delayMs","then"}
    required: bool = True
    repeat: bool = False
    synthesized: bool = False
    attempt_status: str = "ok"


@dataclass
class _State:
    exchanges: list[Exchange] = field(default_factory=list)
    index: dict[tuple[str, str], list[Exchange]] = field(default_factory=dict)
    cursors: dict[tuple[str, str], int] = field(default_factory=dict)
    consumed: set[str] = field(default_factory=set)
    scripted: dict[str, dict[str, Any]] = field(default_factory=dict)
    unmatched: list[dict[str, Any]] = field(default_factory=list)


def _verify_prompt_pins(pins: dict[str, Any], bundle: str) -> None:
    for role, pin in pins.items():
        version = pin.get("version")
        pinned_hash = pin.get("hash")
        try:
            current = load_prompt(str(PROMPTS_DIR), role, version)
        except FileNotFoundError as exc:
            raise FixturePromptDrift(
                f"bundle {bundle}: prompt {role}/v{version} missing locally: {exc}"
            ) from exc
        if current.hash != pinned_hash:
            raise FixturePromptDrift(
                f"bundle {bundle}: prompts/{role}/v{version}.md changed since this bundle was "
                f"recorded (pinned {pinned_hash}, current {current.hash}). Re-record: see "
                "FIXTURES.md §re-record (scripts: export_fixtures). "
                "Do not edit the fixture by hand."
            )


def _exchange_from_payload(
    payload: dict[str, Any],
    *,
    entry: dict[str, Any],
    source: str,
) -> Exchange:
    exchange_id = str(entry.get("id") or payload.get("id") or f"extra-{uuid.uuid4().hex[:8]}")
    role = str(entry.get("role") or payload.get("role") or "")
    if not role:
        raise MockLoadError(f"{source}: exchange {exchange_id} has no role")
    request = payload.get("request") or {}
    body = request.get("body")
    if not isinstance(body, dict) or "model" not in body or "messages" not in body:
        raise MockLoadError(f"{source}: exchange {exchange_id} request.body needs model+messages")
    messages_sha = canonical_sha256(_strip_cache(body["messages"]))
    declared = (entry.get("key") or {}).get("messagesSha256")
    if declared is not None and declared != messages_sha:
        raise MockLoadError(
            f"{source}: exchange {exchange_id} key.messagesSha256 does not match its messages "
            f"(declared {declared}, computed {messages_sha}) — curation bug"
        )
    kind = str(entry.get("kind") or payload.get("kind") or "completion")
    response = payload.get("response")
    if not isinstance(response, dict):
        raise MockLoadError(f"{source}: exchange {exchange_id} has no response object")
    if kind == "delay" and "delayMs" not in response:
        raise MockLoadError(f"{source}: exchange {exchange_id} kind=delay needs response.delayMs")
    if kind in ("completion", "http_error") and "status" not in response:
        raise MockLoadError(f"{source}: exchange {exchange_id} response needs status+body")
    return Exchange(
        id=exchange_id,
        role=role,
        key=(str(body["model"]), messages_sha),
        kind=kind,
        request_body=body,
        response=response,
        required=bool(entry.get("required", True)),
        repeat=bool(entry.get("repeat", False)),
        synthesized=bool(entry.get("synthesized", False)),
        attempt_status=str(entry.get("attemptStatus", "ok")),
    )


def _load_bundle_dir(path: Path) -> list[Exchange]:
    manifest_path = path / "manifest.json"
    if not manifest_path.is_file():
        raise MockLoadError(f"bundle {path}: no manifest.json")
    manifest = _strict_object(manifest_path.read_bytes())
    _verify_prompt_pins(manifest.get("prompts") or {}, str(path))
    exchanges: list[Exchange] = []
    for entry in manifest.get("exchanges") or []:
        payload_path = path / str(entry["path"])
        payload = _strict_object(payload_path.read_bytes())
        declared_sha = entry.get("sha256")
        if declared_sha is not None:
            actual_sha = canonical_sha256(payload)
            if actual_sha != declared_sha:
                raise MockLoadError(
                    f"bundle {path}: {entry['path']} sha256 mismatch "
                    f"(manifest {declared_sha}, actual {actual_sha})"
                )
        exchanges.append(_exchange_from_payload(payload, entry=entry, source=str(path)))
    return exchanges


class MockLlm:
    """Replay + scripted-fallback state machine behind the FastAPI app."""

    def __init__(self, spool_dir: Path) -> None:
        self.spool_dir = Path(spool_dir)
        self.spool_dir.mkdir(parents=True, exist_ok=True)
        self._state = _State()
        self._lock = asyncio.Lock()
        self._spool_seq = 0

    # ---- control plane -------------------------------------------------

    def load(
        self,
        *,
        bundle_dirs: list[str] | None = None,
        extras: list[dict[str, Any]] | None = None,
        scripted_roles: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Replace ALL state. Verification (sha + prompt pins) happens HERE so a
        drifted bundle fails before any scenario runs."""
        state = _State()
        for bundle in bundle_dirs or []:
            state.exchanges.extend(_load_bundle_dir(Path(bundle)))
        for raw in extras or []:
            state.exchanges.append(_exchange_from_payload(raw, entry=raw, source="extras"))
        for exchange in state.exchanges:
            state.index.setdefault(exchange.key, []).append(exchange)
        for role, config in (scripted_roles or {}).items():
            if not isinstance(config, dict) or "kind" not in config:
                raise MockLoadError(f"scripted_roles[{role!r}] must be an object with 'kind'")
            state.scripted[role] = config
        self._state = state
        return {
            "exchanges": len(state.exchanges),
            "keys": len(state.index),
            "scriptedRoles": sorted(state.scripted),
        }

    def reset(self) -> None:
        """Cursors to zero + unmatched cleared; bundles/scripted kept."""
        self._state.cursors.clear()
        self._state.consumed.clear()
        self._state.unmatched.clear()

    def status(self) -> dict[str, Any]:
        state = self._state
        remaining = [
            {
                "id": exchange.id,
                "role": exchange.role,
                "required": exchange.required,
                "key": {"model": exchange.key[0], "messagesSha256": exchange.key[1]},
            }
            for exchange in state.exchanges
            if exchange.required and exchange.id not in state.consumed
        ]
        return {
            "loaded": len(state.exchanges),
            "consumed": len(state.consumed),
            "unmatchedCount": len(state.unmatched),
            "scriptedRoles": sorted(state.scripted),
            "remaining": remaining,
        }

    def unmatched(self) -> dict[str, Any]:
        return {"count": len(self._state.unmatched), "entries": list(self._state.unmatched)}

    # ---- data plane ----------------------------------------------------

    async def serve(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        model = str(body.get("model", ""))
        messages = body.get("messages")
        if not isinstance(messages, list):
            return self._unmatched(body, model, "", "request has no messages list")
        messages_sha = canonical_sha256(_strip_cache(messages))
        key = (model, messages_sha)
        pin_role = (
            (body.get("response_format") or {}).get("json_schema", {}).get("name")
            if isinstance(body.get("response_format"), dict)
            else None
        )
        role = pin_role or ("agent" if body.get("tools") else None)

        async with self._lock:
            state = self._state
            entries = state.index.get(key)
            exchange: Exchange | None = None
            if entries:
                cursor = state.cursors.get(key, 0)
                if cursor < len(entries):
                    exchange = entries[cursor]
                    state.cursors[key] = cursor + 1
                elif entries[-1].repeat:
                    exchange = entries[-1]
                if exchange is not None:
                    try:
                        _match_subset(
                            body,
                            exchange.request_body,
                            exchange.id,
                            allowed_extras=NPMGUARD_ALLOWED_EXTRAS,
                        )
                    except ReplayMismatch as exc:
                        # same content hash but full-body divergence = curation bug
                        return self._unmatched(body, model, messages_sha, str(exc))
                    if pin_role is not None and pin_role != exchange.role:
                        return self._unmatched(
                            body,
                            model,
                            messages_sha,
                            f"role pin mismatch: json_schema.name={pin_role!r} but "
                            f"exchange {exchange.id} role={exchange.role!r}",
                        )
                    state.consumed.add(exchange.id)
            scripted = state.scripted.get(role) if exchange is None and role else None
            if exchange is None and scripted is None:
                return self._unmatched(
                    body, model, messages_sha, f"no exchange for key and no scripted role {role!r}"
                )

        if exchange is not None:
            return await self._serve_response(exchange.response)
        assert scripted is not None and role is not None
        return await self._serve_scripted(role, scripted, body)

    async def _serve_response(self, response: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        while "delayMs" in response:
            await asyncio.sleep(response["delayMs"] / 1000)
            response = response["then"]
        return int(response["status"]), response["body"]

    async def _serve_scripted(
        self, role: str, config: dict[str, Any], body: dict[str, Any]
    ) -> tuple[int, dict[str, Any]]:
        kind = config["kind"]
        model = str(body.get("model", "mock"))
        if kind == "delay":
            await asyncio.sleep(float(config.get("delay_ms", 0)) / 1000)
            return await self._serve_scripted(role, config["then"], body)
        if kind == "http_error":
            error_body = config.get(
                "body", {"error": {"message": "mock: scripted provider error", "code": 500}}
            )
            return int(config.get("status", 500)), error_body
        if kind == "truncated":
            return 200, _completion_envelope(
                model, str(config.get("content", '{"trunca')), finish_reason="length"
            )
        if kind == "static":
            content = config["body"]
        elif kind == "judge":
            content = self._judge_body(config, body)
        elif kind == "hypothesis":
            content = self._hypothesis_body(config, body)
        else:
            raise MockLoadError(f"scripted role {role!r}: unknown kind {kind!r}")
        validator = _ROLE_MODELS.get(role)
        if validator is not None:
            validator.model_validate(content)  # fail loud in the mock, not the engine
        return 200, _completion_envelope(model, json.dumps(content))

    @staticmethod
    def _user_text(body: dict[str, Any]) -> str:
        return "\n".join(
            str(message.get("content") or "")
            for message in body.get("messages", [])
            if isinstance(message, dict) and message.get("role") == "user"
        )

    def _judge_body(self, config: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        """Content-aware judge: cite REAL event ids parsed from the live timeline."""
        malicious = bool(config.get("malicious", False))
        if not malicious:
            return {
                "malicious": False,
                "reason": str(
                    config.get("reason", "Scripted judge: observed behavior stays benign.")
                ),
                "citedEvents": [],
            }
        ids = _TIMELINE_ID.findall(self._user_text(body))
        if not ids:
            raise MockLoadError(
                "scripted judge: malicious=true requested but no event ids (e1..eN) found "
                "in the incoming timeline — the run captured no events"
            )
        return {
            "malicious": True,
            "reason": str(
                config.get("reason", "Scripted judge: suspected behavior observed in timeline.")
            ),
            "citedEvents": ids[: int(config.get("max_cited", 3))],
        }

    def _hypothesis_body(self, config: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        """Content-aware hypothesis: pick a REAL trigger target from the prompt."""
        target = config.get("trigger_target")
        if target is None:
            match = _TRIGGER_TARGETS.search(self._user_text(body))
            targets = (
                [item.strip() for item in match.group(1).split(",") if item.strip()]
                if match
                else []
            )
            if not targets:
                raise MockLoadError(
                    "scripted hypothesis: no trigger targets found in the incoming prompt "
                    "and no explicit trigger_target configured"
                )
            target = targets[0]
        default_setup = {
            "environment": [],
            "files": [],
            "dateIso": None,
            "urlStubs": [],
            "filePatches": [],
            "preloadCode": None,
        }
        return {
            "description": str(
                config.get("description", f"Scripted hypothesis exercising {target}")
            ),
            "claim": {
                "kind": str(config.get("claim_kind", "env_exfil")),
                "gating": config.get("gating"),
            },
            "severity": str(config.get("severity", "high")),
            "setup": config.get("setup", default_setup),
            "triggerTarget": str(target),
        }

    def _unmatched(
        self, body: dict[str, Any], model: str, messages_sha: str, reason: str
    ) -> tuple[int, dict[str, Any]]:
        self._spool_seq += 1
        spool_path = self.spool_dir / f"unmatched-{self._spool_seq:03d}.json"
        spool_path.write_text(
            json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        nearest = self._nearest(body, model)
        self._state.unmatched.append(
            {
                "ts": datetime.now(UTC).isoformat(),
                "model": model,
                "messagesSha256": messages_sha,
                "reason": reason,
                "nearest": nearest,
                "bodyPath": str(spool_path),
            }
        )
        return 500, {
            "error": {
                "message": "npmguard-mock: unmatched request",
                "code": "unmatched",
                "model": model,
                "messagesSha256": messages_sha,
                "reason": reason,
                "nearest": nearest,
            }
        }

    def _nearest(self, body: dict[str, Any], model: str) -> dict[str, Any] | None:
        candidates = [
            exchange for exchange in self._state.exchanges if exchange.key[0] == model
        ] or self._state.exchanges
        if not candidates:
            return None
        candidate = candidates[0]
        try:
            _match_subset(
                body,
                candidate.request_body,
                candidate.id,
                allowed_extras=NPMGUARD_ALLOWED_EXTRAS,
            )
            divergence = "(full match?)"
        except ReplayMismatch as exc:
            divergence = str(exc)
        return {"id": candidate.id, "divergence": divergence[:500]}


def create_mock_app(spool_dir: Path | str, *, bundle_dirs: list[str] | None = None) -> FastAPI:
    """Build the mock server app; state is reachable as ``app.state.mock``."""
    mock = MockLlm(Path(spool_dir))
    if bundle_dirs:
        mock.load(bundle_dirs=bundle_dirs)
    app = FastAPI()
    app.state.mock = mock

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/chat/completions")
    async def chat(request: Request) -> JSONResponse:
        try:
            body = _strict_object(await request.body())
        except (UnicodeError, ValueError) as exc:
            return JSONResponse(
                {"error": {"message": f"npmguard-mock: bad JSON body: {exc}"}}, status_code=400
            )
        try:
            status, payload = await mock.serve(body)
        except Exception as exc:  # fail loud with the cause, never a silent 200
            return JSONResponse(
                {"error": {"message": f"npmguard-mock: {type(exc).__name__}: {exc}"}},
                status_code=500,
            )
        return JSONResponse(payload, status_code=status)

    @app.post("/_mock/load")
    async def mock_load(request: Request) -> JSONResponse:
        payload = await request.json()
        try:
            result = mock.load(
                bundle_dirs=payload.get("bundle_dirs") or payload.get("bundles") or [],
                extras=payload.get("extras") or [],
                scripted_roles=payload.get("scripted_roles") or {},
            )
        except (MockLoadError, FixturePromptDrift, ValueError) as exc:
            return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=400)
        return JSONResponse(result)

    @app.post("/_mock/reset")
    async def mock_reset() -> dict[str, str]:
        mock.reset()
        return {"status": "reset"}

    @app.get("/_mock/status")
    async def mock_status() -> JSONResponse:
        return JSONResponse(mock.status())

    @app.get("/_mock/unmatched")
    async def mock_unmatched() -> JSONResponse:
        return JSONResponse(mock.unmatched())

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    async def catchall(path: str, request: Request) -> JSONResponse:
        mock._state.unmatched.append(
            {
                "ts": datetime.now(UTC).isoformat(),
                "model": "",
                "messagesSha256": "",
                "reason": f"unmatched path: {request.method} /{path}",
                "nearest": None,
                "bodyPath": "",
            }
        )
        return JSONResponse(
            {"error": {"message": f"npmguard-mock: no route /{path}"}}, status_code=404
        )

    return app


class MockLlmClient:
    """Small sync client for the mock's control plane (usable from async tests)."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.teardown_checks = True  # conftest teardown honors this escape hatch

    @property
    def v1_url(self) -> str:
        """Value for NPMGUARD_LLM_BASE_URL."""
        return f"{self.base_url}/v1"

    def load(
        self,
        *,
        bundle_dirs: list[str] | None = None,
        extras: list[dict[str, Any]] | None = None,
        scripted_roles: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        response = httpx.post(
            f"{self.base_url}/_mock/load",
            json={
                "bundle_dirs": [str(item) for item in bundle_dirs or []],
                "extras": extras or [],
                "scripted_roles": scripted_roles or {},
            },
            timeout=30,
        )
        if response.status_code != 200:
            raise MockLoadError(f"/_mock/load failed: {response.status_code} {response.text}")
        return response.json()

    def reset(self) -> None:
        httpx.post(f"{self.base_url}/_mock/reset", timeout=10).raise_for_status()

    def status(self) -> dict[str, Any]:
        response = httpx.get(f"{self.base_url}/_mock/status", timeout=10)
        response.raise_for_status()
        return response.json()

    def unmatched(self) -> dict[str, Any]:
        response = httpx.get(f"{self.base_url}/_mock/unmatched", timeout=10)
        response.raise_for_status()
        return response.json()

    def assert_clean(self) -> None:
        """Zero unmatched requests AND every required exchange consumed."""
        report = self.unmatched()
        assert report["count"] == 0, f"mock LLM saw unmatched requests: {report['entries']}"
        status = self.status()
        assert not status["remaining"], (
            f"required mock exchanges never consumed: {status['remaining']}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="npmguard replay mock LLM server")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--spool", required=True, help="directory for unmatched-request bodies")
    parser.add_argument("--bundle", action="append", default=[], help="bundle dir (repeatable)")
    args = parser.parse_args()
    import socket

    import uvicorn

    port = args.port
    if port == 0:
        with contextlib.closing(socket.socket()) as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
    app = create_mock_app(args.spool, bundle_dirs=args.bundle)
    print(f"PORT={port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()

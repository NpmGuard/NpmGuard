"""Probe Bedrock models against the exact request shapes NpmGuard sends.

The corpus supplies real prompts for all six LLM roles. Structured roles use
their current portable strict schemas; the agent role uses its recorded tool
catalog and requires a schema-valid function call. Results contain metrics and
errors only, never prompts, model output, or credentials.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from kit_llm import BedrockAdapter, LlmSettings, ProviderRequest, portable_strict_schema
from npmguard.hypothesis_agent import HypothesisProposal
from npmguard.phases import (
    FileFlagResponse,
    JudgeVerdict,
    PackageIntent,
    hypothesis_submission,
)

MODELS = (
    "zai.glm-5",
    "deepseek.v3.2",
    "moonshotai.kimi-k2.5",
    "xai.grok-4.3",
)
ROLES = ("intent", "flag", "hypothesis", "propose", "agent", "judge")
FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "llm"
ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
OUTPUTS: dict[str, type[BaseModel]] = {
    "intent": PackageIntent,
    "flag": FileFlagResponse,
    "hypothesis": hypothesis_submission(
        ["package.json#preinstall", "index.js", "setup.js", "/pkg/npmguard-driver.js"]
    ),
    "propose": HypothesisProposal,
    "judge": JudgeVerdict,
}
MAX_OUTPUT_TOKENS = {
    "intent": 1_500,
    "flag": 2_500,
    "hypothesis": 8_000,
    "propose": 2_000,
    "agent": 3_000,
    "judge": 1_500,
}


def _fixtures(root: Path) -> dict[str, list[dict[str, Any]]]:
    by_role: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for path in sorted(root.glob("*/exchanges/*.json")):
        exchange = json.loads(path.read_text(encoding="utf-8"))
        role = exchange.get("role")
        body = exchange.get("request", {}).get("body", {})
        if role in ROLES and isinstance(body.get("messages"), list):
            by_role[role].append(body)
    missing = [role for role in ROLES if not by_role[role]]
    if missing:
        raise RuntimeError(f"recorded corpus has no requests for roles: {missing}")
    return by_role


def _request(model: str, role: str, fixture: dict[str, Any]) -> ProviderRequest:
    output = OUTPUTS.get(role)
    return ProviderRequest(
        role=role,
        model=model,
        messages=fixture["messages"],
        response_schema=portable_strict_schema(output) if output is not None else None,
        max_output_tokens=MAX_OUTPUT_TOKENS[role],
        tools=fixture.get("tools") if role == "agent" else None,
        reasoning={"effort": "low"} if model == "xai.grok-4.3" else None,
    )


def _validate(role: str, fixture: dict[str, Any], result) -> None:
    if role == "agent":
        if not result.tool_calls:
            raise ValueError("agent returned no tool call")
        allowed = {
            tool["function"]["name"]: tool["function"]["parameters"] for tool in fixture["tools"]
        }
        for call in result.tool_calls:
            function = call["function"]
            if function["name"] not in allowed:
                raise ValueError(f"agent called unknown tool {function['name']!r}")
            arguments = json.loads(function["arguments"])
            if not isinstance(arguments, dict):
                raise ValueError("agent tool arguments are not an object")
        return
    if result.content is None:
        raise ValueError("structured role returned no text")
    OUTPUTS[role].model_validate_json(result.content)


async def _probe(
    adapter: BedrockAdapter,
    *,
    model: str,
    role: str,
    repeat: int,
    fixture: dict[str, Any],
    timeout_seconds: float,
) -> dict[str, Any]:
    started = time.monotonic()
    result = None
    try:
        async with asyncio.timeout(timeout_seconds):
            result = await adapter.complete(_request(model, role, fixture))
        _validate(role, fixture, result)
        return {
            "model": model,
            "role": role,
            "repeat": repeat,
            "pass": True,
            "latencyMs": round((time.monotonic() - started) * 1_000),
            "inputTokens": result.in_tokens,
            "outputTokens": result.out_tokens,
            "cachedTokens": result.cached_tokens,
            "actualModel": result.actual_model,
            "finishReason": result.finish_reason,
        }
    except Exception as error:  # noqa: BLE001 - the matrix records every provider failure
        row = {
            "model": model,
            "role": role,
            "repeat": repeat,
            "pass": False,
            "latencyMs": round((time.monotonic() - started) * 1_000),
            "errorType": f"{type(error).__module__}.{type(error).__qualname__}",
            "error": _error_summary(error),
        }
        if result is not None:
            row.update(
                {
                    "inputTokens": result.in_tokens,
                    "outputTokens": result.out_tokens,
                    "cachedTokens": result.cached_tokens,
                    "actualModel": result.actual_model,
                    "finishReason": result.finish_reason,
                }
            )
        return row


def _error_summary(error: Exception) -> str:
    if isinstance(error, TimeoutError):
        return "per-call timeout"
    if isinstance(error, ValidationError):
        failures = [
            {
                "location": ".".join(str(part) for part in item["loc"]),
                "type": item["type"],
            }
            for item in error.errors(include_input=False, include_url=False)
        ]
        return json.dumps(failures, separators=(",", ":"))
    message = str(error)
    for known in (
        "agent returned no tool call",
        "agent tool arguments are not an object",
    ):
        if message == known:
            return known
    if message.startswith("agent called unknown tool"):
        return "agent called an unknown tool"
    if isinstance(error, json.JSONDecodeError):
        return "agent returned invalid tool arguments"
    status = getattr(error, "status_code", None)
    if status is not None:
        body = getattr(error, "body", None)
        code = body.get("code") if isinstance(body, dict) else None
        return f"provider HTTP {status}" + (f" ({code})" if code else "")
    return "call failed; inspect provider logs"


async def _limited_probe(
    semaphore: asyncio.Semaphore,
    adapter: BedrockAdapter,
    **kwargs: Any,
) -> dict[str, Any]:
    async with semaphore:
        return await _probe(adapter, **kwargs)


def _credential(path: Path) -> str | None:
    key = (
        os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
        or os.environ.get("AWS_BEDROCK_API_KEY")
        or os.environ.get("BEDROCK_KEY")
    )
    if key or not path.is_file():
        return key
    accepted = {
        "NPMGUARD_LLM_API_KEY",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_BEDROCK_API_KEY",
        "BEDROCK_KEY",
    }
    for line in path.read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() in accepted:
            return value.strip().strip("\"'")
    return None


def _summary(models: list[str], rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        model: {
            role: {
                "passed": sum(
                    row["pass"] for row in rows if row["model"] == model and row["role"] == role
                ),
                "attempts": sum(1 for row in rows if row["model"] == model and row["role"] == role),
            }
            for role in ROLES
        }
        for model in models
    }


def _checkpoint(
    path: Path,
    *,
    region: str,
    models: list[str],
    roles: list[str],
    repeats: int,
    rows: list[dict[str, Any]],
) -> None:
    report = {
        "region": region,
        "models": models,
        "roles": roles,
        "repeats": repeats,
        "summary": _summary(models, rows),
        "rows": rows,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(report, indent=2), encoding="utf-8")
    temporary.replace(path)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", action="append", dest="models")
    parser.add_argument("--role", action="append", dest="roles", choices=ROLES)
    parser.add_argument("--region", required=True)
    parser.add_argument("--repeats", type=int, default=4)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=60)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--credentials-file", type=Path, default=ENV_FILE)
    args = parser.parse_args()

    key = _credential(args.credentials_file)
    if not key:
        raise SystemExit("a Bedrock bearer key is required in the environment or credentials file")
    if args.repeats < 1:
        raise SystemExit("--repeats must be positive")
    if args.timeout_seconds <= 0:
        raise SystemExit("--timeout-seconds must be positive")
    if args.concurrency < 1:
        raise SystemExit("--concurrency must be positive")

    models = args.models or list(MODELS)
    roles = args.roles or list(ROLES)
    fixtures = _fixtures(FIXTURE_ROOT)
    root = f"https://bedrock-mantle.{args.region}.api.aws"
    settings = LlmSettings(llm_api_key=key, llm_base_url=f"{root}/v1")
    adapter = BedrockAdapter(settings, responses_base_url=f"{root}/openai/v1")
    rows: list[dict[str, Any]] = []
    if args.resume and args.output.is_file():
        previous = json.loads(args.output.read_text(encoding="utf-8"))
        expected = (args.region, models, roles, args.repeats)
        observed = (
            previous.get("region"),
            previous.get("models"),
            previous.get("roles", list(ROLES)),
            previous.get("repeats"),
        )
        if observed != expected:
            raise SystemExit("resume report does not match region, models, and repeat count")
        rows = previous.get("rows") or []
    completed = {(row["model"], row["role"], row["repeat"]) for row in rows}
    semaphore = asyncio.Semaphore(args.concurrency)
    try:
        for model in models:
            for role in roles:
                candidates = fixtures[role]
                pending = [
                    _limited_probe(
                        semaphore,
                        adapter,
                        model=model,
                        role=role,
                        repeat=repeat,
                        fixture=candidates[repeat % len(candidates)],
                        timeout_seconds=args.timeout_seconds,
                    )
                    for repeat in range(args.repeats)
                    if (model, role, repeat) not in completed
                ]
                for result in asyncio.as_completed(pending):
                    row = await result
                    rows.append(row)
                    completed.add((row["model"], row["role"], row["repeat"]))
                    _checkpoint(
                        args.output,
                        region=args.region,
                        models=models,
                        roles=roles,
                        repeats=args.repeats,
                        rows=rows,
                    )
                    print(
                        f"{row['model']} {row['role']} {row['repeat'] + 1}/{args.repeats}: "
                        f"{'pass' if row['pass'] else 'fail'}",
                        file=sys.stderr,
                        flush=True,
                    )
    finally:
        await adapter.aclose()

    summary = _summary(models, rows)
    print(json.dumps(summary, indent=2))
    print(f"report: {args.output}")


if __name__ == "__main__":
    asyncio.run(main())

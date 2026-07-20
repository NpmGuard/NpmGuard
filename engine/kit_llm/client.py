"""The chain walk: one logical call = one walk down the role's chain =
attempt rows for every physical call, whatever happens. Repair-then-
advance keeps schema failure distinct from model failure: a parser
failure re-asks the SAME model once with the validation error (a billed
attempt, honestly recorded), then the chain advances. Cancellation
propagates immediately — a disconnected caller must not burn the rest
of the chain. Transforms are open (parser, prompts); this ledger
machinery is closed (its value is being invariant)."""

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import structlog
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm.capture import AttemptWrite, CaptureStore
from kit_llm.config import LlmSettings, ModelSpec, OutputTransport, Role, Roles
from kit_llm.errors import BudgetExhausted, EndOfRope, LoopBudgetExceeded, OutputInvalid
from kit_llm.parser import as_parser
from kit_llm.prompts import load_prompt, render
from kit_llm.provider import OpenRouterAdapter, ProviderPort, ProviderRequest
from kit_llm.spend import SpendTracker, estimate_cost
from kit_llm.tools import Tool, ToolCallError, ToolRegistry, tool_result_message
from kit_spine.request_id import get_request_id

log = structlog.get_logger("kit.llm")

_REPAIR_INSTRUCTION = (
    "Your previous reply failed validation: {error}\n"
    "Reply again, following the required format exactly."
)
_TOOL_REPAIR_INSTRUCTION = (
    "Your previous {tool_name} arguments failed validation: {error}\n"
    "Previous arguments: {raw}\n"
    "Call {tool_name} again with arguments following the required schema exactly."
)
_OUTPUT_TOOL_NAME = "emit_output"


@dataclass(frozen=True)
class LlmResult:
    output: Any  # parsed value (or raw text when the role has no parser)
    raw: str
    run_id: str
    model: str
    steps: int


class LlmClient:
    def __init__(
        self,
        provider: ProviderPort,
        capture: CaptureStore,
        spend: SpendTracker,
        roles: Roles,
        settings: LlmSettings,
    ) -> None:
        self.provider = provider
        self.capture = capture
        self.spend = spend
        self.roles = roles
        self.settings = settings

    async def run(
        self,
        role_name: str,
        *,
        messages: list[dict[str, Any]] | None = None,
        vars: dict[str, str] | None = None,
        output: Any = ...,  # ... = the role's own contract
        output_transport: OutputTransport = "content",
        on_token: Callable[[str], None] | None = None,
        context: tuple[str, str] = ("app", ""),
    ) -> LlmResult:
        """One logical call. `messages` is the core input (the message
        list IS the LLM API's fundamental type); `vars` renders the
        role's prompt file into a system message PREPENDED to `messages`.
        `output_transport="tool"` forces a synthetic output function and
        treats its arguments as the final candidate instead of content.
        Returns the parsed output; every physical attempt lands in
        llm_attempts regardless of outcome."""
        role = self.roles.get(role_name)
        final_output = role.output if output is ... else output
        _validate_output_transport(final_output, output_transport, on_token=on_token)
        built, prompt_version, prompt_hash = self._build_messages(role, messages, vars)
        run_id = await self.capture.create_run(context[0], context[1], role.name)
        try:
            await self.spend.guard()
        except BudgetExhausted:
            await self.capture.finish_run(run_id, "budget", steps=0)
            raise

        try:
            result = await self._step(
                role,
                run_id=run_id,
                step=0,
                messages=built,
                output=final_output,
                output_transport=output_transport,
                on_token=on_token,
                prompt_version=prompt_version,
                prompt_hash=prompt_hash,
            )
        except OutputInvalid:
            await self.capture.finish_run(run_id, "invalid", steps=1)
            raise
        except EndOfRope:
            await self.capture.finish_run(run_id, "end_of_rope", steps=1)
            raise
        await self.capture.finish_run(run_id, "ok", steps=1)
        return LlmResult(
            output=result.parsed, raw=result.raw, run_id=run_id, model=result.model, steps=1
        )

    async def run_agent(
        self,
        role_name: str,
        *,
        tools: tuple["Tool", ...],
        messages: list[dict[str, Any]] | None = None,
        vars: dict[str, str] | None = None,
        output: Any = ...,
        max_steps: int = 8,
        max_cost_usd: float | None = None,
        context: tuple[str, str] = ("app", ""),
    ) -> LlmResult:
        """An agentic run: consult → the model asks for tools → validate
        args, dispatch, append results → consult again, until it answers
        or a budget trips. Every consultation is a step (its own attempt
        rows). Budgets: max_steps and max_cost_usd → LoopBudgetExceeded,
        transcript captured up to the cap."""
        role = self.roles.get(role_name)
        transcript, prompt_version, prompt_hash = self._build_messages(role, messages, vars)
        registry = ToolRegistry(tools)
        run_id = await self.capture.create_run(context[0], context[1], role.name)
        try:
            await self.spend.guard()
        except BudgetExhausted:
            await self.capture.finish_run(run_id, "budget", steps=0)
            raise

        spent = 0.0
        final_output = role.output if output is ... else output
        for step in range(max_steps):
            try:
                result = await self._step(
                    role, run_id=run_id, step=step, messages=transcript,
                    output=final_output, on_token=None,
                    prompt_version=prompt_version, prompt_hash=prompt_hash,
                    tools=registry.definitions,
                )
            except OutputInvalid:
                await self.capture.finish_run(run_id, "invalid", steps=step + 1)
                raise
            except EndOfRope:
                await self.capture.finish_run(run_id, "end_of_rope", steps=step + 1)
                raise
            spent += result.cost
            if result.tool_calls is None:  # the model answered
                await self.capture.finish_run(run_id, "ok", steps=step + 1)
                return LlmResult(
                    output=result.parsed, raw=result.raw, run_id=run_id,
                    model=result.model, steps=step + 1,
                )
            # the model asked for tools: record its request, dispatch, feed back
            transcript = [
                *transcript,
                {"role": "assistant", "content": None, "tool_calls": result.tool_calls},
            ]
            for call in result.tool_calls:
                fn = call["function"]
                try:
                    outcome = await registry.dispatch(fn["name"], fn.get("arguments", "{}"))
                except ToolCallError as error:
                    outcome = f"error: {error}"  # the model's problem to correct
                transcript.append(tool_result_message(call["id"], outcome))
            if max_cost_usd is not None and spent > max_cost_usd:
                await self.capture.finish_run(run_id, "loop_cap", steps=step + 1)
                raise LoopBudgetExceeded(
                    f"role {role.name!r}: spent {spent:.4f} exceeds max_cost_usd "
                    f"{max_cost_usd}"
                )

        await self.capture.finish_run(run_id, "loop_cap", steps=max_steps)
        raise LoopBudgetExceeded(
            f"role {role.name!r}: {max_steps} steps without a final answer"
        )

    async def aclose(self) -> None:
        """Release provider resources (the HTTP client pool). Call on app
        shutdown. The session factory / engine is app-owned and is NOT
        disposed here — the app that built the engine owns its lifecycle."""
        await self.provider.aclose()

    def _build_messages(
        self,
        role: Role,
        messages: list[dict[str, Any]] | None,
        vars: dict[str, str] | None,
    ) -> tuple[list[dict[str, Any]], int | None, str | None]:
        if messages is None and vars is None:
            raise ValueError("run() needs messages=, vars=, or both")
        built = list(messages or [])
        prompt_version = prompt_hash = None
        if vars is not None:
            prompt = load_prompt(self.settings.llm_prompts_dir, role.prompt or role.name)
            built = [{"role": "system", "content": render(prompt.text, vars)}, *built]
            prompt_version, prompt_hash = prompt.version, prompt.hash
        return built, prompt_version, prompt_hash

    async def _step(
        self,
        role: Role,
        *,
        run_id: str,
        step: int,
        messages: list[dict[str, Any]],
        output: Any,
        output_transport: OutputTransport = "content",
        on_token: Callable[[str], None] | None,
        prompt_version: int | None,
        prompt_hash: str | None,
        tools: list[dict[str, Any]] | None = None,
    ) -> "_StepResult":
        """Walk the chain for ONE logical step. Returns a _StepResult:
        tool_calls set (the model wants tools — no parse, a valid step
        outcome) or parsed set (the model answered). Raises OutputInvalid
        when every model answered but nothing survived the parser;
        EndOfRope on transport exhaustion. cost = sum of this step's
        attempt costs (for the agentic budget)."""
        parser, wants_json = as_parser(output)
        tool_choice: dict[str, Any] | str | None = None
        output_tool_name: str | None = None
        if output_transport == "tool":
            if tools is not None:
                raise ValueError("tool output transport cannot be combined with agent tools")
            tools = [_output_tool_definition(output)]
            output_tool_name = _OUTPUT_TOOL_NAME
            tool_choice = {
                "type": "function",
                "function": {"name": output_tool_name},
            }
        # json_object response mode and tools CONFLICT on real providers: a
        # model told to answer-in-JSON stops calling tools (it answers,
        # hallucinating what a tool would have returned). When tools are
        # offered we let the model tool-call freely; the final answer's
        # shape comes from the prompt + the parser's repair loop, not the
        # response format. (Found dogfooding pulse on mistral-nemo.)
        if tools is not None:
            wants_json = False
        attempt_no = 0
        cost = 0.0
        failures: list[dict[str, Any]] = []
        last_failure_was_invalid = False

        for spec in role.chain:
            transcript = list(messages)  # repair retries extend a copy
            for repair in range(role.repair_retries + 1):
                request = ProviderRequest(
                    role=role.name,
                    model=spec.slug,
                    messages=transcript,
                    temperature=spec.temperature,
                    json_response=wants_json,
                    tools=tools,
                    tool_choice=tool_choice,
                )
                outcome = await self._attempt(
                    request, spec, run_id=run_id, step=step, attempt=attempt_no,
                    on_token=on_token, prompt_version=prompt_version,
                    prompt_hash=prompt_hash,
                )
                attempt_no += 1
                cost += outcome.cost or 0.0
                if outcome.transport_error is not None:
                    failures.append({"model": spec.slug, "error": outcome.transport_error})
                    last_failure_was_invalid = False
                    break  # transport failure: repair can't help — next model
                if output_tool_name is None and outcome.tool_calls:
                    # An agentic action request: the outer loop dispatches it.
                    return _StepResult(
                        tool_calls=outcome.tool_calls, raw=outcome.raw or "",
                        model=spec.slug, cost=cost,
                    )
                try:
                    raw = (
                        _extract_output_tool_arguments(outcome.tool_calls, output_tool_name)
                        if output_tool_name is not None
                        else outcome.raw or ""
                    )
                    if parser is None:
                        return _StepResult(parsed=raw, raw=raw, model=spec.slug, cost=cost)
                    return _StepResult(
                        parsed=parser(raw), raw=raw, model=spec.slug, cost=cost
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    await self._mark_invalid(outcome, error)
                    failures.append({"model": spec.slug, "error": f"invalid: {error}"})
                    last_failure_was_invalid = True
                    if repair < role.repair_retries:
                        if output_tool_name is not None:
                            transcript = [
                                *transcript,
                                {
                                    "role": "user",
                                    "content": _TOOL_REPAIR_INSTRUCTION.format(
                                        tool_name=output_tool_name,
                                        error=error,
                                        raw=_tool_failure_repr(outcome),
                                    ),
                                },
                            ]
                        else:
                            transcript = [
                                *transcript,
                                {"role": "assistant", "content": raw},
                                {
                                    "role": "user",
                                    "content": _REPAIR_INSTRUCTION.format(error=error),
                                },
                            ]
                        continue  # repair: SAME model, error appended
                    break  # repairs exhausted — next model

        detail = {"attempts": failures}
        if last_failure_was_invalid:
            raise OutputInvalid(
                f"role {role.name!r}: no model produced parseable output", details=detail
            )
        raise EndOfRope(
            f"role {role.name!r}: chain exhausted after {attempt_no} attempts",
            details=detail,
        )

    async def _attempt(
        self,
        request: ProviderRequest,
        spec: ModelSpec,
        *,
        run_id: str,
        step: int,
        attempt: int,
        on_token: Callable[[str], None] | None,
        prompt_version: int | None,
        prompt_hash: str | None,
    ) -> "_AttemptOutcome":
        """One physical call: execute, then write its row no matter what."""
        started = time.monotonic()
        write = AttemptWrite(
            run_id=run_id, step=step, attempt=attempt, model=spec.slug,
            prompt_version=prompt_version, prompt_hash=prompt_hash,
            messages=request.messages, tools=request.tools, output=None,
            status="ok", error=None, in_tokens=None, out_tokens=None,
            cached_tokens=None, cost_usd=None, provider_call_id=None,
            latency_ms=0, request_id=get_request_id(),
        )
        try:
            if on_token is not None:
                result = await asyncio.wait_for(
                    self.provider.stream(request, on_token), timeout=spec.timeout_ms / 1000
                )
            else:
                result = await asyncio.wait_for(
                    self.provider.complete(request), timeout=spec.timeout_ms / 1000
                )
        except asyncio.CancelledError:
            await asyncio.shield(
                self.capture.write_attempt(
                    _finish(write, started, status="cancelled", error="caller cancelled")
                )
            )
            raise
        except TimeoutError:
            await self.capture.write_attempt(
                _finish(write, started, status="timeout", error=f"timeout {spec.timeout_ms}ms")
            )
            log.warning("llm attempt timeout", model=spec.slug, role=request.role)
            return _AttemptOutcome(transport_error=f"timeout {spec.timeout_ms}ms")
        except Exception as error:
            await self.capture.write_attempt(
                _finish(write, started, status="http_error", error=str(error))
            )
            log.warning("llm attempt failed", model=spec.slug, error=str(error))
            return _AttemptOutcome(transport_error=str(error))

        # cost pipeline stage 2: static prices when the adapter had none
        cost = result.cost_usd
        if cost is None and spec.prices is not None:
            cost = estimate_cost(
                spec, self.settings, result.in_tokens, result.out_tokens, result.cached_tokens
            )
        finished = _finish(
            write, started, status="ok", error=None,
            output={"content": result.content, "tool_calls": result.tool_calls},
            in_tokens=result.in_tokens, out_tokens=result.out_tokens,
            cached_tokens=result.cached_tokens, cost_usd=cost,
            provider_call_id=result.provider_call_id,
        )
        await self.capture.write_attempt(finished)
        return _AttemptOutcome(
            raw=result.content, tool_calls=result.tool_calls, write=finished, cost=cost
        )

    async def _mark_invalid(self, outcome: "_AttemptOutcome", error: Exception) -> None:
        """The attempt row was written as ok before parsing; parsing is
        part of the attempt's fate, so restate it. One extra UPDATE beats
        holding the row hostage to the parser."""
        if outcome.write is None:
            return
        await self.capture.mark_invalid(
            outcome.write.run_id, outcome.write.step, outcome.write.attempt, str(error)
        )


@dataclass
class _StepResult:
    parsed: Any = None
    raw: str = ""
    model: str = ""
    cost: float = 0.0
    tool_calls: list[dict[str, Any]] | None = None


@dataclass
class _AttemptOutcome:
    raw: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    transport_error: str | None = None
    write: AttemptWrite | None = None
    cost: float | None = None


def _finish(write: AttemptWrite, started: float, **overrides: Any) -> AttemptWrite:
    from dataclasses import replace

    return replace(
        write, latency_ms=int((time.monotonic() - started) * 1000), **overrides
    )


def _validate_output_transport(
    output: Any,
    transport: OutputTransport,
    *,
    on_token: Callable[[str], None] | None,
) -> None:
    if transport not in ("content", "tool"):
        raise ValueError(f"unknown output transport {transport!r}")
    if transport == "tool":
        if not (isinstance(output, type) and issubclass(output, BaseModel)):
            raise ValueError("tool output transport requires a pydantic output model")
        if on_token is not None:
            raise ValueError("tool output transport does not support token streaming")


def _output_tool_definition(output: Any) -> dict[str, Any]:
    if not (isinstance(output, type) and issubclass(output, BaseModel)):
        raise ValueError("tool output transport requires a pydantic output model")
    return {
        "type": "function",
        "function": {
            "name": _OUTPUT_TOOL_NAME,
            "description": "Emit the final answer matching the required schema.",
            "parameters": output.model_json_schema(),
        },
    }


def _extract_output_tool_arguments(
    calls: list[dict[str, Any]] | None,
    expected_name: str,
) -> str:
    if not calls:
        raise ValueError(f"model did not call required output tool {expected_name!r}")
    if len(calls) != 1:
        raise ValueError(
            f"model called {len(calls)} tools; expected exactly one {expected_name!r} call"
        )
    function = calls[0].get("function")
    if not isinstance(function, dict) or function.get("name") != expected_name:
        actual = function.get("name") if isinstance(function, dict) else None
        raise ValueError(f"model called tool {actual!r}; expected {expected_name!r}")
    arguments = function.get("arguments")
    if not isinstance(arguments, str):
        raise ValueError(f"{expected_name!r} arguments must be a JSON string")
    return arguments


def _tool_failure_repr(outcome: _AttemptOutcome) -> str:
    if outcome.tool_calls:
        return repr(outcome.tool_calls)
    return outcome.raw or "(no output)"


def build_llm(
    session_factory: async_sessionmaker,
    settings: LlmSettings,
    roles: Roles,
    *,
    provider: ProviderPort | None = None,
) -> LlmClient:
    """The one entry point apps wire. Default provider: OpenRouter
    (llm_base_url is config — any OpenAI-compatible endpoint works)."""
    provider = provider or OpenRouterAdapter(settings)
    specs = {spec.slug: spec for role in roles.by_name.values() for spec in role.chain}
    capture = CaptureStore(session_factory)
    spend = SpendTracker(session_factory, settings, specs)
    return LlmClient(provider, capture, spend, roles, settings)

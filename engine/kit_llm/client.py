"""The chain walk: one logical call = one walk down the role's chain =
attempt rows for every physical call, whatever happens. Repair-then-
advance keeps schema failure distinct from model failure: a parser
failure re-asks the SAME model once with the validation error (a billed
attempt, honestly recorded), then the chain advances. Cancellation
propagates immediately — a disconnected caller must not burn the rest
of the chain. Transforms are open (parser, prompts); this ledger
machinery is closed (its value is being invariant)."""

import asyncio
import inspect
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

import structlog
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm.capture import AttemptWrite, CaptureStore
from kit_llm.config import (
    JsonObject,
    LlmSettings,
    ModelSpec,
    PlainText,
    Role,
    Roles,
    StrictSchema,
)
from kit_llm.errors import (
    BudgetExhausted,
    CandidateRejected,
    ClientHookError,
    EndOfRope,
    LoopBudgetExceeded,
    OutputInvalid,
)
from kit_llm.parser import as_parser
from kit_llm.prompts import load_prompt, render
from kit_llm.provider import (
    OpenRouterAdapter,
    ProviderInvariantError,
    ProviderPort,
    ProviderRequest,
    ProviderResponseError,
    ProviderResult,
    ProviderResultError,
)
from kit_llm.schema import portable_strict_schema
from kit_llm.spend import SpendTracker, estimate_cost
from kit_llm.tools import Tool, ToolCallError, ToolRegistry, tool_result_message
from kit_spine.request_id import get_request_id

log = structlog.get_logger("kit.llm")

_REPAIR_INSTRUCTION = (
    "Your previous reply failed validation: {error}\n"
    "Reply again, following the required format exactly."
)


@dataclass(frozen=True)
class LlmResult:
    output: Any  # parsed value (or raw text when the role has no parser)
    raw: str
    run_id: str
    model: str
    steps: int
    actual_model: str | None = None
    provider: str | None = None
    finish_reason: str | None = None
    transport: str | None = None  # winning route's requested output transport


@dataclass(frozen=True)
class _WireTransport:
    """One route's resolved output transport in provider-request form."""

    label: str  # "text" | "json_object" | "strict_schema" (attempt attribution)
    json_response: bool
    response_schema: dict[str, Any] | None


_PLAIN_WIRE = _WireTransport("text", False, None)
_JSON_OBJECT_WIRE = _WireTransport("json_object", True, None)


def _resolve_transports(role: Role, output: Any) -> list[_WireTransport]:
    """Resolve every chain entry's transport against the effective output
    contract BEFORE any money is spent: a StrictSchema() entry that cannot be
    projected is a configuration error, not a billed attempt. The strict
    projection is computed once and shared by every entry that needs it."""
    _, wants_json = as_parser(output)
    default = _JSON_OBJECT_WIRE if wants_json else _PLAIN_WIRE
    projected: dict[str, Any] | None = None
    resolved: list[_WireTransport] = []
    for spec in role.chain:
        transport = spec.transport
        if transport is None:
            resolved.append(default)
        elif isinstance(transport, PlainText):
            resolved.append(_PLAIN_WIRE)
        elif isinstance(transport, JsonObject):
            resolved.append(_JSON_OBJECT_WIRE)
        else:
            assert isinstance(transport, StrictSchema)
            schema = transport.schema
            if schema is None:
                if not (isinstance(output, type) and issubclass(output, BaseModel)):
                    raise TypeError(
                        f"role {role.name!r} model {spec.slug!r}: StrictSchema() without "
                        "an explicit schema needs a pydantic output contract to project"
                    )
                if projected is None:
                    projected = portable_strict_schema(output)
                schema = projected
            resolved.append(_WireTransport("strict_schema", False, dict(schema)))
    return resolved


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
        validate: Callable[[Any], None] | None = None,
        decode: Callable[[Any], Any] | None = None,
        on_token: Callable[[str], None] | None = None,
        context: tuple[str, str] = ("app", ""),
    ) -> LlmResult:
        """One logical call. `messages` is the core input (the message
        list IS the LLM API's fundamental type); `vars` renders the
        role's prompt file into a system message PREPENDED to `messages`.
        Returns the parsed output; every physical attempt lands in
        llm_attempts regardless of outcome."""
        role = self.roles.get(role_name)
        final_output = role.output if output is ... else output
        _preflight_output(final_output)
        _preflight_callback("validate", validate)
        _preflight_callback("decode", decode)
        _preflight_callback("on_token", on_token)
        transports = _resolve_transports(role, final_output)
        built, prompt_version, prompt_hash = self._build_messages(role, messages, vars)
        run_id = await self._create_run(context[0], context[1], role.name)
        steps = 0
        try:
            try:
                await self.spend.guard()
            except BudgetExhausted:
                await self._finish_run(run_id, "budget", steps=0)
                raise
            steps = 1
            result = await self._step(
                role,
                run_id=run_id,
                step=0,
                messages=built,
                output=final_output,
                validate=validate,
                decode=decode,
                on_token=on_token,
                prompt_version=prompt_version,
                prompt_hash=prompt_hash,
                transports=transports,
            )
            await self._finish_run(run_id, "ok", steps=1)
        except OutputInvalid:
            await self._finish_run(run_id, "invalid", steps=steps)
            raise
        except EndOfRope:
            await self._finish_run(run_id, "end_of_rope", steps=steps)
            raise
        except ClientHookError:
            await self._finish_run(run_id, "client_error", steps=steps)
            raise
        except ProviderInvariantError:
            await self._finish_run(run_id, "client_error", steps=steps)
            raise
        except asyncio.CancelledError:
            await self._finish_run(run_id, "cancelled", steps=steps)
            raise
        except BudgetExhausted:
            raise
        except Exception:
            await self._finish_run(run_id, "client_error", steps=steps)
            raise
        return LlmResult(
            output=result.parsed,
            raw=result.raw,
            run_id=run_id,
            model=result.model,
            steps=1,
            actual_model=result.actual_model,
            provider=result.provider,
            finish_reason=result.finish_reason,
            transport=result.transport,
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
        attempts captured up to the cap."""
        if isinstance(max_steps, bool) or not isinstance(max_steps, int) or max_steps <= 0:
            raise ValueError("max_steps must be a positive integer")
        if max_cost_usd is not None and (
            isinstance(max_cost_usd, bool)
            or not isinstance(max_cost_usd, (int, float))
            or not math.isfinite(max_cost_usd)
            or max_cost_usd < 0
        ):
            raise ValueError("max_cost_usd must be a finite non-negative number or None")
        role = self.roles.get(role_name)
        transcript, prompt_version, prompt_hash = self._build_messages(role, messages, vars)
        registry = ToolRegistry(tools)
        tool_definitions = registry.definitions  # schema preflight before a run exists
        final_output = role.output if output is ... else output
        _preflight_output(final_output)
        run_id = await self._create_run(context[0], context[1], role.name)
        steps = 0
        try:
            try:
                await self.spend.guard()
            except BudgetExhausted:
                await self._finish_run(run_id, "budget", steps=0)
                raise

            spent = 0.0
            for step in range(max_steps):
                steps = step + 1
                if step > 0:
                    # re-guard between consultations: a multi-step run must
                    # not keep paying after the 24h window is exhausted
                    try:
                        await self.spend.guard()
                    except BudgetExhausted:
                        await self._finish_run(run_id, "budget", steps=step)
                        raise
                result = await self._step(
                    role,
                    run_id=run_id,
                    step=step,
                    messages=transcript,
                    output=final_output,
                    on_token=None,
                    validate=None,
                    decode=None,
                    prompt_version=prompt_version,
                    prompt_hash=prompt_hash,
                    transports=None,  # offered tools suppress response formats
                    tools=tool_definitions,
                )
                spent += result.cost
                if max_cost_usd is not None and spent > max_cost_usd:
                    await self._finish_run(run_id, "loop_cap", steps=steps)
                    raise LoopBudgetExceeded(
                        f"role {role.name!r}: spent {spent:.4f} exceeds max_cost_usd {max_cost_usd}"
                    )
                if result.tool_calls is None:  # the model answered
                    await self._finish_run(run_id, "ok", steps=steps)
                    return LlmResult(
                        output=result.parsed,
                        raw=result.raw,
                        run_id=run_id,
                        model=result.model,
                        steps=steps,
                        actual_model=result.actual_model,
                        provider=result.provider,
                        finish_reason=result.finish_reason,
                        transport=result.transport,
                    )
                if step == max_steps - 1:
                    # the loop is out of steps: dispatching now would fire
                    # side-effecting tools whose results can never be
                    # consulted — finish loop_cap without dispatch (the
                    # max_cost_usd path above already behaves this way)
                    break
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
                    except Exception as error:
                        log.exception(
                            "llm client tool handler failed",
                            tool=fn["name"],
                            model=result.model,
                        )
                        raise ClientHookError(
                            f"client tool handler failed for {fn['name']!r}",
                            details={
                                "phase": "tool",
                                "tool": fn["name"],
                                "model": result.model,
                                "actual_model": result.actual_model,
                                "provider": result.provider,
                            },
                        ) from error
                    try:
                        transcript.append(tool_result_message(call["id"], outcome))
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        log.exception(
                            "llm client tool result serialization failed",
                            tool=fn["name"],
                            model=result.model,
                        )
                        raise ClientHookError(
                            f"client tool result could not be serialized for {fn['name']!r}",
                            details={
                                "phase": "tool_result",
                                "tool": fn["name"],
                                "model": result.model,
                                "actual_model": result.actual_model,
                                "provider": result.provider,
                            },
                        ) from error
            await self._finish_run(run_id, "loop_cap", steps=max_steps)
            raise LoopBudgetExceeded(
                f"role {role.name!r}: {max_steps} steps without a final answer"
            )
        except OutputInvalid:
            await self._finish_run(run_id, "invalid", steps=steps)
            raise
        except EndOfRope:
            await self._finish_run(run_id, "end_of_rope", steps=steps)
            raise
        except ClientHookError:
            await self._finish_run(run_id, "client_error", steps=steps)
            raise
        except ProviderInvariantError:
            await self._finish_run(run_id, "client_error", steps=steps)
            raise
        except asyncio.CancelledError:
            await self._finish_run(run_id, "cancelled", steps=steps)
            raise
        except (BudgetExhausted, LoopBudgetExceeded):
            raise
        except Exception:
            await self._finish_run(run_id, "client_error", steps=steps)
            raise

    async def _create_run(self, context_kind: str, context_id: str, role: str) -> str:
        """Create the envelope without losing a committed row to cancellation.

        A database commit can complete immediately before the caller receives
        the new id. Run creation therefore follows the same shield-and-join
        rule as paid attempt capture. If the caller is cancelled at that seam,
        finish the now-known envelope as cancelled before propagating.
        """
        task = asyncio.create_task(self.capture.create_run(context_kind, context_id, role))
        run_id, cancelled = await _join_critical(task)
        if cancelled is not None:
            try:
                await self._finish_run(run_id, "cancelled", steps=0)
            except asyncio.CancelledError:
                pass
            raise cancelled
        return run_id

    async def _finish_run(self, run_id: str, status: str, steps: int) -> None:
        """Commit a terminal status before cancellation can escape.

        If cancellation arrives while another terminal status is committing,
        first join that transaction, then restate the final status as
        ``cancelled``. This also covers cancellation inside an exception
        handler, which a sibling ``except CancelledError`` cannot observe.
        """
        task = asyncio.create_task(self.capture.finish_run(run_id, status, steps))
        _, cancelled = await _join_critical(task)
        if cancelled is not None and status != "cancelled":
            restate = asyncio.create_task(self.capture.finish_run(run_id, "cancelled", steps))
            _, later = await _join_critical(restate)
            cancelled = cancelled or later
        if cancelled is not None:
            raise cancelled

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
        validate: Callable[[Any], None] | None,
        decode: Callable[[Any], Any] | None,
        on_token: Callable[[str], None] | None,
        prompt_version: int | None,
        prompt_hash: str | None,
        transports: list["_WireTransport"] | None,
        tools: list[dict[str, Any]] | None = None,
    ) -> "_StepResult":
        """Walk the chain for ONE logical step. Returns a _StepResult:
        tool_calls set (the model wants tools — no parse, a valid step
        outcome) or parsed set (the model answered). Raises OutputInvalid
        when every model answered but nothing survived the parser;
        EndOfRope on transport exhaustion. cost = sum of this step's
        attempt costs (for the agentic budget)."""
        parser, _ = as_parser(output)
        # Response formats and tools CONFLICT on real providers: a model told
        # to answer-in-JSON stops calling tools (it answers, hallucinating
        # what a tool would have returned). When tools are offered we let the
        # model tool-call freely; the final answer's shape comes from the
        # prompt + the parser's repair loop, not the response format. (Found
        # dogfooding pulse on mistral-nemo.) Transport knobs are inert here.
        if tools is not None or transports is None:
            transports = [_PLAIN_WIRE] * len(role.chain)
        attempt_no = 0
        cost = 0.0
        failures: list[dict[str, Any]] = []
        saw_candidate_failure = False

        for spec, wire in zip(role.chain, transports, strict=True):
            transcript = list(messages)  # repair retries extend a copy
            for repair in range(role.repair_retries + 1):
                request = ProviderRequest(
                    role=role.name,
                    model=spec.slug,
                    messages=transcript,
                    temperature=spec.temperature,
                    json_response=wire.json_response,
                    response_schema=wire.response_schema,
                    max_output_tokens=spec.max_output_tokens,
                    tools=tools,
                    reasoning=spec.reasoning.to_wire() if spec.reasoning is not None else None,
                )
                outcome = await self._attempt(
                    request,
                    spec,
                    run_id=run_id,
                    step=step,
                    attempt=attempt_no,
                    transport=wire.label,
                    on_token=on_token,
                    prompt_version=prompt_version,
                    prompt_hash=prompt_hash,
                )
                attempt_no += 1
                cost += outcome.cost or 0.0
                if outcome.transport_error is not None:
                    failures.append(
                        {
                            "model": spec.slug,
                            "actual_model": outcome.actual_model,
                            "provider": outcome.provider,
                            "transport": wire.label,
                            "finish_reason": outcome.finish_reason,
                            "cost_usd": outcome.cost,
                            "kind": "transport",
                            "phase": "provider",
                            "error": outcome.transport_error,
                        }
                    )
                    break  # transport failure: repair can't help — next model
                if outcome.candidate_failure is not None:
                    failures.append(
                        _candidate_failure_record(
                            spec,
                            outcome,
                            transport=wire.label,
                            kind=outcome.candidate_failure,
                            phase="response",
                            error=outcome.failure_message or outcome.candidate_failure,
                        )
                    )
                    saw_candidate_failure = True
                    break  # refusal/truncation: same-limit repair is not useful
                if tools is not None and outcome.tool_calls:
                    # An agentic action request: the outer loop dispatches it.
                    return _StepResult(
                        tool_calls=outcome.tool_calls,
                        raw=outcome.raw or "",
                        model=spec.slug,
                        cost=cost,
                        actual_model=outcome.actual_model,
                        provider=outcome.provider,
                        finish_reason=outcome.finish_reason,
                        transport=wire.label,
                    )
                raw = outcome.raw or ""
                parsed: Any = None
                rejection: _CandidateFailure | None = None
                try:
                    parsed = raw if parser is None else parser(raw)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    rejection = _CandidateFailure("malformed_output", "parse", error)

                if rejection is None and validate is not None:
                    try:
                        validation_result = validate(parsed)
                        if inspect.isawaitable(validation_result):
                            _close_awaitable(validation_result)
                            raise TypeError(
                                "validate returned an awaitable; hooks must be synchronous"
                            )
                        if validation_result is not None:
                            raise TypeError("validate must return None")
                    except asyncio.CancelledError:
                        raise
                    except CandidateRejected as error:
                        rejection = _CandidateFailure("semantic_invalid", "validate", error)
                    except Exception as error:
                        log.exception("llm client hook failed", phase="validate", model=spec.slug)
                        raise _client_hook_error("validate", spec, outcome) from error

                if rejection is None and decode is not None:
                    try:
                        parsed = decode(parsed)
                        if inspect.isawaitable(parsed):
                            _close_awaitable(parsed)
                            raise TypeError(
                                "decode returned an awaitable; hooks must be synchronous"
                            )
                    except asyncio.CancelledError:
                        raise
                    except CandidateRejected as error:
                        rejection = _CandidateFailure("decode_invalid", "decode", error)
                    except Exception as error:
                        log.exception("llm client hook failed", phase="decode", model=spec.slug)
                        raise _client_hook_error("decode", spec, outcome) from error

                if rejection is None:
                    return _StepResult(
                        parsed=parsed,
                        raw=raw,
                        model=spec.slug,
                        cost=cost,
                        actual_model=outcome.actual_model,
                        provider=outcome.provider,
                        finish_reason=outcome.finish_reason,
                        transport=wire.label,
                    )

                await self._mark_invalid(outcome, rejection.error)
                failures.append(
                    _candidate_failure_record(
                        spec,
                        outcome,
                        transport=wire.label,
                        kind=rejection.kind,
                        phase=rejection.phase,
                        error=rejection.error,
                    )
                )
                saw_candidate_failure = True
                if repair < role.repair_retries:
                    repair_error = f"{rejection.phase}: {rejection.error}"
                    transcript = [
                        *transcript,
                        {"role": "assistant", "content": raw},
                        {
                            "role": "user",
                            "content": _REPAIR_INSTRUCTION.format(error=repair_error),
                        },
                    ]
                    continue  # repair: SAME model, typed failure appended
                break  # repairs exhausted — next model

        detail = {"attempts": failures}
        if saw_candidate_failure:
            raise OutputInvalid(
                f"role {role.name!r}: no model produced acceptable output", details=detail
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
        transport: str,
        on_token: Callable[[str], None] | None,
        prompt_version: int | None,
        prompt_hash: str | None,
    ) -> "_AttemptOutcome":
        """One physical call: execute, then write its row no matter what."""
        started = time.monotonic()
        write = AttemptWrite(
            run_id=run_id,
            step=step,
            attempt=attempt,
            model=spec.slug,
            prompt_version=prompt_version,
            prompt_hash=prompt_hash,
            messages=request.messages,
            tools=request.tools,
            output=None,
            status="ok",
            error=None,
            in_tokens=None,
            out_tokens=None,
            cached_tokens=None,
            cost_usd=None,
            provider_call_id=None,
            actual_model=None,
            provider=None,
            finish_reason=None,
            transport=transport,
            latency_ms=0,
            request_id=get_request_id(),
        )
        try:
            if on_token is not None:
                result = await asyncio.wait_for(
                    self.provider.stream(request, _guard_token_callback(on_token)),
                    timeout=spec.timeout_ms / 1000,
                )
            else:
                result = await asyncio.wait_for(
                    self.provider.complete(request), timeout=spec.timeout_ms / 1000
                )
            if not isinstance(result, ProviderResult):
                raise ProviderResultError(
                    "provider port returned an object other than ProviderResult"
                )
        except asyncio.CancelledError:
            await self._persist_attempt(
                _finish(write, started, status="cancelled", error="caller cancelled")
            )
            raise
        except _TokenCallbackError as error:
            await self._persist_attempt(
                _finish(write, started, status="client_error", error="on_token hook failed")
            )
            log.exception("llm client token hook failed", model=spec.slug)
            raise ClientHookError(
                f"client on_token hook failed for model {spec.slug!r}",
                details={
                    "phase": "on_token",
                    "model": spec.slug,
                    "actual_model": None,
                    "provider": None,
                },
            ) from error.__cause__
        except ProviderResponseError as error:
            result = error.result
            cost = _result_cost(result, spec, self.settings)
            finished = _finish_provider_result(
                write,
                started,
                result,
                status="provider_error",
                error=str(error),
                cost=cost,
            )
            await self._persist_attempt(finished)
            log.warning(
                "llm provider response had no usable choice",
                model=spec.slug,
                actual_model=result.actual_model,
                provider=result.provider,
            )
            return _AttemptOutcome(
                transport_error=str(error),
                write=finished,
                cost=cost,
                actual_model=result.actual_model,
                provider=result.provider,
                finish_reason=result.finish_reason,
            )
        except ProviderResultError as error:
            await self._persist_attempt(
                _finish(write, started, status="http_error", error=str(error))
            )
            raise
        except ProviderInvariantError:
            raise
        except TimeoutError:
            await self._persist_attempt(
                _finish(write, started, status="timeout", error=f"timeout {spec.timeout_ms}ms")
            )
            log.warning("llm attempt timeout", model=spec.slug, role=request.role)
            return _AttemptOutcome(transport_error=f"timeout {spec.timeout_ms}ms")
        except Exception as error:
            invariant = _provider_invariant_cause(error)
            if invariant is not None:
                if isinstance(invariant, ProviderResultError):
                    await self._persist_attempt(
                        _finish(write, started, status="http_error", error=str(invariant))
                    )
                raise invariant
            await self._persist_attempt(
                _finish(write, started, status="http_error", error=str(error))
            )
            log.warning("llm attempt failed", model=spec.slug, error=str(error))
            return _AttemptOutcome(transport_error=str(error))

        # cost pipeline stage 2: static prices when the adapter had none
        cost = _result_cost(result, spec, self.settings)
        candidate_failure, failure_message = _response_failure(result.finish_reason, result.refusal)
        finished = _finish_provider_result(
            write,
            started,
            result,
            status=candidate_failure or "ok",
            error=failure_message,
            cost=cost,
        )
        await self._persist_attempt(finished)
        return _AttemptOutcome(
            raw=result.content,
            tool_calls=result.tool_calls,
            write=finished,
            cost=cost,
            actual_model=result.actual_model,
            provider=result.provider,
            finish_reason=result.finish_reason,
            candidate_failure=candidate_failure,
            failure_message=failure_message,
        )

    async def _persist_attempt(self, write: AttemptWrite) -> None:
        """Commit a completed physical call before propagating cancellation.

        Shielding alone lets the caller return while the ledger write is still
        running. Keeping the task and awaiting it after cancellation preserves
        the one-row-per-call invariant before the logical run is finalized.
        """
        task = asyncio.create_task(self.capture.write_attempt(write))
        _, cancelled = await _join_critical(task)
        if cancelled is not None:
            raise cancelled

    async def _mark_invalid(self, outcome: "_AttemptOutcome", error: Exception) -> None:
        """The attempt row was written as ok before parsing; parsing is
        part of the attempt's fate, so restate it. One extra UPDATE beats
        holding the row hostage to the parser."""
        if outcome.write is None:
            return
        task = asyncio.create_task(
            self.capture.mark_invalid(
                outcome.write.run_id,
                outcome.write.step,
                outcome.write.attempt,
                str(error),
            )
        )
        _, cancelled = await _join_critical(task)
        if cancelled is not None:
            raise cancelled


@dataclass
class _StepResult:
    parsed: Any = None
    raw: str = ""
    model: str = ""
    cost: float = 0.0
    tool_calls: list[dict[str, Any]] | None = None
    actual_model: str | None = None
    provider: str | None = None
    finish_reason: str | None = None
    transport: str | None = None


@dataclass
class _AttemptOutcome:
    raw: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    transport_error: str | None = None
    write: AttemptWrite | None = None
    cost: float | None = None
    actual_model: str | None = None
    provider: str | None = None
    finish_reason: str | None = None
    candidate_failure: Literal["truncated", "refused", "provider_error"] | None = None
    failure_message: str | None = None


@dataclass(frozen=True)
class _CandidateFailure:
    kind: Literal["malformed_output", "semantic_invalid", "decode_invalid"]
    phase: Literal["parse", "validate", "decode"]
    error: Exception


def _provider_invariant_cause(error: BaseException) -> ProviderInvariantError | None:
    """Find a fatal port invariant hidden by an SDK transport wrapper."""
    pending: list[BaseException] = [error]
    seen: set[int] = set()
    while pending and len(seen) < 100:
        current = pending.pop()
        marker = id(current)
        if marker in seen:
            continue
        seen.add(marker)
        if isinstance(current, ProviderInvariantError):
            return current
        if current.__context__ is not None:
            pending.append(current.__context__)
        if current.__cause__ is not None:
            pending.append(current.__cause__)
    return None


def _response_failure(
    finish_reason: str | None,
    refusal: str | None,
) -> tuple[Literal["truncated", "refused", "provider_error"] | None, str | None]:
    if refusal is not None and refusal.strip():
        return "refused", refusal
    normalized = (finish_reason or "").lower().replace("-", "_")
    if normalized in {"length", "max_tokens", "max_output_tokens"}:
        return "truncated", f"provider stopped at output limit ({finish_reason})"
    # A 200 whose choice carries finish_reason=error is a provider-side abort
    # (e.g. mid-stream failure surfaced inside a success envelope). Its partial
    # content is unusable; type it distinctly rather than as malformed output.
    if normalized == "error":
        return "provider_error", f"provider aborted generation ({finish_reason})"
    return None, None


def _candidate_failure_record(
    spec: ModelSpec,
    outcome: _AttemptOutcome,
    *,
    transport: str,
    kind: str,
    phase: str,
    error: Exception | str,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "model": spec.slug,
        "actual_model": outcome.actual_model,
        "provider": outcome.provider,
        "transport": transport,
        "finish_reason": outcome.finish_reason,
        "kind": kind,
        "phase": phase,
        "exception_type": (
            f"{type(error).__module__}.{type(error).__qualname__}"
            if isinstance(error, Exception)
            else None
        ),
        "error": str(error),
    }
    return record


def _client_hook_error(
    phase: Literal["validate", "decode"],
    spec: ModelSpec,
    outcome: _AttemptOutcome,
) -> ClientHookError:
    return ClientHookError(
        f"client {phase} hook failed for model {spec.slug!r}",
        details={
            "phase": phase,
            "model": spec.slug,
            "actual_model": outcome.actual_model,
            "provider": outcome.provider,
        },
    )


def _finish(write: AttemptWrite, started: float, **overrides: Any) -> AttemptWrite:
    from dataclasses import replace

    return replace(write, latency_ms=int((time.monotonic() - started) * 1000), **overrides)


def _result_cost(
    result: ProviderResult,
    spec: ModelSpec,
    settings: LlmSettings,
) -> float | None:
    if result.cost_usd is not None:
        return result.cost_usd
    if spec.prices is None or all(
        count is None for count in (result.in_tokens, result.out_tokens, result.cached_tokens)
    ):
        return None
    return estimate_cost(
        spec,
        settings,
        result.in_tokens,
        result.out_tokens,
        result.cached_tokens,
    )


def _finish_provider_result(
    write: AttemptWrite,
    started: float,
    result: ProviderResult,
    *,
    status: str,
    error: str | None,
    cost: float | None,
) -> AttemptWrite:
    return _finish(
        write,
        started,
        status=status,
        error=error,
        output={
            "content": result.content,
            "tool_calls": result.tool_calls,
            "actual_model": result.actual_model,
            "provider": result.provider,
            "finish_reason": result.finish_reason,
            "refusal": result.refusal,
            "reasoning": result.reasoning,
        },
        in_tokens=result.in_tokens,
        out_tokens=result.out_tokens,
        cached_tokens=result.cached_tokens,
        cost_usd=cost,
        provider_call_id=result.provider_call_id,
        actual_model=result.actual_model,
        provider=result.provider,
        finish_reason=result.finish_reason,
    )


def _preflight_output(output: Any) -> None:
    parser, _ = as_parser(output)
    if parser is not None and not callable(parser):
        raise TypeError("output must be a pydantic model class, callable parser, or None")


def _preflight_callback(name: str, callback: Any) -> None:
    if callback is not None and not callable(callback):
        raise TypeError(f"{name} must be callable or None")
    if callback is not None and (
        inspect.iscoroutinefunction(callback)
        or inspect.iscoroutinefunction(getattr(callback, "__call__", None))
    ):
        raise TypeError(f"{name} must be synchronous")


def _close_awaitable(value: Any) -> None:
    close = getattr(value, "close", None)
    if callable(close):
        close()


class _TokenCallbackError(Exception):
    """Internal marker so a client callback crash cannot become fallback."""


def _guard_token_callback(callback: Callable[[str], None]) -> Callable[[str], None]:
    def guarded(token: str) -> None:
        try:
            result = callback(token)
            if inspect.isawaitable(result):
                _close_awaitable(result)
                raise TypeError("on_token returned an awaitable; hooks must be synchronous")
            if result is not None:
                raise TypeError("on_token must return None")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise _TokenCallbackError from error

    return guarded


_T = TypeVar("_T")


async def _join_critical(task: asyncio.Task[_T]) -> tuple[_T, asyncio.CancelledError | None]:
    """Join an already-started ledger write despite repeated cancellation.

    ``shield`` protects the child once. The loop is what protects it from a
    second (or later) ``Task.cancel()`` while the caller is joining the first
    cancellation. Cancellation is remembered and propagated only after the
    durable child has completed.
    """
    cancelled: asyncio.CancelledError | None = None
    while True:
        try:
            return await asyncio.shield(task), cancelled
        except asyncio.CancelledError as error:
            cancelled = cancelled or error
            if task.done():
                return task.result(), cancelled


def build_llm(
    session_factory: async_sessionmaker,
    settings: LlmSettings,
    roles: Roles,
    *,
    provider: ProviderPort | None = None,
) -> LlmClient:
    """The one entry point apps wire. The default adapter targets OpenRouter;
    injected ProviderPort implementations make other routes explicit."""
    provider = provider or OpenRouterAdapter(settings)
    specs: dict[str, ModelSpec] = {}
    for role in roles.by_name.values():
        # transports × the role's own output contract must resolve (incl. the
        # strict projection audit) — a chain that cannot run fails at wiring,
        # not on the first paid call. Per-call output= overrides re-resolve.
        _resolve_transports(role, role.output)
        for spec in role.chain:
            previous = specs.get(spec.slug)
            if previous is not None and previous.prices != spec.prices:
                raise ValueError(
                    f"model {spec.slug!r} has conflicting prices across roles; "
                    "model slugs used by the spend ledger must have one price"
                )
            specs[spec.slug] = spec
    capture = CaptureStore(session_factory)
    spend = SpendTracker(session_factory, settings, specs)
    return LlmClient(provider, capture, spend, roles, settings)

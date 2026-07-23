"""Two-phase hypothesis generation.

The one-shot generator asks a model to emit a whole nested experiment plan in a
single JSON object that must decode AND compile — brittle for models weak at
deep structured output. This generator splits the job the way the reliability
study found robust across providers:

  Phase 1 (propose)  — a small structured call for the hypothesis itself
                       (claim, severity, description) plus a *loose* tool sketch.
                       The sketch may be wrong; phase 2 fixes it.
  Phase 2 (build)    — an agentic tool-calling loop (kit run_agent) that
                       constructs each setup tool, validated per call by the REAL
                       oracle (experiments.BUILDERS + compile_experiment) with
                       precise semantic feedback, then finalizes the single
                       trigger. Turn budget scales ~3x the proposed tool count.

It implements the same HypothesisGenerator port as KitHypothesisGenerator and is
wired as the fallback that rescues the routes one-shot can't arm (see
FallbackHypothesisGenerator). Per-model reasoning/output knobs live in
llm_runtime; this module holds no provider policy.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from kit_llm import LlmClient, Tool
from kit_llm.errors import BudgetExhausted, EndOfRope, LoopBudgetExceeded, OutputInvalid
from kit_llm.tools import ToolCallError

from .config import Settings
from .contract.models import Claim, EntryPoints, FocusRange, Hypothesis, ToolCall
from .errors import AuditIncompleteError
from .experiments import (
    BUILDERS,
    EXPERIMENT_CODE_GUIDANCE,
    TOOL_CATALOG,
    ExperimentCompileError,
    compile_experiment,
)
from .observation import dry_run_load
from .phases import (
    ClaimKind,
    Flag,
    Gating,
    PackageIntent,
    Severity,
    StrictLlmOutput,
    _safe_file,
    number_lines,
    trigger_targets,
)

DRIVER_PATH = "/pkg/npmguard-driver.js"
_JS = re.compile(r"\b(?:const|let|var|require|import|function|=>)\b|[;{}]")
_CI_GUARD = re.compile(r"if\s*\(\s*process\.env\.CI\s*\)")


def _looks_like_js(text: str) -> bool:
    return "\n" in text or bool(_JS.search(text))


# --- phase 1: the hypothesis + a loose tool sketch (sketch may be wrong) -------


class HypothesisProposal(StrictLlmOutput):
    description: str
    kind: ClaimKind
    gating: Gating | None
    severity: Severity
    triggerTargetIntent: str
    plannedTools: list[str]
    rationale: str


# --- phase 2: model-facing tool params (map to the real builder arg shapes) ----


class _Kv(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    value: str


class SetEnvArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    vars: list[_Kv]


class _FileSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    content: str


class PlantFilesArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    files: list[_FileSpec]


class _Stub(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pattern: str
    responseStatus: int = 200
    responseBody: str = "ok"
    responseHeaders: list[_Kv] = Field(default_factory=list)


class StubUrlArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stubs: list[_Stub]


class _Replacement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pattern: str
    replacement: str


class _Patch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    replacements: list[_Replacement]


class PatchFileArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patches: list[_Patch]


class PreloadArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str


class SetDateArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    iso: str


class FinalizeArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = "entrypoint"
    target: str
    driverCode: str | None = None
    argv: list[str] = Field(default_factory=list)
    stdin: str | None = None


class TwoPhaseHypothesisGenerator:
    """Propose-then-build hypothesis generation behind the HypothesisGenerator
    port. Requires `propose` and `agent` roles on the LlmClient."""

    def __init__(self, llm: LlmClient, settings: Settings) -> None:
        self.llm = llm
        self.settings = settings

    async def generate(
        self,
        flag: Flag,
        *,
        package_path: Path,
        intent: PackageIntent,
        entry_points: EntryPoints,
        hypothesis_id: str,
        created_at: str,
        audit_id: str,
    ) -> Hypothesis:
        try:
            contents = _safe_file(package_path, flag.file).read_text(encoding="utf-8")
        except OSError:
            contents = ""
        focus = contents[:40_000]
        targets = trigger_targets(flag, entry_points)
        numbered = number_lines(focus)
        base = (
            f"## Package intent (benign baseline)\n{intent.statedPurpose}\n\n"
            f"## Flag\n- file: {flag.file}\n- lines: {', '.join(flag.lines)}\n- why: {flag.why}\n\n"
            f"## Flagged code\n```\n{numbered[:6000]}\n```\n\n"
            f"## Setup tools\n{TOOL_CATALOG}\n"
        )

        try:
            proposal = await self._propose(base, targets, audit_id)
            calls = await self._build(base, proposal, targets, focus, audit_id, package_path)
        except BudgetExhausted:
            raise
        except AuditIncompleteError:
            raise
        except Exception as exc:  # noqa: BLE001 — normalize to the phase error
            raise AuditIncompleteError(
                "hypothesize",
                f"agentic build failed to arm {flag.file} ({flag.why}): {exc}",
            ) from exc

        return Hypothesis(
            hypId=hypothesis_id,
            description=proposal.description,
            claim=Claim(kind=proposal.kind, gating=proposal.gating),
            focusFiles=[flag.file],
            focusLines=[FocusRange(file=flag.file, range=line) for line in flag.lines],
            experiment=calls,
            severity=proposal.severity,
            parentHypId=None,
            childHypIds=[],
            state="OPEN",
            createdBy="hypothesize",
            evidenceRefs=[],
            createdAt=created_at,
            resolvedAt=None,
            resolution=None,
        )

    async def _propose(self, base: str, targets: list[str], audit_id: str) -> HypothesisProposal:
        prompt = base + (
            "\nPropose ONE experiment. State the malicious claim to test, its kind, gating and "
            "severity, a one-line description, exactly which trigger target you will invoke "
            f"(one of {targets}, or describe custom JS driver code), and a loose list of the setup "
            "tools you expect to use. The tool list is a sketch — do not write tool arguments yet."
        )
        try:
            result = await self.llm.run(
                "propose",
                vars={},
                messages=[{"role": "user", "content": prompt}],
                context=("audit", audit_id),
            )
        except (OutputInvalid, EndOfRope) as exc:
            raise AuditIncompleteError(
                "hypothesize", f"proposal did not produce a valid hypothesis: {exc}"
            ) from exc
        return result.output

    async def _build(
        self,
        base: str,
        proposal: HypothesisProposal,
        targets: list[str],
        focus: str,
        audit_id: str,
        package_path: Path,
    ) -> list[ToolCall]:
        accumulated: list[ToolCall] = []
        done: dict[str, list[ToolCall]] = {}

        def add(tool: str, args: dict) -> str:
            try:
                BUILDERS[tool](args)  # the real per-tool oracle
            except ExperimentCompileError as exc:
                raise ToolCallError(str(exc)) from exc
            accumulated.append(ToolCall(tool=tool, args=args))
            return f"OK: {tool} accepted. setup so far = {[c.tool for c in accumulated]}."

        async def h_env(a: SetEnvArgs) -> str:
            env: dict[str, str] = {}
            for kv in a.vars:
                if kv.name in env:
                    raise ToolCallError(f"duplicate env var {kv.name!r}")
                env[kv.name] = kv.value
            if _CI_GUARD.search(focus) and env.get("CI"):
                raise ToolCallError(
                    "CI is tested by JS truthiness; omit CI or set it to '' — never 'false' "
                    "(any non-empty string is truthy)."
                )
            return add("setEnv", {"env": env})

        async def h_plant(a: PlantFilesArgs) -> str:
            return add("plantFiles", {"files": [f.model_dump() for f in a.files]})

        async def h_stub(a: StubUrlArgs) -> str:
            stubs = [
                {
                    "pattern": s.pattern,
                    "responseStatus": s.responseStatus,
                    "responseBody": s.responseBody,
                    "responseHeaders": {kv.name: kv.value for kv in s.responseHeaders}
                    or {"Content-Type": "text/plain"},
                }
                for s in a.stubs
            ]
            return add("stubUrl", {"stubs": stubs})

        async def h_patch(a: PatchFileArgs) -> str:
            return add(
                "patchFile",
                {
                    "patches": [
                        {"path": p.path, "replacements": [r.model_dump() for r in p.replacements]}
                        for p in a.patches
                    ]
                },
            )

        async def h_preload(a: PreloadArgs) -> str:
            return add("preload", {"code": a.code})

        async def h_date(a: SetDateArgs) -> str:
            return add("setDate", {"iso": a.iso})

        async def h_finalize(a: FinalizeArgs) -> str:
            target = a.target.strip()
            for pre in ("runtime:", "install:", "bin:", "subpath:"):
                if target.startswith(pre):
                    target = target[len(pre):].strip()
            calls = list(accumulated)
            if a.driverCode or (target not in targets and _looks_like_js(target)):
                code = a.driverCode or target
                if any(c.tool == "plantFiles" and any(
                    f.get("path") == DRIVER_PATH for f in (c.args or {}).get("files", [])
                ) for c in calls):
                    raise ToolCallError(f"driver already planted at {DRIVER_PATH}")
                calls.append(ToolCall(tool="plantFiles", args={"files": [{"path": DRIVER_PATH, "content": code}]}))
                target = DRIVER_PATH
            elif target not in targets:
                raise ToolCallError(
                    f"target {a.target!r} is not a valid entry point. Choose exactly one of "
                    f"{targets}, or pass driverCode with a JavaScript program that exercises "
                    "the behavior."
                )
            calls.append(
                ToolCall(
                    tool="trigger",
                    args={"kind": a.kind or "entrypoint", "target": target,
                          "argv": a.argv, "stdin": a.stdin},
                )
            )
            try:
                compile_experiment(calls)
            except ExperimentCompileError as exc:
                raise ToolCallError(f"cannot finalize: {exc}") from exc
            # Compiling proves the tool shape; a dry-run proves the payload LOADS.
            # A bad require in the driver/preload only shows up here — feed it back so
            # the model fixes the path rather than deferring an inert run downstream.
            load_failure = await dry_run_load(package_path, calls, self.settings)
            if load_failure is not None:
                raise ToolCallError(
                    f"the experiment does not load: {load_failure.detail} — fix the offending "
                    "require in your driver or preload (use './file.js' or '/pkg/file.js', never a "
                    "bare 'file.js'), then finalize again."
                )
            done["calls"] = calls
            return "ARMED: experiment compiled and loaded — you are done."

        tools = (
            Tool("setEnv", SetEnvArgs, h_env, "Inject env vars (plant creds / defeat env gates)."),
            Tool("plantFiles", PlantFilesArgs, h_plant, "Seed absolute-path files with bait content."),
            Tool("stubUrl", StubUrlArgs, h_stub, "Return canned HTTP responses for URL patterns."),
            Tool("patchFile", PatchFileArgs, h_patch, "Exact-string rewrites of package files."),
            Tool("preload", PreloadArgs, h_preload, "Inject a Node preload script."),
            Tool("setDate", SetDateArgs, h_date, "Freeze wall-clock at an ISO timestamp."),
            Tool(
                "finalize", FinalizeArgs, h_finalize,
                "Set the single trigger and compile. Call LAST. target = one existing entry point, "
                "or pass driverCode with custom JS.",
            ),
        )
        n_tools = max(1, len([t for t in proposal.plannedTools if t]))
        budget = min(24, max(10, 3 * (n_tools + 2)))
        prompt = base + (
            f"\n## Proposal\nclaim: {proposal.kind}\nseverity: {proposal.severity}\n"
            f"description: {proposal.description}\ntarget intent: {proposal.triggerTargetIntent}\n"
            f"planned tools: {proposal.plannedTools}\nrationale: {proposal.rationale}\n\n"
            f"## Valid trigger targets\n{targets}\n\n"
            "Build the experiment by calling setup tools (each is validated — I return a precise "
            "error if wrong; fix and retry), then you MUST call `finalize` exactly once with the "
            "trigger. You may call several setup tools in one turn. The run is complete only once "
            "`finalize` returns ARMED — do not stop before that. Escape newlines in every JSON "
            f"string. Keep the experiment minimal.\n\n{EXPERIMENT_CODE_GUIDANCE}"
        )
        async def drive(message: str, steps: int) -> None:
            try:
                await self.llm.run_agent(
                    "agent",
                    tools=tools,
                    vars={},
                    messages=[{"role": "user", "content": message}],
                    max_steps=steps,
                    context=("audit", audit_id),
                )
            except BudgetExhausted:
                raise
            except LoopBudgetExceeded:
                pass  # inspected via `done` below

        await drive(prompt, budget)
        if "calls" not in done:
            # Some models stop (answer) with the bait set up but the trigger never
            # called. One explicit, bounded nudge naming exactly what's missing —
            # not a fabricated trigger; the model still chooses the target.
            nudge = (
                f"You set up {[c.tool for c in accumulated]} but never armed the experiment. "
                f"Call `finalize` NOW — exactly once — with target one of {targets} (or pass "
                "driverCode with custom JS). Do nothing else."
            )
            await drive(nudge, 4)

        if "calls" not in done:
            raise AuditIncompleteError(
                "hypothesize", "agent finished without a compiled trigger"
            )
        return done["calls"]


class FallbackHypothesisGenerator:
    """Union of hypothesis approaches. Try the primary; if it cannot ARM a flag,
    the secondary retries with a different strategy. Mirrors the measured result
    that no single approach wins every model — one-shot is strong for most
    routes, the agentic loop rescues one-shot-weak ones. Budget exhaustion is
    terminal and is never retried."""

    def __init__(self, primary, secondary) -> None:
        self.primary = primary
        self.secondary = secondary

    async def generate(self, flag: Flag, **kwargs) -> Hypothesis:
        try:
            return await self.primary.generate(flag, **kwargs)
        except BudgetExhausted:
            raise
        except AuditIncompleteError:
            return await self.secondary.generate(flag, **kwargs)

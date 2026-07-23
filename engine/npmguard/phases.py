from __future__ import annotations

import asyncio
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol, get_args

from pydantic import BaseModel, ConfigDict, Field, create_model, field_validator, model_validator
from pydantic.json_schema import SkipJsonSchema

from kit_llm import BudgetExhausted, CandidateRejected, EndOfRope, LlmClient, OutputInvalid

from .config import SOURCE_FILE_TYPES, Settings
from .contract.models import (
    Claim,
    EntryPoints,
    FileSummary,
    FocusRange,
    Hypothesis,
    InventoryReport,
    ToolCall,
)
from .errors import AuditIncompleteError
from .events import AuditEmitter
from .experiments import EXPERIMENT_CODE_GUIDANCE, TOOL_CATALOG, compile_experiment
from .observation import dry_run_load

Capability = Literal[
    "NETWORK",
    "DATA_EXFILTRATION",
    "DNS_EXFIL",
    "DOM_INJECT",
    "FILESYSTEM",
    "BINARY_DOWNLOAD",
    "PROCESS_SPAWN",
    "ENV_VARS",
    "CREDENTIAL_THEFT",
    "EVAL",
    "OBFUSCATION",
    "ENCRYPTED_PAYLOAD",
    "DOS_LOOP",
    "ANTI_AI_PROMPT",
    "GEO_GATING",
    "LIFECYCLE_HOOK",
    "WORM_PROPAGATION",
    "CLIPBOARD_HIJACK",
    "TELEMETRY_RAT",
    "BUILD_PLUGIN_EXFIL",
    "NPM_TOKEN_ABUSE",
]
CAPABILITY_VALUES = frozenset(get_args(Capability))
ClaimKind = Literal[
    "env_exfil",
    "cred_theft",
    "binary_drop",
    "obfuscation",
    "persistence",
    "destructive",
    "propagation",
    "dos_loop",
    "clipboard_hijack",
    "dom_inject",
    "telemetry",
    "dns_exfil",
    "build_plugin_exfil",
]
Gating = Literal["time_gate", "geo_gate", "ci_gate", "inspector_gate", "docker_gate"]
Severity = Literal["low", "medium", "high", "critical"]


class PackageIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    statedPurpose: str
    expectedCapabilities: list[str] = Field(max_length=12)
    rationale: str
    # Off-wire marker (SkipJsonSchema keeps it out of the LLM contract): True
    # only for fallback_intent, so the trace/report records that this intent
    # was NOT LLM-validated. See the INVARIANT in extract_intent.
    degraded: SkipJsonSchema[bool] = False


class FlagDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lines: list[str] = Field(
        min_length=1,
        max_length=12,
        description="Compact 1-based line ranges only (for example 12-18), never copied source text.",
    )
    why: str

    @model_validator(mode="before")
    @classmethod
    def normalize_provider_shape(cls, value):
        """Accept common near-miss shapes, then emit the canonical contract.

        OpenAI-compatible providers receive the JSON schema, but some models
        still rename `lines`/`why` during an otherwise valid response. Keeping
        this normalization at the LLM boundary lets Kit validate and capture a
        typed result without weakening the report schema downstream.
        """
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        if "lines" not in normalized:
            if "lineRanges" in normalized:
                normalized["lines"] = normalized["lineRanges"]
            elif "line_range" in normalized:
                normalized["lines"] = normalized["line_range"]
            elif "start_line" in normalized:
                end = normalized.get("end_line", normalized["start_line"])
                normalized["lines"] = f"{normalized['start_line']}-{end}"
        if "why" not in normalized:
            normalized["why"] = (
                normalized.get("description") or normalized.get("reason") or normalized.get("flag")
            )
        for alias in (
            "lineRanges",
            "line_range",
            "start_line",
            "end_line",
            "description",
            "reason",
            "flag",
        ):
            normalized.pop(alias, None)
        return normalized

    @field_validator("lines", mode="before")
    @classmethod
    def normalize_lines(cls, value):
        values = [value] if isinstance(value, (str, int)) else value
        if not isinstance(values, list):
            return values
        normalized = []
        for item in values:
            if isinstance(item, int):
                normalized.append(f"{item}-{item}")
            elif (
                isinstance(item, (list, tuple))
                and len(item) == 2
                and all(isinstance(part, int) for part in item)
            ):
                normalized.append(f"{item[0]}-{item[1]}")
            elif isinstance(item, str):
                stripped = item.strip()
                if match := re.fullmatch(r"(\d+)\s*-\s*(\d+)", stripped):
                    normalized.append(f"{match.group(1)}-{match.group(2)}")
                elif match := (
                    re.fullmatch(r"(\d+)", stripped)
                    or re.match(r"(\d+)\s*:.*", stripped, re.S)
                ):
                    normalized.append(f"{match.group(1)}-{match.group(1)}")
                else:
                    normalized.append(stripped)
            else:
                raise ValueError(f"invalid line range {item!r}")
        return normalized


class FileFlagResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    capabilities: list[Capability]
    flags: list[FlagDraft] = Field(max_length=8)

    @model_validator(mode="before")
    @classmethod
    def normalize_bounded_response(cls, value):
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        capabilities = normalized.get("capabilities", [])
        if isinstance(capabilities, dict):
            capabilities = [name for name, enabled in capabilities.items() if enabled]
        if isinstance(capabilities, list):
            normalized["capabilities"] = [
                item for item in capabilities if item in CAPABILITY_VALUES
            ][:12]
        flags = normalized.get("flags")
        if isinstance(flags, list):
            normalized["flags"] = flags[:8]
        return normalized


class JudgeVerdict(BaseModel):
    model_config = ConfigDict(extra="forbid")

    malicious: bool
    reason: str
    citedEvents: list[str]


class Flag(BaseModel):
    file: str
    lines: list[str]
    why: str


class FlagOutput(BaseModel):
    flags: list[Flag]
    fileSummaries: list[FileSummary]


class StrictLlmOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EnvVarDraft(StrictLlmOutput):
    name: str = Field(
        description="Environment variable name. Never set CI to the string 'false'; JavaScript treats it as truthy."
    )
    value: str


class PlantFileSpec(StrictLlmOutput):
    path: str
    content: str


class HeaderDraft(StrictLlmOutput):
    name: str
    value: str


class StubSpec(StrictLlmOutput):
    pattern: str
    responseStatus: int
    responseBody: str
    responseHeaders: list[HeaderDraft]


class Replacement(StrictLlmOutput):
    pattern: str
    replacement: str


class PatchSpec(StrictLlmOutput):
    path: str
    replacements: list[Replacement] = Field(min_length=1)


class ClaimDraft(StrictLlmOutput):
    kind: ClaimKind
    gating: Gating | None


class ExperimentSetupPlan(StrictLlmOutput):
    environment: list[EnvVarDraft] = Field(
        description="Only variables that must be injected. Omit CI when the sandbox already starts without it."
    )
    files: list[PlantFileSpec]
    dateIso: str | None
    urlStubs: list[StubSpec]
    filePatches: list[PatchSpec]
    preloadCode: str | None


def hypothesis_submission(targets: list[str]) -> type[BaseModel]:
    return create_model(
        "HypothesisPlan",
        __base__=StrictLlmOutput,
        description=(str, ...),
        claim=(ClaimDraft, ...),
        severity=(Severity, ...),
        setup=(ExperimentSetupPlan, ...),
        triggerTarget=(
            str,
            Field(
                description=(
                    "Exact existing entry point to execute, one of: "
                    + ", ".join(targets)
                    + ". If custom invocation code is needed, return that JavaScript here; "
                    "the application will plant and execute /pkg/npmguard-driver.js."
                )
            ),
        ),
    )


def number_lines(contents: str) -> str:
    return "\n".join(f"{index + 1}: {line}" for index, line in enumerate(contents.splitlines()))


async def _gather_fail_fast(coroutines) -> None:
    """Cancel sibling model calls as soon as one phase item fails.

    asyncio.gather propagates the first exception but otherwise leaves sibling
    awaitables running. For concurrent LLM phases that turns one deterministic
    contract failure into many billed calls.
    """
    tasks = [asyncio.create_task(coroutine) for coroutine in coroutines]
    try:
        await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


README_CANDIDATES = (
    "README.md",
    "README.MD",
    "Readme.md",
    "readme.md",
    "README",
    "README.markdown",
    "README.txt",
)
CRITICAL_SUMMARY = (
    re.compile(r"\bcredential(?:s)?\s+(?:theft|stealer|harvesting|exfiltration)\b", re.I),
    re.compile(
        r"\b(?:steals?|harvests?|exfiltrat(?:es|ed|ing|ion))\b.*\b(?:credentials?|secrets?|tokens?|keys?|env(?:ironment)?|npm|aws|ssh|kube|docker|metadata|imds)\b",
        re.I,
    ),
    re.compile(
        r"\b(?:ssh\s+keys?|aws\s+credentials?|npm\s+tokens?|github\s+tokens?|cloud\s+metadata|imds)\b",
        re.I,
    ),
    re.compile(r"\b(?:malware|trojan|supply\s+chain\s+attack)\b", re.I),
)


def find_readme(package_path: Path, inventory: InventoryReport) -> str | None:
    docs = {file.path for file in inventory.files if file.fileType == "doc" and not file.isBinary}
    for candidate in README_CANDIDATES:
        if candidate not in docs:
            continue
        try:
            content = (package_path / candidate).read_text(encoding="utf-8")
        except OSError:
            continue
        return (
            content
            if len(content) <= 16_000
            else content[:16_000] + f"\n\n[... truncated, original was {len(content)} bytes ...]"
        )
    return None


def fallback_intent(inventory: InventoryReport) -> PackageIntent:
    description = (inventory.metadata.description or "").strip()
    return PackageIntent(
        statedPurpose=description or "(no stated purpose — package omitted description and README)",
        expectedCapabilities=[],
        rationale="No LLM-derived intent available; downstream analysis must treat any capability as potentially surprising.",
        degraded=True,
    )


async def extract_intent(
    package_path: Path, inventory: InventoryReport, llm: LlmClient, audit_id: str
) -> PackageIntent:
    metadata = inventory.metadata
    readme = find_readme(package_path, inventory)
    dependencies = list((inventory.dependencies.get("prod") or {}).keys())
    prompt = (
        f"## Package manifest\n- name: {metadata.name or 'unknown'}\n- version: {metadata.version or 'unknown'}\n- description: {metadata.description or '(none)'}\n- license: {metadata.license or 'unknown'}\n- homepage: {metadata.homepage or '(none)'}\n- keywords: {', '.join(metadata.keywords or []) or '(none)'}\n\n"
        f"## Runtime dependencies\n{', '.join(dependencies) or '(none)'}\n\n## Declared bin entries\n{', '.join(inventory.entryPoints.bin) or '(none)'}\n\n"
        f"## README\n{readme or '(no README found)'}\n\n## Task\nInfer statedPurpose, a conservative expectedCapabilities list, and rationale."
    )
    try:
        result = await llm.run(
            "intent",
            vars={},
            messages=[{"role": "user", "content": prompt}],
            context=("audit", audit_id),
        )
        return PackageIntent.model_validate(result.output)
    except (EndOfRope, OutputInvalid):
        # INVARIANT: intent is either LLM-validated or explicitly degraded=True.
        # Only kit's retryable provider classes (chain exhausted / no surviving
        # candidate) fall back; BudgetExhausted, cancellation, and code bugs
        # propagate — the same budget-terminal discipline as the hypothesize
        # phases (see KitHypothesisGenerator.generate).
        return fallback_intent(inventory)


def _safe_file(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise AuditIncompleteError("flag", f"file escapes package root: {relative}")
    return path


async def run_flag(
    package_path: Path,
    inventory: InventoryReport,
    intent: PackageIntent,
    llm: LlmClient,
    audit_id: str,
    emitter: AuditEmitter | None = None,
) -> FlagOutput:
    def noise(path: str) -> bool:
        return bool(
            path.endswith(".d.ts")
            or re.search(r"(^|/)(test|tests|__tests__|__mocks__)/", path)
            or re.search(r"\.(test|spec)\.(js|ts|mjs|cjs|tsx|mts)$", path)
        )

    source_files = [
        file
        for file in inventory.files
        if file.fileType in SOURCE_FILE_TYPES and not file.isBinary and not noise(file.path)
    ]
    facts: dict[str, list[str]] = {}
    for flag in inventory.flags:
        if flag.file:
            facts.setdefault(flag.file, []).append(f"[{flag.severity}] {flag.check}: {flag.detail}")
    responses: list[tuple[str, FileFlagResponse] | None] = [None] * len(source_files)
    semaphore = asyncio.Semaphore(max(1, int(os.environ.get("NPMGUARD_TRIAGE_CONCURRENCY", "8"))))
    complete = 0
    lock = asyncio.Lock()

    async def analyze(index: int) -> None:
        nonlocal complete
        file = source_files[index]
        async with semaphore:
            try:
                contents = _safe_file(package_path, file.path).read_text(encoding="utf-8")
            except OSError as exc:
                raise AuditIncompleteError(
                    "flag", f"could not analyze {file.path}: file-unreadable"
                ) from exc
            if len(contents) > 500_000:
                kb = round(len(contents) / 1024)
                response = FileFlagResponse(
                    summary=f"File is {kb}KB — too large for the FLAG read",
                    capabilities=[],
                    flags=[
                        FlagDraft(
                            lines=["1-1"],
                            why=f"File {file.path} is {kb}KB — too large to read statically; needs a dynamic run to inspect.",
                        )
                    ],
                )
            elif not contents.strip():
                response = FileFlagResponse(summary="Empty file", capabilities=[], flags=[])
            else:
                if emitter:
                    await emitter.emit("file_analyzing", {"file": file.path})
                prompt = f"## Package intent\n- statedPurpose: {intent.statedPurpose}\n- expectedCapabilities: {', '.join(intent.expectedCapabilities) or '(none)'}\n- rationale: {intent.rationale}\n\n## File: {file.path}\n```\n{number_lines(contents)}\n```"
                if facts.get(file.path):
                    prompt += "\n\n## Structural facts\n" + "\n".join(facts[file.path])
                prompt += (
                    "\n\n## Task\nReturn a compact summary, only security capabilities from the supplied enum, "
                    "and at most 8 highest-signal thin flags with compact exact ranges such as 12-18. "
                    "Do not flag ordinary logging, feature detection, regular expressions, encoding, or environment access "
                    "when it is intrinsic to the stated purpose and does not handle secrets or evade analysis."
                )

                def validate_response(candidate: FileFlagResponse) -> None:
                    source_lines = contents.splitlines()
                    line_count = max(1, len(source_lines))
                    for draft in candidate.flags:
                        canonical: list[str] = []
                        for line_range in draft.lines:
                            match = re.fullmatch(r"(\d+)-(\d+)", line_range)
                            if match is None:
                                snippet = line_range.strip()
                                matches = [
                                    index
                                    for index, source in enumerate(source_lines, 1)
                                    if source.strip() == snippet
                                ]
                                if not matches and snippet:
                                    matches = [
                                        index
                                        for index, source in enumerate(source_lines, 1)
                                        if snippet in source
                                    ]
                                if not matches:
                                    raise CandidateRejected(
                                        f"line value {line_range!r} is neither a range nor source text from the file"
                                    )
                                canonical.extend(f"{index}-{index}" for index in matches[:1])
                                continue
                            start, end = map(int, match.groups())
                            if start < 1 or end < start or end > line_count:
                                raise CandidateRejected(
                                    f"line range {line_range!r} is outside 1-{line_count}"
                                )
                            canonical.append(f"{start}-{end}")
                        draft.lines = list(dict.fromkeys(canonical))
                    if not candidate.flags and any(
                        pattern.search(candidate.summary) for pattern in CRITICAL_SUMMARY
                    ):
                        raise CandidateRejected(
                            "summary describes credential theft or exfiltration but flags is empty"
                        )

                try:
                    result = await llm.run(
                        "flag",
                        vars={},
                        messages=[{"role": "user", "content": prompt}],
                        validate=validate_response,
                        context=("audit", audit_id),
                    )
                    response = FileFlagResponse.model_validate(result.output)
                except Exception as exc:
                    raise AuditIncompleteError(
                        "flag", f"could not analyze {file.path}: model call failed: {exc}"
                    ) from exc
            responses[index] = (file.path, response)
            async with lock:
                complete += 1
                if emitter:
                    await emitter.emit(
                        "triage_progress",
                        {"current": complete, "total": len(source_files), "file": file.path},
                    )

    await _gather_fail_fast(analyze(index) for index in range(len(source_files)))
    flags, summaries = [], []
    for item in responses:
        assert item is not None
        file, response = item
        summaries.append(
            FileSummary(file=file, summary=response.summary, capabilities=response.capabilities)
        )
        flags.extend(Flag(file=file, lines=draft.lines, why=draft.why) for draft in response.flags)
    return FlagOutput(flags=flags, fileSummaries=summaries)


def trigger_targets(flag: Flag, entry_points: EntryPoints) -> list[str]:
    return list(
        dict.fromkeys([*entry_points.runtime, *entry_points.install, *entry_points.bin, flag.file])
    )


class HypothesisGenerator(Protocol):
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
    ) -> Hypothesis: ...


class KitHypothesisGenerator:
    """Replaceable adapter for the pending Kit hypothesis-generation update."""

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
        focus = contents[:40_000] + ("\n… (truncated)" if len(contents) > 40_000 else "")
        targets = trigger_targets(flag, entry_points)
        output = hypothesis_submission(targets)
        prompt = (
            f"## Package intent\n- statedPurpose: {intent.statedPurpose}\n- expectedCapabilities: {', '.join(intent.expectedCapabilities) or '(none)'}\n\n"
            f"## Flag\n- file: {flag.file}\n- lines: {', '.join(flag.lines)}\n- why: {flag.why}\n\n"
            f"## Entry points\n- install: {', '.join(entry_points.install) or '(none)'}\n- runtime: {', '.join(entry_points.runtime) or '(none)'}\n- bin: {', '.join(entry_points.bin) or '(none)'}\n\n"
            f"## Flagged code\n### {flag.file}\n```\n{number_lines(focus)}\n```\n\n## Available setup mechanisms\n{TOOL_CATALOG}\n\n"
            "Return one JSON plan matching the supplied schema. Use empty arrays or null for setup mechanisms that are not needed. "
            f"Set triggerTarget to exactly one of: {', '.join(targets)}. If exercising a library API requires custom JavaScript, "
            "put that program in triggerTarget; it will be planted as /pkg/npmguard-driver.js and executed inside the sandbox. "
            "The sandbox starts without CI; do not inject CI='false' to defeat a truthiness gate because non-empty strings are truthy in JavaScript.\n\n"
            f"{EXPERIMENT_CODE_GUIDANCE}\n\n"
            "Suggested bait canary: NPMGUARD_CANARY_TOKEN_f8e2d91a"
        )

        def decode_plan(submission: BaseModel) -> tuple[BaseModel, list[ToolCall]]:
            setup = submission.setup
            calls: list[ToolCall] = []
            target = submission.triggerTarget.strip()
            for prefix in ("runtime:", "install:", "bin:"):
                if target.startswith(prefix):
                    target = target[len(prefix) :].strip()
            driver_code: str | None = None
            if target not in targets:
                if "\n" in target or re.search(r"\b(?:const|let|var|require|import)\b|[;{}]", target):
                    driver_code = target
                    target = "/pkg/npmguard-driver.js"
                else:
                    raise CandidateRejected(
                        f"triggerTarget must be one of {targets!r} or contain a JavaScript driver"
                    )
            if setup.environment:
                env: dict[str, str] = {}
                for item in setup.environment:
                    if item.name in env:
                        raise CandidateRejected(f"duplicate environment variable {item.name!r}")
                    env[item.name] = item.value
                if re.search(r"if\s*\(\s*process\.env\.CI\s*\)", focus) and env.get("CI"):
                    raise CandidateRejected(
                        "CI is tested by JavaScript truthiness; omit CI or set it to an empty string, never 'false'"
                    )
                calls.append(ToolCall(tool="setEnv", args={"env": env}))
            files = [item.model_dump(mode="json") for item in setup.files]
            if driver_code is not None:
                if any(item["path"] == target for item in files):
                    raise CandidateRejected(f"duplicate planted driver path {target!r}")
                files.append({"path": target, "content": driver_code})
            if files:
                calls.append(
                    ToolCall(
                        tool="plantFiles",
                        args={"files": files},
                    )
                )
            if setup.dateIso is not None:
                calls.append(ToolCall(tool="setDate", args={"iso": setup.dateIso}))
            if setup.urlStubs:
                stubs = []
                for stub in setup.urlStubs:
                    headers: dict[str, str] = {}
                    for header in stub.responseHeaders:
                        if header.name in headers:
                            raise CandidateRejected(f"duplicate response header {header.name!r}")
                        headers[header.name] = header.value
                    stubs.append(
                        {
                            "pattern": stub.pattern,
                            "responseStatus": stub.responseStatus,
                            "responseBody": stub.responseBody,
                            "responseHeaders": headers,
                        }
                    )
                calls.append(ToolCall(tool="stubUrl", args={"stubs": stubs}))
            if setup.filePatches:
                calls.append(
                    ToolCall(
                        tool="patchFile",
                        args={
                            "patches": [
                                patch.model_dump(mode="json") for patch in setup.filePatches
                            ]
                        },
                    )
                )
            if setup.preloadCode is not None:
                calls.append(ToolCall(tool="preload", args={"code": setup.preloadCode}))
            calls.append(
                ToolCall(
                    tool="trigger",
                    args={
                        "kind": "entrypoint",
                        "target": target,
                        "argv": [],
                        "stdin": None,
                    },
                )
            )
            compile_experiment(calls)
            return submission, calls

        try:
            result = await self.llm.run(
                "hypothesis",
                vars={},
                messages=[{"role": "user", "content": prompt}],
                output=output,
                decode=decode_plan,
                context=("audit", audit_id),
            )
            submission, calls = result.output
        except BudgetExhausted:
            raise  # spend exhaustion is terminal — never retried by the fallback
        except Exception as exc:
            raise AuditIncompleteError(
                "hypothesize", f"could not arm {flag.file} ({flag.why}) after bounded repair: {exc}"
            ) from exc
        # The one-shot decode has no repair channel for a payload that compiles but
        # cannot load. Fail over to the agentic generator, which dry-runs and repairs.
        load_failure = await dry_run_load(package_path, calls, self.settings)
        if load_failure is not None:
            raise AuditIncompleteError(
                "hypothesize",
                f"one-shot experiment for {flag.file} did not load: {load_failure.detail}",
            )
        return Hypothesis(
            hypId=hypothesis_id,
            description=submission.description,
            claim=Claim(kind=submission.claim.kind, gating=submission.claim.gating),
            focusFiles=[flag.file],
            focusLines=[FocusRange(file=flag.file, range=line) for line in flag.lines],
            experiment=calls,
            severity=submission.severity,
            parentHypId=None,
            childHypIds=[],
            state="OPEN",
            createdBy="hypothesize",
            evidenceRefs=[],
            createdAt=created_at,
            resolvedAt=None,
            resolution=None,
        )


async def run_hypothesize(
    flags: list[Flag],
    generator: HypothesisGenerator,
    *,
    package_path: Path,
    intent: PackageIntent,
    entry_points: EntryPoints,
    audit_id: str,
    emitter: AuditEmitter | None = None,
) -> list[Hypothesis]:
    created_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    output: list[Hypothesis | None] = [None] * len(flags)
    semaphore = asyncio.Semaphore(max(1, int(os.environ.get("NPMGUARD_TRIAGE_CONCURRENCY", "8"))))

    async def arm(index: int) -> None:
        flag = flags[index]
        hypothesis_id = f"hyp-{index + 1:04d}"
        async with semaphore:
            if emitter:
                await emitter.emit("file_analyzing", {"file": flag.file})
            hypothesis = await generator.generate(
                flag,
                package_path=package_path,
                intent=intent,
                entry_points=entry_points,
                hypothesis_id=hypothesis_id,
                created_at=created_at,
                audit_id=audit_id,
            )
            output[index] = hypothesis
            if emitter:
                await emitter.emit(
                    "hypothesis_emitted",
                    {
                        "hypId": hypothesis_id,
                        "claim": hypothesis.claim.kind,
                        "severity": hypothesis.severity,
                        "file": flag.file,
                    },
                )

    await _gather_fail_fast(arm(index) for index in range(len(flags)))
    hypotheses: list[Hypothesis] = []
    for item in output:
        # INVARIANT: _gather_fail_fast returned without raising, so every flag
        # is armed — len(hypotheses) == len(flags) (mirrors run_flag). A None
        # here would be a silently dropped suspicion: a hidden coverage gap
        # that could launder into a false SAFE.
        assert item is not None
        hypotheses.append(item)
    return hypotheses

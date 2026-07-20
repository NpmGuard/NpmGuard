from __future__ import annotations

import asyncio
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal, Protocol

from pydantic import BaseModel, Field, create_model, field_validator, model_validator

from kit_llm import LlmClient

from .config import SOURCE_FILE_TYPES
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
from .experiments import TOOL_CATALOG, compile_experiment

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
    statedPurpose: str
    expectedCapabilities: list[Capability]
    rationale: str


class FlagDraft(BaseModel):
    lines: list[str] = Field(min_length=1)
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
            else:
                normalized.append(item)
        return normalized


class FileFlagResponse(BaseModel):
    summary: str
    capabilities: list[str] = Field(default_factory=list)
    flags: list[FlagDraft] = Field(default_factory=list)


class JudgeVerdict(BaseModel):
    malicious: bool
    reason: str
    citedEvents: list[str] = Field(default_factory=list)


class Flag(BaseModel):
    file: str
    lines: list[str]
    why: str


class FlagOutput(BaseModel):
    flags: list[Flag]
    fileSummaries: list[FileSummary]


class SetEnvCall(BaseModel):
    tool: Literal["setEnv"]
    env: dict[str, str]


class PlantFileSpec(BaseModel):
    path: str
    content: str


class PlantFilesCall(BaseModel):
    tool: Literal["plantFiles"]
    files: list[PlantFileSpec] = Field(min_length=1)


class SetDateCall(BaseModel):
    tool: Literal["setDate"]
    iso: str


class StubSpec(BaseModel):
    pattern: str
    responseStatus: int | None = None
    responseBody: str | None = None
    responseHeaders: dict[str, str] | None = None


class StubUrlCall(BaseModel):
    tool: Literal["stubUrl"]
    stubs: list[StubSpec] = Field(min_length=1)


class Replacement(BaseModel):
    pattern: str
    replacement: str


class PatchSpec(BaseModel):
    path: str
    replacements: list[Replacement] = Field(min_length=1)


class PatchFileCall(BaseModel):
    tool: Literal["patchFile"]
    patches: list[PatchSpec] = Field(min_length=1)


class PreloadCall(BaseModel):
    tool: Literal["preload"]
    code: str


SetupCall = Annotated[
    SetEnvCall | PlantFilesCall | SetDateCall | StubUrlCall | PatchFileCall | PreloadCall,
    Field(discriminator="tool"),
]


class ClaimDraft(BaseModel):
    kind: ClaimKind
    gating: Gating | None = None


def hypothesis_submission(targets: list[str]) -> type[BaseModel]:
    target_literal = Literal.__getitem__(tuple(targets))
    trigger = create_model("HypothesisTrigger", target=(target_literal, ...))
    return create_model(
        "HypothesisSubmission",
        description=(str, ...),
        claim=(ClaimDraft, ...),
        severity=(Severity, ...),
        setup=(list[SetupCall], ...),
        trigger=(trigger, ...),
    )


def number_lines(contents: str) -> str:
    return "\n".join(f"{index + 1}: {line}" for index, line in enumerate(contents.splitlines()))


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
    except Exception:
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
            or re.search(r"(^|/)(__tests__|__mocks__)/", path)
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
                    flags=[
                        FlagDraft(
                            lines=["1-1"],
                            why=f"File {file.path} is {kb}KB — too large to read statically; needs a dynamic run to inspect.",
                        )
                    ],
                )
            elif not contents.strip():
                response = FileFlagResponse(summary="Empty file")
            else:
                if emitter:
                    await emitter.emit("file_analyzing", {"file": file.path})
                prompt = f"## Package intent\n- statedPurpose: {intent.statedPurpose}\n- expectedCapabilities: {', '.join(intent.expectedCapabilities) or '(none)'}\n- rationale: {intent.rationale}\n\n## File: {file.path}\n```\n{number_lines(contents)}\n```"
                if facts.get(file.path):
                    prompt += "\n\n## Structural facts\n" + "\n".join(facts[file.path])
                prompt += "\n\n## Task\nReturn summary, capabilities, and zero or more thin flags with exact line ranges."
                try:
                    result = await llm.run(
                        "flag",
                        vars={},
                        messages=[{"role": "user", "content": prompt}],
                        context=("audit", audit_id),
                    )
                    response = FileFlagResponse.model_validate(result.output)
                except Exception as exc:
                    raise AuditIncompleteError(
                        "flag", f"could not analyze {file.path}: model call failed: {exc}"
                    ) from exc
                if not response.flags and any(
                    pattern.search(response.summary) for pattern in CRITICAL_SUMMARY
                ):
                    raise AuditIncompleteError(
                        "flag",
                        f'{file.path}: summary describes a risk but emitted no flag — "{response.summary[:160]}"',
                    )
            responses[index] = (file.path, response)
            async with lock:
                complete += 1
                if emitter:
                    await emitter.emit(
                        "triage_progress",
                        {"current": complete, "total": len(source_files), "file": file.path},
                    )

    await asyncio.gather(*(analyze(index) for index in range(len(source_files))))
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

    def __init__(self, llm: LlmClient) -> None:
        self.llm = llm

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
            f"## Flagged code\n### {flag.file}\n```\n{number_lines(focus)}\n```\n\n## Available tools\n{TOOL_CATALOG}\n\nSuggested bait canary: NPMGUARD_CANARY_TOKEN_f8e2d91a"
        )
        try:
            result = await self.llm.run(
                "hypothesis",
                vars={},
                messages=[{"role": "user", "content": prompt}],
                output=output,
                output_transport="tool",
                context=("audit", audit_id),
            )
            submission = result.output
            calls = []
            for setup in submission.setup:
                value = setup.model_dump(mode="json", exclude_none=True)
                name = value.pop("tool")
                calls.append(ToolCall(tool=name, args=value))
            calls.append(
                ToolCall(
                    tool="trigger",
                    args={
                        "kind": "entrypoint",
                        "target": submission.trigger.target,
                        "argv": [],
                        "stdin": None,
                    },
                )
            )
            compile_experiment(calls)
        except Exception as exc:
            raise AuditIncompleteError(
                "hypothesize", f"could not arm {flag.file} ({flag.why}) after bounded repair: {exc}"
            ) from exc
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

    await asyncio.gather(*(arm(index) for index in range(len(flags))))
    return [hypothesis for hypothesis in output if hypothesis is not None]

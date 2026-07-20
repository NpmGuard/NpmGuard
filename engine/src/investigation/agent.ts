import { generateText, generateObject, tool, stepCountIs } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import { getModel } from "../llm.js";
import type { InvestigationAgentOutput, InvestigationInput, ToolCallRecord } from "../models.js";
import type { AuditLogger } from "../audit-log.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import { readFileImpl, listFilesImpl, searchFilesImpl, searchInFileImpl } from "./tools-read.js";
import { evalJsImpl, requireAndTraceImpl, runLifecycleHookImpl, fastForwardTimersImpl } from "./tools-execute.js";
import type { DockerSandboxController } from "../sandbox/controller.js";
import type { EmitFn } from "../events.js";
import { repairInvestigationExtraction } from "./extraction.js";

const StructuredInvestigationOutput = z.object({
  findings: z.array(z.object({
    capability: z.string().min(1),
    confidence: z.enum(["CONFIRMED", "LIKELY", "SUSPECTED"]),
    fileLine: z.string().min(1),
    problem: z.string().min(1),
    evidence: z.string().min(1),
    reproductionStrategy: z.string().min(1),
  })),
  summary: z.string(),
});

export async function runInvestigationAgent(
  input: InvestigationInput,
  sandbox: DockerSandboxController,
  lifecycleHooks: Record<string, string>,
  emit?: EmitFn,
  log?: AuditLogger,
): Promise<InvestigationAgentOutput> {
  const model = getModel(config.investigationModel);
  const packagePath = input.packagePath;

  const tools = {
    readFile: tool({
      description: "Read a file from the package. Path is relative to package root.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => readFileImpl(packagePath, path),
    }),
    listFiles: tool({
      description: "List all files in the package with sizes and extensions.",
      inputSchema: z.object({}),
      execute: async () => listFilesImpl(packagePath),
    }),
    searchFiles: tool({
      description: "Regex search across all text files in the package. Returns matches with surrounding context.",
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) => searchFilesImpl(packagePath, pattern),
    }),
    searchInFile: tool({
      description:
        "Regex search INSIDE ONE file (byte-offset based). Use this on big obfuscated bundles (>1MB, minified single-line files like bun_environment.js) — it returns 200 chars of surrounding context per match. Far more efficient than evalJs chunked-reads for finding URLs, API keys, decoder symbols, fs paths, etc. in obfuscated payloads.",
      inputSchema: z.object({ path: z.string(), pattern: z.string() }),
      execute: async ({ path, pattern }) => searchInFileImpl(packagePath, path, pattern),
    }),
    evalJs: tool({
      description:
        'Execute a JavaScript snippet in the sandbox for deobfuscation. ' +
        "e.g., evalJs({ code: \"console.log(atob('Y2hpbGRf...'))\" }) to decode base64. " +
        "Returns stdout + stderr. Hard timeout applies.",
      inputSchema: z.object({ code: z.string() }),
      execute: async ({ code }) => evalJsImpl(sandbox, code),
    }),
    requireAndTrace: tool({
      description:
        "Load a package entry point with full Node.js instrumentation. " +
        "Monkey-patches require, fs, http, child_process, process.env, crypto, eval, timers. " +
        "Returns a structured trace log. Entrypoint relative to package root (e.g. 'index.js').",
      inputSchema: z.object({ entrypoint: z.string() }),
      execute: async ({ entrypoint }) => requireAndTraceImpl(sandbox, entrypoint),
    }),
    runLifecycleHook: tool({
      description:
        "Run a lifecycle script (preinstall, postinstall, install, prepare) with instrumentation. " +
        "Only allowed hook names are accepted.",
      inputSchema: z.object({ hookName: z.string() }),
      execute: async ({ hookName }) => runLifecycleHookImpl(sandbox, hookName, lifecycleHooks),
    }),
    fastForwardTimers: tool({
      description:
        "Load the package with fake timers, then advance time by advanceMs milliseconds. " +
        "Use to trigger time-gated payloads (e.g., setTimeout with 48h delay). " +
        "Entrypoint relative to package root.",
      inputSchema: z.object({
        entrypoint: z.string(),
        advanceMs: z.number(),
      }),
      execute: async ({ entrypoint, advanceMs }) =>
        fastForwardTimersImpl(sandbox, entrypoint, advanceMs),
    }),
  };

  // Collect tool call records for observability
  const toolCallRecords: ToolCallRecord[] = [];
  // Full untruncated results for file logging
  const fullToolResults: { tool: string; args: unknown; result: string; reasoning: string }[] = [];
  let stepIndex = 0;

  console.log(`[agent] starting investigation of ${input.packageName || "unknown"}`);
  log?.writeLog("agent_prompt.md", `# System Prompt\n\n${SYSTEM_PROMPT}\n\n# User Prompt\n\n${buildUserPrompt(input)}`);

  emit?.("agent_thinking", { step: 0 });

  // Step 1: Multi-turn investigation with tool use
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    tools,
    stopWhen: stepCountIs(config.maxAgentTurns),
    onStepFinish({ toolCalls, toolResults, text }) {
      stepIndex++;
      console.log(`[agent] ── step ${stepIndex} ──`);

      // Log each tool call and its result
      for (const tc of toolCalls) {
        const argsStr = JSON.stringify(tc.input).slice(0, 200);
        console.log(`[agent]   → ${tc.toolName}(${argsStr})`);

        emit?.("agent_tool_call", { tool: tc.toolName, args: tc.input as Record<string, unknown>, step: stepIndex });

        const tr = toolResults.find(
          (r: { toolCallId: string }) => r.toolCallId === tc.toolCallId,
        );
        const resultStr = tr ? String(tr.output) : "(no result)";
        const preview = resultStr.slice(0, 500);
        const injectionDetected = resultStr.includes("[REDACTED: potential prompt injection");

        console.log(`[agent]   ← ${resultStr.length}B${injectionDetected ? " [INJECTION_REDACTED]" : ""}`);
        // Show first few lines of the result for quick visibility
        const previewLines = preview.split("\n").slice(0, 6);
        for (const line of previewLines) {
          console.log(`[agent]     ${line}`);
        }
        if (resultStr.length > 500) {
          console.log(`[agent]     ... (${resultStr.length - 500} more bytes)`);
        }

        emit?.("agent_tool_result", { tool: tc.toolName, resultPreview: preview, step: stepIndex, injectionDetected });

        toolCallRecords.push({
          tool: tc.toolName,
          args: tc.input as Record<string, unknown>,
          resultPreview: preview,
          timestamp: new Date().toISOString(),
          injectionDetected,
        });

        // Save full untruncated result
        fullToolResults.push({
          tool: tc.toolName,
          args: tc.input,
          result: resultStr,
          reasoning: text || "",
        });
      }

      // Log agent reasoning between tool calls
      if (text) {
        console.log(`[agent]   reasoning: ${text.slice(0, 500)}`);
        if (text.length > 500) {
          console.log(`[agent]   ... (${text.length - 500} more chars)`);
        }
        emit?.("agent_reasoning", { text: text.slice(0, 2000), step: stepIndex });
      }

      // Signal that the LLM is thinking again for the next step
      emit?.("agent_thinking", { step: stepIndex + 1 });
    },
  });

  console.log(`[agent] investigation complete — ${result.steps.length} steps, ${toolCallRecords.length} tool calls`);

  // Save full untruncated agent conversation to file
  log?.writeLog("agent_steps.json", fullToolResults);

  // Log the agent's final text response
  if (result.text) {
    console.log(`[agent] final response (${result.text.length} chars):`);
    const lines = result.text.slice(0, 1000).split("\n").slice(0, 15);
    for (const line of lines) {
      console.log(`[agent]   ${line}`);
    }
    if (result.text.length > 1000) {
      console.log(`[agent]   ... (${result.text.length - 1000} more chars)`);
    }
  }

  log?.writeLog("agent_response.md", result.text);

  // Build concise tool context for the extraction LLM
  const toolCallLog: string[] = [];
  for (const tc of toolCallRecords) {
    toolCallLog.push(`[${tc.tool}](${JSON.stringify(tc.args).slice(0, 200)}) → ${tc.resultPreview.slice(0, 300)}`);
  }
  const toolContext = toolCallLog.length > 0
    ? `\n\nTool call log (${toolCallLog.length} calls):\n${toolCallLog.join("\n")}`
    : "";

  // Step 2: Extract structured findings from the conversation
  console.log("[agent] extracting structured findings...");
  const extractionPrompt =
    "Based on the investigation below, extract all findings as structured data.\n\n" +
    "Only include suspicious or malicious behaviors as findings. " +
    "Do not include absence-of-risk, benign explanations, legitimate feature use, type-only files, or performance-only observations as findings; put those in the summary. " +
    "If no suspicious behavior remains, return findings: [].\n\n" +
    "For every finding, all six fields are required:\n" +
    "- capability: exactly one canonical capability label, never a comma-separated list\n" +
    "- confidence: preserve the investigation's CONFIRMED, LIKELY, or SUSPECTED value\n" +
    "- fileLine: the concrete file and line or byte-offset range\n" +
    "- problem: a concise description of the suspicious source-to-impact behavior\n" +
    "- evidence: exact source snippets or runtime trace observations that support the problem\n" +
    "- reproductionStrategy: a separate, safe way to verify the behavior\n\n" +
    "Never leave problem, evidence, or reproductionStrategy empty. " +
    "Do not copy reproduction instructions into evidence. " +
    "A benchmark marker or dataset label is context, not security evidence.\n\n" +
    `Investigation result:\n${result.text}${toolContext}`;
  console.log(`[agent] extraction prompt: ${extractionPrompt.length} chars (${toolCallLog.length} tool calls included)`);

  log?.writeLog("extraction_prompt.md", extractionPrompt);

  // Bound the extraction LLM call so a hung response can't park the whole
  // pipeline past the upstream phase timeout. Observed in bench v9 on the
  // `mgc` audit: agent finished, extraction never returned, pipeline-level
  // timeout fired eventually but bench polling gave up first.
  const EXTRACTION_TIMEOUT_MS = 90_000;
  const extractionTimer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
  const rawExtraction = await Promise.race([
    generateObject({
      model,
      schema: StructuredInvestigationOutput,
      prompt: extractionPrompt,
    }),
    new Promise<never>((_, reject) => {
      extractionTimer.id = setTimeout(
        () => reject(new Error(`extraction generateObject timed out after ${EXTRACTION_TIMEOUT_MS}ms`)),
        EXTRACTION_TIMEOUT_MS,
      );
    }),
  ]).finally(() => {
    if (extractionTimer.id) clearTimeout(extractionTimer.id);
  }).catch((err) => {
    console.warn(`[agent] extraction failed: ${err instanceof Error ? err.message : String(err)} — recovering grounded fields from agent response`);
    return null;
  });
  const extraction = repairInvestigationExtraction(rawExtraction?.object ?? null, result.text);

  console.log(`[agent] extraction complete — ${extraction.findings.length} findings`);
  for (const f of extraction.findings) {
    console.log(`[agent]   [${f.confidence}] ${f.capability} @ ${f.fileLine}: ${f.problem.slice(0, 120)}`);
  }

  log?.writeLog("extraction_result.json", extraction);

  return {
    ...extraction,
    toolCalls: toolCallRecords,
    agentText: result.text,
  };
}

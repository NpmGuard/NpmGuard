/**
 * Record a demo replay — runs a real audit and captures the event stream + files.
 *
 * Usage:  npx tsx scripts/record-demo.ts <packageName> [version]
 *
 * Requires: ANTHROPIC_API_KEY (or configured LLM backend) + Docker running.
 * Output:   demo-data/<packageName>.json
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { runAudit } from "../src/pipeline.js";
import type { AuditEvent } from "../src/events.js";

const packageName = process.argv[2];
const version = process.argv[3];

const EXPECTED_CONTROL_VERDICTS: Record<string, "SAFE" | "DANGEROUS"> = {
  react: "SAFE",
  "test-pkg-dom-inject": "DANGEROUS",
  "test-pkg-env-exfil": "DANGEROUS",
};

if (!packageName) {
  console.error("Usage: npx tsx scripts/record-demo.ts <packageName> [version]");
  process.exit(1);
}

// Catch unhandled rejections so we see the full stack
process.on("unhandledRejection", (err) => {
  console.error("[record] unhandled rejection:", err);
  process.exit(1);
});

console.log(`[record] Starting audit for ${packageName}${version ? `@${version}` : ""}...`);
console.log(`[record] LLM backend: ${process.env.NPMGUARD_LLM_BACKEND || "anthropic"}`);
console.log(`[record] Time: ${new Date().toISOString()}`);

const events: AuditEvent[] = [];
let seq = 0;
let lastPhase = "";

// Capture all events
const emit = (type: string, payload: Record<string, unknown>) => {
  const event: AuditEvent = {
    type,
    auditId: "recording",
    timestamp: new Date().toISOString(),
    seq: seq++,
    ...payload,
  };
  events.push(event);

  // Log with context
  let detail = "";
  if (type === "phase_started") {
    lastPhase = String(payload.phase);
    detail = ` → ${lastPhase}`;
  } else if (type === "phase_completed") {
    detail = ` (${lastPhase}, ${payload.durationMs}ms)`;
  } else if (type === "file_analyzing") {
    detail = ` ${payload.file}`;
  } else if (type === "finding_discovered") {
    const f = payload.finding as Record<string, unknown>;
    detail = ` [${f.confidence}] ${f.capability}`;
  } else if (type === "verdict_reached") {
    detail = ` ${payload.verdict} (${payload.proofCount} proofs)`;
  } else if (type === "audit_error") {
    detail = ` ERROR: ${payload.error}`;
  } else if (type === "agent_tool_call") {
    detail = ` ${payload.tool}(${JSON.stringify(payload.args).slice(0, 60)})`;
  } else if (type === "verify_test_result") {
    detail = ` ${payload.testFile}: ${payload.status}`;
  }

  console.log(`  [${String(seq).padStart(3)}] ${type}${detail}`);
};

const startTime = Date.now();

try {
  const { report, packagePath, cleanup } = await runAudit(packageName, emit, undefined, version);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[record] Audit complete in ${elapsed}s: ${report.verdict}`);
  console.log(`[record] ${events.length} events, ${report.proofs?.length ?? 0} proofs`);

  const expectedVerdict = EXPECTED_CONTROL_VERDICTS[packageName];
  const hasConfirmedProof = report.proofs.some((proof) => proof.kind === "TEST_CONFIRMED");
  if (
    (expectedVerdict && report.verdict !== expectedVerdict) ||
    (expectedVerdict === "DANGEROUS" && !hasConfirmedProof)
  ) {
    cleanup();
    throw new Error(
      `Refusing to overwrite the ${packageName} control demo: expected ${expectedVerdict}` +
        `${expectedVerdict === "DANGEROUS" ? " with a TEST_CONFIRMED proof" : ""}, ` +
        `received ${report.verdict} with ${report.proofs.length} proof(s).`,
    );
  }

  // Read file contents from the extracted package
  const fileListEvent = events.find((e) => e.type === "file_list") as AuditEvent & { files: Array<{ path: string; isBinary: boolean }> } | undefined;
  const files: Record<string, string> = {};

  if (fileListEvent) {
    for (const f of fileListEvent.files) {
      if (f.isBinary) continue;
      const absPath = path.join(packagePath, f.path);
      try {
        files[f.path] = fs.readFileSync(absPath, "utf-8");
      } catch (err) {
        console.warn(`[record] could not read ${f.path}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`[record] ${Object.keys(files).length}/${fileListEvent.files.length} files captured`);
  }

  // Write recording
  const recording = {
    packageName,
    version: version || "latest",
    recordedAt: new Date().toISOString(),
    events,
    files,
    report,
  };

  const outDir = path.resolve(import.meta.dirname, "../demo-data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${packageName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(recording, null, 2));

  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`[record] Written to ${outPath} (${sizeKB} KB)`);

  cleanup();
  process.exit(0);
} catch (err) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n[record] FAILED after ${elapsed}s, ${events.length} events captured so far`);
  console.error(`[record] Last phase: ${lastPhase}`);
  if (err instanceof Error) {
    console.error(`[record] Error: ${err.message}`);
    console.error(err.stack);
  } else {
    console.error("[record] Error:", err);
  }
  process.exit(1);
}

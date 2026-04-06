import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditReport } from "./models.js";
import type { AuditEvent } from "./events.js";
import { createSession, createEmitFn, finalizeSession } from "./events.js";

// ---------------------------------------------------------------------------
// Recording format
// ---------------------------------------------------------------------------

interface DemoRecording {
  packageName: string;
  version: string;
  recordedAt: string;
  events: AuditEvent[];
  files: Record<string, string>;
  report: AuditReport;
}

// ---------------------------------------------------------------------------
// Load recordings from demo-data/ at startup
// ---------------------------------------------------------------------------

const recordings = new Map<string, DemoRecording>();

const DEMO_DATA_DIR = path.resolve(import.meta.dirname, "../demo-data");

if (fs.existsSync(DEMO_DATA_DIR)) {
  for (const file of fs.readdirSync(DEMO_DATA_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(DEMO_DATA_DIR, file), "utf-8");
      const recording: DemoRecording = JSON.parse(raw);
      recordings.set(recording.packageName, recording);
      console.log(`[demo] loaded recording: ${recording.packageName} (${recording.events.length} events, ${Object.keys(recording.files).length} files)`);
    } catch (err) {
      console.warn(`[demo] failed to load ${file}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAvailableDemos(): string[] {
  return [...recordings.keys()];
}

const SPEED_MULTIPLIER = 1.0;
const MIN_DELAY_MS = 10;
const MAX_DELAY_MS = 4000;

// Minimum delays for event types that should feel substantive
const MIN_TYPE_DELAY: Record<string, number> = {
  phase_started: 400,
  file_analyzing: 600,
  file_verdict: 300,
  agent_thinking: 500,
  agent_tool_call: 400,
  agent_tool_result: 500,
  agent_reasoning: 800,
  finding_discovered: 600,
  triage_complete: 500,
  verdict_reached: 800,
  verify_test_result: 700,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startReplay(packageName: string): { auditId: string; packageName: string } {
  const recording = recordings.get(packageName);
  if (!recording) {
    throw new Error(`No demo recording for "${packageName}"`);
  }

  const session = createSession(packageName);
  session.fileContents = recording.files;
  session.packagePath = "__demo__";

  // Replay events asynchronously with timing
  replayEvents(session.auditId, session.emitter, recording).catch((err) => {
    console.error(`[demo] replay error for ${packageName}:`, err);
  });

  return { auditId: session.auditId, packageName };
}

async function replayEvents(
  auditId: string,
  emitter: import("node:events").EventEmitter,
  recording: DemoRecording,
): Promise<void> {
  const emit = createEmitFn(auditId, emitter);
  const events = recording.events;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    // Compute delay: use original timestamps, enforce per-type minimums
    const typeMin = MIN_TYPE_DELAY[event.type] ?? MIN_DELAY_MS;
    if (i > 0) {
      const prev = new Date(events[i - 1]!.timestamp).getTime();
      const curr = new Date(event.timestamp).getTime();
      let delay = Math.max(typeMin, curr - prev);
      delay = Math.min(MAX_DELAY_MS, delay);
      delay = Math.round(delay / SPEED_MULTIPLIER);
      await sleep(delay);
    }

    // Emit with the original payload (emit() stamps fresh auditId, timestamp, seq)
    const { type, auditId: _a, timestamp: _t, seq: _s, ...payload } = event;
    emit(type, payload);
  }

  // Finalize session with saved report
  finalizeSession(auditId, recording.report);
}

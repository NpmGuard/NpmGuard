import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AuditReport } from "./models.js";

// Re-export shared event types — the authoritative definitions live in
// @npmguard/shared. Legacy engine-side short names (AuditStarted,
// FileList, …) are aliased to the new *Event names to avoid churn in
// existing call sites under engine/src/**.
export type {
  BaseAuditEvent,
  AuditStartedEvent,
  PhaseStartedEvent,
  PhaseCompletedEvent,
  FileListEvent,
  FileAnalyzingEvent,
  FileVerdictEvent,
  TriageCompleteEvent,
  TriageProgressEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentReasoningEvent,
  AgentThinkingEvent,
  FindingDiscoveredEvent,
  VerdictReachedEvent,
  InventoryMetaEvent,
  VerifyStartedEvent,
  VerifyTestResultEvent,
  AuditErrorEvent,
  AuditEventUnion,
  AuditEventType,
  EmitFn,
} from "@npmguard/shared";

export { EVENT_TYPES } from "@npmguard/shared";

import type { AuditEventUnion, EmitFn } from "@npmguard/shared";

/** Structural alias for any SSE event — accepts the typed union or a loose
 *  ad-hoc event emitted via `EmitFn` for event types not yet in the shared
 *  discriminated union (e.g., verify_attempt, verify_regenerating). */
export type AuditEvent =
  | AuditEventUnion
  | {
      type: string;
      auditId: string;
      timestamp: string;
      seq: number;
      [key: string]: unknown;
    };

export function createEmitFn(auditId: string, emitter: EventEmitter): EmitFn {
  return (type: string, payload: Record<string, unknown>) => {
    const event = {
      type,
      auditId,
      timestamp: new Date().toISOString(),
      seq: -1, // overwritten when pushed into eventBuffer
      ...payload,
    };
    emitter.emit("event", event);
  };
}

export function setSessionPackagePath(auditId: string, packagePath: string): void {
  const session = sessions.get(auditId);
  if (session) session.packagePath = packagePath;
}

// ---------------------------------------------------------------------------
// Session store — engine-internal, tracks live audits and buffers SSE events
// ---------------------------------------------------------------------------

export interface AuditSession {
  auditId: string;
  emitter: EventEmitter;
  eventBuffer: AuditEvent[];
  packagePath: string | null;
  report: AuditReport | null;
  status: "running" | "done" | "error";
  cleanupFn: (() => void) | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  fileContents: Record<string, string> | null;
}

const sessions = new Map<string, AuditSession>();

const SESSION_TTL_MS = 30 * 60_000; // 30 minutes after completion
const MAX_SESSIONS = 100;
const MAX_EVENT_BUFFER = 5000;

/** Evict the oldest finalized session to make room for a new one. */
function evictOldestFinalized(): boolean {
  for (const [id, s] of sessions) {
    if (s.status !== "running") {
      if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
      if (s.cleanupFn) s.cleanupFn();
      sessions.delete(id);
      return true;
    }
  }
  return false;
}

export function createSession(packageName: string): AuditSession {
  // Enforce session limit — evict finalized sessions first
  if (sessions.size >= MAX_SESSIONS) {
    if (!evictOldestFinalized()) {
      throw new Error("Too many concurrent audit sessions");
    }
  }

  void packageName;
  const auditId = randomUUID();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  const session: AuditSession = {
    auditId,
    emitter,
    eventBuffer: [],
    packagePath: null,
    report: null,
    status: "running",
    cleanupFn: null,
    cleanupTimer: null,
    fileContents: null,
  };
  // Buffer all events so late-connecting SSE clients can replay them
  emitter.on("event", (event: AuditEvent) => {
    if (session.eventBuffer.length < MAX_EVENT_BUFFER) {
      event.seq = session.eventBuffer.length; // stamp with stable buffer index
      session.eventBuffer.push(event);
    }
  });
  sessions.set(auditId, session);
  return session;
}

export function getSession(auditId: string): AuditSession | undefined {
  return sessions.get(auditId);
}

export function setSessionCleanup(auditId: string, cleanupFn: () => void): void {
  const session = sessions.get(auditId);
  if (session) session.cleanupFn = cleanupFn;
}

export function finalizeSession(auditId: string, report: AuditReport | null, error?: string): void {
  const session = sessions.get(auditId);
  if (!session) {
    console.warn(`[events] finalizeSession called for unknown session: ${auditId}`);
    return;
  }
  session.report = report;
  session.status = error ? "error" : "done";
  // Schedule cleanup of the session and package files
  session.cleanupTimer = setTimeout(() => {
    if (session.cleanupFn) session.cleanupFn();
    sessions.delete(auditId);
  }, SESSION_TTL_MS);
}

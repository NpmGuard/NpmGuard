/**
 * The pure SSE event fold. All audit-stream state transitions live here —
 * the Zustand store is a thin shell that pipes events through this reducer.
 *
 * Invariants:
 * - Pure: (state, event) → state. No IO, no time reads, no globals.
 * - Idempotent under replay: reconnect resumes from a seq cursor (the engine
 *   reads Last-Event-ID / ?since), but a duplicate seq is always a no-op, so a
 *   full-buffer replay would fold identically.
 * - Unknown event types are ignored, never fatal (forward compatibility): the
 *   engine may add event types ahead of this file.
 * - Terminal events (verdict_reached | audit_error) end the run; later
 *   non-terminal events are ignored.
 */

import type {
  AuditEvent,
  FileRecord,
  FileVerdict,
  HypothesisCounts,
  HypothesisState,
  InventoryMeta,
  TriageHypothesis,
  Verdict,
} from "./engine-types.ts";
import {
  LIFECYCLE_SCRIPTS,
  PHASE_LABELS,
  PHASE_ORDER,
  RISK_SUSPICIOUS_THRESHOLD,
  riskContributionToStatus,
  type FileStatus,
  type PhaseInfo,
  type PipelineLogEntry,
} from "./types.ts";

export interface TriageSummary {
  hypothesisCount: number;
  hypotheses: TriageHypothesis[];
}

/** A hypothesis as tracked across its lifecycle (emitted → resolved). */
export interface HypothesisView {
  hypId: string;
  claim: string;
  severity: string;
  description: string;
  file?: string;
  state: HypothesisState;
  reason?: string;
}

export interface DepsInfo {
  installed: boolean;
  packageCount: number;
  skipped: string | null;
}

export interface AuditFoldState {
  packageName: string;
  running: boolean;
  /** seq numbers already folded — the replay/duplicate guard */
  seenSeqs: ReadonlySet<number>;

  phase: string | null;
  phases: PhaseInfo[];
  triageProgress: { current: number; total: number } | null;

  files: FileRecord[];
  fileStatuses: Record<string, FileStatus>;
  fileVerdicts: Record<string, FileVerdict>;
  inventoryMeta: InventoryMeta | null;
  deps: DepsInfo | null;
  statedPurpose: string | null;
  expectedCapabilities: string[];

  pipelineLog: PipelineLogEntry[];
  triage: TriageSummary | null;
  hypotheses: HypothesisView[];

  verdict: Verdict | null;
  verdictRationale: string | null;
  counts: HypothesisCounts | null;
  confirmedCount: number;

  /** file the UI should auto-open (set during the flag phase) */
  followFile: string | null;

  error: string | null;
  errorCode: string | null;
  errorRetryable: boolean;
}

export function initialFoldState(): AuditFoldState {
  return {
    packageName: "",
    running: true,
    seenSeqs: new Set(),
    phase: null,
    phases: PHASE_ORDER.map((name) => ({ name, status: "pending" })),
    triageProgress: null,
    files: [],
    fileStatuses: {},
    fileVerdicts: {},
    inventoryMeta: null,
    deps: null,
    statedPurpose: null,
    expectedCapabilities: [],
    pipelineLog: [],
    triage: null,
    hypotheses: [],
    verdict: null,
    verdictRationale: null,
    counts: null,
    confirmedCount: 0,
    followFile: null,
    error: null,
    errorCode: null,
    errorRetryable: false,
  };
}

function log(
  state: AuditFoldState,
  entry: Omit<PipelineLogEntry, "timestamp">,
  timestamp: string,
): PipelineLogEntry[] {
  return [...state.pipelineLog, { ...entry, timestamp }];
}

function markPhase(phases: PhaseInfo[], name: string, patch: Partial<PhaseInfo>): PhaseInfo[] {
  if (!phases.some((p) => p.name === name)) {
    // Phases outside PHASE_ORDER are appended so progress never lies about
    // what ran.
    return [...phases, { name, status: "pending", ...patch }];
  }
  return phases.map((p) => (p.name === name ? { ...p, ...patch } : p));
}

function upsertHypothesis(list: HypothesisView[], hyp: HypothesisView): HypothesisView[] {
  const idx = list.findIndex((h) => h.hypId === hyp.hypId);
  if (idx === -1) return [...list, hyp];
  const next = list.slice();
  next[idx] = { ...next[idx], ...hyp };
  return next;
}

const TERMINAL_TYPES = new Set(["verdict_reached", "audit_error"]);

export function foldAuditEvent(state: AuditFoldState, event: AuditEvent): AuditFoldState {
  if (state.seenSeqs.has(event.seq)) return state;
  if (!state.running && !TERMINAL_TYPES.has(event.type)) return state;

  const seenSeqs = new Set(state.seenSeqs);
  seenSeqs.add(event.seq);
  const base = { ...state, seenSeqs };
  const at = event.timestamp;

  switch (event.type) {
    case "audit_started":
      return { ...base, packageName: event.packageName };

    case "audit_enqueued":
      return {
        ...base,
        pipelineLog: log(base, { kind: "info", text: `Queued · position ${event.queuePosition}` }, at),
      };

    case "phase_started":
      return {
        ...base,
        phase: event.phase,
        phases: markPhase(base.phases, event.phase, { status: "active" }),
        pipelineLog: log(base, { kind: "phase", text: PHASE_LABELS[event.phase] ?? event.phase }, at),
      };

    case "phase_completed":
      return {
        ...base,
        phases: markPhase(base.phases, event.phase, { status: "done", durationMs: event.durationMs }),
      };

    case "dependencies_provisioned": {
      const text = event.skipped
        ? `Dependencies skipped: ${event.skipped}`
        : event.installed
          ? `Installed ${event.packageCount} package${event.packageCount === 1 ? "" : "s"}`
          : "No dependencies to install";
      return {
        ...base,
        deps: { installed: event.installed, packageCount: event.packageCount, skipped: event.skipped },
        pipelineLog: log(base, { kind: "info", text }, at),
      };
    }

    case "file_list": {
      const fileStatuses: Record<string, FileStatus> = {};
      for (const file of event.files) fileStatuses[file.path] = "pending";
      const dirs = new Set(event.files.map((f) => f.path.split("/").slice(0, -1).join("/")));
      return {
        ...base,
        files: event.files,
        fileStatuses,
        pipelineLog: log(
          base,
          { kind: "info", text: `Found ${event.files.length} files across ${dirs.size} director${dirs.size === 1 ? "y" : "ies"}` },
          at,
        ),
      };
    }

    case "inventory_meta": {
      const { type: _type, auditId: _a, timestamp: _t, seq: _s, ...meta } = event;
      let pipelineLog = base.pipelineLog;
      const lifecycle = Object.keys(meta.scripts).filter((s) => LIFECYCLE_SCRIPTS.includes(s));
      if (lifecycle.length > 0) {
        pipelineLog = [
          ...pipelineLog,
          {
            kind: "scripts",
            text: `Lifecycle scripts: ${lifecycle.join(", ")}`,
            scripts: Object.fromEntries(lifecycle.map((s) => [s, meta.scripts[s] ?? ""])),
            timestamp: at,
          },
        ];
      }
      // Group keys are prod/dev/optional/peer (inventory.py) — NOT the
      // package.json field names. Reading `dependencies`/`devDependencies` here
      // made this line report 0 · 0 for every package.
      const prod = Object.keys(meta.dependencies.prod ?? {}).length;
      const dev = Object.keys(meta.dependencies.dev ?? {}).length;
      pipelineLog = [
        ...pipelineLog,
        { kind: "info", text: `${prod} prod · ${dev} dev dependencies`, timestamp: at },
      ];
      return { ...base, inventoryMeta: meta, pipelineLog };
    }

    case "intent_extracted":
      return {
        ...base,
        statedPurpose: event.statedPurpose,
        expectedCapabilities: event.expectedCapabilities,
        pipelineLog: log(base, { kind: "info", text: `Stated purpose: ${event.statedPurpose}` }, at),
      };

    case "file_analyzing":
      return {
        ...base,
        fileStatuses: { ...base.fileStatuses, [event.file]: "analyzing" },
        followFile: base.phase === "flag" ? event.file : base.followFile,
        pipelineLog: log(base, { kind: "file-scan", text: event.file, file: event.file }, at),
      };

    case "triage_progress":
      return { ...base, triageProgress: { current: event.current, total: event.total } };

    case "hypothesis_emitted":
      return {
        ...base,
        hypotheses: upsertHypothesis(base.hypotheses, {
          hypId: event.hypId,
          claim: event.claim,
          severity: event.severity,
          description: "",
          file: event.file,
          state: "OPEN",
        }),
        pipelineLog: log(
          base,
          {
            kind: "hypothesis",
            text: `Hypothesis: ${event.claim} (${event.severity}) in ${event.file}`,
            file: event.file,
          },
          at,
        ),
      };

    case "file_verdict": {
      const verdict = event.verdict;
      const status = riskContributionToStatus(verdict.riskContribution);
      let pipelineLog = base.pipelineLog;
      if (verdict.riskContribution >= RISK_SUSPICIOUS_THRESHOLD) {
        pipelineLog = [
          ...pipelineLog,
          {
            kind: "file-flag",
            text: verdict.summary,
            file: verdict.file,
            risk: verdict.riskContribution,
            timestamp: at,
          },
        ];
      }
      return {
        ...base,
        fileStatuses: { ...base.fileStatuses, [verdict.file]: status },
        fileVerdicts: { ...base.fileVerdicts, [verdict.file]: verdict },
        pipelineLog,
      };
    }

    case "triage_complete": {
      const hypotheses = Array.isArray(event.hypotheses) ? event.hypotheses : [];
      let tracked = base.hypotheses;
      for (const h of hypotheses) {
        tracked = upsertHypothesis(tracked, {
          hypId: h.hypId,
          claim: h.claim,
          severity: h.severity,
          description: h.description,
          state: "OPEN",
        });
      }
      return {
        ...base,
        triage: {
          hypothesisCount:
            typeof event.hypothesisCount === "number" ? event.hypothesisCount : hypotheses.length,
          hypotheses,
        },
        hypotheses: tracked,
        triageProgress: null,
      };
    }

    case "graph_built":
      return {
        ...base,
        pipelineLog: log(
          base,
          {
            kind: "info",
            text: `Evidence graph built · ${event.nodeCount} node${event.nodeCount === 1 ? "" : "s"}`,
          },
          at,
        ),
      };

    case "hypothesis_resolved":
      return {
        ...base,
        hypotheses: upsertHypothesis(base.hypotheses, {
          hypId: event.hypId,
          claim: event.claim,
          severity: event.severity,
          description: "",
          state: event.state,
          reason: event.reason,
        }),
        pipelineLog: log(
          base,
          { kind: "info", text: `Hypothesis ${event.claim} → ${event.state}${event.reason ? `: ${event.reason}` : ""}` },
          at,
        ),
      };

    case "verdict_reached":
      return {
        ...base,
        running: false,
        verdict: event.verdict,
        verdictRationale: event.rationale,
        counts: event.counts,
        confirmedCount: event.confirmedCount,
      };

    case "audit_error":
      return {
        ...base,
        running: false,
        error: event.error ?? "The audit failed",
        errorCode: event.code ?? null,
        errorRetryable: event.retryable ?? false,
        pipelineLog: log(base, { kind: "info", text: `Error: ${event.error ?? "audit failed"}` }, at),
      };

    default:
      // Unknown event type — tolerated for forward compatibility.
      return base;
  }
}

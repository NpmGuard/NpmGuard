import { create } from "zustand";
import type {
  FileRecord,
  FileVerdict,
  FileStatus,
  PhaseInfo,
  AgentStep,
  Finding,
  FocusArea,
  Proof,
  SSEEvent,
  PipelineLogEntry,
  InventoryMeta,
} from "../lib/types";
import { PHASE_ORDER, PHASE_LABELS, LIFECYCLE_SCRIPTS, RISK_SUSPICIOUS_THRESHOLD, riskContributionToStatus, readFileArg } from "../lib/types";

const API_BASE = "/api";

interface AuditState {
  // Audit session
  auditId: string | null;
  packageName: string;
  isRunning: boolean;
  hasStarted: boolean;
  reconnecting: boolean;

  // Pipeline state
  phase: string | null;
  phases: PhaseInfo[];

  // File tree
  files: FileRecord[];
  fileStatuses: Record<string, FileStatus>;
  fileVerdicts: Record<string, FileVerdict>;

  // Triage
  riskScore: number | null;
  riskSummary: string | null;
  focusAreas: FocusArea[];

  // Pipeline activity (early phases)
  pipelineLog: PipelineLogEntry[];

  // Investigation
  agentSteps: AgentStep[];
  findings: Finding[];

  // Verdict
  verdict: "SAFE" | "DANGEROUS" | null;
  capabilities: string[];
  proofCount: number;
  proofs: Proof[];

  // Inventory metadata
  inventoryMeta: InventoryMeta | null;

  // UI state
  selectedFile: string | null;
  selectedFileContent: string | null;
  autoFollow: boolean;
  error: string | null;
  errorCode: string | null;
  errorRetryable: boolean;

  // Animation state
  agentThinking: boolean;
  triageProgress: { current: number; total: number } | null;

  // Checkout state
  checkoutLoading: boolean;

  // Actions
  startAudit: (packageName: string, version?: string) => Promise<void>;
  startDemo: (packageName: string) => Promise<void>;
  startCheckout: (packageName: string, version?: string, email?: string) => Promise<void>;
  startAuditFromCheckout: (sessionId: string) => Promise<void>;
  connectToSession: (auditId: string) => Promise<void>;
  handleEvent: (event: SSEEvent) => void;
  selectFile: (path: string) => Promise<void>;
  reset: () => void;
}

const initialState = {
  auditId: null,
  packageName: "",
  isRunning: false,
  hasStarted: false,
  reconnecting: false,
  phase: null,
  phases: PHASE_ORDER.map((name) => ({ name, status: "pending" as const })),
  files: [],
  fileStatuses: {},
  fileVerdicts: {},
  riskScore: null,
  riskSummary: null,
  focusAreas: [],
  pipelineLog: [],
  agentSteps: [],
  findings: [],
  verdict: null,
  capabilities: [],
  proofCount: 0,
  proofs: [],
  inventoryMeta: null,
  selectedFile: null,
  selectedFileContent: null,
  autoFollow: true,
  error: null,
  errorCode: null,
  errorRetryable: false,
  agentThinking: false,
  triageProgress: null,
  checkoutLoading: false,
};

let activeEventSource: EventSource | null = null;
let activeFileAbort: AbortController | null = null;
// Per-connection seen-set; replaced on every connectSSE call so replays are always fresh
let seenEventSeqs = new Set<number>();
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;

function closeSSE() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
}

function connectSSE(
  auditId: string,
  set: (partial: Partial<AuditState>) => void,
  get: () => AuditState,
) {
  // Close any existing connection first (guards against React Strict Mode double-fire)
  closeSSE();
  // Fresh dedup set per connection — replayed events from the server always start at seq 0
  seenEventSeqs = new Set();
  reconnectAttempts = 0;

  function openConnection() {
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }

    const es = new EventSource(`${API_BASE}/audit/${auditId}/events`);
    activeEventSource = es;

    const handler = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as SSEEvent;
        // Successful message — reset reconnect counter and clear reconnecting state
        if (reconnectAttempts > 0) {
          reconnectAttempts = 0;
          set({ reconnecting: false });
        }
        get().handleEvent(event);
      } catch (err) {
        console.warn("Malformed SSE event, skipping:", err);
      }
    };

    const eventTypes = [
      "audit_started", "phase_started", "phase_completed",
      "file_list", "file_analyzing", "file_verdict",
      "triage_complete", "triage_progress", "inventory_meta",
      "agent_thinking", "agent_tool_call", "agent_tool_result",
      "agent_reasoning", "finding_discovered",
      "verify_started", "verify_test_result",
      "verdict_reached", "audit_error",
    ] as const;
    for (const type of eventTypes) {
      es.addEventListener(type, handler);
    }

    es.onerror = () => {
      es.close();
      activeEventSource = null;

      // Only reconnect if the audit is still supposed to be running
      if (!get().isRunning) return;

      reconnectAttempts++;
      if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
          16_000,
        );
        set({ reconnecting: true });
        reconnectTimer = setTimeout(openConnection, delay);
      } else {
        // All retries exhausted
        set({ isRunning: false, reconnecting: false, error: "Lost connection to audit engine" });
      }
    };
  }

  openConnection();
}

export const useAuditStore = create<AuditState>((set, get) => ({
  ...initialState,

  reset: () => {
    closeSSE();
    set({ ...initialState, phases: PHASE_ORDER.map((name) => ({ name, status: "pending" as const })) });
  },

  startAudit: async (packageName: string, version?: string) => {
    get().reset();
    set({ packageName, isRunning: true, hasStarted: true });

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/audit/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName, ...(version && { version }) }),
      });
    } catch {
      set({ isRunning: false, error: "Failed to connect to audit engine" });
      return;
    }

    if (!res.ok) {
      set({ isRunning: false, error: `Engine returned ${res.status}` });
      return;
    }

    let auditId: string;
    try {
      const body = await res.json();
      auditId = body.auditId;
    } catch {
      set({ isRunning: false, error: "Invalid response from engine" });
      return;
    }
    set({ auditId });

    connectSSE(auditId, set, get);
  },

  startDemo: async (packageName: string) => {
    get().reset();
    set({ packageName, isRunning: true, hasStarted: true });

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/demo/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName }),
      });
    } catch {
      set({ isRunning: false, error: "Failed to connect to audit engine" });
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      set({ isRunning: false, error: body.error || `Demo unavailable (${res.status})` });
      return;
    }

    let auditId: string;
    try {
      const body = await res.json();
      auditId = body.auditId;
    } catch {
      set({ isRunning: false, error: "Invalid response from engine" });
      return;
    }
    set({ auditId });

    connectSSE(auditId, set, get);
  },

  startCheckout: async (packageName: string, version?: string, email?: string) => {
    set({ checkoutLoading: true, error: null });

    try {
      const res = await fetch(`${API_BASE}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageName,
          ...(version && { version }),
          ...(email && { email }),
        }),
      });

      if (res.status === 501) {
        // Payments not configured — fall back to free audit
        set({ checkoutLoading: false });
        return get().startAudit(packageName, version);
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        set({ checkoutLoading: false, error: body.error || `Payment error (${res.status})` });
        return;
      }

      const { url } = await res.json();
      window.location.href = url;
    } catch {
      set({ checkoutLoading: false, error: "Failed to connect to payment system" });
    }
  },

  startAuditFromCheckout: async (sessionId: string) => {
    get().reset();
    set({ isRunning: true, hasStarted: true });

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/audit/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stripeSessionId: sessionId }),
      });
    } catch {
      set({ isRunning: false, error: "Failed to connect to audit engine" });
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      set({ isRunning: false, error: body.error || `Engine returned ${res.status}` });
      return;
    }

    let auditId: string;
    let pkgName: string | undefined;
    try {
      const body = await res.json();
      auditId = body.auditId;
      pkgName = body.packageName;
    } catch {
      set({ isRunning: false, error: "Invalid response from engine" });
      return;
    }

    set({ auditId, ...(pkgName && { packageName: pkgName }) });
    connectSSE(auditId, set, get);
  },

  connectToSession: async (auditId: string) => {
    get().reset();
    set({ auditId, isRunning: true, hasStarted: true });

    // Check if session exists before connecting SSE
    try {
      const res = await fetch(`${API_BASE}/audit/${auditId}/report`);
      if (!res.ok) {
        const msg = res.status === 404
          ? "This audit session has expired or was not found."
          : `Engine returned ${res.status}`;
        // Session truly gone — nothing to show in AuditView
        set({ isRunning: false, hasStarted: false, error: msg });
        return;
      }
    } catch {
      set({ isRunning: false, error: "Failed to connect to audit engine" });
      return;
    }

    connectSSE(auditId, set, get);
  },

  handleEvent: (event: SSEEvent) => {
    // Deduplicate: skip events we've already processed (guards against SSE replay + Strict Mode)
    // Use server-assigned seq (buffer index) — unique even for same-millisecond events
    const seq = event.seq;
    if (seq !== undefined) {
      if (seenEventSeqs.has(seq)) return;
      seenEventSeqs.add(seq);
    }

    const state = get();

    switch (event.type) {
      case "audit_started": {
        if (event.packageName) {
          set({ packageName: event.packageName });
        }
        break;
      }

      case "phase_started": {
        set({
          phase: event.phase,
          phases: state.phases.map((p) =>
            p.name === event.phase ? { ...p, status: "active" } : p
          ),
          pipelineLog: [...state.pipelineLog, {
            kind: "phase" as const,
            text: PHASE_LABELS[event.phase] || event.phase,
            timestamp: event.timestamp,
          }],
        });
        break;
      }

      case "phase_completed": {
        set({
          phases: state.phases.map((p) =>
            p.name === event.phase ? { ...p, status: "done", durationMs: event.durationMs } : p
          ),
        });
        break;
      }

      case "file_list": {
        const statuses: Record<string, FileStatus> = {};
        for (const f of event.files) {
          statuses[f.path] = "pending";
        }
        const dirs = new Set(
          event.files.map((f) => f.path.split("/").slice(0, -1).join("/")).filter(Boolean)
        );
        set({
          files: event.files,
          fileStatuses: statuses,
          pipelineLog: [...state.pipelineLog, {
            kind: "info" as const,
            text: `Found ${event.files.length} files${dirs.size > 0 ? ` across ${dirs.size} directories` : ""}`,
            timestamp: event.timestamp,
          }],
        });
        break;
      }

      case "file_analyzing": {
        set({
          fileStatuses: { ...state.fileStatuses, [event.file]: "analyzing" },
          pipelineLog: [...state.pipelineLog, {
            kind: "file-scan" as const,
            text: event.file,
            file: event.file,
            timestamp: event.timestamp,
          }],
        });
        // Auto-follow: open file in viewer during triage
        if (state.autoFollow && state.phase === "triage") {
          get().selectFile(event.file);
        }
        break;
      }

      case "file_verdict": {
        const { verdict } = event;
        const status = riskContributionToStatus(verdict.riskContribution);
        const pipelineLog = verdict.riskContribution >= RISK_SUSPICIOUS_THRESHOLD
          ? [...state.pipelineLog, {
            kind: "file-flag" as const,
            text: verdict.summary || `Risk ${verdict.riskContribution}/10`,
            file: verdict.file,
            risk: verdict.riskContribution,
            timestamp: event.timestamp,
          }]
          : state.pipelineLog;
        set({
          fileStatuses: { ...state.fileStatuses, [verdict.file]: status },
          fileVerdicts: { ...state.fileVerdicts, [verdict.file]: verdict },
          pipelineLog,
        });
        break;
      }

      case "triage_progress": {
        set({ triageProgress: { current: event.current, total: event.total } });
        break;
      }

      case "inventory_meta": {
        const meta: InventoryMeta = {
          scripts: event.scripts,
          dependencies: event.dependencies,
          entryPoints: event.entryPoints,
          metadata: event.metadata,
        };
        const lifecycle = Object.entries(event.scripts)
          .filter(([k]) => LIFECYCLE_SCRIPTS.includes(k));
        const newEntries: typeof state.pipelineLog = [];
        if (lifecycle.length > 0) {
          newEntries.push({
            kind: "scripts" as const,
            text: lifecycle.map(([k, v]) => `${k}: ${v}`).join("\n"),
            scripts: event.scripts,
            timestamp: event.timestamp,
          });
        }
        const depCounts = Object.entries(event.dependencies)
          .filter(([, deps]) => Object.keys(deps).length > 0)
          .map(([kind, deps]) => `${Object.keys(deps).length} ${kind}`)
          .join(" · ");
        if (depCounts) {
          newEntries.push({
            kind: "info" as const,
            text: depCounts + " dependencies",
            timestamp: event.timestamp,
          });
        }
        set({
          inventoryMeta: meta,
          pipelineLog: [...state.pipelineLog, ...newEntries],
        });
        break;
      }

      case "triage_complete": {
        set({
          riskScore: event.riskScore,
          riskSummary: event.riskSummary,
          focusAreas: event.focusAreas,
          triageProgress: null,
        });
        break;
      }

      case "agent_thinking": {
        set({ agentThinking: true });
        break;
      }

      case "agent_tool_call": {
        set({ agentThinking: false });
        const step: AgentStep = {
          type: "tool_call",
          tool: event.tool,
          args: event.args,
          step: event.step,
          timestamp: event.timestamp,
        };
        set({ agentSteps: [...state.agentSteps, step] });

        // Auto-follow: if agent reads a file, select it
        if (state.autoFollow && event.tool === "readFile") {
          const filePath = readFileArg(event.args);
          if (filePath) get().selectFile(filePath);
        }
        break;
      }

      case "agent_tool_result": {
        const step: AgentStep = {
          type: "tool_result",
          tool: event.tool,
          resultPreview: event.resultPreview,
          step: event.step,
          timestamp: event.timestamp,
          injectionDetected: event.injectionDetected,
        };
        set({ agentSteps: [...state.agentSteps, step] });
        break;
      }

      case "agent_reasoning": {
        set({ agentThinking: false });
        const step: AgentStep = {
          type: "reasoning",
          text: event.text,
          step: event.step,
          timestamp: event.timestamp,
        };
        set({ agentSteps: [...state.agentSteps, step] });
        break;
      }

      case "finding_discovered": {
        set({ findings: [...state.findings, event.finding] });
        break;
      }

      case "verify_started": {
        set({
          pipelineLog: [...state.pipelineLog, {
            kind: "info" as const,
            text: `Running ${event.totalTests} exploit test${event.totalTests === 1 ? "" : "s"} in sandbox...`,
            timestamp: event.timestamp,
          }],
        });
        break;
      }

      case "verify_test_result": {
        const labels = { confirmed: "PASSED", unconfirmed: "FAILED", infra_error: "INFRA ERROR" } as const;
        set({
          pipelineLog: [...state.pipelineLog, {
            kind: "info" as const,
            text: `Test ${event.testFile}: ${labels[event.status]}${event.error ? ` (${event.error})` : ""}`,
            timestamp: event.timestamp,
          }],
        });
        break;
      }

      case "verdict_reached": {
        set({
          verdict: event.verdict,
          capabilities: event.capabilities,
          proofCount: event.proofCount,
          isRunning: false,
          agentThinking: false,
        });
        // Fetch full report to hydrate proof details (non-blocking)
        const { auditId } = get();
        if (auditId) {
          fetch(`${API_BASE}/audit/${auditId}/report`)
            .then((r) => (r.ok ? r.json() : null))
            .then((report) => {
              if (report?.proofs) set({ proofs: report.proofs });
            })
            .catch(() => { });
        }
        break;
      }

      case "audit_error": {
        const errorMsg = event.error ?? "Audit failed";
        set({
          isRunning: false,
          reconnecting: false,
          error: errorMsg,
          errorCode: event.code ?? null,
          errorRetryable: event.retryable ?? false,
          pipelineLog: [...state.pipelineLog, {
            kind: "info" as const,
            text: `Error: ${errorMsg}`,
            timestamp: event.timestamp,
          }],
        });
        break;
      }
    }
  },

  selectFile: async (filePath: string) => {
    const { auditId } = get();
    set({ selectedFile: filePath, selectedFileContent: null });

    if (!auditId) return;

    // Cancel any in-flight file fetch
    activeFileAbort?.abort();
    const controller = new AbortController();
    activeFileAbort = controller;

    try {
      const res = await fetch(
        `${API_BASE}/audit/${auditId}/file/${filePath}`,
        { signal: controller.signal },
      );
      if (res.ok) {
        const content = await res.text();
        if (get().selectedFile === filePath) {
          set({ selectedFileContent: content });
        }
      } else {
        if (get().selectedFile === filePath) {
          set({ selectedFileContent: `// Failed to load file (${res.status})` });
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (get().selectedFile === filePath) {
        set({ selectedFileContent: "// Failed to load file" });
      }
    }
  },
}));

/**
 * Audit domain store — a thin shell over the pure fold (lib/audit-fold.ts).
 * Owns: SSE connection lifecycle, start-audit orchestration (free / demo /
 * Stripe / crypto), selected-file fetching, and post-verdict report hydration.
 * All event-driven state transitions happen in foldAuditEvent — never here.
 */

import { create } from "zustand";
import { ApiError } from "../lib/api-base.ts";
import {
  fetchAuditFile,
  fetchAuditReport,
  startAuditStream,
  startCheckout as apiStartCheckout,
  startDemo as apiStartDemo,
} from "../lib/api.ts";
import { foldAuditEvent, initialFoldState, type AuditFoldState } from "../lib/audit-fold.ts";
import { apiBase } from "../lib/config.ts";
import type { AuditReport } from "../lib/engine-types.ts";
import { connectAuditStream, type StreamHandle } from "../lib/sse.ts";

interface AuditStoreState extends AuditFoldState {
  auditId: string | null;
  hasStarted: boolean;
  reconnecting: boolean;
  checkoutLoading: boolean;
  /** demo started inline on Landing — the App suppresses the /audit/:id
   * auto-navigate so it streams in place (MiniAuditFeed) without leaving. */
  demoInline: boolean;

  /** hydrated from GET /audit/:id/report after verdict_reached (schemaVersion 2) */
  report: AuditReport | null;

  selectedFile: string | null;
  selectedFileContent: string | null;

  startAudit: (packageName: string, version?: string) => Promise<void>;
  startDemo: (packageName: string) => Promise<void>;
  startCheckout: (packageName: string, version?: string, email?: string) => Promise<void>;
  startAuditFromCheckout: (stripeSessionId: string) => Promise<void>;
  startAuditFromTx: (txHash: string, packageName: string, version: string) => Promise<void>;
  connectToSession: (auditId: string) => Promise<void>;
  selectFile: (path: string) => void;
  reset: () => void;
}

let stream: StreamHandle | null = null;
let fileAbort: AbortController | null = null;

function baseState() {
  return {
    ...initialFoldState(),
    auditId: null as string | null,
    hasStarted: false,
    reconnecting: false,
    checkoutLoading: false,
    demoInline: false,
    report: null as AuditReport | null,
    selectedFile: null as string | null,
    selectedFileContent: null as string | null,
  };
}

export const useAuditStore = create<AuditStoreState>((set, get) => {
  function connect(auditId: string) {
    stream?.close();
    stream = connectAuditStream(
      `${apiBase()}/audit/${auditId}/events`,
      {
        onEvent(event) {
          const before = get();
          const after = foldAuditEvent(before, event);
          if (after === before) return;
          set(after);

          // Auto-follow: the fold marks which file the pipeline is reading.
          if (after.followFile && after.followFile !== before.followFile) {
            get().selectFile(after.followFile);
          }

          // Terminal: hydrate the durable schemaVersion-2 report for the reveal.
          if (event.type === "verdict_reached") {
            void fetchAuditReport(auditId)
              .then((report) => set({ report }))
              .catch(() => {
                // Session may already be expiring; the persisted report stays
                // reachable via /package/:name/report.
              });
          }
        },
        onConnected: () => {
          if (get().reconnecting) set({ reconnecting: false });
        },
        onReconnecting: () => set({ reconnecting: true }),
        onFailed: () =>
          set({ running: false, reconnecting: false, error: "Lost connection to the audit engine" }),
      },
      { isDone: () => !get().running },
    );
  }

  function begin(auditId: string, packageName?: string) {
    fileAbort?.abort();
    set({
      ...baseState(),
      auditId,
      hasStarted: true,
      packageName: packageName ?? get().packageName,
    });
    connect(auditId);
  }

  return {
    // Idle at boot: `running` is a stream-lifecycle flag, true only while an
    // audit stream is live (begin() resets to the fold's initial running:true).
    ...baseState(),
    running: false,

    async startAudit(packageName, version) {
      set({ error: null });
      const { auditId } = await startAuditStream({ packageName, version });
      begin(auditId, packageName);
    },

    async startDemo(packageName) {
      set({ error: null });
      const { auditId } = await apiStartDemo(packageName);
      begin(auditId, packageName);
      // Inline on Landing: stream in place, don't take over the route.
      set({ demoInline: true });
    },

    async startCheckout(packageName, version, email) {
      set({ checkoutLoading: true, error: null });
      try {
        const { url } = await apiStartCheckout(packageName, version, email);
        window.location.href = url;
      } catch (err) {
        const message =
          err instanceof ApiError && err.status === 501
            ? "Card payments are not configured on this engine"
            : err instanceof Error
              ? err.message
              : "Checkout failed";
        set({ checkoutLoading: false, error: message });
      }
    },

    async startAuditFromCheckout(stripeSessionId) {
      set({ error: null });
      const { auditId, packageName } = await startAuditStream({ stripeSessionId });
      begin(auditId, packageName);
    },

    async startAuditFromTx(txHash, packageName, version) {
      set({ error: null });
      const { auditId } = await startAuditStream({
        packageName,
        version,
        txHash,
        chain: "base-sepolia",
      });
      begin(auditId, packageName);
    },

    async connectToSession(auditId) {
      // Probe the session first: an expired/missing session must land on an
      // error state, not an empty audit view.
      try {
        const res = await fetch(`${apiBase()}/audit/${auditId}/report`);
        if (res.status === 404) throw new ApiError(404, null, "not found");
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          set({
            ...baseState(),
            running: false,
            hasStarted: false,
            error: "This audit session has expired or was not found.",
          });
          return;
        }
        // Network hiccup — fall through and let the SSE reconnect logic cope.
      }
      begin(auditId);
    },

    selectFile(path) {
      const { auditId } = get();
      if (!auditId) return;
      fileAbort?.abort();
      const controller = new AbortController();
      fileAbort = controller;
      set({ selectedFile: path, selectedFileContent: null });
      void fetchAuditFile(auditId, path, controller.signal)
        .then((content) => {
          if (get().selectedFile === path) set({ selectedFileContent: content });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (get().selectedFile === path) {
            set({
              selectedFileContent: `// ${err instanceof Error ? err.message : "Failed to load file"}`,
            });
          }
        });
    },

    reset() {
      stream?.close();
      stream = null;
      fileAbort?.abort();
      fileAbort = null;
      set({ ...baseState(), running: false });
    },
  };
});

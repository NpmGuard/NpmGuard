/**
 * Audit domain store — a thin shell over the pure replay core.
 *
 * Owns: SSE connection lifecycle, start-audit orchestration (free / demo /
 * Stripe / crypto), source fetching, report hydration, and the playback state a
 * viewer manipulates. All event-driven state transitions happen in
 * `foldAuditEvent` — never here.
 *
 * ── The one structural idea: transport and presentation are separate ─────────
 *
 * Frames land in the TAPE the moment they arrive, live or replayed. What a
 * viewer SEES is `stateAt(tape, playhead)`. Those two numbers moving
 * independently is what buys every playback behaviour at once:
 *
 *   - pausing a live audit stops the playhead and never stops ingestion, so
 *     `Resume live · N new` is simply `frames.length - playhead`;
 *   - seeking is a re-derivation from frame zero, so it cannot drift from a
 *     fresh load of the same audit;
 *   - a reconnect appends the frames it missed and the visible state is
 *     unchanged until the playhead moves, so the canvas never blanks.
 *
 * A single "current state" field would collapse all of that back into one
 * number, and each behaviour would need its own patch.
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
import { initialFoldState, isRichReplay, type AuditFoldState } from "../lib/audit-fold.ts";
import {
  appendFrame,
  emptyTape,
  nextSignificant,
  previousSignificant,
  stateAt,
  type AuditTape,
} from "../lib/audit-tape.ts";
import { DEFAULT_SPEED, type Speed } from "../lib/replay-clock.ts";
import { LOADING, failed, loaded, type LoadState } from "../components/ui/load-state.ts";
import { apiBase } from "../lib/config.ts";
import type { AuditReport } from "@npmguard/shared";
import { connectAuditStream, type StreamHandle } from "../lib/sse.ts";

/** What the viewer is currently inspecting; null closes the inspector. */
export interface Inspection {
  nodeId: string;
}

interface AuditStoreState extends AuditFoldState {
  auditId: string | null;
  hasStarted: boolean;
  reconnecting: boolean;
  /** every retry exhausted — the partial graph stays, and retry is offered */
  connectionLost: boolean;
  checkoutLoading: boolean;
  /** attached to an audit that already exists (a permalink) rather than one this
   * session started. The stream is byte-identical either way — this says where
   * the URL came from, and the App uses it to leave that URL alone. */
  replaying: boolean;

  /** every durable frame received, in seq order */
  tape: AuditTape;
  /** how many frames are VISIBLE. Never greater than tape.frames.length. */
  playhead: number;
  playing: boolean;
  speed: Speed;
  /** the selected node, or null. An open inspector suppresses auto-resume. */
  inspecting: Inspection | null;
  /** the viewer panned or selected, so the camera stops following */
  cameraFollows: boolean;
  /** auto-resume is off for this inspection because the viewer said so */
  stayPaused: boolean;
  /**
   * How the playhead last moved.
   *
   * "release" is one frame from the clock (or one live arrival) — the only case
   * where a new node should ANIMATE in. A "seek" reconstructs the projection
   * from frame zero, and animating every node it produces is what makes a scrub
   * look like a crash rather than a jump.
   */
  lastMove: "release" | "seek";

  /** hydrated from GET /audit/:id/report after verdict_reached (schemaVersion 2) */
  report: AuditReport | null;

  selectedFile: string | null;
  /**
   * The source of `selectedFile`, as a read that either succeeded or did not.
   *
   * A `string` here would let a failed fetch be rendered as file content — which
   * is exactly what happened: the catch wrote `"// " + err.message` into the
   * viewer and a reader saw engine prose where the file's first line belongs.
   * In the one view whose job is showing what was audited, that is the product
   * lying. The type makes it unspellable.
   */
  source: LoadState<string>;

  startAudit: (packageName: string, version?: string) => Promise<void>;
  startDemo: (packageName: string) => Promise<void>;
  startCheckout: (packageName: string, version?: string, email?: string) => Promise<void>;
  startAuditFromCheckout: (stripeSessionId: string) => Promise<void>;
  startAuditFromTx: (txHash: string, packageName: string, version: string) => Promise<void>;
  connectToSession: (auditId: string) => Promise<void>;
  retryConnection: () => void;
  selectFile: (path: string) => void;

  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: Speed) => void;
  seekTo: (playhead: number) => void;
  stepBackward: () => void;
  stepForward: () => void;
  restart: () => void;
  advance: () => void;
  resumeLive: () => void;
  inspect: (nodeId: string | null) => void;
  setStayPaused: (value: boolean) => void;
  setCameraFollows: (value: boolean) => void;
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
    connectionLost: false,
    checkoutLoading: false,
    replaying: false,
    tape: emptyTape(),
    playhead: 0,
    playing: true,
    speed: DEFAULT_SPEED,
    inspecting: null as Inspection | null,
    cameraFollows: true,
    stayPaused: false,
    lastMove: "release" as "release" | "seek",
    report: null as AuditReport | null,
    selectedFile: null as string | null,
    source: LOADING as LoadState<string>,
  };
}

/**
 * Visible state for a playhead, plus the fold-derived fields the store spreads
 * flat. Recomputed from the tape rather than mutated, which is what makes a seek
 * indistinguishable from having watched to that point.
 */
function visible(tape: AuditTape, playhead: number): AuditFoldState {
  return stateAt(tape, playhead);
}

export const useAuditStore = create<AuditStoreState>((set, get) => {
  function connect(auditId: string) {
    stream?.close();
    stream = connectAuditStream(
      `${apiBase()}/audit/${auditId}/events`,
      {
        onEvent(event) {
          const before = get();
          const tape = appendFrame(before.tape, event);
          if (tape === before.tape) return;

          // ONE tape, TWO release policies — the whole distinction between
          // watching an audit and replaying one.
          //
          //   live      — the playhead follows the tape's head, so a frame that
          //               arrives is on screen. There is nothing to pace: the
          //               engine's own tempo IS the audit's tempo.
          //   recorded  — the tape arrives whole and instantly (the engine seeds
          //               a recording with no sleeps), so following the head
          //               would show the verdict before the first hypothesis.
          //               The replay clock releases frames instead.
          //
          // `wasAtHead` is measured BEFORE the append, so on either policy a
          // frame arriving never drags a paused viewer forward.
          const wasAtHead = before.playhead === before.tape.frames.length;
          const follows = wasAtHead && before.playing && !before.replaying;
          const playhead = follows ? tape.frames.length : before.playhead;
          set({ ...visible(tape, playhead), tape, playhead, lastMove: "release" });

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
          if (get().reconnecting || get().connectionLost) {
            set({ reconnecting: false, connectionLost: false });
          }
        },
        onReconnecting: () => set({ reconnecting: true }),
        // The visible projection is left ALONE. A dropped connection is a fact
        // about the network, not about the audit — resetting to empty would
        // discard evidence the viewer already has and can still read.
        onFailed: () => set({ reconnecting: false, connectionLost: true, playing: false }),
        // Drift, not a dropout. The stream is already closed and reconnecting
        // would replay the same bad frame, so the run ends here — with a message
        // that says the engine disagreed with the contract rather than blaming
        // the network. The audit itself keeps running server-side and its durable
        // report stays reachable at /package/:name/report.
        onContractViolation: (detail) => {
          set({
            running: false,
            reconnecting: false,
            playing: false,
            error: `The audit stream sent a frame that does not match the contract (${detail})`,
            errorCode: "CONTRACT_VIOLATION",
            errorRetryable: false,
          });
        },
      },
      {
        // Read off the TAPE, not off the visible projection. `running` describes
        // what the viewer has been shown, and a replay paused at frame 3 of 110
        // is still "running" to a viewer while the stream itself ended long ago —
        // which had the client reconnecting to a finished audit for the whole
        // length of every replay.
        isDone: () =>
          get().tape.frames.some(
            (frame) => frame.type === "verdict_reached" || frame.type === "audit_error",
          ),
      },
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
      set({ replaying: true });
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
      set({ replaying: true });
    },

    retryConnection() {
      const { auditId } = get();
      if (!auditId) return;
      set({ connectionLost: false, reconnecting: true });
      connect(auditId);
    },

    selectFile(path) {
      const { auditId } = get();
      if (!auditId) return;
      fileAbort?.abort();
      const controller = new AbortController();
      fileAbort = controller;
      set({ selectedFile: path, source: LOADING });
      void fetchAuditFile(auditId, path, controller.signal)
        .then((content) => {
          if (get().selectedFile === path) set({ source: loaded(content) });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (get().selectedFile !== path) return;
          // NOT rendered as file content. A failed read says so, names the file,
          // and offers a retry — it never becomes a first line in a code pane.
          set({
            source: failed({
              what: path,
              detail: err instanceof Error ? err.message : "The source could not be read",
              retry: () => get().selectFile(path),
            }),
          });
        });
    },

    // ── playback ────────────────────────────────────────────────────────────

    setPlaying(playing) {
      set({ playing, ...(playing ? { stayPaused: false } : {}) });
    },

    setSpeed(speed) {
      // Speed changes waits, never order or state — so the visible projection is
      // deliberately untouched here.
      set({ speed });
    },

    seekTo(playhead) {
      const { tape } = get();
      const bounded = Math.max(0, Math.min(playhead, tape.frames.length));
      // A seek rebuilds the projection from frame zero. There is no reverse
      // transition to get wrong, so scrubbing backwards is exactly as correct as
      // scrubbing forwards.
      set({ ...visible(tape, bounded), tape, playhead: bounded, playing: false, lastMove: "seek" });
    },

    stepBackward() {
      get().seekTo(previousSignificant(get().tape, get().playhead));
    },

    stepForward() {
      get().seekTo(nextSignificant(get().tape, get().playhead));
    },

    restart() {
      const { tape } = get();
      set({ ...visible(tape, 0), tape, playhead: 0, playing: true, inspecting: null, lastMove: "seek" });
    },

    /** Release exactly one more frame. The React layer owns the timer. */
    advance() {
      const { tape, playhead } = get();
      if (playhead >= tape.frames.length) return;
      const next = playhead + 1;
      set({ ...visible(tape, next), tape, playhead: next, lastMove: "release" });
    },

    resumeLive() {
      const { tape } = get();
      set({
        ...visible(tape, tape.frames.length),
        tape,
        playhead: tape.frames.length,
        playing: true,
        inspecting: null,
        cameraFollows: true,
        stayPaused: false,
        lastMove: "seek",
      });
    },

    inspect(nodeId) {
      if (nodeId === null) {
        set({ inspecting: null, stayPaused: false });
        return;
      }
      // Selecting pauses a RECORDED replay and suspends camera-follow on a live
      // one — but never stops ingestion, so nothing is missed while reading.
      set({ inspecting: { nodeId }, cameraFollows: false, playing: false });
    },

    setStayPaused(value) {
      set({ stayPaused: value });
    },

    setCameraFollows(value) {
      set({ cameraFollows: value });
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

/** Frames received but not yet shown — the `Resume live · N new` counter. */
export function unseenCount(state: AuditStoreState): number {
  return Math.max(0, state.tape.frames.length - state.playhead);
}

/** Whether this stream can drive the evidence graph at all. */
export function canRenderGraph(state: AuditStoreState): boolean {
  return isRichReplay(state);
}

/**
 * The pure SSE event fold. All audit-stream state transitions live here —
 * the Zustand store is a thin shell that pipes events through this reducer, and
 * so is the replay clock: a recorded audit and a live one differ only in WHEN a
 * frame is handed to this function, never in what it does with one.
 *
 * Invariants:
 * - Pure: (state, event) → state. No IO, no time reads, no globals.
 * - Idempotent under replay: reconnect resumes from a seq cursor (the engine
 *   reads Last-Event-ID / ?since), but a duplicate seq is always a no-op, so a
 *   full-buffer replay folds identically. Seeking relies on the same property:
 *   folding 0…N from a clean state IS the state at N.
 * - Unknown event types are ignored, never fatal (forward compatibility): the
 *   engine may add event types ahead of this file.
 * - Terminal events (verdict_reached | audit_error) end the run; later
 *   non-terminal events are ignored.
 *
 * The event is the contract's own DISCRIMINATED union (`AuditEventUnion`,
 * shared/src/events.ts), so the switch below narrows on the discriminant the
 * engine's Pydantic models are generated from rather than on a hand-restated
 * copy of it. That does NOT weaken the forward-compatibility invariant, and the
 * reason is worth stating because the two look like they conflict: strictness
 * lives at the transport boundary and tolerance lives here, and they apply to
 * different classes of frame.
 *
 *   - A NEW event type the engine adds is never delivered to this fold at all:
 *     the audit stream uses NAMED SSE events and `lib/sse.ts` subscribes only to
 *     the names in `EVENT_TYPES`, so an unsubscribed name is dropped by
 *     EventSource itself. Forward-compatible by construction, with no branch.
 *   - A KNOWN event type whose payload lost a field is a contract violation, and
 *     `lib/sse.ts` fails it loudly rather than folding a half-frame.
 *   - Anything that reaches `default` — a retired type replayed from a durable
 *     log, or a caller that bypasses the stream — is INERT. The union being
 *     closed makes `default` unreachable to the typechecker, but it is very
 *     reachable at runtime, because the value came off a wire. Never replace it
 *     with an exhaustiveness assertion that throws.
 *
 * WHAT THIS FOLD DELIBERATELY DOES NOT HOLD: prose. There is no log of rendered
 * sentences here. The transcript is generated from these same events by
 * `investigator-copy.ts`, so one fact has one home and a sentence cannot drift
 * from the state it describes.
 */

import type {
  AuditEventUnion,
  BaseAuditEvent,
  Budget,
  ClaimKind,
  DisplayObservation,
  EvidenceRef,
  FileRecord,
  FileVerdict,
  FocusRange,
  HypothesisCounts,
  HypothesisSeverity,
  HypothesisState,
  InventoryMetaEvent,
  ObserveFlags,
  RunDisplay,
  ToolCall,
  Trigger,
  TriageHypothesis,
  VerdictEnum,
} from "@npmguard/shared";
import { REPLAY_FORMAT } from "@npmguard/shared";
import { PHASE_ORDER, type PhaseInfo } from "./types.ts";

/**
 * The inventory payload as the fold stores it: the `inventory_meta` event with
 * the SSE envelope stripped off. Spelled as a derivation of the contract event
 * rather than restated, so a field added to the event cannot go missing here —
 * and so the `inventory_meta` arm's rest-destructure is checked against it.
 */
export type InventoryMeta = Omit<InventoryMetaEvent, "type" | keyof BaseAuditEvent>;

export interface TriageSummary {
  hypothesisCount: number;
  hypotheses: TriageHypothesis[];
}

/**
 * Where a hypothesis has got to, as distinct from what it CONCLUDED.
 *
 * `state` answers "is it true"; `stage` answers "how far has the investigation
 * got". Collapsing them loses the two states a viewer most needs mid-audit: a
 * suspicion whose sandbox is running, and one whose evidence is being weighed.
 *
 * `merged` is terminal without being a conclusion: the hypothesis asked the same
 * question as another, so that one's run answers both and this one never runs.
 */
export type HypothesisStage =
  | "emitted"
  | "merged"
  | "experiment"
  | "sandbox"
  | "judging"
  | "resolved";

export interface HypothesisView {
  hypId: string;
  claim: ClaimKind;
  severity: HypothesisSeverity;
  description: string;
  focusFiles: string[];
  focusLines: FocusRange[];
  state: HypothesisState;
  stage: HypothesisStage;
  reason: string | null;
  by: string | null;
  runId: string | null;
  evidenceRefs: EvidenceRef[];
  citedEventIds: string[];
  /** the surviving hypothesis this one was folded into, if any */
  mergedInto: string | null;
}

/** One experiment, accumulated across its four boundary frames. */
export interface RunView {
  hypId: string;
  runId: string;
  experiment: ToolCall[];
  trigger: Trigger;
  observe: ObserveFlags | null;
  budget: Budget | null;
  display: RunDisplay | null;
  /**
   * The preview bound UNION the rows the judgment cited, keyed by event id.
   *
   * The judge had not run when `sandbox_completed` was emitted, so a cited row
   * can be one the preview left out. Merging here — rather than asking each
   * consumer to do it — is what makes "the inspector always contains every event
   * the judgment cited" true of every consumer rather than of the careful ones.
   */
  observations: DisplayObservation[];
  citedEventIds: string[];
  stage: "planned" | "running" | "judging" | "done";
}

export interface DepsInfo {
  installed: boolean;
  packageCount: number;
  skipped: string | null;
}

export interface AuditFoldState {
  packageName: string;
  /**
   * The replay vocabulary this stream speaks, off `audit_started`. Streams below
   * `REPLAY_FORMAT` carry no experiment frames, so there is nothing for the
   * evidence graph to fold and nothing to infer them from — `isRichReplay`
   * decides once, and the workspace shows an unsupported-replay state rather
   * than animating a reconstruction.
   */
  replayVersion: number;
  running: boolean;
  /** seq numbers already folded — the replay/duplicate guard */
  seenSeqs: ReadonlySet<number>;

  phase: string | null;
  phases: PhaseInfo[];
  triageProgress: { current: number; total: number } | null;

  files: FileRecord[];
  fileVerdicts: Record<string, FileVerdict>;
  /** the file the pipeline is reading right now — activity, not a permanent node */
  analyzing: string | null;
  /** distinct files the pipeline has opened; the coverage counter's numerator */
  scannedCount: number;
  inventoryMeta: InventoryMeta | null;
  deps: DepsInfo | null;
  statedPurpose: string | null;
  expectedCapabilities: string[];

  triage: TriageSummary | null;
  hypotheses: HypothesisView[];
  runs: Record<string, RunView>;

  verdict: VerdictEnum | null;
  verdictRationale: string | null;
  counts: HypothesisCounts | null;
  confirmedCount: number;

  error: string | null;
  errorCode: string | null;
  errorRetryable: boolean;
}

export function initialFoldState(): AuditFoldState {
  return {
    packageName: "",
    replayVersion: 0,
    running: true,
    seenSeqs: new Set(),
    phase: null,
    phases: PHASE_ORDER.map((name) => ({ name, status: "pending" })),
    triageProgress: null,
    files: [],
    fileVerdicts: {},
    analyzing: null,
    scannedCount: 0,
    inventoryMeta: null,
    deps: null,
    statedPurpose: null,
    expectedCapabilities: [],
    triage: null,
    hypotheses: [],
    runs: {},
    verdict: null,
    verdictRationale: null,
    counts: null,
    confirmedCount: 0,
    error: null,
    errorCode: null,
    errorRetryable: false,
  };
}

/**
 * Whether this stream can be folded into an evidence graph.
 *
 * A hard cut, deliberately: below format 2 the stream has no experiment,
 * sandbox or judgment frames, so a graph built from it would be a drawing of
 * events that were never recorded. There is no compatibility projection and no
 * reconstruction from the final report.
 */
export function isRichReplay(state: AuditFoldState): boolean {
  return state.replayVersion >= REPLAY_FORMAT;
}

function markPhase(phases: PhaseInfo[], name: string, patch: Partial<PhaseInfo>): PhaseInfo[] {
  if (!phases.some((p) => p.name === name)) {
    // Phases outside PHASE_ORDER are appended so progress never lies about
    // what ran.
    return [...phases, { name, status: "pending", ...patch }];
  }
  return phases.map((p) => (p.name === name ? { ...p, ...patch } : p));
}

function upsertHypothesis(
  list: HypothesisView[],
  hypId: string,
  patch: Partial<HypothesisView> & Pick<HypothesisView, "claim" | "severity">,
): HypothesisView[] {
  const index = list.findIndex((item) => item.hypId === hypId);
  if (index === -1) {
    return [
      ...list,
      {
        hypId,
        description: "",
        focusFiles: [],
        focusLines: [],
        state: "OPEN",
        stage: "emitted",
        reason: null,
        by: null,
        runId: null,
        evidenceRefs: [],
        citedEventIds: [],
        mergedInto: null,
        ...patch,
      },
    ];
  }
  const next = list.slice();
  next[index] = { ...next[index], ...patch };
  return next;
}

function patchRun(
  runs: Record<string, RunView>,
  hypId: string,
  patch: Partial<RunView>,
): Record<string, RunView> {
  const current = runs[hypId];
  if (!current) return runs;
  return { ...runs, [hypId]: { ...current, ...patch } };
}

/**
 * Observations by event id, timeline order.
 *
 * Later entries win on collision, because the merge only ever runs preview-then-
 * cited and a cited row is the one the judgment actually rested on. Ordering is
 * numeric on the `eN` handle rather than on arrival: the two sources are
 * different slices of one timeline, and concatenating them would interleave the
 * run out of order.
 */
export function mergeObservations(
  existing: readonly DisplayObservation[],
  incoming: readonly DisplayObservation[],
): DisplayObservation[] {
  const byId = new Map(existing.map((item) => [item.eventId, item]));
  for (const item of incoming) byId.set(item.eventId, item);
  return [...byId.values()].sort(
    (a, b) => Number(a.eventId.slice(1)) - Number(b.eventId.slice(1)),
  );
}

const TERMINAL_TYPES = new Set(["verdict_reached", "audit_error"]);

export function foldAuditEvent(state: AuditFoldState, event: AuditEventUnion): AuditFoldState {
  if (state.seenSeqs.has(event.seq)) return state;
  if (!state.running && !TERMINAL_TYPES.has(event.type)) return state;

  const seenSeqs = new Set(state.seenSeqs);
  seenSeqs.add(event.seq);
  const base = { ...state, seenSeqs };

  switch (event.type) {
    case "audit_started":
      return { ...base, packageName: event.packageName, replayVersion: event.replayVersion };

    case "audit_enqueued":
      return base;

    case "phase_started":
      return {
        ...base,
        phase: event.phase,
        phases: markPhase(base.phases, event.phase, { status: "active" }),
      };

    case "phase_completed":
      return {
        ...base,
        phases: markPhase(base.phases, event.phase, { status: "done", durationMs: event.durationMs }),
      };

    case "dependencies_provisioned":
      return {
        ...base,
        deps: {
          installed: event.installed,
          packageCount: event.packageCount,
          skipped: event.skipped,
        },
      };

    case "file_list":
      return { ...base, files: event.files };

    case "inventory_meta": {
      const { type: _type, auditId: _a, timestamp: _t, seq: _s, ...meta } = event;
      return { ...base, inventoryMeta: meta };
    }

    case "intent_extracted":
      return {
        ...base,
        statedPurpose: event.statedPurpose,
        expectedCapabilities: event.expectedCapabilities,
      };

    case "file_analyzing":
      // Counted, not accumulated. A scanned file that turns out clean earns a
      // number, never a node — §5.2's density rule, enforced by the fold rather
      // than by every consumer remembering it.
      return {
        ...base,
        analyzing: event.file,
        scannedCount: base.scannedCount + (base.analyzing === event.file ? 0 : 1),
      };

    case "triage_progress":
      return { ...base, triageProgress: { current: event.current, total: event.total } };

    case "hypothesis_emitted":
      return {
        ...base,
        hypotheses: upsertHypothesis(base.hypotheses, event.hypId, {
          claim: event.claim,
          severity: event.severity,
          description: event.description,
          focusFiles: event.focusFiles,
          focusLines: event.focusLines,
          state: "OPEN",
          stage: "emitted",
        }),
      };

    case "file_verdict":
      return {
        ...base,
        fileVerdicts: { ...base.fileVerdicts, [event.verdict.file]: event.verdict },
      };

    case "triage_complete":
      return {
        ...base,
        triage: { hypothesisCount: event.hypothesisCount, hypotheses: event.hypotheses },
        triageProgress: null,
        analyzing: null,
      };

    case "graph_built": {
      // A merged hypothesis is answered by the node it folded into, and says so.
      // Without this it would sit OPEN for the rest of the audit, which is
      // exactly what a dropped suspicion looks like.
      let hypotheses = base.hypotheses;
      for (const merge of event.merges) {
        const existing = hypotheses.find((item) => item.hypId === merge.hypId);
        if (!existing) continue;
        hypotheses = upsertHypothesis(hypotheses, merge.hypId, {
          claim: existing.claim,
          severity: existing.severity,
          stage: "merged",
          mergedInto: merge.into,
        });
      }
      return { ...base, hypotheses };
    }

    case "experiment_started": {
      const existing = base.hypotheses.find((item) => item.hypId === event.hypId);
      return {
        ...base,
        runs: {
          ...base.runs,
          [event.hypId]: {
            hypId: event.hypId,
            runId: event.runId,
            experiment: event.experiment,
            trigger: event.trigger,
            observe: null,
            budget: null,
            display: null,
            observations: [],
            citedEventIds: [],
            stage: "planned",
          },
        },
        hypotheses: existing
          ? upsertHypothesis(base.hypotheses, event.hypId, {
              claim: existing.claim,
              severity: existing.severity,
              stage: "experiment",
              state: "IN_PROGRESS",
              runId: event.runId,
            })
          : base.hypotheses,
      };
    }

    case "sandbox_started": {
      const existing = base.hypotheses.find((item) => item.hypId === event.hypId);
      return {
        ...base,
        runs: patchRun(base.runs, event.hypId, {
          observe: event.observe,
          budget: event.budget,
          stage: "running",
        }),
        hypotheses: existing
          ? upsertHypothesis(base.hypotheses, event.hypId, {
              claim: existing.claim,
              severity: existing.severity,
              stage: "sandbox",
            })
          : base.hypotheses,
      };
    }

    case "sandbox_completed": {
      const current = base.runs[event.hypId];
      if (!current) return base;
      return {
        ...base,
        runs: {
          ...base.runs,
          [event.hypId]: {
            ...current,
            display: event.run,
            observations: mergeObservations(current.observations, event.run.observations),
            stage: "judging",
          },
        },
      };
    }

    case "judgment_started": {
      const existing = base.hypotheses.find((item) => item.hypId === event.hypId);
      return {
        ...base,
        hypotheses: existing
          ? upsertHypothesis(base.hypotheses, event.hypId, {
              claim: existing.claim,
              severity: existing.severity,
              stage: "judging",
            })
          : base.hypotheses,
      };
    }

    case "hypothesis_resolved": {
      const current = base.runs[event.hypId];
      return {
        ...base,
        runs: current
          ? {
              ...base.runs,
              [event.hypId]: {
                ...current,
                observations: mergeObservations(
                  current.observations,
                  event.citedObservations,
                ),
                citedEventIds: event.citedEventIds,
                stage: "done",
              },
            }
          : base.runs,
        hypotheses: upsertHypothesis(base.hypotheses, event.hypId, {
          claim: event.claim,
          severity: event.severity,
          state: event.state,
          stage: "resolved",
          reason: event.reason,
          by: event.by,
          runId: event.runId,
          evidenceRefs: event.evidenceRefs,
          citedEventIds: event.citedEventIds,
        }),
      };
    }

    case "verdict_reached":
      return {
        ...base,
        running: false,
        analyzing: null,
        verdict: event.verdict,
        verdictRationale: event.rationale,
        counts: event.counts,
        confirmedCount: event.confirmedCount,
      };

    case "audit_error":
      // All three fields are REQUIRED and non-null on the contract, and supplied
      // by every emit site. The previous `?? "The audit failed"` fallbacks came
      // from a hand-written type that declared them `?: T | null`; they were
      // unreachable, and a fallback that cannot run only tells a reader the
      // message might be missing when it never is.
      return {
        ...base,
        running: false,
        analyzing: null,
        error: event.error,
        errorCode: event.code,
        errorRetryable: event.retryable,
      };

    default:
      // Unreachable to the typechecker (the union is closed), reachable at
      // runtime (the value came off a wire): a retired type replayed from the
      // durable log lands here. Tolerated and INERT — never a throw.
      return base;
  }
}

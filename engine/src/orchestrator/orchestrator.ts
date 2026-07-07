import type { Hypothesis } from "@npmguard/shared";
import type { HypothesisGraph } from "../graph/hypothesis-graph.js";
import type { EntryPoints } from "../models.js";
import type { AuditLogger } from "../audit-log.js";
import type { ArtifactStore } from "../evidence/artifact-store.js";
import type { EmitFn } from "../events.js";
import { nextOpen } from "../graph/priority-queue.js";
import { withTimeout } from "../util.js";
import { claimHasDynamicStrategy, runExperiment } from "./experimenter.js";
import { runCodeReader } from "./code-reader.js";

// ---------------------------------------------------------------------------
// Orchestrator — the dispatch loop that lets the hypothesis graph resolve
// itself. This is the piece the v2 graft skipped: without it, every node stays
// OPEN and the verdict is SUSPECT forever.
//
// Deterministic control (priority + routing + completion); the workers own the
// judgement:
//   - dynamic claims  → experimenter (reproduce under observation → CONFIRMED
//                        with a RunArtifact, else INCONCLUSIVE/DEFERRED)
//   - static claims   → code-reader (REFUTE if benign, else INCONCLUSIVE)
//
// Invariant it upholds: CONFIRMED is reached ONLY via a dynamic RunArtifact.
// No worker route ever leaves a node IN_PROGRESS — every dispatched hypothesis
// lands in a terminal state, so `deriveGraphVerdict` can be authoritative.
// ---------------------------------------------------------------------------

const PER_HYP_MS = 90_000; // cap on a single experiment (stuck run can't burn it all)
const CODE_READER_MS = 60_000; // cap on a single static reading

export interface OrchestratorContext {
  packagePath: string;
  entryPoints: EntryPoints;
  artifactStore: ArtifactStore;
  log: AuditLogger;
  emit?: EmitFn;
  /** Overall wall-clock budget for the whole dispatch loop. */
  globalBudgetMs: number;
}

export interface OrchestratorSummary {
  dispatched: number;
  confirmed: number;
  refuted: number;
  inconclusive: number;
  deferred: number;
}

/**
 * Run the dispatch loop until no OPEN hypothesis remains (or the global budget
 * is exhausted, at which point any undispatched OPEN nodes are marked DEFERRED
 * so the coverage gap surfaces as UNKNOWN rather than a lingering SUSPECT).
 */
export async function runOrchestrator(
  graph: HypothesisGraph,
  ctx: OrchestratorContext,
): Promise<OrchestratorSummary> {
  const { entryPoints, emit } = ctx;
  const runtimeEntry = entryPoints.runtime[0] ?? "index.js";
  const start = Date.now();
  const summary: OrchestratorSummary = {
    dispatched: 0,
    confirmed: 0,
    refuted: 0,
    inconclusive: 0,
    deferred: 0,
  };

  let h: Hypothesis | null;
  while ((h = nextOpen(graph)) !== null) {
    if (Date.now() - start > ctx.globalBudgetMs) {
      // Budget blown — mark every still-OPEN node DEFERRED and stop.
      for (const open of graph.filterByState("OPEN")) {
        graph.transition(open.hypId, {
          to: "DEFERRED",
          by: "orchestrator",
          reason: `Analysis budget (${ctx.globalBudgetMs}ms) exhausted before this hypothesis was dispatched.`,
        });
        summary.deferred += 1;
        emitResolved(emit, graph.get(open.hypId));
      }
      console.warn(`[orchestrator] global budget exhausted — deferred remaining OPEN hypotheses`);
      break;
    }

    // OPEN → IN_PROGRESS. Every path below lands it in a terminal state.
    graph.transition(h.hypId, { to: "IN_PROGRESS", by: "orchestrator" });
    summary.dispatched += 1;

    if (claimHasDynamicStrategy(h.claim.kind)) {
      await dispatchDynamic(h, graph, ctx, runtimeEntry, summary);
    } else {
      await dispatchStatic(h, graph, ctx, summary);
    }

    emitResolved(emit, graph.get(h.hypId));
  }

  console.log(
    `[orchestrator] resolved ${summary.dispatched} hypothes${summary.dispatched === 1 ? "is" : "es"} — ` +
      `${summary.confirmed} confirmed, ${summary.refuted} refuted, ` +
      `${summary.inconclusive} inconclusive, ${summary.deferred} deferred`,
  );
  return summary;
}

function emitResolved(emit: EmitFn | undefined, h: Hypothesis): void {
  emit?.("hypothesis_resolved", {
    hypId: h.hypId,
    claim: h.claim.kind,
    severity: h.severity,
    state: h.state,
    by: h.resolution?.by ?? "orchestrator",
    reason: h.resolution?.reason ?? "",
  });
}

/**
 * DEFER a hypothesis after an unexpected worker error — but only if it hasn't
 * already resolved. A terminal node re-transitioned throws in HypothesisGraph,
 * which would crash the whole audit; so if the error surfaced after resolution
 * we just log it and leave the terminal state intact.
 */
function deferOnError(
  graph: HypothesisGraph,
  hypId: string,
  by: string,
  err: unknown,
  summary: OrchestratorSummary,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (graph.get(hypId).state !== "IN_PROGRESS") {
    console.error(`[orchestrator] ${hypId} threw after resolving (${graph.get(hypId).state}): ${msg}`);
    return;
  }
  graph.transition(hypId, { to: "DEFERRED", by, reason: `Worker error: ${msg}` });
  summary.deferred += 1;
}

// ---------------------------------------------------------------------------
// Dynamic route — experimenter. Reproduce the behavior under observation.
// ---------------------------------------------------------------------------

async function dispatchDynamic(
  h: Hypothesis,
  graph: HypothesisGraph,
  ctx: OrchestratorContext,
  runtimeEntry: string,
  summary: OrchestratorSummary,
): Promise<void> {
  const { packagePath, entryPoints, artifactStore, log } = ctx;
  try {
    const result = await withTimeout(
      runExperiment(h, packagePath, runtimeEntry, entryPoints.install),
      PER_HYP_MS,
      `experiment:${h.hypId}`,
    );

    if (result === null) {
      // Shouldn't happen (routed here because a strategy exists), but stay safe.
      graph.transition(h.hypId, {
        to: "DEFERRED",
        by: "worker:experimenter",
        reason: `No experiment strategy available for claim ${h.claim.kind}.`,
      });
      summary.deferred += 1;
      return;
    }

    // Persist the RunArtifact regardless of outcome — it documents what we ran.
    const { contentHash: artifactContentHash, ...artifactWithoutHash } = result.artifact;
    const artifactHash = artifactStore.writeArtifact(artifactWithoutHash);
    if (artifactHash !== artifactContentHash) {
      console.warn(
        `[orchestrator] artifact hash mismatch for ${result.artifact.runId}: ` +
          `artifact=${artifactContentHash} store=${artifactHash}`,
      );
    }
    log.writeLog(`experiment-${h.hypId}.json`, {
      hypId: h.hypId,
      confirmed: result.confirmed,
      reason: result.reason,
      runId: result.artifact.runId,
      artifactHash,
      evidenceRef: result.evidenceRef,
      wallMs: result.artifact.wallMs,
      eventCount: result.artifact.events.length,
      eventSummary: result.artifact.eventSummary,
      error: result.artifact.error,
    });

    if (result.confirmed) {
      // transition() appends evidenceRefs — don't also addEvidence (double-count).
      graph.transition(h.hypId, {
        to: "CONFIRMED",
        by: "worker:experimenter",
        reason: result.reason,
        evidenceRefs: [result.evidenceRef],
      });
      summary.confirmed += 1;
      return;
    }

    // Ran but did not fire. Attach the run as coverage evidence — INCONCLUSIVE/
    // DEFERRED take no evidenceRefs in transition(), so add it explicitly here.
    graph.addEvidence(h.hypId, [result.evidenceRef]);
    const errKind = result.artifact.error?.kind ?? null;
    const observationFailed =
      errKind === "SetupError" || errKind === "SensorError" || errKind === "TimeoutError";
    if (observationFailed) {
      // We could not cleanly observe — this is a coverage gap, not a clean run.
      graph.transition(h.hypId, {
        to: "DEFERRED",
        by: "worker:experimenter",
        reason: `Observation incomplete (${errKind}): ${result.reason}`,
      });
      summary.deferred += 1;
    } else {
      // The package ran and the payload did not fire under this trigger/setup.
      // Not a refutation — it may be gated (time/geo/CI/inspector). INCONCLUSIVE.
      graph.transition(h.hypId, {
        to: "INCONCLUSIVE",
        by: "worker:experimenter",
        reason: result.reason,
      });
      summary.inconclusive += 1;
    }
  } catch (err) {
    deferOnError(graph, h.hypId, "worker:experimenter", err, summary);
  }
}

// ---------------------------------------------------------------------------
// Static route — code-reader. Refute if benign; otherwise inform loudly.
// ---------------------------------------------------------------------------

async function dispatchStatic(
  h: Hypothesis,
  graph: HypothesisGraph,
  ctx: OrchestratorContext,
  summary: OrchestratorSummary,
): Promise<void> {
  const { packagePath, log } = ctx;
  try {
    const result = await withTimeout(
      runCodeReader(h, packagePath),
      CODE_READER_MS,
      `code-reader:${h.hypId}`,
    );
    if (result.reading) log.writeLog(`code-reader-${h.hypId}.json`, result.reading);

    if (result.disposition === "REFUTED" && result.evidenceRef) {
      // transition() appends evidenceRefs — don't also addEvidence (double-count).
      graph.transition(h.hypId, {
        to: "REFUTED",
        by: "worker:code-reader",
        reason: result.reason,
        evidenceRefs: [result.evidenceRef],
      });
      summary.refuted += 1;
    } else if (result.disposition === "DEFERRED") {
      graph.transition(h.hypId, {
        to: "DEFERRED",
        by: "worker:code-reader",
        reason: result.reason,
      });
      summary.deferred += 1;
    } else {
      graph.transition(h.hypId, {
        to: "INCONCLUSIVE",
        by: "worker:code-reader",
        reason: result.reason,
      });
      summary.inconclusive += 1;
    }
  } catch (err) {
    deferOnError(graph, h.hypId, "worker:code-reader", err, summary);
  }
}

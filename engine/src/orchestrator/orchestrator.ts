import assert from "node:assert";
import type { Hypothesis } from "@npmguard/shared";
import type { HypothesisGraph } from "../graph/hypothesis-graph.js";
import type { AuditLogger } from "../audit-log.js";
import type { ArtifactStore } from "../evidence/artifact-store.js";
import type { EmitFn } from "../events.js";
import { nextOpen } from "../graph/priority-queue.js";
import { withTimeout } from "../util.js";
import { runExperiment } from "./experimenter.js";

// ---------------------------------------------------------------------------
// Orchestrator — the dispatch loop that resolves the hypothesis graph. It runs
// each hypothesis's experiment under observation and lets the judge decide;
// deterministic control (priority + completion), the workers own the judgement.
//
// INVARIANT: every hypothesis carries a registry-valid experiment (HYPOTHESIZE
// arms it or the audit errors), so there is ONE resolution path — run + judge. A
// suspicion is resolved by running it, never by reading it. CONFIRMED is reached
// only via a dynamic RunArtifact, and no dispatch leaves a node IN_PROGRESS:
// every one lands in a terminal state, so deriveGraphVerdict is authoritative.
// ---------------------------------------------------------------------------

const PER_HYP_MS = 90_000; // cap on a single experiment (a stuck run can't burn the whole budget)

export interface OrchestratorContext {
  packagePath: string;
  artifactStore: ArtifactStore;
  log: AuditLogger;
  emit?: EmitFn;
  /** The package's stated purpose — the benign baseline the judge weighs behavior against. */
  statedPurpose: string;
  /** Overall wall-clock budget for the whole dispatch loop. */
  globalBudgetMs: number;
}

export interface OrchestratorSummary {
  dispatched: number;
  confirmed: number;
  inconclusive: number;
  deferred: number;
}

/**
 * Run the dispatch loop until no OPEN hypothesis remains, or the global budget is
 * exhausted — at which point any undispatched OPEN node is marked DEFERRED so it
 * resolves rather than lingering OPEN.
 */
export async function runOrchestrator(
  graph: HypothesisGraph,
  ctx: OrchestratorContext,
): Promise<OrchestratorSummary> {
  const { emit } = ctx;
  const start = Date.now();
  const summary: OrchestratorSummary = {
    dispatched: 0,
    confirmed: 0,
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

    // OPEN → IN_PROGRESS. The dispatch below lands it in a terminal state.
    graph.transition(h.hypId, { to: "IN_PROGRESS", by: "orchestrator" });
    summary.dispatched += 1;

    // INVARIANT: HYPOTHESIZE armed every flag or raised, so a dispatched
    // hypothesis always carries a runnable experiment — there is no read-only route.
    assert(h.experiment.length > 0, `orchestrator: unarmed hypothesis ${h.hypId} reached dispatch`);
    await dispatchExperiment(h, graph, ctx, summary);

    emitResolved(emit, graph.get(h.hypId));
  }

  console.log(
    `[orchestrator] resolved ${summary.dispatched} hypothes${summary.dispatched === 1 ? "is" : "es"} — ` +
      `${summary.confirmed} confirmed, ${summary.inconclusive} inconclusive, ${summary.deferred} deferred`,
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

/**
 * Run a hypothesis's experiment under observation and record the outcome:
 * CONFIRMED (the judge cited dynamic proof) → DANGEROUS evidence; a clean run
 * that did not fire → INCONCLUSIVE; a run or judge that could not complete →
 * DEFERRED (a coverage gap, never a quiet pass).
 */
async function dispatchExperiment(
  h: Hypothesis,
  graph: HypothesisGraph,
  ctx: OrchestratorContext,
  summary: OrchestratorSummary,
): Promise<void> {
  const { packagePath, artifactStore, log } = ctx;
  try {
    const result = await withTimeout(
      runExperiment(h, packagePath, ctx.statedPurpose),
      PER_HYP_MS,
      `experiment:${h.hypId}`,
    );

    // Persist the RunArtifact regardless of outcome — it documents what we ran.
    const { contentHash: artifactContentHash, ...artifactWithoutHash } = result.artifact;
    const artifactHash = artifactStore.writeArtifact(artifactWithoutHash);
    if (artifactHash !== artifactContentHash) {
      console.warn(
        `[orchestrator] artifact hash mismatch for ${result.artifact.runId}: ` +
          `artifact=${artifactContentHash} store=${artifactHash}`,
      );
    }
    // The timeline is the run's whitebox — persisted so the judge's citations
    // are auditable and retrievable via the /audit/:id/file route.
    log.writeLog(`timeline-${h.hypId}.md`, result.timeline);
    log.writeLog(`experiment-${h.hypId}.json`, {
      hypId: h.hypId,
      confirmed: result.confirmed,
      reason: result.reason,
      citedEvents: result.citedEvents,
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
    // A judge that couldn't run is a coverage gap too — same as a failed
    // observation, we simply don't know. DEFER, never a quiet INCONCLUSIVE pass.
    if (observationFailed || result.judgeFailed) {
      graph.transition(h.hypId, {
        to: "DEFERRED",
        by: "worker:experimenter",
        reason: result.judgeFailed
          ? `Judge could not evaluate the run: ${result.reason}`
          : `Observation incomplete (${errKind}): ${result.reason}`,
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

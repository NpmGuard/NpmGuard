// ---------------------------------------------------------------------------
// Audit-trail entry shape + adapters from the two upstream representations:
// the persisted `report.trace` (PhaseLog[]) and the live store's `phases`.
// ---------------------------------------------------------------------------

export interface TrailEntry {
  phase: string;
  durationMs: number | null;
  status: "done" | "active" | "pending";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export function trailFromTrace(
  trace: Array<{ phase: string; durationMs: number; input?: Record<string, unknown>; output?: Record<string, unknown> }>,
): TrailEntry[] {
  return trace.map((t) => ({
    phase: t.phase,
    durationMs: t.durationMs,
    status: "done",
    input: t.input,
    output: t.output,
  }));
}

export function trailFromPhases(
  phases: Array<{ name: string; durationMs?: number; status: "pending" | "active" | "done" }>,
): TrailEntry[] {
  return phases.map((p) => ({
    phase: p.name,
    durationMs: p.durationMs ?? null,
    status: p.status,
  }));
}

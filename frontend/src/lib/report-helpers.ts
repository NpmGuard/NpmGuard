import type { Proof } from "./types";

// ---------------------------------------------------------------------------
// Verification status — shared between FindingsList and any future surface
// that wants to render a proof's verification state with consistent colors.
// ---------------------------------------------------------------------------

export interface VerificationStatus {
  label: string;
  color: string;
  bg: string;
  border: string;
  rank: number;
}

export function verificationStatus(proof?: Proof): VerificationStatus {
  if (!proof) return { label: "FLAGGED", color: "var(--text-muted)", bg: "var(--bg-tertiary)", border: "var(--text-muted)", rank: 5 };
  switch (proof.kind) {
    case "TEST_CONFIRMED": return { label: "VERIFIED", color: "var(--danger)", bg: "var(--danger-bg)", border: "var(--danger)", rank: 0 };
    case "AI_DYNAMIC": return { label: "OBSERVED", color: "var(--suspected)", bg: "var(--suspected-bg)", border: "var(--suspected)", rank: 1 };
    case "TEST_UNCONFIRMED":
      if (proof.verifyError) return { label: "INFRA ERROR", color: "var(--text-muted)", bg: "var(--bg-tertiary)", border: "var(--text-muted)", rank: 3.5 };
      return { label: "UNVERIFIED", color: "var(--suspected)", bg: "var(--suspected-bg)", border: "var(--suspected)", rank: 2 };
    case "AI_STATIC": return { label: "STATIC", color: "var(--text-muted)", bg: "var(--bg-tertiary)", border: "var(--text-muted)", rank: 3 };
    case "STRUCTURAL": return { label: "STRUCTURAL", color: "var(--text-dim)", bg: "var(--bg-secondary)", border: "var(--text-dim)", rank: 4 };
  }
  return { label: "FLAGGED", color: "var(--text-muted)", bg: "var(--bg-tertiary)", border: "var(--text-muted)", rank: 5 };
}

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

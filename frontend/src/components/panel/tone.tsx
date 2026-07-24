/** Shared verdict/status tone mapping for the panel cluster — the single
 * verdict→tone chokepoint. Tones resolve to the base.css semantic vars;
 * components never touch raw hexes.
 *
 * Retargeted to PanelVerdict (4-state wire). The dev engine never emits
 * SUSPECT and only emits UNKNOWN as the pending rollup bucket, so the SUSPECT
 * tone branch is reserved-but-never-triggered — kept for forward-compat. The
 * param stays widened to `string` because `Alert.verdict` rides the wire as a
 * plain string; every value it carries is still a PanelVerdict member. */

import type { PanelVerdict, ScanSummary } from "../../lib/engine-types.ts";

export type Tone = "safe" | "danger" | "suspect" | "unknown" | "running";

export function verdictTone(verdict: PanelVerdict | string | null | undefined): Tone {
  switch (verdict) {
    case "SAFE":
      return "safe";
    case "DANGEROUS":
      return "danger";
    case "SUSPECT":
      return "suspect";
    default:
      return "unknown";
  }
}

/** `--accent` value for `.card--accent` severity bars. */
export function toneAccent(tone: Tone): string {
  switch (tone) {
    case "safe":
      return "var(--safe)";
    case "danger":
      return "var(--danger)";
    case "suspect":
      return "var(--suspect)";
    case "running":
      return "var(--running)";
    default:
      return "var(--tone-paper-accent)";
  }
}

/** Card accent for a repo's last scan (running > failed > verdict). */
export function scanTone(scan: ScanSummary | null): Tone {
  if (!scan) return "unknown";
  if (scan.status === "running") return "running";
  if (scan.status === "failed") return "danger";
  return verdictTone(scan.verdict);
}

/** Status-dot class for a tone; plain paper dot for unknown/pending. */
export function toneDotClass(tone: Tone): string {
  return tone === "unknown" ? "dot" : `dot dot--${tone}`;
}

/** Verdict pill — uppercase rendering comes from the pill class, not code. */
export function VerdictPill({ verdict }: { verdict: string }) {
  return <span className={`pill pill--${verdictTone(verdict)}`}>{verdict}</span>;
}

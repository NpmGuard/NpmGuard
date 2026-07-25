/** Shared outcome/status tone mapping for the panel cluster — the single
 * outcome→tone chokepoint, plus the dep sort rank that depends on it. Tones
 * resolve to the base.css semantic vars; components never touch raw hexes.
 *
 * The domain is the panel `Outcome` (SAFE | ERROR | DANGEROUS, null until
 * concluded) from the generated contract, NOT the audit-core verdict. The two
 * axes stay separate here too: `outcomeTone` maps what we KNOW, and the dep
 * helpers below fold in progress (`jobState`) only where the UI shows progress.
 *
 * The param is no longer widened to `string`: the retired 4-state PanelVerdict
 * and a bare-`string` Alert.verdict were what forced that, and a widened param
 * silently accepted values the map had no arm for. */

import type { AuditSet, AuditSetItem, Outcome } from "@npmguard/shared";

export type Tone = "safe" | "danger" | "error" | "running" | "unknown";

/** `unknown` is the absence of information (nothing concluded, no scan yet) —
 * never a conclusion. An audit that FAILED is `error`, which is a conclusion. */
export function outcomeTone(outcome: Outcome | null): Tone {
  switch (outcome) {
    case "SAFE":
      return "safe";
    case "DANGEROUS":
      return "danger";
    case "ERROR":
      return "error";
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
    case "error":
      return "var(--error)";
    case "running":
      return "var(--running)";
    default:
      return "var(--tone-paper-accent)";
  }
}

/** Card accent for a repo's last audit set: set progress first (still running),
 * then the outcome over its own items.
 *
 * There is no `failed` arm any more — R-1's falsification pass found zero
 * producers for a failed SET, so the status domain is `running | done` and the
 * branch that handled it was dead. Every way a set can go wrong now resolves into
 * its rollup, where ERROR is a real, countable outcome. */
export function scanTone(set: AuditSet | null): Tone {
  if (!set) return "unknown";
  if (set.status === "running") return "running";
  return outcomeTone(set.rollup.outcome);
}

/** Status-dot class for a tone; plain paper dot for unknown/pending. */
export function toneDotClass(tone: Tone): string {
  return tone === "unknown" ? "dot" : `dot dot--${tone}`;
}

/** Severity-first sort rank over the two axes: concluded severity first
 * (DANGEROUS > ERROR), then live progress (running before queued), then SAFE.
 * ERROR outranks a running audit because it needs a human; a running one
 * resolves itself. */
export function depPriority(dep: AuditSetItem): number {
  if (dep.outcome === "DANGEROUS") return 0;
  if (dep.outcome === "ERROR") return 1;
  if (dep.outcome === null) return dep.jobState === "running" ? 2 : 3;
  return 4; // SAFE
}

/** Tone for one dep: its outcome, except that a still-running attempt shows as
 * running rather than as absent information. */
export function depTone(dep: AuditSetItem): Tone {
  if (dep.outcome === null && dep.jobState === "running") return "running";
  return outcomeTone(dep.outcome);
}

/** Outcome pill — uppercase rendering comes from the pill class, not code. */
export function OutcomePill({ outcome }: { outcome: Outcome }) {
  return <span className={`pill pill--${outcomeTone(outcome)}`}>{outcome}</span>;
}

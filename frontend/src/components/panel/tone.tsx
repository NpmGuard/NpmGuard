/** Shared outcome/status tone mapping for the panel cluster — the single
 * outcome→tone chokepoint, plus the dep sort rank that depends on it.
 *
 * The domain is the panel `Outcome` (SAFE | ERROR | DANGEROUS, null until
 * concluded) from the generated contract, NOT the audit-core verdict. The two
 * axes stay separate here too: `outcomeTone` maps what we KNOW, and the dep
 * helpers below fold in progress (`jobState`) only where the UI shows progress.
 *
 * The param is no longer widened to `string`: the retired 4-state PanelVerdict
 * and a bare-`string` Alert.verdict were what forced that, and a widened param
 * silently accepted values the map had no arm for.
 *
 * This file is now LOGIC ONLY. The two renderers that used to live at the
 * bottom moved to `components/ui/verdict-stamp.tsx` as `VerdictStamp` /
 * `ProgressStamp`, which is where brief §3.3 inventories them and where the
 * three non-panel surfaces that render a verdict (`/replays`, `/packages`, and
 * the inbound `/scan`) can reach them without importing out of the panel
 * cluster. What stays here is genuinely panel domain: the outcome→tone map and
 * the dep sort rank built on it.
 *
 * ── WHY TWO STYLING SUBSTRATES STILL APPEAR HERE ────────────────────────────
 *
 * The two class/var helpers (`toneAccent`, `toneDotClass`) are still on the
 * legacy `base.css` names, and that is deliberate rather than unfinished: their
 * only remaining callers are
 * `features/repos/components/{RepoCard,PortfolioPosture}.tsx`, which are still
 * whole-hog legacy. Handing a legacy card a token-coloured mark would put two
 * palettes inside one 18px-padded warm-paper box, which reads worse than either.
 * They die with those two components. */

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

/** LEGACY. `--accent` value for `base.css`'s `.card--accent` severity bars.
 * Sole surviving caller is `features/repos/components/RepoCard.tsx`; see the
 * file header for why it was not migrated with the renderers. A v3 surface uses
 * `<Card severity="danger" | "error">` instead, which carries the §2.8 3px rule
 * and deliberately has no `safe` arm. */
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

/** LEGACY. Status-dot class for a tone; plain paper dot for unknown/pending.
 * Sole surviving caller is `features/repos/components/PortfolioPosture.tsx`,
 * whose legend sits beside a legacy `.rail` in the same card — see the file
 * header. A v3 surface does not use a colour-only mark at all: §2.4 requires
 * glyph + word + colour, in that order of priority, so the state travels on
 * `VerdictStamp` / `ProgressStamp` and severity reaches a row as a 3px rule. */
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

/** The 3px left rule a row or card wears for this tone, or `undefined`.
 * `Card`/`TableRow` accept `"danger" | "error"` and nothing else — §0 rule 1
 * makes SAFE the quietest state in the system, and 313 green-ruled rows would
 * drown the three that matter. Centralised here so the two call sites cannot
 * disagree about which tones earn a rule. */
export function toneSeverity(tone: Tone): "danger" | "error" | undefined {
  return tone === "danger" || tone === "error" ? tone : undefined;
}

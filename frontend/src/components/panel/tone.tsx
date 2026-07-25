/** Shared outcome/status tone mapping for the panel cluster — the single
 * outcome→tone chokepoint, plus the dep sort rank that depends on it.
 *
 * The domain is the panel `Outcome` (SAFE | ERROR | DANGEROUS, null until
 * concluded) from the generated contract, NOT the audit-core verdict. The two
 * axes stay separate here too: `outcomeTone` maps what we KNOW, and the dep
 * helpers below fold in progress (`jobState`) only where the UI shows progress.
 *
 * The param is typed `Outcome`, never widened to `string`: a widened param
 * silently accepts values the map has no arm for.
 *
 * This file is now LOGIC ONLY. The two renderers that used to live at the
 * bottom moved to `components/ui/verdict-stamp.tsx` as `VerdictStamp` /
 * `ProgressStamp`, which is where brief §3.3 inventories them and where the
 * three non-panel surfaces that render a verdict (`/replays`, `/packages`, and
 * the inbound `/scan`) can reach them without importing out of the panel
 * cluster. What stays here is genuinely panel domain: the outcome→tone map and
 * the dep sort rank built on it.
 *
 * There is no longer a second styling substrate in here. `toneAccent` and
 * `toneDotClass` returned legacy `base.css` names and were kept alive for
 * `features/repos/components/{RepoCard,PortfolioPosture}.tsx`; both were
 * recomposed onto the token layer, which left the two helpers with zero callers,
 * so they are deleted rather than left as a door back to a palette that no
 * longer exists. */

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

/** Card accent for a repo's last audit set: set progress first (still running),
 * then the outcome over its own items.
 *
 * There is no `failed` arm: the set status domain is `running | done`. Every way
 * a set can go wrong resolves into its rollup, where ERROR is a real, countable
 * outcome. */
export function scanTone(set: AuditSet | null): Tone {
  if (!set) return "unknown";
  if (set.status === "running") return "running";
  return outcomeTone(set.rollup.outcome);
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

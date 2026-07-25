/** Pure quota-display logic for UsageBucket allowances. */

import type { UsageBucket } from "@npmguard/shared";

export type QuotaState =
  | { kind: "unlimited" }
  | { kind: "exhausted" }
  | { kind: "available"; remaining: number };

/** remaining === null means UNLIMITED (limit 0), not zero-left. */
export function quotaState(bucket: UsageBucket): QuotaState {
  if (bucket.remaining === null) return { kind: "unlimited" };
  if (bucket.remaining <= 0) return { kind: "exhausted" };
  return { kind: "available", remaining: bucket.remaining };
}

/** Copy for the public-repo-audit allowance. Re-auditing a repository that
 * already consumed a slot is always free — exhausted is not a dead end. */
export function publicAuditAllowanceCopy(bucket: UsageBucket): string {
  const state = quotaState(bucket);
  switch (state.kind) {
    case "unlimited":
      return "Unlimited public repository audits.";
    case "exhausted":
      return "Free repository allowance used. Existing repositories can still be re-audited.";
    case "available":
      return `${state.remaining} new public ${state.remaining === 1 ? "repository" : "repositories"} left. Re-audits are free.`;
  }
}

export function usageLabel(bucket: UsageBucket): string {
  return bucket.remaining === null ? `${bucket.used} / ∞` : `${bucket.used} / ${bucket.limit}`;
}

/* `usageFraction` was deleted here when `AllowanceMeter` became an adapter over
   `ui/meter`. The primitive derives its own fill from `(value, max)` and its own
   state machine from the same pair, so keeping a second fraction beside it was two
   projections of one number — and the projection here was the dishonest one: it
   painted a 5% sliver for an UNMETERED bucket, a magnitude for a ceiling that does
   not exist. `Meter` prints "No limit on this plan" and draws no bar. Do not
   reintroduce it; if a caller needs a fill, it needs `Meter`. */
